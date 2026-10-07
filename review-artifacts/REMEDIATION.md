# Security review remediation

This branch addresses the confirmed findings in `REVIEW.md`, which describes
the original `master` commit `89481cc3`. Validation below is local only. No
production or staging database, Worker, secret, route, or account setting was
changed. A push of this branch is not a deployment.

| Baseline finding | Change | Local regression |
|---|---|---|
| C1: portable D1 read yields signing key | Generate a unique key ID; encrypt the D1 JWK with AES-GCM under the generated, long-lived `SETUP_TOKEN` Worker secret. Re-read D1 on each request and fail closed for legacy plaintext/corrupt rows. | `d1-read-forgery.mjs`, `test:e2e:setup`, `performance-portable.mjs` |
| C2: group removal does not stop refresh | Recheck current client group/admin eligibility at code and refresh redemption; revoke ineligible refresh families. | `token-boundaries.mjs` |
| C3: access tokens/UserInfo over-disclose | Scope-gate access-token claims; require `openid` and client audience at UserInfo; return only scope-granted claims. | `token-boundaries.mjs`, `test:e2e:local` |
| C4: no WebAuthn user verification | Require UV at registration and authentication, and a fresh assertion in the same session before credential changes. | `no-user-verification.mjs`, `test:e2e:local` |
| C5: wrong client burns a grant | Validate client, redirect and PKCE before atomic code consumption; bind refresh rotation/replay to its client. | `token-boundaries.mjs` |
| C6: partial first-admin setup | Commit admin, enrollment, audit and issuer pin in one D1 transaction. | `first-run-failure.mjs`, `test:e2e:setup` |

Additional changes: fragment-based enrollment links; portable issuer pin and
alias handling; fail-closed setup/registration without an auth limiter; rate
limit `/authorize`; bounded CIMD/DCR/upstream input; atomic WebAuthn challenge
consumption; sandbox CPU/subrequest/tool/log/output budgets; D1 indexes and
lower query fan-out; safer local E2E defaults; dependency upgrades. Existing
path-based enrollment links remain valid until expiry, so replace any
outstanding link that may have appeared in logs.

## Validation

- Passed: `npm run test:e2e:local`, `npm run test:e2e:setup`,
  `node review-artifacts/token-boundaries.mjs`,
  `node review-artifacts/first-run-failure.mjs`,
  `node review-artifacts/no-user-verification.mjs`,
  `node review-artifacts/d1-read-forgery.mjs`, `npm test`,
  `npm run typecheck`, `npm run typecheck:e2e`, `npx oxlint --type-aware src`,
  `npm audit --audit-level=low` (zero advisories), reference `deploy:check`,
  and portable Wrangler dry run.
- Local portable baseline after changes: first `/healthz` with key generation
  242.7 ms; five warm `/healthz` samples 2.3–3.4 ms; five warm JWKS samples
  2.1–3.2 ms. This is a small local D1 and is not production latency.
- The repository-wide `npm run gates` and `npm run lint` still fail: lint
  includes Node E2E scripts under Worker rules, deadcode flags the review
  scripts, and the ratchet ceilings do not match the current source tree.
  `npm run fmt:check` also reports broad formatting drift. These checks need
  a separate policy/baseline cleanup; no failing test was removed or weakened.

## Upgrade and remaining validation

Existing portable installs must set an explicit canonical `ISSUER` and rotate
the old plaintext D1 signing key into Worker secrets **before deploying this
code**. Follow `DEPLOY.md` → “Portable signing-key upgrade.” The new code
fails closed on a legacy plaintext row or an initialized database with no
issuer pin. Migrations 0009 and 0010 are additive, but portable Workers Builds
applies migrations before code; back up D1 and rehearse rollback first.

Still unverified: the actual Deploy to Cloudflare wizard and Workers Builds
permission model, real alias/custom-domain routing and passkey transition,
Cloudflare Rate Limiting and Dynamic Worker billing, live rows-read/latency,
and DNS rebinding behavior for CIMD. Use a disposable Cloudflare account or
designated staging installation for those checks. The staging E2E command
clears its database and must not be run against shared staging data.

Static access tokens and ID tokens retain claims until their one-hour expiry
after user or group changes. The `execute` wall-clock race returns after ten
seconds; actual Dynamic Worker cancellation remains platform dependent and
needs cloud validation. Budget changes should be checked against legitimate
MCP workflows in a disposable environment.
