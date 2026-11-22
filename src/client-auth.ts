import type { Context } from "hono";
import type { Env } from "./config";
import { getClient, audit } from "./db";
import type { OidcClient } from "./db";
import { nowSec, sha256Hex, timingSafeEqualHex } from "./util";
export async function authenticateClient(
  c: Context<{ Bindings: Env }>,
  body: Record<string, string | undefined>,
): Promise<OidcClient | null> {
  let clientId = body.client_id ?? "";
  let clientSecret = body.client_secret ?? "";
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const idx = decoded.indexOf(":");
      if (idx < 0) return null;
      clientId = decodeURIComponent(decoded.slice(0, idx));
      clientSecret = decodeURIComponent(decoded.slice(idx + 1));
    } catch {
      return null;
    }
  }
  if (!clientId) return null;
  const client = await getClient(c.env.DB, clientId);
  if (!client) return null;
  if (client.client_type === "public") {
    return clientSecret ? null : client;
  }
  if (!clientSecret) {
    await audit(c.env.DB, "CLIENT_AUTH_FAILED", { clientId: client.id });
    return null;
  }
  const presented = await sha256Hex(clientSecret);
  if (timingSafeEqualHex(presented, client.secret_hash)) {
    if (client.previous_secret_hash && !client.replacement_used_at)
      await c.env.DB.prepare(
        "UPDATE oidc_clients SET replacement_used_at=unixepoch() WHERE id=? AND secret_hash=? AND replacement_used_at IS NULL",
      )
        .bind(client.id, presented)
        .run();
    return client;
  }
  if (
    client.previous_secret_hash &&
    (client.previous_secret_until ?? 0) > nowSec() &&
    timingSafeEqualHex(presented, client.previous_secret_hash)
  )
    return client;
  await audit(c.env.DB, "CLIENT_AUTH_FAILED", { clientId: client.id });
  return null;
}
