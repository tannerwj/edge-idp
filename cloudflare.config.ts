import { bindings, defineConfig, triggers } from "cf/config";

/**
 * edge-idp — Cloudflare Workers + D1. Deployed with the `cf` CLI
 * (`npm run deploy` → `cf deploy`).
 *
 * PORTABILITY: accountId, the per-stage values below (ISSUER, D1 id, route)
 * and RP_NAME are this instance's values. Forks replace them (see DEPLOY.md).
 *
 * accountId pins every cf command in this repo to the personal account: with
 * a directory-bound auth profile (`cf auth activate`), a command can never land
 * in another account — it fails instead of falling back.
 *
 * Stages: the default mode is production. `--mode staging` deploys a separate
 * Worker on workers.dev with its own D1, so the e2e suite can run against real
 * Cloudflare without touching production data (`npm run staging:*`).
 *
 * Secrets (set with `cf workers secrets update <NAME>`, never committed):
 *   SIGNING_KEY_JWK          RS256 private JWK (node scripts/gen-key.mjs)
 *   SIGNING_KEY_JWK_PREVIOUS optional, during a key rotation
 *   SENTRY_DSN               optional error tracking
 *   CF_API_TOKEN             optional, Access read-only (with CF_ACCOUNT_ID)
 *
 * Local dev (`npm run dev`) reads .dev.vars and keeps D1 in .wrangler/state.
 */
const STAGES = {
  production: {
    name: "identity",
    issuer: "https://auth.johnson.network",
    d1: { name: "identity", id: "832a3094-2375-47b8-aa06-7f146c56eb25" },
    route: { pattern: "auth.johnson.network/*", zone: "johnson.network" },
    previewUrls: true,
    // Rate limit namespace ids are unique per account, so each stage has its own.
    limiters: { auth: "1001", api: "1002" },
  },
  staging: {
    name: "identity-staging",
    issuer: "https://identity-staging.twj.workers.dev",
    d1: { name: "identity-staging", id: "ec5d745d-3e6d-47d8-aa7f-a6026b3a2f5e" },
    route: null,
    // Version preview URLs are a different host than ISSUER, so passkeys
    // (RP ID) would not work there anyway.
    previewUrls: false,
    limiters: { auth: "2001", api: "2002" },
  },
} as const;

export default defineConfig(({ mode }) => {
  const stage = mode === "staging" ? STAGES.staging : STAGES.production;
  return {
    accountId: "83c27d7f9b8764a53148888203d434cb",
    worker: {
      name: stage.name,
      compatibilityDate: "2026-10-06",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint: "src/index.tsx",
      observability: { enabled: true },
      // Production matches the live setup: zone route on johnson.network,
      // workers.dev on. Staging lives on workers.dev only.
      workersDev: true,
      previewUrls: stage.previewUrls,
      triggers: [
        ...(stage.route ? [triggers.fetch(stage.route)] : []),
        // Hourly maintenance: expired rows, audit retention, unused DCR clients.
        triggers.scheduled({ schedule: "17 * * * *" }),
      ],
      env: {
        // Public base URL; no trailing slash. WebAuthn RP ID is derived from it.
        ISSUER: bindings.text(stage.issuer),
        RP_NAME: bindings.text("Johnson ID"),
        SIGNING_KEY_JWK: bindings.secret(),
        DB: bindings.d1(stage.d1),
        // Per-IP Workers Rate Limiting. Generous on purpose: Claude's connector
        // egress (160.79.104.0/21) shares IPs across many users.
        AUTH_LIMITER: bindings.rateLimit({ namespace: stage.limiters.auth, simple: { limit: 30, period: 60 } }),
        API_LIMITER: bindings.rateLimit({ namespace: stage.limiters.api, simple: { limit: 300, period: 60 } }),
        // Dynamic Worker loader for the MCP code-mode sandbox.
        LOADER: bindings.workerLoader(),
      },
    },
  };
});
