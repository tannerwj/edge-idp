/**
 * Instance configuration. Everything instance-specific lives in wrangler.toml
 * [vars] / secrets / D1 — never hardcoded in source (portability requirement).
 */
export interface Env {
  DB: D1Database;
  /** Public base URL, e.g. https://auth.example.com. No trailing slash. */
  ISSUER: string;
  /** Human name shown on sign-in / enrollment pages. */
  RP_NAME: string;
  /** Secret: RS256 private key as a JSON JWK string. */
  SIGNING_KEY_JWK: string;
}

/** Fail closed at the edge: refuse to serve if instance config is missing. */
export function assertConfigured(env: Env): void {
  for (const key of ["ISSUER", "RP_NAME", "SIGNING_KEY_JWK"] as const) {
    const v = env[key];
    if (!v || v.includes("REPLACE")) {
      throw new Error(`identity: ${key} is not configured (see DEPLOY.md)`);
    }
  }
  if (!/^https:\/\/[^/]+$/.test(env.ISSUER)) {
    throw new Error("identity: ISSUER must be an https origin with no path");
  }
}
