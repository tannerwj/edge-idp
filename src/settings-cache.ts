export const ACCENTS = [
  "indigo",
  "iris",
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "graphite",
] as const;

export interface InstanceSettings {
  accent: string;
  name: string | null;
  cfApiToken: string | null;
  cfAccountId: string | null;
}

const KEYS = {
  accent: "accent",
  name: "instance_name",
  cfApiToken: "cf_api_token",
  cfAccountId: "cf_account_id",
} as const;

export const SETTING_KEYS = KEYS;

const TTL_MS = 60_000;
let cache: { value: InstanceSettings; at: number } | null = null;

export async function getInstanceSettings(db: D1Database): Promise<InstanceSettings> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const { results } = await db
    .prepare("SELECT key, value FROM instance_settings WHERE key IN (?1, ?2, ?3, ?4)")
    .bind(KEYS.accent, KEYS.name, KEYS.cfApiToken, KEYS.cfAccountId)
    .all<{ key: string; value: string }>();
  const get = (k: string) => results.find((r) => r.key === k)?.value || null;
  const accent = get(KEYS.accent) ?? "indigo";
  const value: InstanceSettings = {
    accent: (ACCENTS as readonly string[]).includes(accent) ? accent : "indigo",
    name: get(KEYS.name),
    cfApiToken: get(KEYS.cfApiToken),
    cfAccountId: get(KEYS.cfAccountId),
  };
  cache = { value, at: now };
  return value;
}

export async function getAccent(env: { DB: D1Database }): Promise<string> {
  return (await getInstanceSettings(env.DB)).accent;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
