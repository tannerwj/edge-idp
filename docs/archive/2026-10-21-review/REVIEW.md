# edge-idp review: security, performance, best practices

**Scope:** clean `master` at `f43acce`, 2026-10-21. Delta-focused: the 2026-10-07 review (`../2026-10-security-review/`) covered the core OIDC/WebAuthn/MCP paths; this one concentrates on code added since (`3725ab1..f43acce`: access grants, app groups, favorites, `apps_connect`, secret pickup, public sign-up, settings) and re-checks the earlier open items. No application code, staging or production was touched. Reproductions ran on throwaway local D1 instances with synthetic users.

**Baseline:** `typecheck`, `gates`, unit tests (25/25) pass; `npm audit` reports 0 vulnerabilities (including the earlier `sharp` advisory).

**Reproduce:** `node docs/archive/2026-10-21-review/review-repro.mjs` from the repo root (starts a local instance like `tests/security/*`). Every line prints `REPRODUCED` on `f43acce`; after fixes, the checks should be inverted into `tests/security/` regressions.

## Security findings

### S1 — Members can assert any unused email as verified — **High**, reproduced

- **Trace:** `POST /account/profile` (`src/account.tsx` › `/account/profile`) calls `ops.updateUser` with the user's own id; `updateUser` (`src/ops.ts:58`) checks only format and uniqueness. `mintIdToken` (`src/crypto.ts:81-83`) then emits `email`, `email_verified: true` and `preferred_username` from the stored value.
- **Evidence:** member `member@example.test` set `ceo@example.test`; a fresh ID token from an admin client carried `email: ceo@example.test, email_verified: true`.
- **Impact:** Cloudflare Access policies that match emails or email domains, and downstream apps that link accounts by email (Open WebUI merge-by-email, older Grafana email lookup), trust the claim. Any member can pass another person's email rule or take over an app account keyed by an address not yet registered here. THREAT_MODEL never discusses self-service email change.
- **Fix:** make email admin-only (simplest and consistent with "becoming a member is the admin's intent"), or require proof of control before the new address is emitted. Regression: member POST to `/account/profile` with a new email is refused or leaves tokens unchanged.

### S2 — Public accounts can claim real emails — **Medium**, reproduced

- **Trace:** the same route has no `public` check. The admin UI shows "Signed up through a public app (no email)" (`src/admin/user-detail.tsx:92`) regardless of what is stored. `makeMember` (`src/ops.ts:278`) flips `public = 0` and leaves whatever email is there, which is then emitted as verified (S1).
- **Evidence:** a public account set `new.hire@example.test`; `users_create` for that address then failed with "A user with that email already exists."
- **Impact:** anonymous sign-ups can squat the address of someone an admin is about to invite (an admin who then "makes the existing account a member" hands the attacker that identity, verified). Even without squatting, "Make member" emits `<id>@public.invalid` as a verified email.
- **Fix:** refuse profile email changes for public accounts (covered by the S1 fix if email becomes admin-only); have `makeMember` require a real email; show the stored email in the admin UI.

### S3 — Step-up does not protect admin accounts — **Medium**, reproduced

- **Trace:** `/account` passkey add/remove requires a 5-minute step-up (`src/session.ts › hasRecentStepUp`), but `POST /admin/users/:id/enrollment` (`src/admin/users.tsx:347`) mints an enrollment link for any user, including the caller, on a plain admin session. No admin UI route or MCP tool calls `hasRecentStepUp`, so admin passkey removal, admin creation, API-token creation and `set_admin` are likewise session-only.
- **Evidence:** an admin session with no step-up got `401 reauth_required` from `/webauthn/register/options`, then minted itself an enrollment link and started a registration with it (`200`).
- **Impact:** THREAT_MODEL says "a stolen session cookie must not be enough to persist access by planting a new credential". That holds for members but not for admins, the accounts it matters most for.
- **Fix:** require `hasRecentStepUp` on admin routes that create credentials or privilege: enrollment links, passkey reset/removal, user create with admin, set admin, API-token create, `apps_connect`/secret rotation. Refuse self-targeted enrollment links outright (self uses `/account`).

