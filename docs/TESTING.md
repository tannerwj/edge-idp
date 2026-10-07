# Testing

End-to-end tests are the primary check: they boot a real Worker with a real
D1 database and drive real passkey ceremonies through a virtual
authenticator. Unit tests exist only for parsers and small algorithms. Mocks
are used only at the network and process edges.

Code references use the form `tests/file.mjs › section`. The behavior these
suites protect is explained in [THREAT_MODEL.md](THREAT_MODEL.md) and
[ARCHITECTURE.md](ARCHITECTURE.md).

## Before you commit

```bash
npm run typecheck && npm run gates
npm test
npm run test:e2e
```

Add `npm run test:e2e:setup` and `npm run test:security` when you touch setup,
instance resolution (`src/instance.ts`, `src/setup.tsx`) or anything
security-related. CI runs only typecheck, `typecheck:e2e`, `fmt:check`, unit
tests and gates; the e2e suites need a local `cf`/`wrangler` runtime and a
browser, so run them yourself.

## Prerequisites

- `npm install`.
- Chromium for Playwright, once: `npx playwright install chromium`. Needed by
  `full.mjs`, `setup.mjs` and `tests/security/no-user-verification.mjs`.
- No Cloudflare login is needed for local suites: `cf dev` and `wrangler dev`
  run the Worker and D1 locally. `test:e2e:staging` and `npm run smoke` hit a
  deployed Worker; staging also needs a `cf` login scoped to the repo (see
  DEPLOY.md › 2) because it resets the staging database.
- Network access for the CIMD step in `full.mjs`, unless `E2E_OFFLINE=1`.

## Suites

| Command                    | What it runs                                  | Target                              |
| -------------------------- | --------------------------------------------- | ----------------------------------- |
| `npm test`                 | `tests/unit.test.ts` (vitest)                 | none                                |
| `npm run test:e2e`         | `tests/e2e/full.mjs`, then `api.mjs`          | throwaway local (`cf dev`)          |
| `npm run test:e2e:setup`   | `tests/e2e/setup.mjs`                         | throwaway portable (`wrangler dev`) |
| `npm run test:security`    | each `tests/security/*.mjs`                   | throwaway local or portable         |
| `npm run test:e2e:staging` | `tests/e2e/full.mjs` with `E2E_STAGE=staging` | deployed staging Worker             |
| `npm run smoke`            | `tests/smoke/**/*.e2e.ts`                     | any deployed instance               |

Every script prints `ok` / `FAIL` lines and exits non-zero on any failure.

### Unit (`npm test`)

Vitest with `environment: "node"`, including only `tests/unit.test.ts`. It
covers base64url, `sha256Hex`, `timingSafeEqualHex`, `rpIdFromIssuer`,
`emailKey` and the upstream `newerVersion` comparison (`vitest.config.ts`).

The `newerVersion` expected values were worked out by hand from MAJOR.MINOR.PATCH
ordering, not by running the code: numeric (not lexical) comparison, major
then minor then patch, equal is not newer, pre-release and build suffixes are
ignored, and anything that isn't a full three-part version never reports an
update.

### Full flow (`tests/e2e/full.mjs`)

The main suite. It boots a throwaway `cf dev` instance on a random port in
8790–8889 with `http://localhost:<port>` as the issuer (localhost is a secure
context, so WebAuthn works over plain http), then drives Chromium with a
virtual authenticator through:

- seeding an admin, then enrollment and passkey sign-in;
- the step-up requirement for credential changes;
- the admin UI;
- the same-origin guard;
- the OIDC authorization code flow, `prompt` and `max_age`;
- the regression that app tokens can't drive the admin API;
- MCP discovery, MCP via dynamic client registration (Cursor/Claude Code
  style), including code mode;
- refresh token rotation and reuse detection, and revoking consent;
- API tokens;
- CIMD, using Claude Code's real metadata document;
- the audit trail, the maintenance cron, and the feedback and update notice.

### OIDC API (`tests/e2e/api.mjs`)

Runs as the second half of `npm run test:e2e`. It needs no browser: it boots a
local instance on fixed port 18877, seeds a user, a confidential client, a
session and a `family` group straight into D1, then checks discovery, JWKS,
`/authorize` validation, the full code flow (PKCE mismatch, wrong secret, code
reuse), the ID token signature and claims, `/userinfo`, and a confidential
client with `require_pkce = 0`. Because the port is fixed, don't run two
copies at once.

### One-click install (`npm run test:e2e:setup`)

Runs the `wrangler.jsonc` template exactly as the Deploy to Cloudflare button
ships it (no `ISSUER`, no signing key, no users, only `SETUP_TOKEN`) with
`wrangler dev`, from a temp copy without `cloudflare.config.ts`. It checks
that:

