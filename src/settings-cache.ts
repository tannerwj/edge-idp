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

export const STEP_UP_WINDOWS = ["5", "15", "60", "off"] as const;
export type StepUpWindow = (typeof STEP_UP_WINDOWS)[number];
export const SIGN_IN_UV = ["required", "discouraged"] as const;
export type SignInUv = (typeof SIGN_IN_UV)[number];

export interface InstanceSettings {
  accent: string;
  name: string | null;
  cfApiToken: string | null;
  cfAccountId: string | null;
  adminStepUp: StepUpWindow;
  signInUv: SignInUv;
}

const KEYS = {
  accent: "accent",
  name: "instance_name",
  cfApiToken: "cf_api_token",
  cfAccountId: "cf_account_id",
  adminStepUp: "admin_step_up",
  signInUv: "sign_in_uv",
} as const;

function oneOf<T extends string>(list: readonly T[], v: string | null, fallback: T): T {
  return list.find((x) => x === v) ?? fallback;
}

export const SETTING_KEYS = KEYS;

const TTL_MS = 10_000;
let cache: { value: InstanceSettings; at: number } | null = null;

export async function getInstanceSettings(db: D1Database): Promise<InstanceSettings> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const { results } = await db
    .prepare("SELECT key, value FROM instance_settings WHERE key IN (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(
      KEYS.accent,
      KEYS.name,
      KEYS.cfApiToken,
      KEYS.cfAccountId,
      KEYS.adminStepUp,
      KEYS.signInUv,
    )
    .all<{ key: string; value: string }>();
  const get = (k: string) => results.find((r) => r.key === k)?.value || null;
  const accent = get(KEYS.accent) ?? "indigo";
  const value: InstanceSettings = {
    accent: (ACCENTS as readonly string[]).includes(accent) ? accent : "indigo",
    name: get(KEYS.name),
    cfApiToken: get(KEYS.cfApiToken),
    cfAccountId: get(KEYS.cfAccountId),
    adminStepUp: oneOf(STEP_UP_WINDOWS, get(KEYS.adminStepUp), "5"),
    signInUv: oneOf(SIGN_IN_UV, get(KEYS.signInUv), "required"),
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
