import type { Env } from "./config";
import { audit, setSetting } from "./db";
import { ALERT_GROUPS, sendWebhook, WEBHOOK_FORMATS } from "./notify";
import type { Webhook } from "./notify";
import { outboundUrlProblem } from "./outbound";
import { by, OpError } from "./ops-core";
import type { Actor } from "./ops-core";
import { invalidateSettingsCache, SETTING_KEYS } from "./settings-cache";
import { newId, nowSec, randomToken } from "./util";

const KNOWN = new Set(ALERT_GROUPS.flatMap((g) => g.events));

export async function setAlerts(
  db: D1Database,
  input: { events: string[]; emailAdmins: boolean; userNotices: boolean },
  a: Actor,
): Promise<void> {
  const events = [...new Set(input.events.filter((e) => KNOWN.has(e)))];
  await setSetting(db, SETTING_KEYS.alertEvents, JSON.stringify(events));
  await setSetting(db, SETTING_KEYS.alertEmailAdmins, input.emailAdmins ? "1" : "0");
  await setSetting(db, SETTING_KEYS.userNotices, input.userNotices ? "1" : "0");
  invalidateSettingsCache();
  await audit(db, "SETTINGS_CHANGED", {
    userId: a.adminId,
    detail: by(a, { alerts: events.length, emailAdmins: input.emailAdmins }),
  });
}

export async function addWebhook(
  env: Env,
  input: { name: string; url: string; format: string; sign: boolean },
  a: Actor,
): Promise<string> {
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 60) || "Webhook";
  const url = input.url.trim();
  const problem = outboundUrlProblem(url, env.ISSUER);
  if (problem) throw new OpError(problem);
  const format = WEBHOOK_FORMATS.find((f) => f === input.format);
  if (!format) throw new OpError("Pick a format.");
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO webhooks (id, name, url, format, secret, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, name, url, format, input.sign ? randomToken(32) : null, nowSec())
    .run();
  await audit(env.DB, "WEBHOOK_ADDED", {
    userId: a.adminId,
    detail: by(a, { name, host: new URL(url).host, format }),
  });
  return id;
}

export async function deleteWebhook(db: D1Database, id: string, a: Actor): Promise<void> {
  const row = await db
    .prepare("DELETE FROM webhooks WHERE id = ?1 RETURNING name")
    .bind(id)
    .first<{ name: string }>();
  if (!row) throw new OpError("Webhook not found.");
  await audit(db, "WEBHOOK_REMOVED", { userId: a.adminId, detail: by(a, { name: row.name }) });
}

export async function testWebhook(env: Env, id: string, a: Actor): Promise<string> {
  const hook = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?1")
    .bind(id)
    .first<Webhook>();
  if (!hook) throw new OpError("Webhook not found.");
  const status = await sendWebhook(env, hook, "WEBHOOK_TEST", {
    userId: a.adminId,
    detail: by(a),
  });
  if (!/^2\d\d$/.test(status)) throw new OpError(`The test didn't go through: ${status}.`);
  return status;
}