### S4 — `/end-session` is an open redirect — **Medium-Low**, reproduced

- **Trace:** `postLogoutTarget` (`src/oidc.tsx:287`) accepts any `post_logout_redirect_uri` whose origin equals the origin of one of the client's redirect URIs. Two gaps:
  1. DCR (`/register`) and CIMD are open and on by default, so anyone can register a client with `https://evil.example/cb` and then use `/end-session?client_id=…&post_logout_redirect_uri=https://evil.example/anything`.
  2. Every non-special scheme (`cursor://`, `myapp://`, `javascript:`, `data:`) has origin `"null"`, so a client with any custom-scheme redirect matches `javascript:…`. Browsers won't execute `javascript:` from a `Location` header, but the check is wrong.
- **Impact:** phishing redirects from the IdP's own hostname. Passkeys limit credential theft, but a fake "sign in again" page on a look-alike domain is still useful to an attacker. Contradicts THREAT_MODEL "cannot be used as an open redirect".
- **Fix:** follow OIDC RP-Initiated Logout: exact match against registered `post_logout_redirect_uris` (or the redirect list), only for admin-registered clients or with a valid `id_token_hint`; never compare opaque origins.

### S5 — Lower-severity items (read, not reproduced)

| Item | Evidence | Fix |
|---|---|---|
| Sandbox 50-call cap is bypassable with concurrency | `src/mcp/sandbox.ts:89` checks `toolCalls.length` before the `await`, pushes after (`:93`); `Promise.all` of N calls all pass. Whether `subRequests: 50` backstops RPC calls is unverified. The 10 s race doesn't cancel the worker. | Count on entry (`calls++` before the await); abort in-flight host calls on timeout. |
| Registration and sign-up don't destroy the prior session | `src/webauthn.ts:242`, `src/signup.ts:118` call `createSession` without `destroySession`; the old row stays valid until expiry. THREAT_MODEL says sign-in destroys the existing session. | Call `destroySession(c)` before `createSession` as `/auth/verify` does. |
| Legacy `/enroll/:token` still live and still minted | `src/index.tsx:200`; `scripts/seed-admin.mjs:50` prints `/enroll/<token>` (so the token reaches Workers Logs/Sentry URLs). Per-route `no-referrer` is overwritten by the global `Referrer-Policy` (`src/index.tsx:107`). | Make seed-admin print `/enroll#…`, then drop the route; set Referrer-Policy only when absent. |
| ID tokens ignore `email`/`profile`/`groups` scopes | `mintIdToken` always includes email and groups (documented for Cloudflare Access). Third-party DCR/CIMD clients asking only `openid` still get them. | Scope-gate for non-admin clients. |
| Sign-up doesn't verify the credential is discoverable | `residentKey: "required"` is only requested (`src/signup.ts:49`); nothing checks `credProps`. Self-harm only (account can't sign in). | Check `clientExtensionResults.credProps.rk` where present. |
| `settings_set` accent not validated server-side | `src/mcp/tools-apps.ts:330` stores any string (rendered escaped). | Validate against the accent list. |

## Checked, no issue found

- Sign-up challenges are typed (`signup` vs `registration`/`authentication`), single-use, and the client is re-read from the challenge, not the request, at verify.
- Public-account containment: `clientAccessProblem` refuses public accounts at any non-public client before groups/grants, at authorize, code and refresh; everyone grants exclude them; `setAdmin` refuses them; tokens omit their placeholder email.
- `appsForUser`, `clientAccessProblem` (linked clients) and `claimsForClient` all derive from the same `resolveAccess` result, so tile, sign-in and roles agree.
- Every MCP write tool is flagged `write: true`; `settings_get` never returns the Cloudflare token.
- Admin router gates every route on a current admin session; favorites check `appsForUser` visibility; both sit behind the same-origin guard.
- Secret pickup: 256-bit token, domain-separated SHA-256 key, random 12-byte IV, `DELETE … RETURNING` single use, on the AUTH limiter.
- Redirect URIs (admin, DCR, `apps_connect`) go through `validRedirectUri`; app tile URLs are http/https only.
- No `raw()`/`innerHTML`/`eval` beyond the doctype; all rendering is escaped JSX. No source comments.
- Code and refresh grants validate before consuming and bind the client in the atomic update (prior C5 fix holds).

