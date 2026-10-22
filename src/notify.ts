import type { Env } from "./config";
import { getClient, getUser, onAudit } from "./db";
import type { AuditOpts } from "./db";
import { emailStatus, sendMail } from "./email";
import type { MailContent } from "./email";
import { postOutbound } from "./outbound";
import { currentScope } from "./request-context";
import { getInstanceSettings } from "./settings-cache";
import type { InstanceSettings } from "./settings-cache";
import { eventMeta } from "./ui/feed";
import { nowSec } from "./util";

export const WEBHOOK_FORMATS = ["json", "discord", "slack", "ntfy"] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export interface Webhook {
  id: string;
  name: string;
  url: string;
  format: WebhookFormat;
  secret: string | null;
  enabled: number;
  created_at: number;
  last_at: number | null;
  last_status: string | null;
}

export const ALERT_GROUPS: { label: string; events: string[] }[] = [
  {
    label: "Security signals",
    events: [
      "REFRESH_REUSE_DETECTED",
      "PASSKEY_COUNTER_REGRESSION",
      "SETUP_REJECTED",
      "ACCESS_DENIED",
      "EMAIL_CHANGED",
      "MAGIC_LINK_SIGN_IN",
    ],
  },
  {
    label: "Privileges and credentials",
    events: [
      "ADMIN_GRANTED",
      "ADMIN_REVOKED",
      "API_TOKEN_CREATED",
      "CLIENT_SECRET_ROTATED",
      "PASSKEYS_REVOKED",
      "SECURITY_SETTINGS_CHANGED",
    ],
  },
  {
    label: "Accounts",
    events: [
      "RECOVERY_REQUESTED",
      "RECOVERY_LINK_SENT",
      "USER_CREATED",
      "USER_SIGNED_UP",
      "USER_DISABLED",
      "USER_DELETED",
      "PASSKEY_REGISTERED",
    ],
  },
  {
    label: "Clients",
    events: ["CLIENT_REGISTERED", "CLIENT_DISCOVERED", "CONSENT_GRANTED"],
  },
];

const USER_NOTICES: Record<
  string,
  (rp: string) => Omit<MailContent, "paragraphs"> & { line: string }
> = {
  PASSKEY_REGISTERED: (rp) => ({
    subject: `A passkey was added to your ${rp} account`,
    heading: "New passkey added",
    line: "A new passkey can now sign in to your account.",
  }),
  PASSKEY_REMOVED: (rp) => ({
    subject: `A passkey was removed from your ${rp} account`,
    heading: "Passkey removed",
    line: "One of your passkeys was removed and can no longer sign in.",
  }),
  PASSKEYS_REVOKED: (rp) => ({
    subject: `Your ${rp} passkeys were reset`,
    heading: "Your passkeys were reset",
    line: "An admin removed all of your passkeys. You'll need a new enrollment link to sign in.",
  }),
  ADMIN_GRANTED: (rp) => ({
    subject: `You're now an admin of ${rp}`,
    heading: "You're an admin now",
    line: "Your account can now manage people, apps and settings.",
  }),
  MAGIC_LINK_SIGN_IN: (rp) => ({
    subject: `You signed in to ${rp} with an email link`,
    heading: "Signed in with an email link",
    line: "Your account was just signed in using a link sent to this address.",
  }),
};

export async function listWebhooks(db: D1Database): Promise<Webhook[]> {
  const { results } = await db
    .prepare("SELECT * FROM webhooks ORDER BY created_at ASC")
    .all<Webhook>();
  return results;
}

interface Described {
  label: string;
  summary: string;
  user: { id: string; name: string; email: string } | null;
}

