import type { Env } from "./config";
import { audit, getUser } from "./db";
import { mintLogoutToken } from "./crypto";
import { cfConfigured, revokeAccessSessions } from "./cf-access";
import { outboundUrlProblem, postOutbound } from "./outbound";
import { currentScope } from "./request-context";
import { getInstanceSettings } from "./settings-cache";
import { newId } from "./util";

interface Delivery {
  id: string;
  user_id: string;
  client_id: string | null;
  destination: string;
  reason: string;
  attempts: number;
  account_id: string | null;
}

async function postDelivery(env: Env, d: Delivery) {
  if (d.client_id === null) {
    const settings = await getInstanceSettings(env.DB);
    if (
      !settings.cfAccessRevoke ||
      settings.cfApiToken ||
      !cfConfigured(env) ||
      env.CF_ACCOUNT_ID !== d.account_id
    )
      return "Configuration changed";
    await revokeAccessSessions(env, d.destination);
    return "200";
  }
  const uri = await env.DB.prepare("SELECT backchannel_logout_uri FROM oidc_clients WHERE id=?")
    .bind(d.client_id)
    .first<string>("backchannel_logout_uri");
  if (uri !== d.destination || outboundUrlProblem(uri, env.ISSUER)) return "Configuration changed";
  const token = await mintLogoutToken(env, d.user_id, d.client_id);
  return postOutbound(uri, {
    body: new URLSearchParams({ logout_token: token }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

function deliveryStatus(result: string, attempts: number) {
  if (/^2\d\d$/.test(result)) return "Acknowledged";
  if (result === "Configuration changed") return result;
  if (/^HTTP [34]/.test(result) && !["HTTP 429", "HTTP 408", "HTTP 425"].includes(result))
    return "Failed";
  return attempts >= 5 ? "Failed" : "Pending";
}

async function deliver(env: Env, id: string) {
  const d = await env.DB.prepare(
    "UPDATE logout_deliveries SET due=unixepoch()+120,attempts=attempts+1 WHERE id=? AND status='Pending' AND due<=unixepoch() RETURNING *",
  )
    .bind(id)
    .first<Delivery>();
  if (!d) return;
  const result = await postDelivery(env, d).catch(() => "Temporary failure");
  const status = deliveryStatus(result, d.attempts);
  const updated = await env.DB.prepare(
    "UPDATE logout_deliveries SET status=?1,due=unixepoch()+?2,destination=CASE WHEN ?1='Pending' THEN destination END WHERE id=?3 AND attempts=?4 AND status='Pending'",
  )
    .bind(status, 60 * 2 ** d.attempts, id, d.attempts)
    .run();
  if (updated.meta.changes)
    await audit(env.DB, d.client_id === null ? "ACCESS_SESSIONS_REVOKED" : "BACKCHANNEL_LOGOUT", {
      userId: d.reason === "deleted" ? null : d.user_id,
      clientId: d.client_id,
      detail: { reason: d.reason, status: /^(HTTP )?\d{3}$/.test(result) ? result : status },
    });
}

export async function drainLogout(env: Env, batch?: string) {
  const db = env.DB;
  const ids = batch
    ? db
        .prepare(
          "SELECT id FROM logout_deliveries WHERE status='Pending' AND due<=unixepoch() AND batch=? ORDER BY due LIMIT 12",
        )
        .bind(batch)
    : db.prepare(
        "SELECT id FROM logout_deliveries WHERE status='Pending' AND due<=unixepoch() ORDER BY due LIMIT 12",
      );
  const { results } = await ids.all<{ id: string }>();
  await Promise.all(results.map((r) => deliver(env, r.id)));
}

export async function signOutOfApps(
  db: D1Database,
  userId: string,
  reason: string,
  mutations: D1PreparedStatement[],
) {
  const scope = currentScope();
  const user = await getUser(db, userId);
  if (!user || !scope) {
    await db.batch(mutations);
    return;
  }
  const batch = newId(),
    env = scope.env,
    settings = await getInstanceSettings(db);
  const stmts = [
    db
      .prepare(`INSERT INTO logout_deliveries(id,batch,user_id,client_id,name,destination,reason,status)
 SELECT lower(hex(randomblob(16))),?,s.user_id,c.id,c.name,c.backchannel_logout_uri,?,CASE WHEN c.backchannel_logout_uri IS NULL THEN 'No integration' ELSE 'Pending' END
 FROM client_signins s JOIN oidc_clients c ON c.id=s.client_id WHERE s.user_id=?`)
      .bind(batch, reason, userId),
    db.prepare("DELETE FROM client_signins WHERE user_id=?").bind(userId),
  ];
  if (!user.public && settings.cfAccessRevoke && cfConfigured(env) && !settings.cfApiToken)
    stmts.push(
      db
        .prepare(
          "INSERT INTO logout_deliveries(id,batch,user_id,name,destination,account_id,reason,status) VALUES(?,?,?,'Cloudflare Access',?,?,?,'Pending')",
        )
        .bind(newId(), batch, userId, user.email, env.CF_ACCOUNT_ID ?? null, reason),
    );
  await db.batch([...stmts, ...mutations]);
  scope.wait(drainLogout(env, batch));
}
