# Threat model

This server is the root of trust for its apps: whoever controls it can mint
identity for anyone. Every auth-relevant decision below gets its one-paragraph
rationale. When in doubt, the code fails closed.

Code references use the form `src/file.ts › symbol`. How the pieces fit
together is in [ARCHITECTURE.md](ARCHITECTURE.md); how each property is tested
is in [TESTING.md](TESTING.md).

## Credentials: passkeys only

There is no password column, no password reset flow, and no fallback factor.
That deletes credential stuffing, password spraying, and reset-token phishing
in one move, at the cost that account recovery is admin-assisted (revoke keys,
then send a fresh enrollment link). Users are nudged to enroll two passkeys
(phone and laptop) so losing one device is a non-event.

A user cannot remove their own last passkey from Account & security; the
handler refuses a deletion that would leave zero credentials, so nobody can
lock themselves out by accident (`src/account.tsx › /account/keys/:id/remove`).

## WebAuthn ceremony integrity

Challenges are 256-bit random, single-use, 5-minute TTL, stored in D1, and
bound to the user they were issued for; every verify step re-checks the
binding, so a challenge can't be replayed or swapped between users. Single use
is enforced in one statement: `DELETE … WHERE challenge = ? AND expires_at >=
now RETURNING …` reads and consumes the challenge together, so two concurrent
verifies cannot both get it (`src/webauthn-challenges.ts › takeChallenge`).

`expectedOrigin` is the exact `ISSUER` origin and `expectedRPID` its hostname,
so a credential registered on a lookalike domain can never verify here.

User verification is **required** for both registration and authentication:
`userVerification: "required"` in the options and `requireUserVerification:
true` at verify. Owning or touching the device is not enough to authenticate
to a service that is the root of trust for every app. ID tokens say so with
`amr: ["pop", "user"]` (RFC 8176: proof of possession plus user presence and
verification) (`src/webauthn.ts › /register/options, /auth/options`,
`src/crypto.ts › mintIdToken`).

Algorithms are pinned to ES256 and RS256
(`supportedAlgorithmIDs: [-7, -257]`). Without the pin, SimpleWebAuthn v14
offers ML-DSA first on runtimes with post-quantum WebCrypto, so the negotiated
algorithm would depend on the runtime; the pin keeps behavior the same
everywhere.

Attestation is `none`: we don't need to know the authenticator model to trust
the signature. The AAGUID is therefore self-reported, so provider names
("iCloud Keychain", "YubiKey") are for display only and never feed a trust
decision (`src/aaguid.ts`). Counters are enforced only for credentials that
have previously reported nonzero; synced passkeys sit at 0 forever, and
rejecting them would be a false positive. A regression is refused and audited
as `PASSKEY_COUNTER_REGRESSION`.

**Accepted risk: passkey enumeration by email.** `/webauthn/auth/options` with
an `email` reveals whether that address has passkeys, because the allow list
comes back empty for unknown addresses. This is accepted because the email
path exists only for non-discoverable security keys, there is no password to
stuff, and the default sign-in button uses discoverable credentials and sends
no email at all (`src/webauthn.ts › /auth/options`).

## Authorization codes

Single-use, 60-second TTL, stored as SHA-256 hashes, and bound to the client,
redirect URI and PKCE challenge that created them.

`redirect_uri` is compared with exact string equality against the registered
list, for every client type; prefix matching would let
`https://app.example.com.evil.com` steal codes. The one exception is RFC 8252
§7.3: an `http` loopback redirect (`localhost`, `127.0.0.1`, `[::1]`) matches a
registered loopback URI with the same host, path and query on any port,
because native apps bind an ephemeral port for each sign-in
(`src/oauth-clients.ts › redirectMatches`). At `/token`, `redirect_uri` is
optional (OAuth 2.1), but when present it must equal the URI bound to the code.

Redemption checks everything before it consumes anything. Expiry, client,
redirect URI, PKCE, and the user's current eligibility for the client are all
validated first; any failure returns `invalid_grant` and leaves the code
unused, so someone who sees a code cannot deny the real client its sign-in by
presenting it wrongly. Only then does a single `UPDATE auth_codes SET used = 1
WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND code_challenge
= ? AND used = 0 AND expires_at >= now RETURNING …` consume it. The predicates
repeat the validated bindings, so if two valid `/token` calls race, exactly
one gets a row back (`src/oauth-token.ts › codeGrant`).