async function describe(env: Env, event: string, opts: AuditOpts): Promise<Described> {
  const [user, client, actor] = await Promise.all([
    opts.userId ? getUser(env.DB, opts.userId) : null,
    opts.clientId ? getClient(env.DB, opts.clientId) : null,
    typeof opts.detail?.by === "string" && opts.detail.by !== opts.userId
      ? getUser(env.DB, opts.detail.by)
      : null,
  ]);
  const parts = [
    user ? (user.public ? user.name : `${user.name} <${user.email}>`) : null,
    client ? `app: ${client.name}` : null,
    actor ? `by ${actor.name}` : null,
  ].filter(Boolean);
  return {
    label: eventMeta(event).label,
    summary: parts.join(" · ") || "No person or app attached.",
    user: user ? { id: user.id, name: user.name, email: user.public ? "" : user.email } : null,
  };
}

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function webhookBody(
  hook: Webhook,
  env: Env,
  event: string,
  d: Described,
  opts: AuditOpts,
): { body: string; headers: Record<string, string> } {
  const line = `${d.label} · ${d.summary}`;
  if (hook.format === "discord")
    return {
      body: JSON.stringify({ content: `**${env.RP_NAME}**: ${line}` }),
      headers: { "content-type": "application/json" },
    };
  if (hook.format === "slack")
    return {
      body: JSON.stringify({ text: `*${env.RP_NAME}*: ${line}` }),
      headers: { "content-type": "application/json" },
    };
  if (hook.format === "ntfy")
    return {
      body: d.summary,
      headers: { "content-type": "text/plain", title: `${env.RP_NAME}: ${d.label}` },
    };
  return {
    body: JSON.stringify({
      event,
      label: d.label,
      summary: d.summary,
      at: nowSec(),
      instance: env.RP_NAME,
      issuer: env.ISSUER,
      user: d.user,
      client_id: opts.clientId ?? null,
      detail: opts.detail ?? null,
    }),
    headers: { "content-type": "application/json" },
  };
}

export async function sendWebhook(
  env: Env,
  hook: Webhook,
  event: string,
  opts: AuditOpts,
): Promise<string> {
  const d = await describe(env, event, opts);
  const { body, headers } = webhookBody(hook, env, event, d, opts);
  if (hook.secret) headers["x-edge-idp-signature"] = `sha256=${await hmac(hook.secret, body)}`;
  const status = await postOutbound(hook.url, { body, headers });
  await env.DB.prepare("UPDATE webhooks SET last_at = ?1, last_status = ?2 WHERE id = ?3")
    .bind(nowSec(), status, hook.id)
    .run();
  return status;
}

async function emailAdmins(env: Env, s: InstanceSettings, d: Described): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT email FROM users WHERE is_admin = 1 AND disabled = 0 AND public = 0",
  ).all<{ email: string }>();
  for (const a of results)
    await sendMail(env, s, a.email, {
      subject: `[${env.RP_NAME}] ${d.label}`,
      heading: d.label,
      paragraphs: [d.summary],
      button: { label: "Open the audit log", url: `${env.ISSUER}/admin/audit` },
      footer: "You're receiving this because admin alerts are on in Settings › Notifications.",
    });
}

async function noticeUser(env: Env, s: InstanceSettings, event: string, opts: AuditOpts) {
  const make = USER_NOTICES[event];
  if (!make || !opts.userId) return;
  const user = await getUser(env.DB, opts.userId);
  if (!user || user.public || user.disabled) return;
  if (event === "PASSKEY_REGISTERED") {
    const n = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?1",
    )
      .bind(user.id)
      .first<{ n: number }>();
    if ((n?.n ?? 0) <= 1) return;
  }
  const m = make(env.RP_NAME);
  await sendMail(env, s, user.email, {
    subject: m.subject,
    heading: m.heading,
    paragraphs: [m.line, "You can review your passkeys and sessions in Account & security."],
    button: { label: "Account & security", url: `${env.ISSUER}/account` },
    footer: "If this wasn't you or an admin you trust, tell your admin right away.",
  });
}

export async function dispatch(env: Env, event: string, opts: AuditOpts): Promise<void> {
  const s = await getInstanceSettings(env.DB);
  const mail = emailStatus(env, s) === "ready";
  const jobs: Promise<unknown>[] = [];
  if (mail && s.userNotices) jobs.push(noticeUser(env, s, event, opts));
  if (s.alertEvents.includes(event)) {
    if (mail && s.alertEmailAdmins)
      jobs.push(describe(env, event, opts).then((d) => emailAdmins(env, s, d)));
    for (const hook of await listWebhooks(env.DB))
      if (hook.enabled) jobs.push(sendWebhook(env, hook, event, opts));
  }
  await Promise.allSettled(jobs);
}

export function startNotifications(): void {
  onAudit((event, opts) => {
    const scope = currentScope();
    if (scope) scope.wait(dispatch(scope.env, event, opts).catch((e) => console.error(e)));
  });
}
