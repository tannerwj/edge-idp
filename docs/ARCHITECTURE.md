# Architecture

How edge-idp is built and why. Security rationale lives in
[THREAT_MODEL.md](THREAT_MODEL.md); this document covers structure and design
decisions, and links there instead of repeating it. Test suites are described
in [TESTING.md](TESTING.md), operations in [DEPLOY.md](../DEPLOY.md).

Code references use the form `src/file.ts › symbol`.

## Overview

edge-idp is one Cloudflare Worker (Hono, server-rendered JSX) backed by one D1
database. It is a passkey-only OpenID Connect provider, an OAuth 2.1
authorization server for MCP clients, an admin UI, and an admin MCP server.
There is no separate frontend build or SPA: the browser gets server-rendered
HTML plus one small script and one stylesheet, both served by the Worker
itself.

Everything specific to an instance lives in the Worker config
(`cloudflare.config.ts`, or `wrangler.jsonc` for one-click installs), in
secrets, and in D1. Nothing instance-specific is hardcoded in source, which
keeps the project portable (`src/config.ts › Env`).

## Request lifecycle

Every request passes through one global middleware, in this order
(`src/index.tsx › global middleware`):

1. **Trailing slash.** A GET with a trailing slash (other than `/`) gets a 301
   to the path without it, so each page has one URL and auth checks see one
   form of each path.