PKCE S256 is **required by default** on every flow: it's cheap defense in
depth. Confidential server-side clients that cannot send a code challenge
(e.g. Cloudflare Access) may opt out per client (`require_pkce = 0`); the code
remains bound to the exact redirect URI and the client must still prove
possession of its 256-bit secret at the token endpoint, which preserves the
anti-interception property PKCE provides for public clients. Public clients
can never opt out.

## Who can authorize what

Admin-registered clients are first-party: they skip consent (the passkey
ceremony is the intent) and are open to everyone unless restricted to groups.
Clients that introduce themselves, through dynamic registration (RFC 7591) or
a Client ID Metadata Document (an https `client_id` URL), are third-party:
they always get a consent screen. The screen shows the redirect host, plus the
metadata URL's domain for CIMD clients. Self-registered clients are labelled
unverified. Only admins can authorize them until an admin assigns groups. The
`mcp` / `mcp:read` scopes are admin-only regardless of client. The same policy
is applied at authorization, code redemption and refresh
(`src/oauth-shared.ts › clientAccessProblem`). Consent is remembered per
(user, client). Revoking it under Account → Connected apps deletes the grant
and that client's refresh tokens for the user.

## Authorization requests and redirects

Errors for an unknown client, an unusable CIMD client, or a `redirect_uri`
that does not match are rendered as error pages, never redirects: without a
validated client and redirect URI there is no safe place to send the error.
Only after both are validated are errors returned to the client by redirect,
with `state` and `iss` (`src/oidc.tsx › validateAuthorize`).

The consent form POST to `/authorize/decision` re-validates the entire
authorization request from the submitted fields. The form is
attacker-controllable input and must not be trusted to carry a request that
`/authorize` already checked.

RP-initiated logout redirects only to a `post_logout_redirect_uri` whose
origin matches one of the client's registered redirect URIs (the client comes
from `client_id` or a verified `id_token_hint`), so `/end-session` cannot be
used as an open redirect (`src/oidc.tsx › postLogoutTarget`).

The `next` parameter on `/login` accepts only same-origin relative paths.
Values starting with `//` (protocol-relative) or `/\` (which browsers treat as
`//`) fall back to `/`, so a fresh login can never be redirected off-site
(`src/index.tsx › safeNext`).

## Client authentication

Secrets are generated at 256 bits, stored as SHA-256 hashes, and compared in
constant time (`timingSafeEqualHex`), because `===` leaks prefix information
through timing. Both `client_secret_basic` and `client_secret_post` are
accepted (Cloudflare documents neither; three independent integrations
confirm Basic). Secrets are shown once at creation; rotation is immediate and
total. Public clients (`token_endpoint_auth_method: none`) have no secret and
are always held to PKCE; a public client that presents a secret is refused
rather than guessed about (`src/oauth-token.ts › authenticateClient`).

## Dynamic clients: CIMD and DCR

Fetching a CIMD document means fetching a URL chosen by whoever started the
sign-in, which makes it a server-side request forgery risk. The fetch is
limited as follows:

- https only;
- the client_id must have a path, and no userinfo, query, fragment or dot segments;
- IP-literal, localhost and single-label hosts are refused;
- redirects are not followed;
- 5 KB / 5 s limits, with the size cap enforced on streamed bytes, not only on
  `Content-Length` (`src/http-body.ts › readBodyLimited`);
- the document's `client_id` must equal the URL exactly;
- secret-based auth methods and embedded secrets are rejected.

Workers' `fetch` can't reach private networks, which covers DNS names that
resolve to internal addresses. Documents are cached as client rows, honoring
`Cache-Control` within 5 min to 7 days bounds. A stale copy is used if the
publisher is briefly down, but only for 24 hours past its expiry; after that
the client fails to resolve, so a dead publisher cannot keep its redirect
URIs and display name alive indefinitely (`src/oauth-clients.ts ›
resolveClient`).

