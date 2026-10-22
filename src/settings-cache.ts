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
  dcrEnabled: boolean;
  cimdEnabled: boolean;
  emailEnabled: boolean;
  emailFrom: string | null;
  emailFromName: string | null;
}

export const SETTING_KEYS = {
  accent: "accent",
  name: "instance_name",
  cfApiToken: "cf_api_token",
  cfAccountId: "cf_account_id",
  adminStepUp: "admin_step_up",
  signInUv: "sign_in_uv",
  dcrEnabled: "dcr_enabled",
  cimdEnabled: "cimd_enabled",
  emailEnabled: "email_enabled",
  emailFrom: "email_from",
  emailFromName: "email_from_name",
} as const;

export function oneOf<T extends string>(list: readonly T[], v: string | null, fallback: T): T {
  return list.find((x) => x === v) ?? fallback;
}

const TTL_MS = 10_000;
let cache: { value: InstanceSettings; at: number } | null = null;

function parseSettings(rows: { key: string; value: string }[]): InstanceSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (k: string) => map.get(k) || null;
  const flag = (k: string, fallback: boolean) => (map.has(k) ? map.get(k) === "1" : fallback);
  const K = SETTING_KEYS;
  return {
    accent: oneOf(ACCENTS, get(K.accent), "indigo"),
    name: get(K.name),
    cfApiToken: get(K.cfApiToken),
    cfAccountId: get(K.cfAccountId),
    adminStepUp: oneOf(STEP_UP_WINDOWS, get(K.adminStepUp), "5"),
    signInUv: oneOf(SIGN_IN_UV, get(K.signInUv), "required"),
    dcrEnabled: flag(K.dcrEnabled, true),
    cimdEnabled: flag(K.cimdEnabled, true),
    emailEnabled: flag(K.emailEnabled, false),
    emailFrom: get(K.emailFrom),
    emailFromName: get(K.emailFromName),
  };
}

export async function getInstanceSettings(db: D1Database): Promise<InstanceSettings> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const { results } = await db
    .prepare("SELECT key, value FROM instance_settings")
    .all<{ key: string; value: string }>();
  const value = parseSettings(results);
  cache = { value, at: now };
  return value;
}

export async function getAccent(env: { DB: D1Database }): Promise<string> {
  return (await getInstanceSettings(env.DB)).accent;
}

export function invalidateSettingsCache(): void {
  cache = null;
}
