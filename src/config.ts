/**
 * Instance configuration. Everything instance-specific lives in the Worker
 * config (cloudflare.config.ts, or wrangler.jsonc for one-click installs),
 * secrets and D1 — never hardcoded in source (portability requirement).
 *
 * ISSUER, RP_NAME and SIGNING_KEY_JWK may be unset at deploy time; they're
 * resolved per request before any handler runs (see instance.ts).
 */
export interface Env {
  DB: D1Database;
  /** Public base URL, e.g. https://auth.example.com. No trailing slash. */
  ISSUER: string;
  /** Human name shown on sign-in / enrollment pages. */
  RP_NAME: string;
  /** Secret: RS256 private key as a JSON JWK string. */
  SIGNING_KEY_JWK: string;
  /**
   * Required for portable installs: generated 32-byte base64url secret.
   * Authorizes first-run /setup and encrypts the generated D1 signing key.
   * Keep it after setup and back it up separately from D1.
   */
  SETUP_TOKEN?: string;
  /**
   * Optional: "owner/repo" for feedback links and the daily update check
   * (default: the upstream project), or "off". See upstream.ts.
   */
  UPSTREAM_REPO?: string;
  /** Optional: Sentry DSN for error tracking. */
  SENTRY_DSN?: string;
  /** Dynamic Worker loader for the MCP code-mode sandbox. */
  LOADER?: WorkerLoader;
  /**
   * Optional: previous RS256 private JWK, published in JWKS (never used to
   * sign) so tokens minted before a key rotation keep verifying until they
   * expire. See DEPLOY.md "Rotating the signing key".
   */
  SIGNING_KEY_JWK_PREVIOUS?: string;
  /** Optional Workers Rate Limiting bindings (see cloudflare.config.ts). */
  AUTH_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;
  /**
   * Optional Cloudflare Access integration. When both are set, the admin UI
   * can import Access apps into the launcher and show their policies.
   */
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

/** True for local development origins (http://localhost / 127.0.0.1). */
export function isLocalIssuer(issuer: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(issuer);
}

/** Fail closed at the edge: refuse to serve if instance config is missing. */
export function assertConfigured(env: Env): void {
  for (const key of ["ISSUER", "RP_NAME", "SIGNING_KEY_JWK"] as const) {
    const v = env[key];
    if (!v || v.includes("REPLACE")) {
      throw new Error(`identity: ${key} is not configured (see DEPLOY.md)`);
    }
  }
  // https everywhere, except plain-http localhost for `cf dev` (WebAuthn
  // treats localhost as a secure context, so passkeys still work there).
  if (!/^https:\/\/[^/]+$/.test(env.ISSUER) && !isLocalIssuer(env.ISSUER)) {
    throw new Error("identity: ISSUER must be an https origin with no path");
  }
}
