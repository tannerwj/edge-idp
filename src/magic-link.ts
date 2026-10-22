import type { Env } from "./config";
import { audit, getUser, getUserByEmail } from "./db";
import type { User } from "./db";
import { emailStatus, sendMail } from "./email";
import { getInstanceSettings } from "./settings-cache";
import { nowSec, randomToken, sha256Hex } from "./util";

const LINK_TTL = 600;
const RESEND_GAP = 60;

export async function magicLinksOpen(env: Env): Promise<boolean> {
  const s = await getInstanceSettings(env.DB);
  return s.magicLinks && emailStatus(env, s) === "ready";
}

function eligible(user: User | null): user is User {
  return !!user && !user.disabled && !user.public && !user.is_admin;
}

export async function sendMagicLink(
  env: Env,
  rawEmail: string,
  next: string,
  ipHash: string | null,
): Promise<void> {
  if (!(await magicLinksOpen(env))) return;
  const user = await getUserByEmail(env.DB, rawEmail.trim().slice(0, 254));
  if (!eligible(user)) return;
  const recent = await env.DB.prepare(
    "SELECT 1 AS x FROM magic_links WHERE user_id = ?1 AND created_at > ?2",
  )
    .bind(user.id, nowSec() - RESEND_GAP)
    .first();
  if (recent) return;
  const token = randomToken(32);
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM magic_links WHERE user_id = ?1").bind(user.id),
    env.DB.prepare(
      "INSERT INTO magic_links (token_hash, user_id, next, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(await sha256Hex(token), user.id, next, now, now + LINK_TTL),
  ]);
  const s = await getInstanceSettings(env.DB);
  const sent = await sendMail(env, s, user.email, {
    subject: `Sign in to ${env.RP_NAME}`,
    heading: `Sign in to ${env.RP_NAME}`,
    paragraphs: [
      "Use the button to sign in. It works once, for 10 minutes, on any device.",
      "Next time, a passkey is quicker: add one from Account & security after you sign in.",
    ],
    button: { label: "Sign in", url: `${env.ISSUER}/login/link#${token}` },
    footer:
      "If you didn't ask to sign in, ignore this email; nobody can use it without this inbox.",
  });
  if (sent.ok) await audit(env.DB, "MAGIC_LINK_SENT", { userId: user.id, ipHash });
}

async function lookup(env: Env, token: string, consume: boolean) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const sql = consume
    ? "DELETE FROM magic_links WHERE token_hash = ?1 AND expires_at >= ?2 RETURNING user_id, next"
    : "SELECT user_id, next FROM magic_links WHERE token_hash = ?1 AND expires_at >= ?2";
  const row = await env.DB.prepare(sql)
    .bind(await sha256Hex(token), nowSec())
    .first<{ user_id: string; next: string }>();
  if (!row) return null;
  const user = await getUser(env.DB, row.user_id);
  return eligible(user) && (await magicLinksOpen(env)) ? { user, next: row.next } : null;
}

export function peekMagicLink(env: Env, token: string) {
  return lookup(env, token, false);
}

export function redeemMagicLink(env: Env, token: string) {
  return lookup(env, token, true);
}
