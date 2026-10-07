# Threat model

This server is the root of trust for its apps: whoever controls it can mint
identity for anyone. Every auth-relevant decision below gets its one-paragraph
rationale. When in doubt, the code fails closed.

## Credentials: passkeys only

There is no password column, no password reset flow, and no fallback factor.
That deletes credential stuffing, password spraying, and reset-token phishing
in one move — at the cost that account recovery is admin-assisted (revoke keys
+ fresh enrollment link). Users are nudged to enroll two passkeys (phone +
laptop) so losing one device is a non-event.

## WebAuthn ceremony integrity

Challenges are 256-bit random, single-use (deleted on read), 5-minute TTL, and
bound to the user they were issued for; the verify step re-checks the binding,
so a challenge can't be replayed or swapped between users. `expectedOrigin` is
the exact `ISSUER` origin and `expectedRPID` its hostname — a credential
registered on a lookalike domain can never verify here. Algorithms are pinned
to ES256/RS256; `userVerification` is `preferred` (Apple enforces biometrics
when present anyway; `required` would strand devices without biometrics for no
security gain). Attestation is `none` — we don't need to know the
authenticator model to trust the signature. Counters are enforced only for
credentials that have previously reported nonzero (synced passkeys sit at 0
forever; rejecting them would be a false positive).

## Authorization codes

Single-use, 60-second TTL, stored as SHA-256 hashes, and bound to the
(client, redirect_uri, PKCE challenge) triple that created them. `redirect_uri`
is compared with exact string equality against the admin-registered list —
prefix matching would let `https://app.example.com.evil.com` steal codes.
PKCE S256 is **required by default** on every flow: it's cheap defense in
depth. Confidential server-side clients that cannot send a code challenge
(e.g. Cloudflare Access) may opt out per-client (`require_pkce = 0`); the
code remains bound to the exact redirect URI and the client must still prove
possession of its 256-bit secret at the token endpoint, which preserves the
anti-interception property PKCE provides for public clients.

## Who can authorize what

Admin-registered clients are first-party: they skip consent (the passkey
ceremony is the intent) and are open to everyone unless restricted to groups.
Clients that introduce themselves — dynamic registration (RFC 7591) or a
Client ID Metadata Document (an https `client_id` URL) — are third-party:
they always get a consent screen. The screen shows the redirect host, plus the
metadata URL's domain for CIMD clients. Self-registered clients are labelled
unverified. Only admins can authorize them until an admin assigns groups. The
`mcp` / `mcp:read` scopes are admin-only regardless of client. Consent is
remembered per (user, client). Revoking it under Account → Connected apps
deletes the grant and that client's refresh tokens for the user.

## Client authentication

Secrets are generated at 256 bits, stored as SHA-256 hashes, and compared in
constant time (`timingSafeEqualHex`) — the raw secret never meets a
short-circuiting comparison. Both `client_secret_basic` and
`client_secret_post` are accepted (Cloudflare documents neither; three
independent integrations confirm Basic). Secrets are shown once at creation;
rotation is immediate and total. Public clients (`token_endpoint_auth_method:
none`) have no secret and are always held to PKCE; a public client that
presents a secret is refused rather than guessed about.

## Dynamic clients: CIMD and DCR

Fetching a CIMD document means fetching a URL chosen by whoever started the
sign-in, which makes it a server-side request forgery risk. The fetch is
limited as follows:
- https only;
- the client_id must have a path, and no userinfo, query, fragment or dot segments;
- IP-literal, localhost and single-label hosts are refused;
- redirects are not followed;
- 5 KB / 5 s limits;
- the document's `client_id` must equal the URL exactly;
- secret-based auth methods and embedded secrets are rejected.

Workers' `fetch` can't reach private networks, which covers DNS names that
resolve to internal addresses. Documents are cached as client rows, honoring
`Cache-Control` within 5 min to 7 days bounds. A stale copy is used if the
publisher is briefly down. Redirect URIs for dynamic clients may be https,
http loopback (any port, RFC 8252 §7.3) or a private-use app scheme;
`javascript:`/`data:`/`file:` and similar are rejected. Dynamically registered
clients that never received a consent are deleted after 30 days, since some
MCP clients register again on every connect. Both onboarding paths can be
switched off in Settings.

## Sessions and cross-origin requests

The cookie carries a 256-bit random token; the DB stores only its SHA-256
hash, so a database read never yields a live session. The cookie is
`__Host-idp_session`: Secure, `Path=/`, no `Domain`, so no sibling subdomain
can set or shadow it. It is also HttpOnly and SameSite=Lax. Sessions slide to
30 days, die with the user row (cascade), and are destroyed on
disable/revoke. Signing in replaces any existing session (no fixation).

SameSite is per *site*, so every other host on your domain counts as
same-site. If any of those apps were compromised, Lax alone would let it post
forms to the admin UI. Every cookie-authenticated state change therefore also
passes a same-origin check (`Sec-Fetch-Site`, falling back to `Origin`).
Bearer-authenticated endpoints (`/token`, `/mcp`, …) are exempt because they
never read cookies. `/mcp` refuses any browser `Origin` that isn't this server,
which blocks DNS-rebinding and drive-by requests.