2. **Resolve env.** `resolveEnv` fills in `ISSUER`, `RP_NAME` and
   `SIGNING_KEY_JWK` for this request, then `assertConfigured` checks them. A
   failure returns 500 "Server misconfigured" (see
   [Configuration](#configuration-and-per-request-env)).
3. **Canonical host.** If the request origin isn't the issuer, GET and HEAD get
   a 308 to the issuer origin and anything else gets 421. A local
   (`localhost`/`127.0.0.1`) issuer skips this check.
4. **Limiter presence.** `/setup` and `/register` return 503 when
   `AUTH_LIMITER` is missing, because those endpoints must not run unthrottled.
5. **Same-origin guard.** Mutating requests to cookie-authenticated routes
   must be same-origin (`src/index.tsx › crossOrigin`). Bearer endpoints are
   exempt. The reasoning is in THREAT_MODEL › Sessions and cross-origin
   requests.
6. **Rate limits.** See below.
7. **Handler.**
8. **Security headers** on every response, static assets included: HSTS,
   `nosniff`, `X-Frame-Options: DENY`, COOP, a Permissions-Policy that allows
   WebAuthn only for this origin, the strict CSP, and `cache-control:
   no-store` on HTML that didn't set its own.

The middleware returns `Response | void` on purpose (short-circuit or pass
through), which is why it carries an
`eslint-disable-next-line typescript/consistent-return` directive. The admin
middleware follows the same pattern (`src/admin/index.ts › admin.use`).

**Rate limiting** uses the optional Workers Rate Limiting bindings with two
budgets (`src/index.tsx › limiterFor`):

- `AUTH_LIMITER`: `/webauthn/*`, `/register`, `/authorize/decision`, `/setup`;
- `API_LIMITER`: `/authorize`, `/token`, `/revoke`, `/mcp*`.

Only mutating requests and `/authorize` are counted. The key is the first path
segment plus `cf-connecting-ip`. A limited request gets 429 with
`retry-after: 60`. The limits are per IP and deliberately generous (30/min and
300/min) because Claude's connector egress shares IPs across many users.

**Routing.** The OIDC, token, registration, account and home routers are
mounted at `/` because their routes use absolute paths (`/.well-known/…`,
`/authorize`, …). `/webauthn`, `/admin` and `/mcp` are mounted at their
prefixes. Unhandled errors go to Sentry (when `SENTRY_DSN` is set) and render a
generic 500.

**Scheduled work.** The same Worker exports a `scheduled` handler for the
hourly cron (minute 17). It runs maintenance and the upstream update check
(see [Data model](#data-model-and-maintenance)).

## Configuration and per-request env

`ISSUER`, `RP_NAME` and `SIGNING_KEY_JWK` may be unset at deploy time on a
one-click install. `resolveEnv` resolves them per request before any handler
runs and replaces the raw values on `c.env`, so every consumer keeps reading
`env.ISSUER` and `env.SIGNING_KEY_JWK` unchanged. `Env` types them as strings
for that reason, even though the raw values can be missing
(`src/instance.ts › resolveEnv`).

- **Issuer:** an explicit `ISSUER`, then the issuer pinned in
  `instance_settings`, then the request origin. A database that already has
  users but no pin and no explicit `ISSUER` fails closed instead of guessing
  (it predates issuer pinning, and guessing could silently change the issuer).
- **Instance settings:** the name and the Cloudflare Access connection can be
  changed by admins at runtime, so they live in `instance_settings` and are
  overlaid here. The admin-set name wins over `RP_NAME`, which wins over
  "Identity". For the Cloudflare credentials the Worker secrets
  (`CF_API_TOKEN`, `CF_ACCOUNT_ID`) win over the stored ones. The settings are
  read through a per-isolate cache that lives 10 seconds; a save invalidates
  it in the isolate that handled it, so other isolates catch up within a
  few seconds (`src/settings-cache.ts › getInstanceSettings`).
- **Signing key:** falls back to the encrypted key in D1. Isolates that start
  at the same moment converge on one key: each runs `INSERT OR IGNORE` into
  `signing_keys` (id `current`) and reads the row back. The row is read on
  every request rather than cached, so a replaced key shows up in all isolates
  (`src/instance.ts › storedSigningKey`). The stored format is
  `enc:v1:<iv>:<ciphertext>`, AES-GCM with a 12-byte random IV under
  SHA-256(`"edge-idp signing key v1\0"` + `SETUP_TOKEN`).

After resolution, `assertConfigured` refuses to serve if any of the three is
still missing or still contains the placeholder `REPLACE`; the error names the
key and points to DEPLOY.md (`src/config.ts › assertConfigured`). `ISSUER`
must be an https origin with no path, except plain-http `localhost` or
`127.0.0.1` for local development.

The environment variable and secret reference is in DEPLOY.md › Configuration
reference.

## Module map

```
src/
  index.tsx             app assembly: global middleware, routing, static assets, cron handler, sandbox export
  config.ts             Env type and assertConfigured
  instance.ts           per-request env resolution, issuer pin, encrypted D1 signing key
  setup.tsx             first-run /setup (first admin on one-click installs)
  webauthn.ts           passkey registration and authentication ceremonies, enrollment binding
  webauthn-challenges.ts challenge storage (single-use takeChallenge), base64url helpers
  session.ts            __Host- cookie sessions, sliding expiry, step-up
  crypto.ts             signing key loading, ID/access token minting and verification, JWKS
  aaguid.ts             AAGUID → passkey provider name (display only)
  oidc.tsx              discovery, JWKS, /authorize, consent, RP-initiated logout
  oauth-token.ts        /token (code and refresh grants), /revoke, /userinfo
  oauth-shared.ts       scopes, MCP resource id, discovery documents, fresh user claims, client access policy
  oauth-clients.ts      dynamic client registration, CIMD resolution, redirect matching
  http-body.ts          size-limited body reader for remote documents and request bodies
  mcp.ts                admin MCP server (Streamable HTTP, auth, protocol negotiation)
  mcp/common.ts         tool types, argument helpers, McpAuth, call tracking
  mcp/tools.ts          tool registry (TOOLS) and metrics_summary
  mcp/tools-people.ts   user and group tools
  mcp/tools-apps.ts     client, app, audit and settings tools
  mcp/sandbox.ts        execute code mode: Dynamic Worker sandbox and its host RPC entrypoint
  ops.ts                domain operations shared by the admin UI and MCP (users, groups)
  ops-core.ts           OpError, Actor, shared parsing helpers
  ops-apps.ts           OAuth client, launcher app and API token operations
  ops-settings.ts       instance name and Cloudflare Access connection
  db.ts                 D1 row types, validators, queries, audit writes
  maintenance.ts        hourly retention and cleanup
  upstream.ts           daily upstream version check and feedback links
  settings-cache.ts     per-isolate cache of instance settings (name, accent, Cloudflare connection)
  cf-access.ts          optional read-only Cloudflare Access integration
  util.ts               small pure helpers (encoding, hashing, comparisons)
  account.tsx           Account & security routes
  account-sections.tsx  Account & security views
  home.tsx              home launcher
  pages.tsx             sign-in, enrollment, consent, sign-out, error pages
  admin/                admin UI: index (router, middleware), shell, dashboard, users, user-detail,
                        user-tabs, groups, apps (+ apps-cloudflare import view), clients,
                        client-detail, audit, connect, tokens, metrics, settings
  ui/                   layout (document, flash), components, icons, activity feed
  client/               browser bundle: app.ts entry, ui.ts, dom.ts, passkeys.ts, palette.ts, app.css
  assets.gen.ts         generated: bundled app.js/app.css, build hash, version
```

## Auth and sessions

**Passkeys.** Ceremonies use SimpleWebAuthn v14, which runs on pure WebCrypto
with no Node-only dependencies, so it works in the Workers runtime
(`src/webauthn.ts`).

Registration has two entry points. A new user enrolling a first passkey
presents an enrollment token. A signed-in user adding another passkey uses the
active session plus a recent step-up. Finishing either registration signs the
user in with a new session, with no extra prompt
(`src/webauthn.ts › /register/options, /register/verify`).

Authentication with an `email` lists only that user's credentials. Without one
the allow list is empty, so the browser offers discoverable credentials,
including in the email field's autofill (conditional mediation,
`src/client/passkeys.ts`). At verify, the user is resolved from the explicit
email, then the user the challenge was bound to, then the `userHandle` of a
discoverable credential (`src/webauthn.ts › resolveAuthUser`).

A credential's display name is the user's label (trimmed, at most 60
characters), else the provider name from the AAGUID, else "Synced passkey" or
"Security key" by device type. Credential IDs are stored as BLOBs decoded from
base64url (`src/webauthn.ts › credentialName`).

`storeChallenge` doesn't purge expired challenges; the cron does, so each
ceremony writes only its own row and no request pays for a full-table delete.

**Sessions.** A session's `created_at` doubles as the OIDC `auth_time`:
sessions are created only by a passkey ceremony, so creation time is
authentication time. Expiry slides at most once a minute, and the write runs
in the background (`waitUntil`) with errors swallowed, so a page that makes
several fetches doesn't rewrite the row each time and a failed slide never
fails the request (`src/session.ts › getSession`). Step-up is a separate
timestamp on the session (`step_up_at`), set only by an explicit recheck.

**Signing keys.** The loader keeps two CryptoKeys: the private key, used only
for signing, and a public verify key derived from the private JWK's `n`/`e`,
because jose v6 refuses to verify with a private key. Deriving the public key
keeps one source of truth. Loaded keys are cached per isolate, keyed by the
raw JWK string. `importJWK` is followed by an `instanceof CryptoKey` check
rather than a type assertion (`src/crypto.ts › loadKey`).

JWKS publishes every key that may have signed a still-valid token, current key
first. `SIGNING_KEY_JWK_PREVIOUS` is published but never used to sign, and is
skipped if its `kid` equals the current one. Keys without a `kid` default to
`sig-1` (current) or `sig-0` (previous) (`src/crypto.ts › allKeys,
jwksDocument`).

**First run.** `setupPending` caches "a user exists" for the life of the
isolate once it sees one, because setup can never reopen while users remain
(`src/setup.tsx › setupPending`).

## OIDC and OAuth

**Module split.** `src/oidc.tsx` is the OIDC provider and OAuth 2.1
authorization server front end. `src/oauth-token.ts` holds the token endpoint,
RFC 7009 revocation and `/userinfo`. `src/oauth-shared.ts` holds what the
authorize, token and MCP modules share. `src/oauth-clients.ts` covers clients
that arrive without the admin UI.

**Discovery.** The metadata document is served at both
`/.well-known/openid-configuration` and the RFC 8414
`/.well-known/oauth-authorization-server`; MCP clients try the RFC 8414 path
first, and the content is the same. RFC 9728 Protected Resource Metadata for
`/mcp` is served at both `/.well-known/oauth-protected-resource/mcp` and the
root `/.well-known/oauth-protected-resource`, because clients differ in which
they try first (`src/oauth-shared.ts › discovery, protectedResource`).

**Client types.**

| Type                | How it arrives                                            | Used by                                                | Consent                    |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------ | -------------------------- |
| Admin-registered    | Admin → Clients                                           | Cloudflare Access, self-hosted OIDC apps               | skipped (can be turned on) |
| DCR (RFC 7591)      | `POST /register`                                          | Cursor and most MCP clients                            | always                     |
| CIMD (metadata URL) | `client_id` is an https URL serving the client's metadata | claude.ai, Claude Code, VS Code, and newer MCP clients | always                     |

Claude Code can arrive either way: the e2e suite exercises DCR in the style
Claude Code and Cursor use, and CIMD with Claude Code's real metadata
document.

CIMD (draft-ietf-oauth-client-id-metadata-document) avoids a registration
round trip and anchors the client's identity to a domain the user can see.
claude.ai only uses it when the authorization-server metadata has both
`client_id_metadata_document_supported: true` and `none` in
`token_endpoint_auth_methods_supported`.

- A `client_id` is treated as a CIMD URL only when it meets the draft's §3:
  https, a non-root path, no userinfo, query or fragment, no `.`/`..`
  segments, and already normalized, since it is compared as a plain string
  (`src/oauth-clients.ts › isCimdClientId`).
- CIMD clients may only use `none`. The draft also allows `private_key_jwt`,
  which this server doesn't support, and a shared secret is meaningless for a
  self-published document.
- Unsupported extra grant types in a document are ignored rather than
  rejected, because claude.ai's document lists `jwt-bearer`.
- A CIMD client is served from its stored row while `metadata_expires_at` is
  in the future; otherwise the document is fetched again and upserted, with
  the TTL from `Cache-Control: max-age` (default 24 hours) clamped to 5
  minutes through 7 days (`src/oauth-clients.ts › resolveClient, cacheTtl`).
- Remote bodies are read through `readBodyLimited`: 5 KB for CIMD documents,
  16 KB for DCR requests (`src/http-body.ts`).

Redirect matching, PKCE, the single-use code exchange and the consent policy
are security decisions; see THREAT_MODEL › Authorization codes and Who can
authorize what.

**Resource indicators.** The RFC 8707 `resource` parameter is accepted only for
this server's own resources (`<issuer>/mcp` or the issuer itself), with
trailing slashes forgiven; anything else is `invalid_target`. The resource is
stored with the code and refresh token and becomes the access token's `aud`.
Without one, `mcp`/`mcp:read` grants default to the MCP resource and others to
the client id (`src/oidc.tsx › normalizeResource`,
`src/oauth-token.ts › tokenResponse`).

**Flow details.**

- When `/authorize` sends the user to sign in, the resume URL drops
  `prompt=login` so the request doesn't loop back to the login page after the
  ceremony (`src/oidc.tsx › resumeUrl`).
- A refresh request may narrow scope but never widen it. For clients that
  aren't admin-registered, refresh also checks that the user's consent grant
  still exists (`src/oauth-token.ts › refreshGrant`).
- Revocation (RFC 7009) deletes the whole refresh family when the token
  belongs to the authenticated client. JWT access tokens are stateless and
  expire within an hour, so revoking one is acknowledged with 200.
- `/userinfo` reads the user fresh from D1, so profile and group edits show up
  without a new token.
- The ID token `groups` claim is sorted, so the same memberships always
  produce identical tokens (`src/db.ts › getUserGroups`).

## MCP server and code mode

`POST /mcp` speaks Streamable HTTP, returns JSON responses only, and is
stateless (`src/mcp.ts`). It supports both protocol eras:

- the `initialize` handshake, versions 2024-11-05 through 2025-11-25, which
  every shipping client uses;
- the stateless 2026-07-28 revision, which adds `server/discover` and requires
  the `Mcp-Method` header (and `Mcp-Name` for `tools/call`) to agree with the
  body.

An unknown `MCP-Protocol-Version` gets error -32022 with the supported list; a
header/body mismatch gets -32020 (`src/mcp.ts › checkProtocol`). JSON-RPC
batches are refused. A message with no `id` is a notification, and
`notifications/*` get 202 with no body. `structuredContent` must be an object,
so non-object tool results are wrapped as `{ result }`.

**Credentials.** `/mcp` accepts opaque API tokens (Admin → API tokens) and
OAuth access tokens minted for the MCP resource. A credential without exactly
two dots can't be a JWT, so it is looked up as an API token first, skipping
signature verification on the cheap path (`src/mcp.ts › authenticate`).
`McpAuth.tokenId` is the `api_tokens.id`, or `oauth:<client_id>` for OAuth
callers. Tool calls are recorded in `mcp_calls` fire-and-forget via
`waitUntil` (with `token_id` null for OAuth callers); the cron handles
retention (`src/mcp/common.ts › trackCall`).

**Tools.** Tools are plain definitions with a JSON input schema, grouped in
`tools-people.ts` and `tools-apps.ts` and registered in `TOOLS`. They call the
same domain operations as the admin UI (see [Domain operations](#domain-operations-and-admin-ui)).
`metrics_summary` computes p50/p95 in JavaScript because percentiles need
ordered values; durations are fetched per tool, bounded at 1000 rows.

**Code mode.** The `execute` tool runs a model-written JavaScript snippet in an
isolated Dynamic Worker that calls IdP tools through a typed `id` proxy.
Intermediate results never re-enter model context; only the final return
value comes back. The tool description embeds TypeScript declarations
generated from every tool's input schema, so `execute` must be defined after
all other tools; `sandbox.ts` appends it to `TOOLS` at module load
(`src/mcp/sandbox.ts › EXECUTE_TOOL, toolDeclarations`).

- Each proxied call re-enters the Worker through the `IdCodeSandbox` RPC
  entrypoint. It is reached through `ctx.exports`, which sees only the main
  module's exports, so `src/index.tsx` re-exports it.
- That entrypoint's own `env` is the raw one and may lack `ISSUER` (it can be
  pinned in D1). The host resolves the issuer per request and passes it in as
  a prop.
- `execute` needs the `LOADER` Worker Loader binding. Without it, `execute`
  is left out of `tools/list` and calls fail with "the code-execution sandbox
  is not configured on this worker".
- The isolation guarantees (no network, no env, props-only identity) are in
  THREAT_MODEL › Admin API (MCP) credentials.

## Domain operations and admin UI

Domain operations are shared by the admin UI and the MCP tools, so both apply
the same validation and write the same audit events. Every operation takes the
acting admin for the audit trail and throws `OpError`, whose message is safe
to show the admin, on invalid input (`src/ops.ts`, `src/ops-core.ts`,
`src/ops-apps.ts`).

Admin mutations run through one helper that redirects back with a flash
message. An `OpError` becomes a red toast on the same page; any other
exception is a real bug and propagates to Sentry (`src/admin/shell.tsx ›
act`).

Deleting a group is refused while any client or launcher app here still lists
it in its allowed groups. Group names also appear in Cloudflare Access
policies, which this server can't see, so silently deleting a referenced group
could change who has access in ways the admin didn't intend
(`src/ops.ts › deleteGroup`).

Launcher visibility: an app linked to an OIDC client follows that client's
`allowed_groups`, because that is what `/authorize` enforces; an unlinked app
follows its own list. A NULL or empty list means everyone (`src/db.ts ›
appsForUser`).

Old admin URLs from the previous UI (`/admin/access`, `/admin/preferences`,
`/admin/theme`, `/admin/mcp`) permanently redirect to their current pages so
bookmarks keep working.

**Cloudflare Access integration** (`src/cf-access.ts`) is read-only. It lists
Access applications, shows which ones sign in through this IdP and which
groups their policies require, and imports them into the launcher. Nothing
writes to Cloudflare: Access stays the enforcement point and the source of
truth for its policies. "Our" Access IdP is the OIDC provider whose auth URL
is this server's `/authorize`.

**Upstream update check** (`src/upstream.ts`). Deploy-to-Cloudflare installs
are independent clones, not forks, so nothing links them back upstream. Admins
get links to file issues upstream, and the cron checks at most once a day
whether upstream `master` has a newer `package.json` version (numeric
MAJOR.MINOR.PATCH comparison; suffixes ignored; anything else never reports an
update). The check time is recorded before fetching, so an outage costs one
attempt per day rather than one per hour.

## Data model and maintenance

Migrations in `migrations/` are additive and applied manually (or by
`npm run deploy` under Workers Builds), so the previous Worker version keeps
running on the new schema during a rollback.

**D1 quirks.**

- D1 returns untyped rows. Row validators throw on schema drift instead of
  letting `undefined` pass as a string downstream (`src/db.ts › str, num,
  strArray`).
- BLOB columns come back as an `ArrayBuffer` in local Miniflare but as a plain
  `Array` of byte values in production D1. `blobBytes` normalizes either form
  (or a typed-array view) into a fresh `Uint8Array`; anything else is a schema
  violation, not an empty credential.
- Rows that predate a migration may lack its column: `require_pkce` (0002)
  defaults to true and `environment` (0005) to `production`
  (`src/db.ts › rowToClient`).
- Emails are stored as entered and looked up with ASCII-only case folding on
  both sides, because SQLite's `lower()` folds only ASCII
  (`src/util.ts › emailKey`, `src/db.ts › getUserByEmail`).

**Maintenance cron.** The hourly job does retention and garbage collection so
no user-facing request pays for a table scan. One D1 batch
(`src/maintenance.ts › runMaintenance`) deletes:

- expired WebAuthn challenges and sessions;
- authorization codes more than an hour past expiry;
- enrollment tokens that are used, or more than 7 days past expiry;
- refresh tokens that expired, or were rotated more than a day ago (kept that
  long so reuse detection still recognizes them);
- audit events older than 365 days, and everything older than the
  50,000th-newest id (an id comparison that uses the primary key, instead of a
  `NOT IN (… LIMIT n)` scan);
- `mcp_calls` older than 30 days;
- dynamically registered (DCR) clients older than 30 days that never received
  a consent.

**Caches.** Instance settings (name, accent, Cloudflare connection) change only
by admin action, so they are cached per isolate for 10 seconds instead of costing a D1 read on every request; a change
can take up to 10 seconds to reach other isolates (`src/settings-cache.ts`).

## UI conventions

**Server-rendered, no inline code.** Pages are rendered with `hono/jsx`, and
all browser behavior lives in `/app.js`, wired through `data-*` attributes
because the CSP forbids inline script and style. Pages work without
JavaScript, except the WebAuthn ceremonies, which need it by definition.
Components render no behavior of their own (`src/ui/layout.tsx`,
`src/ui/components.tsx`, `src/client/app.ts`, `src/client/ui.ts`):

- `data-open="<id>"` opens a modal;
- every mutation is a POST form, optionally confirmed through `data-confirm`
  (a styled dialog, not `window.confirm`);
- `tr[data-href]` makes a table row clickable, but each row still contains a
  real `<a>` so keyboard and assistive-technology users get a normal link;
  clicks on interactive elements inside the row are ignored;
- timestamps are rendered relative, in the viewer's locale, by `app.js`;
- `data-copy` copies a value.

**Styling without inline styles.** Every visual variant is a CSS class or data
attribute. Dashboard sparkline bars are bucketed 0 to 19 (5% steps) on the
server and emitted as `data-v`, with one stylesheet rule per bucket
(`src/admin/dashboard.tsx › bars`). The accent palette is selected with
`[data-accent]`. Icons are inline SVG (24px grid, stroke-based, shapes after
Lucide, ISC licensed), so they inherit `currentColor` and need no extra
requests or CSP allowances (`src/ui/icons.tsx`).

**Small decisions worth knowing.**

- `hono/jsx` never emits a doctype, so the layout writes `<!doctype html>`
  explicitly; without it browsers use quirks mode (`src/ui/layout.tsx ›
  Document`).
- Submit buttons are disabled in a `setTimeout(…, 0)` rather than
  synchronously, because disabling synchronously drops the clicked button's
  name and value from the submission (`src/client/ui.ts`).
- On load the client removes `?ok=…` flash codes from the address bar so a
  reload doesn't show the toast again (`src/client/app.ts › boot`).
- The home greeting is time-neutral ("Welcome back") because the server only
  knows UTC, not the viewer's clock (`src/home.tsx › greeting`).
- The command palette validates the `/admin/palette.json` index rather than
  trusting its shape; if the fetch fails, it still offers sidebar pages and
  quick actions (`src/client/palette.ts`).

**Assets.** There is intentionally no Vite or SPA build. `npm run build:client`
bundles `src/client/app.ts` and `app.css` with esbuild into the generated
`src/assets.gen.ts`, and the Worker serves them from memory. Every response,
static ones included, passes through the security-headers middleware, and a
deploy is one atomic artifact. Asset URLs carry `?v=` plus the first 10 hex
characters of a SHA-256 over the JS and CSS, so each deploy busts caches;
assets are served `immutable` and HTML `no-store`. The build runs before `dev`
and `deploy` (`scripts/build-client.mjs`).

## Tooling

- **`cf` CLI**, with `wrangler` only as the bundler `cf` calls. The one-click
  path (Workers Builds) uses `wrangler` with `wrangler.jsonc`;
  `scripts/deploy.mjs` picks the right one (see DEPLOY.md).
- **Checks:** `npm run typecheck` (server and client tsconfigs), `npm run
  gates` (abacus, configured in `abacus.config.json`: lint, ABC complexity,
  tsc, dead code, secrets, import cycles, duplicates, TODOs, and a ratchet
  that keeps size and complexity from growing), and oxfmt for formatting. CI runs typecheck, `typecheck:e2e`,
  `fmt:check`, unit tests and gates on push and PRs; the e2e suites run
  locally (see TESTING.md).
- **Stage config is parsed as text.** `STAGES` in `cloudflare.config.ts` is
  the single source of truth for each stage's Worker name, issuer and D1 id.
  Scripts and the e2e harness read it with `stageConfig`, which uses regexes
  rather than importing the file. Keep each stage as a two-space-indented
  `<stage>: {` block closed by `\n  },`, with double-quoted `name`, `issuer`
  and `d1: { … id }` values, or the scripts won't find them
  (`scripts/cf-local.mjs › stageConfig`).
- `--stage=<name>` on any script maps to `cf`'s `--mode`, defaulting to
  production (`scripts/cf-local.mjs › stageArg`). `sqlRows` runs SQL through
  `cf d1 raw` (local by default) and returns the last statement's rows as
  objects (`scripts/cf-local.mjs › sqlRows`).

**`cf` beta workarounds.** These exist because of `cf` 1.0.0-beta.13 behavior.
Remove each when its condition is met.

| Workaround                                                                                                                                                                       | Why                                                                                                                                                                                                                                                    | Remove when                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `cfJson` reads stdout until it parses as JSON, then stops the whole process group and waits for it to exit (60 s default timeout) (`scripts/cf-local.mjs › cfJson`, `stopGroup`) | `cf d1 … --local` prints its result but leaves its local Miniflare running. Run through `npx`, killing only the wrapper orphans `cf` and its engine, which keep the D1 files open and make later local SQL fail with `[10000] Network connection lost` | `cf d1 --local` exits on its own                |
| Local migrations and seeding pass `--persist-to .wrangler/state` (`scripts/db-migrate.mjs`, `scripts/cf-local.mjs › migrateLocal`)                                               | `cf dev` reads local D1 from `.wrangler/state`, but `cf d1 --local` defaults elsewhere                                                                                                                                                                 | `cf dev` and `cf d1 --local` agree on a default |
