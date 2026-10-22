# Remediation

Fixes for [REVIEW.md](REVIEW.md), shipped in `2049129` and deployed to
production on 2026-10-21 (Worker version `5f4ff67d`). `review-repro.mjs`
documents the original behavior and now prints `NOT REPRODUCED` (exit 1) for
every line; the regression checks that replace it live in `tests/security/`.

## Security

| Finding | Fix | Regression check |
| --- | --- | --- |
| S1 members assert any email as verified | Email is admin-only; Account & security shows it read-only and saves only the name | `identity-and-admin.mjs` |
| S2 public accounts claim real emails | Same; Make member requires a real email (the placeholder is refused) and stores it | `identity-and-admin.mjs`, `full.mjs` |
| S3 step-up doesn't protect admins | Sensitive admin POSTs and `/authorize` for `mcp`/`mcp:read` need a recent recheck; self enrollment links, resets and removals are refused; window is a setting (5 min default, 15, 60, off) that is itself sensitive to change | `identity-and-admin.mjs`, `full.mjs` (recheck UX) |
| S4 `/end-session` open redirect | Admin-registered clients only; https or loopback origins only, never opaque | `identity-and-admin.mjs` |
| Sandbox call cap bypass | Counted when each call starts | `identity-and-admin.mjs` |
| Registration/sign-up kept the old session | `destroySession` before `createSession` | covered by `full.mjs` flows |
| Legacy `/enroll/:token`, seed-admin path links, overridden `no-referrer` | Route removed; seed-admin prints `/enroll#…` with 32 random bytes; global Referrer-Policy only when unset | `full.mjs`, `identity-and-admin.mjs` |
| ID tokens ignored scopes | Scope-gated for DCR/CIMD clients (admin clients unchanged for Cloudflare Access) | `identity-and-admin.mjs` |
| Sign-up didn't check discoverability | Refused when `credProps.rk === false` | n/a (client-reported, self-harm only) |
| `settings_set` accent unvalidated | Validated against the accent list | n/a |

New, requested during remediation: a sign-in user-verification setting
(`required` by default, or `discouraged`). Registration, sign-up and rechecks
always require verification. Checked by `no-user-verification.mjs`.

## Prior review items

- Setup token: must look generated (base64url, 43+, 16+ distinct characters).
- DCR: at most 1,000 unused registrations at a time.
- Migrations: `npm run db:check` in CI refuses `DROP`/`RENAME`.
- `/healthz` stays a readiness check on purpose (the setup suite relies on it
  failing closed); static assets no longer touch D1.
- Not changed: the D1 signing key still has no kid/version lifecycle (needs a
  design for multi-key JWKS and restore), and the upstream check still stamps
  a failed attempt for a day (documented behavior, no security impact).

## Performance

| Finding | Fix |
| --- | --- |
| P1 audit cap scanned 50k rows hourly | `id <= MAX(id) - 50000` (2 rows) |
| P2 `/admin/audit` ~100k rows per view | No total count (has-next via `LIMIT n+1`), static event list, search resolves to user/client ids, event filter ordered by its index |
| P3 `/token` loaded access twice | `loadUserContext` once; policy and claims are pure functions; refresh + audit in one batch |
| P4 portable per-request floor | Static assets skip env resolution; issuer pin and key read in one batch |
| P5 sequential awaits | Session + user in one join; launcher in one parallel round; code audit inside the `issueCode` batch |
| P6 unminified bundle | `minify` + source maps in `wrangler.jsonc` (935 KB / 281 KB gzip); `cf` has no option yet |
| P7 `metrics_summary` N+1 | Three queries, percentiles in JS over every call |
| P8 missing indexes | Migration 0014 |
| P9 `members.filter` per user | Map |

## Repo hygiene

Actions pinned to SHAs; `npm audit --omit=dev --audit-level=high` and
`db:check` in CI; `@tjohnson/abacus` pinned to its locked commit and `cf` to
`1.0.0-beta.13`; gitleaks allowlist for `src/aaguid.ts` limited to UUIDs;
production `previewUrls` off to match DEPLOY.md.
