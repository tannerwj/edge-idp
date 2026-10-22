import type { Env } from "./config";
import { audit } from "./db";
import { sendMail, emailStatus } from "./email";
import type { MailContent } from "./email";
import { by, EMAIL_RE, OpError } from "./ops-core";
import type { Actor } from "./ops-core";
import { getInstanceSettings } from "./settings-cache";
import { nowSec } from "./util";

export type LinkKind = "invite" | "relink" | "recovery";

export type Delivery = { emailed: true } | { emailed: false; error?: string };

export function linkMail(rpName: string, name: string, link: string, kind: LinkKind): MailContent {
  const first = name.split(" ")[0] ?? name;
  if (kind === "invite")
    return {
      subject: `You're invited to ${rpName}`,
      heading: `Hi ${first}, you're invited`,
      paragraphs: [
        `${rpName} uses passkeys instead of passwords: Face ID, Touch ID, Windows Hello or a security key. Set yours up with the button below.`,
        "The link works once and expires in 7 days.",
      ],
      button: { label: "Set up my passkey", url: link },
      footer: "If you weren't expecting this invite, you can ignore it.",
    };
  return {
    subject: `Add a passkey to your ${rpName} account`,
    heading: `Hi ${first}`,
    paragraphs: [
      kind === "recovery"
        ? `You asked for help signing in to ${rpName}. Use the button below to set up a new passkey on this device.`
        : `An admin sent you a new link to set up a passkey for ${rpName}.`,
      kind === "recovery"
        ? "The link works once and expires in 1 hour. Your other passkeys keep working."
        : "The link works once and expires in 7 days.",
    ],
    button: { label: "Set up a passkey", url: link },
    footer:
      "If you didn't ask for this, tell your admin: someone may be trying to get into your account.",
  };
}

export async function deliverLink(
  env: Env,
  user: { name: string; email: string; public: number },
  link: string,
  kind: LinkKind,
): Promise<Delivery> {
  if (user.public) return { emailed: false, error: "This account has no email address." };
  const s = await getInstanceSettings(env.DB);
  if (emailStatus(env, s) !== "ready") return { emailed: false };
  const r = await sendMail(env, s, user.email, linkMail(env.RP_NAME, user.name, link, kind));
  return r.ok ? { emailed: true } : { emailed: false, error: r.error };
}

export interface PendingInvite {
  id: string;
  name: string;
  email: string;
  sent_at: number;
  expires_at: number;
}

export async function pendingInvites(db: D1Database): Promise<PendingInvite[]> {
  const { results } = await db
    .prepare(
      `SELECT u.id, u.name, u.email, MAX(t.created_at) AS sent_at, MAX(t.expires_at) AS expires_at
       FROM enrollment_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.used = 0 AND t.expires_at >= ?1
       GROUP BY u.id ORDER BY sent_at DESC`,
    )
    .bind(nowSec())
    .all<PendingInvite>();
  return results;
}

export async function revokeInvites(db: D1Database, userId: string, a: Actor): Promise<number> {
  const r = await db
    .prepare("DELETE FROM enrollment_tokens WHERE user_id = ?1 AND used = 0")
    .bind(userId)
    .run();
  if (r.meta.changes)
    await audit(db, "ENROLLMENT_REVOKED", { userId, detail: by(a, { links: r.meta.changes }) });
  return r.meta.changes;
}

export interface BulkLine {
  name: string;
  email: string;
}

export function parseBulk(text: string): { people: BulkLine[]; errors: string[] } {
  const people: BulkLine[] = [];
  const errors: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const angled = line.match(/^(.*?)\s*<([^>]+)>$/);
    const parts = angled
      ? [angled[2] ?? "", angled[1] ?? ""]
      : line.split(/[,;\t]/).map((p) => p.trim());
    const email = (parts.find((p) => EMAIL_RE.test(p)) ?? "").trim();
    const name =
      parts.find((p) => p && p !== email)?.replace(/^"|"$/g, "") ||
      (email.split("@")[0] ?? "").replace(/[._-]+/g, " ");
    if (!email) errors.push(`No email address in "${line.slice(0, 80)}"`);
    else people.push({ name: name.trim() || email, email });
  }
  if (people.length > 50) throw new OpError("Invite at most 50 people at a time.");
  return { people, errors };
}