Redirect URIs for dynamic clients may be https, http loopback (any port, RFC
8252 §7.3) or a private-use app scheme; `javascript:`/`data:`/`file:` and
similar are rejected. Dynamically registered clients that never received a
consent are deleted after 30 days, since some MCP clients register again on
every connect. Both onboarding paths can be switched off in Settings.

## Sessions and cross-origin requests

The cookie carries a 256-bit random token; the DB stores only its SHA-256
hash, so a database read never yields a live session. The cookie is
`__Host-idp_session`: Secure, `Path=/`, no `Domain`, so no sibling subdomain
can set or shadow it. It is also HttpOnly and SameSite=Lax. Sessions slide to
30 days, die with the user row (cascade), and are destroyed on
disable/revoke. Signing in destroys any existing session before creating the
new one, so a planted cookie cannot carry over (no fixation).

SameSite is per _site_, so every other host on your domain counts as
same-site. If any of those apps were compromised, Lax alone would let it post
forms to the admin UI. Every cookie-authenticated state change therefore also
passes a same-origin check: `Sec-Fetch-Site` must be `same-origin` or `none`,
falling back to `Origin` when that header is missing. A request with neither
header passes, because it doesn't come from a browser that would attach our
cookie cross-origin. Bearer-authenticated endpoints (`/token`, `/revoke`,
`/register`, `/userinfo`, `/mcp` and their subpaths) are exempt because they
never read cookies (`src/index.tsx › crossOrigin`). `/mcp` refuses any browser
`Origin` that isn't this server, which blocks DNS-rebinding and drive-by
requests.

Adding or removing a passkey on an existing account requires an explicit
passkey recheck (step-up) in the same session within the last 5 minutes
(`STEP_UP_TTL` in `src/session.ts › hasRecentStepUp`). The session's age does
not count: the step-up timestamp is set only by an explicit recheck made while
already signed in as the same user, and at registration verify the session
user must match the challenge's user. A stolen session cookie must not be
enough to persist access by planting a new credential, or to strip the
owner's.

Flash messages use a `__Host-flash` cookie, so no sibling subdomain can set it
and plant text on our pages. The `?ok=` codes in URLs map through a fixed
dictionary; arbitrary text from the URL is never echoed (`src/ui/layout.tsx ›
setFlash, FLASH`).

Authenticated HTML is never cached: any `text/html` response without its own
`cache-control` gets `no-store`, so browsers and proxies don't keep signed-in
pages (`src/index.tsx › global middleware`).

## Consent: first-party skip, third-party always

For admin-registered clients the passkey ceremony moments before `/authorize`
_is_ the consent; an extra "Allow?" click adds nothing. That reasoning stops
holding the moment clients can register themselves, so dynamic and CIMD
clients always get a consent screen (see _Who can authorize what_). Admins can
turn the screen on for any first-party client too.

## Enrollment tokens

Bearer tokens (256-bit, hashed at rest), single-use, 7-day TTL, bound to one
user. The verify step checks that the token presented matches the one the
challenge was issued for, so an attacker can't piggyback their own ceremony
onto someone else's link; a challenge issued without a token can't be
verified with one, and the reverse is refused too (`src/webauthn.ts ›
checkEnrollmentBinding`). The token is burned with a conditional `UPDATE … SET
used = 1 WHERE … AND used = 0` before the credential is stored, so if two
ceremonies race on one link, only one enrolls; the other gets
`invalid_enrollment_token` (`src/webauthn.ts › burnEnrollmentToken`). Admins
generate tokens; there is no self-service enrollment, because user creation is
the admin's explicit intent. A fresh link is revealed once in the admin UI and
never stored in plaintext.

## First admin (one-click installs)

`/setup` creates the first admin, then hands off to normal passkey
enrollment. It exists only while the users table is empty and only when the
installer set a generated 32-byte base64url `SETUP_TOKEN` secret (43
characters) at deploy time. The token is compared in constant time, the
endpoint is on the AUTH rate limit and the same-origin guard, wrong guesses
are audited (`SETUP_REJECTED`), and the insert is conditional on "no users
yet", so two racing requests can't both create an admin. After the first user
exists it 404s.