Adding a passkey to an existing account requires a passkey ceremony in the
last 15 minutes. A stolen session cookie must not be enough to persist access
by planting a new credential.

## Consent: first-party skip, third-party always

For admin-registered clients the passkey ceremony moments before `/authorize`
*is* the consent; an extra "Allow?" click adds nothing. That reasoning stops
holding the moment clients can register themselves, so dynamic and CIMD
clients always get a consent screen (see *Who can authorize what*). Admins can
turn the screen on for any first-party client too.

## Enrollment tokens

Bearer tokens (256-bit, hashed at rest), single-use, 7-day TTL, bound to one
user. The verify step checks that the token presented matches the one the
challenge was issued for, so an attacker can't piggyback their own ceremony
onto someone else's link. Admins generate them; there is no self-service
enrollment — user creation is the admin's explicit intent.

## First admin (one-click installs)

`/setup` creates the first admin, then hands off to normal passkey
enrollment. It exists only while the users table is empty and only when the
installer set a `SETUP_TOKEN` secret (12+ characters) at deploy time. The
token is compared in constant time, the endpoint is on the AUTH rate limit and
the same-origin guard, wrong guesses are audited (`SETUP_REJECTED`), and the
insert is conditional on "no users yet", so two racing requests can't both
create an admin. After the first user exists it 404s permanently. The window
is the gap between deploy and the installer's first visit, and the attacker
would need both the Worker's hostname and the token. Instances seeded with
`scripts/seed-admin.mjs` never expose it.

## Issuer and signing key defaults

So a one-click install needs no configuration:

- **ISSUER** falls back to the request's origin. Only hostnames routed to this
  Worker reach it, so a client can't choose the issuer. Each hostname is its
  own issuer and its own passkey RP ID, so setting ISSUER after adding a custom
  domain is documented as required.
- **The signing key** falls back to one generated on first use and stored in
  D1 (`signing_keys`; never exposed by the UI, MCP or the code sandbox).
  Trade-off, accepted: D1 read access now yields a token-forging key. But D1
  access already means total control (insert an admin, mint a session), so
  the exposure barely moves. Setting the `SIGNING_KEY_JWK` secret always wins,
  and the reference instance does.

## Admin surface

Requires an authenticated session **and** `is_admin`. The first admin comes
from the seed script or `/setup`; later promotions happen here. Disabling a user kills
their sessions immediately; revoking keys kills sessions too, so recovery
starts from a clean slate. Admins can't disable themselves (avoids the
one-admin lockout).

## Token design

ID tokens are RS256 JWTs with `aud` set to the client, a 1-hour TTL, and
`auth_time` taken from the passkey ceremony (not the mint time). Everything
Cloudflare Access needs (email, groups) is **in** the ID token because Access
never calls userinfo.

Access tokens are RFC 9068 JWTs (`typ: at+jwt`, verified as such, so an ID
token can never be replayed as one). Their `aud` is the RFC 8707 resource they
were minted for. `/mcp` accepts only `aud = <issuer>/mcp` with the `mcp` or
`mcp:read` scope, and re-checks that the user is still an active admin on
every call. A token handed to some app at sign-in is therefore useless against
the admin API. That was a real hole in v1. `/userinfo` re-reads the user from
the DB, so disabled users stop resolving immediately.

Authorization codes are redeemed with a single atomic `UPDATE … WHERE used =
0 RETURNING`, so two concurrent `/token` calls can't both win.

Refresh tokens exist only for `offline_access` / `mcp` grants. They rotate on
every use, inside a family with an absolute 30-day lifetime. Presenting an
already-rotated token deletes the whole family and writes a
`REFRESH_REUSE_DETECTED` audit event (RFC 9700 §4.14). They also die with the
user's consent, admin role, or account.

## Admin API (MCP) credentials

API tokens are random, `eidp_`-prefixed (so leaked tokens are greppable),
stored as hashes, scoped (`read` / `admin`), optionally expiring, and
re-checked against their creator on every call. A demoted or disabled admin's
tokens stop working, and demotion deletes them. A read-only caller that hits a
write tool gets `403 insufficient_scope`, so MCP clients can step up. The
`execute` sandbox has no network and no env access, and never sees the
credential. Each tool call re-enters the host, where rights are checked
again.

## What v1 does NOT do (and why that's fine)

- **Rate limiting is best-effort.** The Workers Rate Limiting bindings (per IP,
  per location) slow ceremony and registration spam. WAF rules remain the hard
  backstop (DEPLOY.md). An hourly cron purges expired rows, so spam can't grow
  D1 without bound.
- **Key rotation is two secrets, not a UI.** Publish the old key as
  `SIGNING_KEY_JWK_PREVIOUS` while the new one signs (DEPLOY.md). Tokens last
  1 hour, which bounds the overlap.
- **IPs are hashed** (`ip_hash`) in sessions and audit logs — enough for the
  admin to spot anomalies, not enough to be a PII honeypot.
- **Audit log is bounded** to 365 days or the newest 50k events, enforced by
  the hourly cron (not on every write, which used to scan the table each
  time). CSV export is formula-injection safe.
- **CSP is strict, except for `form-action`.** There is no inline script or
  style. `form-action` is omitted because consent redirects to native-app
  schemes (`cursor://`) that no allowlist can enumerate. All forms are
  server-rendered with escaped content.
