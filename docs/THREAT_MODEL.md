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

## Client authentication

Secrets are generated at 256 bits, stored as SHA-256 hashes, and compared in
constant time (`timingSafeEqualHex`) — the raw secret never meets a
short-circuiting comparison. Both `client_secret_basic` and
`client_secret_post` are accepted (Cloudflare documents neither; three
independent integrations confirm Basic). Secrets are shown once at creation;
rotation is immediate and total.

## Sessions

The cookie carries a 256-bit random token; the DB stores only its SHA-256
hash, so a database read never yields a live session. Cookies are HttpOnly,
Secure, SameSite=Lax, path-scoped. Sessions slide to 30 days, die with the
user row (cascade), and are destroyed on disable/revoke. SameSite=Lax is safe
because `/authorize` is always reached by top-level GET navigation.

## No consent screen (deliberate)

Clients are admin-registered with exact redirect URIs, and the user proved
identity with a passkey moments before `/authorize` runs — the ceremony *is*
the consent. An interstitial "Allow?" page would add a click, not security.
This decision must be revisited if self-registered/third-party clients ever
exist; until then, auto-approve is the QoL-correct call.

## Enrollment tokens

Bearer tokens (256-bit, hashed at rest), single-use, 7-day TTL, bound to one
user. The verify step checks that the token presented matches the one the
challenge was issued for, so an attacker can't piggyback their own ceremony
onto someone else's link. Admins generate them; there is no self-service
enrollment — user creation is the admin's explicit intent.

## Admin surface

Requires an authenticated session **and** `is_admin`. The first admin comes
from the seed script; later promotions happen here. Disabling a user kills
their sessions immediately; revoking keys kills sessions too, so recovery
starts from a clean slate. Admins can't disable themselves (avoids the
one-admin lockout).

## Token design

ID and access tokens are RS256 JWTs, 1-hour TTL, `aud` = the client that
asked. The access token is a JWT (not opaque) so `/userinfo` stays stateless —
it discloses only claims already in the ID token, and its bearer lifetime is
bounded by the same hour. Everything Cloudflare Access needs (email, groups)
is **in** the ID token because Access never calls userinfo.

## What v1 does NOT do (and why that's fine)

- **No in-worker rate limiting.** Per-isolate memory doesn't rate-limit
  anything on Workers. The backstop is Cloudflare edge rate-limit rules
  (documented in DEPLOY.md §10); the worker opportunistically purges expired
  challenges so spam can't grow D1 unboundedly.
- **No key rotation UI.** Rotation = new secret + redeploy; 1-hour tokens bound
  the blast radius. A rotation endpoint is a small, safe addition later.
- **No refresh tokens.** Cloudflare Access manages its own session after the
  code flow; refresh rotation is where minimal providers go to become
  non-minimal.
- **IPs are hashed** (`ip_hash`) in sessions and audit logs — enough for the
  admin to spot anomalies, not enough to be a PII honeypot.
- **Audit log is capped** at 20k rows (FIFO) — evidence, not a growth vector.
