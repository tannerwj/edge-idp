import type { Env } from "./config";
import { audit, getUser } from "./db";
import { mintLogoutToken } from "./crypto";
import { cfConfigured, revokeAccessSessions } from "./cf-access";
import { postOutbound } from "./outbound";
import { currentScope } from "./request-context";
import { getInstanceSettings } from "./settings-cache";

interface Plan {
  userId: string;
  email: string | null;
  clients: { id: string; uri: string }[];
}

async function planFor(db: D1Database, userId: string): Promise<Plan | null> {
  const user = await getUser(db, userId);
  if (!user) return null;
  const { results } = await db
    .prepare(
      `SELECT c.id AS id, c.backchannel_logout_uri AS uri FROM client_signins s
       JOIN oidc_clients c ON c.id = s.client_id
       WHERE s.user_id = ?1 AND c.backchannel_logout_uri IS NOT NULL`,
    )
    .bind(userId)
    .all<{ id: string; uri: string }>();
  return { userId, email: user.public ? null : user.email, clients: results };
}

async function run(env: Env, plan: Plan, reason: string): Promise<void> {
  const who = reason === "deleted" ? null : plan.userId;
  const jobs = plan.clients.map(async (client) => {
    const token = await mintLogoutToken(env, plan.userId, client.id);
    const status = await postOutbound(client.uri, {
      body: new URLSearchParams({ logout_token: token }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    await audit(env.DB, "BACKCHANNEL_LOGOUT", {
      userId: who,
      clientId: client.id,
      detail: { reason, status },
    });
  });
  const s = await getInstanceSettings(env.DB);
  if (plan.email && s.cfAccessRevoke && cfConfigured(env) && !s.cfApiToken)
    jobs.push(
      revokeAccessSessions(env, plan.email)
        .then(() => "ok")
        .catch((e: unknown) => (e instanceof Error ? e.message : "failed"))
        .then((status) =>
          audit(env.DB, "ACCESS_SESSIONS_REVOKED", {
            userId: who,
            detail: { reason, status },
          }),
        ),
    );
  await Promise.allSettled(jobs);
  await env.DB.prepare("DELETE FROM client_signins WHERE user_id = ?1").bind(plan.userId).run();
}

export async function signOutOfApps(db: D1Database, userId: string, reason: string) {
  const scope = currentScope();
  if (!scope) return;
  const plan = await planFor(db, userId);
  if (!plan) return;
  scope.wait(run(scope.env, plan, reason).catch((e) => console.error(e)));
}