The admin, enrollment link, audit rows and issuer pin are committed in one D1
batch, which is transactional. If any write fails, the first-admin row rolls
back too and setup can be retried; otherwise a half-finished setup would leave
a user row behind, `/setup` would 404 from then on, and the admin would have
no enrollment link (`src/setup.tsx › POST /setup`).

The window is the gap between deploy and the installer's first visit, and the
attacker would need both the Worker's hostname and the token. A restored empty
database reopens setup, so keep the setup secret and database backups
together and control who can restore them. Instances seeded with
`scripts/seed-admin.mjs` never expose setup while their users remain.

## Issuer and signing key defaults

The portable installation uses these defaults:

- **ISSUER** falls back to the request's origin before setup. Setup pins that
  origin in D1. Later requests on aliases redirect to the canonical origin;
  non-idempotent requests to aliases return 421. An explicit `ISSUER` overrides
  the pin. Choose the permanent hostname before enrollment: moving the issuer
  changes token identity and the passkey RP ID and requires a client/passkey
  migration. Existing portable databases created before issuer pinning need
  an explicit `ISSUER` for the upgrade or the Worker fails closed rather than
  guess from the request origin.
- **The signing key** falls back to one generated on first use and stored in
  D1 (`signing_keys`), encrypted with AES-GCM under a key derived from the
  long-lived `SETUP_TOKEN` Worker secret. A D1 read alone no longer exports
  signing authority. D1 writes can still change users, sessions and keys;
  Worker secret compromise remains critical. D1 backups and the matching
  `SETUP_TOKEN` are both required to recover this key. The reference instance
  uses the `SIGNING_KEY_JWK` secret, which takes precedence. Legacy plaintext
  portable rows fail closed until the operator rotates to a secret-held key
  (`src/instance.ts › sealKey, openKey`).

## Admin surface

Requires an authenticated session **and** `is_admin`; state-changing requests
also pass the same-origin guard (`src/admin/index.ts › admin.use`). The first
admin comes from the seed script or `/setup`; later promotions happen here.
Disabling a user deletes their sessions and refresh tokens immediately;
revoking keys kills sessions too, so recovery starts from a clean slate.
Admins can't disable themselves (avoids the one-admin lockout).

Emails are stored as entered but looked up by a lowercased key, so an admin
who retypes an existing email in different case cannot create a duplicate
account. SQLite's `lower()` folds only ASCII, so the app's key does the same
(`src/util.ts › emailKey`): A–Z case differences are ignored, other letters
must match exactly, and the stored address always finds itself
(`src/db.ts › getUserByEmail`).

## Cloudflare API token (optional)

The read-only Access integration needs a Cloudflare API token. Admins can
connect it in Settings, which stores it in `instance_settings` in plaintext.
That is acceptable because of what the token can do and what an attacker would
already have: it should carry only Access read permissions (apps, policies,
identity providers), so it can't change anything, and reading D1 already means
full control of this instance. The UI is write-only (the token is never sent
back to a browser, only "connected" and the account ID), it's validated against
Cloudflare before it's saved, connecting and disconnecting are audited, and
it isn't exposed through MCP, so it never lands in an AI tool's context. Setting
`CF_API_TOKEN` as a Worker secret keeps it out of D1 entirely and takes
precedence (`src/ops-settings.ts › connectCloudflare`).

## Token design

Tokens are signed with RS256 only. Cloudflare Access accepts RSA and ECDSA but
not EdDSA or HS256, and signing with anything else would silently break the
integration this server exists for. Verification pins `algorithms:
["RS256"]` as well (`src/crypto.ts`).

ID tokens are RS256 JWTs (`typ: JWT`) with `aud` set to the client, a 1-hour
TTL, and `auth_time` taken from the passkey ceremony (not the mint time).
Everything Cloudflare Access needs (email, groups) is **in** the ID token
because Access never calls userinfo. ID tokens are verified only as an
`id_token_hint` at logout, with 30 days of clock skew allowed: logout hints
are often expired, and there the signature, issuer and `typ` matter, not
freshness (`src/crypto.ts › verifyIdToken`).