## Prior review: open items

Addressed: atomic challenge take, step-up for passkey add, fragment enrollment links (except S5 legacy), sharp advisory, `scripts/setup.sh`, e2e prod default, the doc-drift bullets.

Still open or partial:

- **`/healthz` depends on D1** in portable mode (`resolveEnv` runs first).
- **Setup token entropy** is format-checked only (43 × `a` passes; reference mode skips even the format).
- **D1 signing key** has no kid/version lifecycle; restore + same `SETUP_TOKEN` revives an old key (documented).
- **Upstream check** stamps failures for a day with no separate last-success.
- **DCR** has no global quota or admin approval; any private-use scheme is accepted.
- **Migrations before deploy** in Workers Builds, with no additive-only gate.

## Performance findings

Measured on local SQLite 3.51 with 200 users, 20 clients, 50k audit rows (`EXPLAIN QUERY PLAN` + `.scanstats`); D1's planner may differ. Statement counts are from source.

| # | Finding | Evidence | Fix |
|---|---|---|---|
| P1 | Hourly audit-cap delete reads 50k rows even when it deletes nothing | `src/maintenance.ts:24` subquery `ORDER BY id DESC LIMIT 1 OFFSET 50000` → `SCAN rows=50000`; ~1.2M rows read/day once at the cap (a large share of the daily row-read allowance if the instance is on the D1 free tier). ARCHITECTURE says it "uses the primary key". | `DELETE FROM audit_log WHERE id < (SELECT MAX(id) FROM audit_log) - 50000` (measured `rows=1`; gaps in ids only make it keep more rows, so it is safe). |
| P2 | `/admin/audit` reads ~100k rows per view, ~150k with search | `src/admin/audit.tsx:272`: `COUNT(*)` over the joined set, `SELECT DISTINCT event` over the table, OFFSET paging | Static event list from `CATEGORIES`; keyset paging (`a.id < ?`) instead of exact count; resolve `q` to user/client ids first. |
| P3 | `/token` does the access lookup twice, ~10 sequential round trips | `clientAccessProblem` → `userAccess` (4 stmts), then `claimsFor` → `getUser`, `getUserGroups`, `userAccess` again (`src/oauth-token.ts:168,188`, `src/oauth-shared.ts:105-115`); refresh is the same | Return `{user, access}` from the policy check and pass it to `claimsFor`; batch `mintRefresh` + `audit`. ~10 → ~5 round trips. |
| P4 | Portable mode: 2–3 sequential D1 reads before every request, static assets and `/healthz` included | `src/instance.ts:84,103` (issuer pin uncached, key row + AES decrypt each request) | Cache the pinned issuer once non-null (immutable after setup); read settings/issuer/key in one `batch`; serve `/app.js`, `/app.css`, `/favicon.svg`, `/healthz` before `resolveEnv`. A short key TTL is a doc decision (ARCHITECTURE › Configuration). |
| P5 | Avoidable sequential awaits on hot paths | `getSession` is 2 round trips (sessions, then users; `src/session.ts:61,79`); `GET /` awaits `getUserGroups` outside its `Promise.all` and `subjectOf` re-reads groups and `public` (`src/home.tsx:294`, `src/access.ts:102`); `/authorize` audits outside the `issueCode` batch | Join sessions+users; fold groups into the `Promise.all` and pass the subject; put the audit in the batch. `/` goes 4 → 2 round trips. |
| P6 | Worker bundle unminified, 1.80 MB / 383 KB gzip (+6% since last review) | `wrangler deploy --dry-run`; no `minify` in `wrangler.jsonc` / `cloudflare.config.ts`. SimpleWebAuthn+x509 35%, Sentry+OTel 26%. | `minify: true` in `wrangler.jsonc` (check that `cf` exposes the same option) → 957 KB / 285 KB gzip (−26%) with esbuild. |
| P7 | `metrics_summary` is N+1 | `src/mcp/tools.ts:27-57`: 3 queries per tool used in 24h (~120 statements). ARCHITECTURE describes a different, bounded implementation. | One ordered query per window, percentiles in JS (as documented). |
| P8 | Missing indexes (mostly on deletes) | `refresh_tokens.client_id`, `auth_codes.user_id/client_id`, `mcp_calls.token_id`, `oauth_grants.client_id` (also the DCR-cleanup `NOT EXISTS`), `app_favorites.app_id`; `getUserByEmail` uses `lower(email)` with no expression index; event-filtered audit sorts by `id` and builds a temp B-tree | Additive migration with those indexes; order event-filtered audit by `created_at DESC, id DESC`. |
| P9 | Minor | `src/admin/users.tsx:160` `members.filter` per user (MCP already uses a Map); `seedAppGrants` inserts sequentially | Map lookup; batch. |

