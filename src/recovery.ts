import type { Env } from "./config";
import { audit, getUser, getUserByEmail } from "./db";
import { emailStatus } from "./email";
import { deliverLink } from "./invites";
import type { Delivery } from "./invites";
import { mintEnrollmentLink } from "./ops";
import { by, OpError } from "./ops-core";
import type { Actor } from "./ops-core";
import { getInstanceSettings } from "./settings-cache";
import { newId, nowSec } from "./util";

export const RECOVERY_TTL = 3600;
const SYSTEM: Actor = { adminId: "system", via: "system" };

export interface RecoveryRequest {
  id: string;
  user_id: string;
  name: string;
  email: string;
  created_at: number;
}

export async function requestRecovery(
  env: Env,
  rawEmail: string,
  ipHash: string | null,
): Promise<void> {
  const s = await getInstanceSettings(env.DB);
  if (s.recoveryMode === "off") throw new OpError("Recovery is turned off.");
  const user = await getUserByEmail(env.DB, rawEmail.trim().slice(0, 254));
  if (!user || user.disabled || user.public) return;
  const auto = s.recoveryMode === "auto" && !user.is_admin && emailStatus(env, s) === "ready";
  if (auto) {
    const link = await mintEnrollmentLink(env.DB, env.ISSUER, user.id, SYSTEM, RECOVERY_TTL);
    const d = await deliverLink(env, user, link, "recovery");
    if (d.emailed) {
      await audit(env.DB, "RECOVERY_LINK_SENT", {
        userId: user.id,
        ipHash,
        detail: { auto: true },
      });
      return;
    }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM recovery_requests WHERE user_id = ?1 AND status = 'pending'").bind(
      user.id,
    ),
    env.DB.prepare(
      "INSERT INTO recovery_requests (id, user_id, created_at, ip_hash) VALUES (?1, ?2, ?3, ?4)",
    ).bind(newId(), user.id, nowSec(), ipHash),
  ]);
  await audit(env.DB, "RECOVERY_REQUESTED", { userId: user.id, ipHash });
}

export async function pendingRecovery(db: D1Database): Promise<RecoveryRequest[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.user_id, u.name, u.email, r.created_at FROM recovery_requests r
       JOIN users u ON u.id = r.user_id WHERE r.status = 'pending' ORDER BY r.created_at DESC`,
    )
    .all<RecoveryRequest>();
  return results;
}

async function resolve(db: D1Database, id: string, status: string, a: Actor) {
  const row = await db
    .prepare(
      `UPDATE recovery_requests SET status = ?2, resolved_at = ?3, resolved_by = ?4
       WHERE id = ?1 AND status = 'pending' RETURNING user_id`,
    )
    .bind(id, status, nowSec(), a.adminId)
    .first<{ user_id: string }>();
  if (!row) throw new OpError("That request was already handled.");
  return row.user_id;
}

export async function approveRecovery(
  env: Env,
  id: string,
  send: boolean,
  a: Actor,
): Promise<{ userId: string; link: string; delivery: Delivery | null }> {
  const pending = await env.DB.prepare(
    "SELECT user_id FROM recovery_requests WHERE id = ?1 AND status = 'pending'",
  )
    .bind(id)
    .first<{ user_id: string }>();
  if (!pending) throw new OpError("That request was already handled.");
  const link = await mintEnrollmentLink(env.DB, env.ISSUER, pending.user_id, a, RECOVERY_TTL);
  const userId = await resolve(env.DB, id, "approved", a);
  const user = await getUser(env.DB, userId);
  const delivery = send && user ? await deliverLink(env, user, link, "recovery") : null;
  await audit(env.DB, "RECOVERY_LINK_SENT", {
    userId,
    detail: by(a, { emailed: delivery?.emailed ?? false }),
  });
  return { userId, link, delivery };
}

export async function dismissRecovery(db: D1Database, id: string, a: Actor): Promise<void> {
  const userId = await resolve(db, id, "dismissed", a);
  await audit(db, "RECOVERY_DISMISSED", { userId, detail: by(a) });
}