- the issuer is derived from the host;
- the signing key is generated once, stored in D1, and stable across requests
  and restarts;
- `/login` sends a fresh install to `/setup`;
- a wrong token gets 401 and creates no user, and a cross-origin setup POST is
  refused;
- the right token leads to passkey enrollment and an admin account;
- `/setup` is gone (GET and POST) once a user exists, and setup is audited;
- there is no `execute` MCP tool without a Worker Loader; after a restart
  with one added, the signing key is unchanged and `execute` works and uses
  the derived issuer;
- an initialized database without its issuer pin fails closed (`/healthz` 500) and recovers when the pin is restored.

### Security regressions (`npm run test:security`)

Runs each `tests/security/*.mjs` script in turn and stops at the first
failure. They come from the October 2026 security review.

| Script                     | Instance        | What it proves                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d1-read-forgery.mjs`      | portable        | Read access to D1 alone can't reveal the generated signing key: `signing_keys.current` starts with `enc:v1:` and has no private `"d"` member, and JWKS exposes exactly one key. It prints no key or token.                                                                                                                                                                       |
| `first-run-failure.mjs`    | portable        | If a dependency fails after the first-admin insert (simulated by dropping `audit_log`), the setup POST returns 500, no users or enrollment tokens remain, and `/setup` stays open.                                                                                                                                                                                               |
| `no-user-verification.mjs` | local, Chromium | An authenticator without user verification can't enroll: options demand `userVerification: "required"`, the enrollment page shows an error, and no credential is stored.                                                                                                                                                                                                         |
| `token-boundaries.mjs`     | local           | A code or refresh token presented by the wrong client is rejected without being consumed; a group-restricted client's refresh is denied and its family revoked after the user leaves the group; an `offline_access`-only access token is rejected by `/userinfo` and carries no email; a read-only API token can't write through `execute`; the sandbox has no outbound network. |

"Local" means `startLocal` (`cf dev`, `cloudflare.config.ts`); "portable"
means `startPortable` (`wrangler dev`, `wrangler.jsonc`).

### Staging (`npm run test:e2e:staging`)

Runs `full.mjs` against the deployed `identity-staging` Worker, exercising
real D1, rate limiters, the sandbox loader and the edge. It wipes staging data
first and refuses any other stage. `api.mjs` is local-only and not part of
this run. The maintenance-cron step uses the local-only
`/cdn-cgi/local/scheduled` trigger, so it is skipped on staging. Deploy
staging first (`npm run staging:deploy`); see DEPLOY.md › Staging.

### Smoke (`npm run smoke`)

Read-only checks against a deployed instance, run by the `e2e` runner
(tester-army) with a single node "api" target (`e2e.config.ts`). It covers
discovery and OAuth metadata, admin routes failing closed, cross-origin form
posts, and asset caching.

- `npm run smoke` checks production, using the issuer from
  `cloudflare.config.ts`.
- `npm run smoke -- --stage=staging` checks staging.
- `E2E_BASE_URL=https://… npm run smoke` checks any URL.

The tests read the target from `E2E_BASE_URL` and throw without it, so always
go through `npm run smoke` (`scripts/smoke.mjs`). Runner telemetry is
disabled.

## Environment variables

| Variable       | Effect                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_STAGE`    | `staging` makes `full.mjs` use the remote staging Worker instead of a local instance.                                                               |
| `E2E_OFFLINE`  | Skips the CIMD step (it fetches `https://claude.ai/oauth/claude-code-client-metadata`) and the assertion that the cron recorded upstream's version. |
| `E2E_KEEP`     | Keeps a local instance's temp project directory after the run, for debugging.                                                                       |
| `E2E_BASE_URL` | The smoke target. Set by `scripts/smoke.mjs`.                                                                                                       |

## Harness (`tests/e2e/instances.mjs`)

Each suite gets its own throwaway instance, so tests never touch your
`.dev.vars` or local database and leave nothing behind.

- **`startLocal`** and **`startPortable`** build a temp project copy:
  `src`, `migrations`, `node_modules` and `scripts` are symlinked; the config
  file, `package.json` and `tsconfig.json` are copied; and `.dev.vars` is
  written from the given vars. `startLocal` uses `cloudflare.config.ts` with
  `cf dev`, a fresh key from `scripts/gen-key.mjs`, and D1 state in the copy's
  `.wrangler/state`. `startPortable` uses `wrangler.jsonc` with
  `wrangler dev`.
