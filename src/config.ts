export interface Env {
  DB: D1Database;
  ISSUER: string;
  RP_NAME: string;
  SIGNING_KEY_JWK: string;
  SETUP_TOKEN?: string;
  UPSTREAM_REPO?: string;
  SENTRY_DSN?: string;
  LOADER?: WorkerLoader;
  SIGNING_KEY_JWK_PREVIOUS?: string;
  AUTH_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

export function isLocalIssuer(issuer: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(issuer);
}

export function assertConfigured(env: Env): void {
  for (const key of ["ISSUER", "RP_NAME", "SIGNING_KEY_JWK"] as const) {
    const v = env[key];
    if (!v || v.includes("REPLACE")) {
      throw new Error(`identity: ${key} is not configured (see DEPLOY.md)`);
    }
  }
  if (!/^https:\/\/[^/]+$/.test(env.ISSUER) && !isLocalIssuer(env.ISSUER)) {
    throw new Error("identity: ISSUER must be an https origin with no path");
  }
}