Not issues: `resolveAccess`/`appsForUser`/`claimsForClient` do one load then an in-memory pass; other cron deletes are index range scans; reference mode's per-request floor is ~0 D1 statements (10 s settings cache).

## Best practices and doc drift

AGENTS.md requires docs to match behavior. 96 doc code references resolve, and the module map and documented numbers (TTLs, limits, caps) match, except:

1. THREAT_MODEL › Enrollment tokens / DEPLOY §8: `scripts/seed-admin.mjs` still prints path links, and its token is 2×UUIDv4 (~244 bits), not 256.
2. ARCHITECTURE › Tools: `metrics_summary` description is wrong (P7); `tools-access.ts` missing from the grouping list.
3. ARCHITECTURE › UI conventions cites `src/client/app.ts › boot`, which doesn't exist.
4. ARCHITECTURE › Request lifecycle omits Referrer-Policy; the per-route `no-referrer` is silently overridden.
5. THREAT_MODEL › Sessions: "signing in destroys any existing session" isn't true for registration or sign-up (S5).
6. THREAT_MODEL › Sessions / Admin surface: step-up claim doesn't hold for admins (S3); open-redirect claim (S4).
7. ARCHITECTURE › Maintenance: audit cap "uses the primary key" (P1).
8. DEPLOY §9 limiter list omits `/client-secret/pickup`.
9. DEPLOY says preview URLs are off; `cloudflare.config.ts:9` has `previewUrls: true` for production (harmless due to the 308/421 canonical redirect).
10. README: "about 30 tools" (41); sandbox placed in `mcp.ts` (it's `src/mcp/sandbox.ts`); "Checks" calls everything local but includes `npm run smoke`, which hits production.

Repo hygiene:

- `@tjohnson/abacus` is `github:tannerwj/abacus` with no ref, over `git+ssh`, with no integrity hash in the lockfile. Pin a commit or tag.
- `cf` is `^1.0.0-beta.13`; the caret on a prerelease floats.
- CI uses action tags, not SHAs. It already sets `permissions: contents: read`, but runs no `npm audit` or migration check.
- `.gitleaks.toml` allowlists all of `src/aaguid.ts` by path; scope it to the AAGUID pattern.
- No source comments were found (rule respected).

## Suggested order

1. S1 + S2 (one change: email becomes admin-controlled; `makeMember` requires a real email).
2. S3 (step-up on admin credential/privilege routes; no self enrollment links).
3. S4 (exact post-logout matching).
4. P1, P6 (one-line wins), then P3/P5, P2, P4.
5. Doc drift and S5 items alongside the related change.