Access tokens are RFC 9068 JWTs (`typ: at+jwt`, verified as such, so an ID
token can never be replayed as one). Their `aud` is the RFC 8707 resource they
were minted for, or the `client_id` when none was requested (a userinfo-only
token). Verification fails closed on an unknown `kid`, wrong issuer, wrong
algorithm, wrong `typ` or wrong audience (`src/crypto.ts ›
verifyAccessToken`). `/mcp` accepts only `aud = <issuer>/mcp` with the `mcp`
or `mcp:read` scope, and re-checks that the user is still an active admin on
every call. A token handed to some app at sign-in is therefore useless against
the admin API. That was a real hole in v1. `/userinfo` re-reads the user from
the DB, so disabled users stop resolving immediately.

Authorization codes are covered under _Authorization codes_ above: all
bindings are checked before one atomic consume, and code and refresh
redemption both recheck the user's current client group/admin eligibility.

Refresh tokens are issued only for grants that include `offline_access`,
`mcp` or `mcp:read` (`src/oauth-token.ts › wantsRefresh`). They rotate on
every use, inside a family with an absolute 30-day lifetime, and a refresh may
narrow scope but never widen it. Presenting an already-rotated token by its
own client deletes the whole family and writes a `REFRESH_REUSE_DETECTED`
audit event (RFC 9700 §4.14); rotated tokens are kept for one day so a replay
can still be recognized, then the hourly cron deletes them. Refresh tokens
also die with the user's consent, admin role, group eligibility, or account.
Wrong-client presentations do not consume or revoke another client's grant.

New enrollment links put the bearer token in a URL fragment (`/enroll#<token>`)
so the Worker and Workers Logs never receive it. Previously issued path-token
links (`/enroll/:token`) remain usable until they expire; replace outstanding
links if their URL was logged.

## Admin API (MCP) credentials

API tokens are random, `eidp_`-prefixed (so leaked tokens are greppable),
stored as hashes, scoped (`read` / `admin`), optionally expiring, and
re-checked against their creator on every call. A demoted or disabled admin's
tokens stop working, and demotion deletes their API tokens and MCP grants. A
read-only caller that hits a write tool gets `403 insufficient_scope`, so MCP
clients can step up.

The `execute` sandbox has no network (`globalOutbound: null`) and no env
access, and never sees the credential. Each tool call re-enters the host,
where rights (active admin, not disabled, scope) are checked again. The
caller's identity reaches the host-side entrypoint only through `ctx.props`,
which the host sets when it creates the stub; sandboxed code can't see or
forge props, so it can't impersonate another admin or lift a read-only
restriction. The sandbox's return value is parsed and shape-checked rather
than trusted, because model-written code produced it (`src/mcp/sandbox.ts ›
IdCodeSandbox.callTool, parseOutcome`).

## What v1 does NOT do (and why that's fine)

- **Rate limiting is layered.** The Workers Rate Limiting bindings (per IP,
  per location) slow ceremony, authorization and registration spam. `/setup`
  and `/register` fail closed when `AUTH_LIMITER` is absent; other endpoints
  still benefit from an edge WAF backstop (DEPLOY.md). An hourly cron purges
  expired rows, so transient spam is bounded by storage quota and cleanup.
- **Key rotation is two secrets, not a UI.** Publish the old key as
  `SIGNING_KEY_JWK_PREVIOUS` while the new one signs (DEPLOY.md). Tokens last
  1 hour, which bounds the overlap.
- **IPs are hashed** (`ip_hash`) in sessions and audit logs: enough for the
  admin to spot anomalies, not enough to be a PII honeypot.
- **Audit log is bounded** to 365 days or the newest 50k events, enforced by
  the hourly cron (not on every write, which used to scan the table each
  time). CSV export neutralizes spreadsheet formula injection before quoting
  each cell (`src/admin/audit.tsx › auditCsv`).
- **CSP is strict, except for `form-action`.** There is no inline script or
  style anywhere. `form-action` is omitted on purpose: the consent POST
  answers with a 302 to the client's redirect URI, browsers apply
  `form-action` to that redirect, and native clients use schemes such as
  `cursor://` and `vscode://` that no allowlist can enumerate. All forms are
  server-rendered with escaped content, so there is no injected form for
  `form-action` to stop.
