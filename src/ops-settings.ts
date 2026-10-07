import { audit, deleteSettings, setSetting } from "./db";
import { detectAccountId, verifyAccessRead } from "./cf-access";
import { by, OpError } from "./ops-core";
import type { Actor } from "./ops-core";
import { invalidateSettingsCache, SETTING_KEYS } from "./settings-cache";

const NAME_MAX = 60;
const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

export async function setInstanceName(db: D1Database, raw: string, a: Actor): Promise<string> {
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw new OpError("Give the instance a name.");
  if (name.length > NAME_MAX)
    throw new OpError(`Keep the name to ${NAME_MAX} characters or fewer.`);
  if (/\p{Cc}/u.test(name)) throw new OpError("The name can't contain control characters.");
  await setSetting(db, SETTING_KEYS.name, name);
  invalidateSettingsCache();
  await audit(db, "SETTINGS_CHANGED", { userId: a.adminId, detail: by(a, { name }) });
  return name;
}

export async function connectCloudflare(
  db: D1Database,
  input: { token: string; accountId: string },
  a: Actor,
): Promise<string> {
  const token = input.token.trim();
  const given = input.accountId.trim().toLowerCase();
  if (!TOKEN_RE.test(token))
    throw new OpError("Paste the API token exactly as Cloudflare shows it.");
  if (given && !ACCOUNT_RE.test(given)) {
    throw new OpError("An account ID is 32 hex characters (dashboard URL or account overview).");
  }
  let accountId = given;
  try {
    accountId ||= await detectAccountId(token);
    await verifyAccessRead({ token, accountId });
  } catch (e) {
    throw new OpError(
      `Cloudflare rejected this: ${e instanceof Error ? e.message : "unknown error"}.`,
      {
        cause: e,
      },
    );
  }
  await setSetting(db, SETTING_KEYS.cfApiToken, token);
  await setSetting(db, SETTING_KEYS.cfAccountId, accountId);
  invalidateSettingsCache();
  await audit(db, "CF_API_CONNECTED", { userId: a.adminId, detail: by(a, { accountId }) });
  return accountId;
}

export async function disconnectCloudflare(db: D1Database, a: Actor): Promise<void> {
  await deleteSettings(db, [SETTING_KEYS.cfApiToken, SETTING_KEYS.cfAccountId]);
  invalidateSettingsCache();
  await audit(db, "CF_API_DISCONNECTED", { userId: a.adminId, detail: by(a) });
}