- A server counts as up when `/healthz` answers OK, with a 90-second deadline.
- **`startRemote`** is the staging-only path. It refuses any stage other than
  `staging`, requires `/healthz` to be up (otherwise run
  `npm run staging:deploy`), then deletes every row from every table except
  `d1_migrations`, `instance_settings`, `_cf_*` and `sqlite_*`, with foreign
  keys deferred. Because it deletes data, never point it at production.
- Suites pick random ports in separate ranges (full 8790–8889, setup
  8890–8989, security scripts 9100–10399) so they can run side by side;
  `api.mjs` uses 18877.

## Why the tests do non-obvious things

**Issuer and hosts.**

- `api.mjs` uses its local origin as the issuer because the Worker redirects
  any other host to the issuer (canonical-host rule), and a fake https issuer
  couldn't be served locally.
- `authorizeInBrowser` captures the redirect back to the client by watching
  the browser's outgoing request, because the test client hosts don't exist
  and the request fires before DNS fails. It uses `waitForSelector` rather
  than `page.$` for the consent form, because over a real network the
  previous redirect can commit after `goto` resolves, then waits for `load` so
  the browser has finished failing on the client host before the next step.
- The DCR client registers `http://localhost/callback` and authorizes with
  `http://localhost:53682/callback`, proving the loopback any-port rule.
- MCP code mode re-enters the Worker through the sandbox entrypoint, whose
  `env` is the raw one, so `full.mjs` checks that an invite link created
  inside `execute` still uses this instance's issuer. `setup.mjs` repeats the
  check on an install with no `ISSUER` set.

**Passkey autofill races.**

- With a virtual authenticator, conditional mediation (passkey autofill) may
  complete sign-in on its own before the passkey button is clicked, which is
  the real behavior on a device with one passkey. The tests click the button
  with a short timeout and ignore a failed click; either path is fine.
- The `prompt=login` check runs in a separate tab and closes it afterwards.
  The sign-in page arms autofill, which the virtual authenticator completes
  and redirects away from; closing the tab cancels it so it can't race the
  next step.

**Tokens and codes.**

- A failed client-authentication or PKCE attempt must not burn the
  authorization code. `api.mjs` redeems the same code with the right verifier
  after a PKCE mismatch, and `token-boundaries.mjs` does the same after a
  wrong-client attempt.
- `api.mjs` verifies the ID token signature against the live `/jwks` with
  `jose`: real crypto, no mocks.
- The code-reuse check in `api.mjs` authenticates with `client_secret_post`
  and asserts rejection, so on its own it doesn't prove `client_secret_post`
  succeeds.
- Confidential clients may omit PKCE; the database stores that as an empty
  `code_challenge`. `token-boundaries.mjs` seeds such a code directly, while
  the browser flows always use PKCE.

**Expected server errors.** Both browser suites fail if the server log
contains `ERROR` or `Uncaught`, except for known lines:

- `full.mjs` allows "execute is not available inside execute": the recursion
  check makes the sandbox RPC throw on purpose and workerd logs it
  (`EXPECTED_ERRORS`).
- `setup.mjs` allows "existing installation needs an explicit ISSUER before
  upgrade": it deletes the issuer pin on purpose to prove that an initialized
  portable database without a pin fails closed (`/healthz` 500), then
  restores it (`unexpectedLogErrors`).

**Template coupling.** `setup.mjs` adds the Worker Loader on its second boot
by string-replacing `"triggers": { "crons": ["17 * * * *"] },` in the copied
`wrangler.jsonc`, the template's documented opt-in. If that exact text
changes in the template, the suite throws "couldn't add worker_loaders to the
template".

**Smoke assertions.**

- A 404 on an admin route counts as a broken route. Anonymous requests must
  get a 302 to `/login?next=<path>` (same-origin `next`) so admin content
  never renders. `/admin/` must 301 to `/admin`, and the trailing slash is
  normalized before the auth check.
- Static asset URLs carry `?v=<10-hex content hash>`; assets are `immutable`
  and HTML is `no-store`.
- claude.ai only uses Client ID Metadata Documents when the metadata has both
  `client_id_metadata_document_supported: true` and `none` in
  `token_endpoint_auth_methods_supported`, so both are asserted.
- `/authorize` with an unknown client or unregistered redirect URI must fail
  as a 400 page, never a redirect. The unregistered-redirect check uses a
  client id that doesn't exist, so it hits `invalid_client` first; its only
  point is that nothing ever redirects to `evil.test`.
- A sibling subdomain counts as same-site, so `SameSite=Lax` alone would let
  it post forms here; the same-origin guard must refuse such a POST with 403
  before any handler runs (also checked in `full.mjs › same-origin guard`).
