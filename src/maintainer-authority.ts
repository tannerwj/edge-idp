import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./config";
import { randomToken, sha256Hex } from "./util";
import { getSetting } from "./db";
import { getInstanceSettings } from "./settings-cache";

export class MaintainerAuthority extends WorkerEntrypoint<Env> {
  async fetch(req: Request) {
    const denied = new Response(null, { status: 403 });
    if (req.method !== "POST" || !this.env.MAINTAINER_CONSOLE_URL) return denied;
    const { token, origin, sender } = await req.json<{
      token: string;
      origin: string;
      sender?: string;
    }>();
    if (origin !== this.env.MAINTAINER_CONSOLE_URL || !/^[\w-]{43}$/.test(token)) return denied;
    const path = new URL(req.url).pathname;
    const hash = await sha256Hex(token);
    const db = this.env.DB;
    if (path === "/exchange") {
      const issuer = this.env.ISSUER || (await getSetting(db, "issuer", ""));
      if (!sender || sender !== issuer) return denied;
      const next = randomToken();
      const result = await db
        .prepare(
          "UPDATE maintainer_sessions SET token_hash=?,redeemed=1,expires_at=unixepoch()+1800 WHERE token_hash=? AND redeemed=0 AND expires_at>unixepoch()",
        )
        .bind(await sha256Hex(next), hash)
        .run();
      return result.meta.changes ? new Response(next) : denied;
    }
    if (path !== "/read" && path !== "/write") return denied;
    const row = await db
      .prepare(`SELECT s.step_up_at FROM maintainer_sessions m JOIN sessions s ON s.id_hash=m.session_hash JOIN users u ON u.id=s.user_id
      WHERE m.token_hash=? AND m.redeemed=1 AND m.expires_at>unixepoch() AND s.expires_at>unixepoch() AND s.method='passkey' AND u.is_admin=1 AND u.disabled=0`)
      .bind(hash)
      .first<{ step_up_at: number | null }>();
    if (!row) return denied;
    if (path === "/write") {
      const { adminStepUp } = await getInstanceSettings(db);
      if (
        adminStepUp !== "off" &&
        (!row.step_up_at || row.step_up_at + Number(adminStepUp) * 60 < Date.now() / 1000)
      )
        return denied;
    }
    return new Response(null, { status: 204 });
  }
}
