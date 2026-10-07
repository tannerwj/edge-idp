/**
 * Signed-in user surface: Account & security (profile, passkeys, devices,
 * connected apps, recent activity). The home launcher lives in home.tsx.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./config";
import { audit, getCredentialsForUser } from "./db";
import { getSession, hasRecentStepUp, SESSION_COOKIE } from "./session";
import type { Session } from "./session";
import * as ops from "./ops";
import { nowSec, sha256Hex } from "./util";
import { AppShell, setFlash, uiFor } from "./ui/layout";
import { Avatar, PageHead } from "./ui/components";
import type { Viewer } from "./ui/layout";
import { getCookie } from "hono/cookie";
import {
  AccountLede,
  ActivitySection,
  ConnectedSection,
  PasskeysSection,
  ProfileSection,
  SessionsSection,
} from "./account-sections";
import type { GrantRow, SessionRow } from "./account-sections";
import { field } from "./admin/shell";

type C = Context<{ Bindings: Env }>;

export const account = new Hono<{ Bindings: Env }>();

export function viewerOf(s: Session): Viewer {
  return { id: s.user.id, name: s.user.name, email: s.user.email, isAdmin: !!s.user.is_admin };
}

async function requireSession(c: C): Promise<Session | Response> {
  const s = await getSession(c);
  if (!s) return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 302);
  return s;
}

/* ───────────────────────────── account & security ───────────────────────────── */

function loadAccount(db: D1Database, userId: string) {
  return Promise.all([
    getCredentialsForUser(db, userId),
    db
      .prepare(
        "SELECT id_hash, created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ?1 AND expires_at > ?2 ORDER BY last_seen_at DESC",
      )
      .bind(userId, nowSec())
      .all<SessionRow>(),
    db
      .prepare(
        `SELECT g.client_id, g.scope, g.created_at, g.last_used_at, c.name, c.source FROM oauth_grants g
         JOIN oidc_clients c ON c.id = g.client_id WHERE g.user_id = ?1 ORDER BY g.last_used_at DESC`,
      )
      .bind(userId)
      .all<GrantRow>(),
    db
      .prepare(
        `SELECT a.event, a.created_at, c.name AS client_name FROM audit_log a
         LEFT JOIN oidc_clients c ON c.id = a.client_id
         WHERE a.user_id = ?1 AND a.event NOT IN ('CODE_ISSUED','TOKEN_ISSUED') ORDER BY a.id DESC LIMIT 15`,
      )
      .bind(userId)
      .all<{ event: string; created_at: number; client_name: string | null }>(),
  ]);
}

account.get("/account", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const db = c.env.DB;
  const currentHash = await sha256Hex(getCookie(c, SESSION_COOKIE) ?? "");
  const [creds, sessions, grants, activity] = await loadAccount(db, s.user.id);
  const others = sessions.results.filter((x) => x.id_hash !== currentHash).length;
  return c.html(
    <AppShell
      ui={await uiFor(c)}
      viewer={viewerOf(s)}
      active="account"
      title="Account & security"
      page="account"
      flash={c.req.query("ok")}
      narrow
    >
      <PageHead
        leading={<Avatar name={s.user.name} seed={s.user.id} size="lg" />}
        title={s.user.name}
        lede={<AccountLede user={s.user} />}
      />
      <div class="stack-lg">
        <ProfileSection user={s.user} />

        <PasskeysSection creds={creds} />

        <SessionsSection
          sessions={sessions.results}
          currentHash={currentHash}
          others={others}
          rpName={c.env.RP_NAME}
        />

        <ConnectedSection grants={grants.results} />

        <ActivitySection rows={activity.results} />
      </div>
    </AppShell>,
  );
});

account.post("/account/profile", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const form = await c.req.parseBody();
  try {
    await ops.updateUser(
      c.env.DB,
      s.user.id,
      { name: field(form, "name"), email: field(form, "email") },
      { adminId: s.user.id, via: "ui" },
    );
  } catch (e) {
    if (e instanceof ops.OpError) {
      setFlash(c, e.message, "bad");
      return c.redirect("/account#profile", 303);
    }
    throw e;
  }
  return c.redirect("/account?ok=saved", 303);
});

account.post("/account/keys/:id/remove", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  if (!hasRecentStepUp(s))
    return c.redirect(`/login?reauth=1&next=${encodeURIComponent("/account#passkeys")}`, 303);
  const creds = await getCredentialsForUser(c.env.DB, s.user.id);
  const target = creds.find((k) => k.id === c.req.param("id"));
  // Fail safe: never let a user strand themselves with zero passkeys.
  if (!target || creds.length <= 1) return c.redirect("/account#passkeys", 303);
  await c.env.DB.prepare("DELETE FROM webauthn_credentials WHERE id = ?1 AND user_id = ?2")
    .bind(target.id, s.user.id)
    .run();
  await audit(c.env.DB, "PASSKEY_REMOVED", {
    userId: s.user.id,
    detail: { credential: target.id, name: target.name },
  });
  return c.redirect("/account?ok=key_removed#passkeys", 303);
});

account.post("/account/keys/:id/rename", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const form = await c.req.parseBody();
  const name = field(form, "name").trim().slice(0, 60);
  if (name) {
    await c.env.DB.prepare(
      "UPDATE webauthn_credentials SET name = ?1 WHERE id = ?2 AND user_id = ?3",
    )
      .bind(name, c.req.param("id"), s.user.id)
      .run();
    await audit(c.env.DB, "PASSKEY_RENAMED", {
      userId: s.user.id,
      detail: { credential: c.req.param("id") },
    });
  }
  return c.redirect("/account?ok=key_renamed#passkeys", 303);
});

account.post("/account/sessions/:hash/revoke", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1 AND user_id = ?2")
    .bind(c.req.param("hash"), s.user.id)
    .run();
  await audit(c.env.DB, "SESSION_REVOKED", {
    userId: s.user.id,
    detail: { by: s.user.id, via: "self" },
  });
  return c.redirect("/account?ok=signed_out#sessions", 303);
});

account.post("/account/sessions/revoke-others", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1 AND id_hash != ?2")
    .bind(s.user.id, s.idHash)
    .run();
  await audit(c.env.DB, "SESSION_REVOKED", {
    userId: s.user.id,
    detail: { by: s.user.id, via: "self", others: true },
  });
  return c.redirect("/account?ok=signed_out_others#sessions", 303);
});

account.post("/account/grants/revoke", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const form = await c.req.parseBody();
  const clientId = field(form, "client_id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_grants WHERE user_id = ?1 AND client_id = ?2").bind(
      s.user.id,
      clientId,
    ),
    c.env.DB.prepare("DELETE FROM refresh_tokens WHERE user_id = ?1 AND client_id = ?2").bind(
      s.user.id,
      clientId,
    ),
  ]);
  await audit(c.env.DB, "CONSENT_REVOKED", { userId: s.user.id, clientId });
  return c.redirect("/account?ok=revoked#connected", 303);
});
