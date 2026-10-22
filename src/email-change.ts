import type { Env } from "./config";
import { audit, getUser } from "./db";
import type { User } from "./db";
import { emailStatus, sendMail } from "./email";
import { EMAIL_RE, OpError } from "./ops-core";
import { getInstanceSettings } from "./settings-cache";
import { nowSec, randomToken, sha256Hex } from "./util";

const CHANGE_TTL = 3600;

export async function selfEmailChangeOpen(env: Env): Promise<boolean> {
  const s = await getInstanceSettings(env.DB);
  return s.selfEmailChange && emailStatus(env, s) === "ready";
}

async function addressTaken(db: D1Database, email: string, userId: string): Promise<boolean> {
  return !!(await db
    .prepare("SELECT 1 AS x FROM users WHERE lower(email) = lower(?1) AND id != ?2")
    .bind(email, userId)
    .first());
}

export async function startEmailChange(env: Env, user: User, raw: string): Promise<string> {
  if (user.public) throw new OpError("Accounts made through a public app have no email.");
  if (!(await selfEmailChangeOpen(env))) throw new OpError("Ask an admin to change your email.");
  const email = raw.trim().slice(0, 254);
  if (!EMAIL_RE.test(email) || email.toLowerCase().endsWith("@public.invalid"))
    throw new OpError("Enter a valid email address.");
  if (email.toLowerCase() === user.email.toLowerCase())
    throw new OpError("That's already your email.");
  if (await addressTaken(env.DB, email, user.id))
    throw new OpError("That email is already in use.");
  const token = randomToken(32);
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_changes WHERE user_id = ?1").bind(user.id),
    env.DB.prepare(
      "INSERT INTO email_changes (token_hash, user_id, new_email, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(await sha256Hex(token), user.id, email, now, now + CHANGE_TTL),
  ]);
  const s = await getInstanceSettings(env.DB);
  const sent = await sendMail(env, s, email, {
    subject: `Confirm your new email for ${env.RP_NAME}`,
    heading: "Confirm your new email",
    paragraphs: [
      `${user.name} asked to use this address for ${env.RP_NAME}. Apps you sign in to will see it as your email.`,
      "The link works once and expires in 1 hour.",
    ],
    button: { label: "Confirm this address", url: `${env.ISSUER}/account/email/confirm#${token}` },
  });
  if (!sent.ok) throw new OpError(`The confirmation email didn't go out: ${sent.error}`);
  await audit(env.DB, "EMAIL_CHANGE_REQUESTED", { userId: user.id });
  return email;
}

export async function confirmEmailChange(env: Env, token: string): Promise<User> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new OpError("This link isn't valid.");
  const row = await env.DB.prepare(
    "DELETE FROM email_changes WHERE token_hash = ?1 AND expires_at >= ?2 RETURNING user_id, new_email",
  )
    .bind(await sha256Hex(token), nowSec())
    .first<{ user_id: string; new_email: string }>();
  if (!row) throw new OpError("This link was already used or has expired.");
  const user = await getUser(env.DB, row.user_id);
  if (!user || user.disabled) throw new OpError("This link isn't valid.");
  if (await addressTaken(env.DB, row.new_email, user.id))
    throw new OpError("That email is already in use.");
  await env.DB.prepare("UPDATE users SET email = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(row.new_email, nowSec(), user.id)
    .run();
  await audit(env.DB, "EMAIL_CHANGED", {
    userId: user.id,
    detail: { via: "self", from: user.email, to: row.new_email },
  });
  const s = await getInstanceSettings(env.DB);
  await sendMail(env, s, user.email, {
    subject: `Your ${env.RP_NAME} email was changed`,
    heading: "Your email was changed",
    paragraphs: [
      `The email on your ${env.RP_NAME} account is now ${row.new_email}. Apps will see the new address the next time you sign in to them.`,
    ],
    footer: "If this wasn't you, tell your admin right away.",
  });
  return { ...user, email: row.new_email };
}
