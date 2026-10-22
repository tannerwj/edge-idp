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
in one move, at the cost that account recovery goes through a fresh
enrollment link, sent by an admin or, if an admin allows it, by email
(see _Account recovery_). Users are nudged to enroll two passkeys (phone and
laptop) so losing one device is a non-event.

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

User verification (Face ID, Touch ID, a PIN) is **required** by default for
registration and authentication: `userVerification: "required"` in the options
and `requireUserVerification: true` at verify. Owning or touching the device
should not be enough to authenticate to a service that is the root of trust
for every app.

Admins can relax this for **sign-in only** (Settings › Security, "Sign in
without Face ID, Touch ID or a PIN"), which asks for `discouraged`. The cost is
explicit in the UI: a found or stolen unlocked device or security key is then
enough to sign in. Whether the biometric prompt actually disappears is the
passkey provider's decision; Apple's passkeys usually still ask. Registration,
sign-up and passkey rechecks always require verification, so the relaxed
setting never weakens step-up. The requirement is decided when the challenge is
issued and stored with it; verify enforces the stored value, never anything
the browser sends (`src/webauthn.ts › /auth/options, verifyAssertion`). ID
tokens keep `amr: ["pop", "user"]`: RFC 8176 defines `user` as a user-presence
test, which every WebAuthn assertion includes, so the claim stays accurate
either way (`src/crypto.ts › mintIdToken`).

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
`mcp` / `mcp:read` scopes are admin-only regardless of client. A client linked to a launcher app ignores its own
groups and admits exactly the users that app's grants cover, so "who can open
it" is decided in one place for the launcher, the client and the token's
roles. The same policy is applied at authorization, code redemption and
refresh (`src/oauth-shared.ts › clientAccessProblem`). Consent is remembered per
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
from `client_id` or a verified `id_token_hint`), and only for admin-registered
clients. Anyone can register a client through DCR or CIMD, so honoring their
redirect URIs would hand an attacker a redirect from the IdP's hostname. Only
https and http loopback origins count: every custom scheme (`cursor://`,
`javascript:`) has the opaque origin `"null"`, which would otherwise match
everything opaque. Anything else falls back to the sign-in page, so
`/end-session` cannot be used as an open redirect
(`src/oidc.tsx › postLogoutTarget, webOrigin`).

The `next` parameter on `/login` accepts only same-origin relative paths.
Values starting with `//` (protocol-relative) or `/\` (which browsers treat as
`//`) fall back to `/`, so a fresh login can never be redirected off-site
(`src/index.tsx › safeNext`).

## Client secret pickup

`apps_connect` (and `clients_rotate_secret` with `pickup: true`) never return
a client secret to the MCP caller, so it never enters an AI tool's context or
transcript. They return a one-time pickup token instead; the agent POSTs it to
`/client-secret/pickup` from a shell and pipes the response straight into the
app's configuration. The token is 256-bit, single use (a `DELETE … RETURNING`
consumes it, so two racing pickups can't both get the secret), expires after
10 minutes, and travels in the POST body, never a URL. The row stores the
secret AES-GCM-encrypted under a key derived from the token, and only the
token's hash, so a D1 read during those 10 minutes yields nothing usable. The
endpoint is rate-limited with the authentication budget, unused rows are
purged by the hourly cron, and each pickup is audited
(`src/secret-pickup.ts`). The admin UI still shows a new secret once, on
screen, to the admin.

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
every connect. At most 1,000 such unused registrations exist at a time; beyond
that `/register` answers 503 until the cron or consents free room, so a
registration flood from many IPs (which the per-IP limit can't stop) is
bounded in storage, at the cost of new DCR clients waiting during the flood
(`src/oauth-clients.ts › tooManyPendingClients`). Both onboarding paths can be
switched off in Settings.

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

Admins are the accounts this matters most for, and the admin UI can mint
credentials and privilege on its own, so sensitive admin actions need the same
recheck: inviting people, enrollment links, passkey resets and removals, role
and member changes, email edits, API tokens, OAuth client create/edit/rotate,
and every Settings change (`src/admin/index.ts › SENSITIVE`). Without one the
admin is sent to confirm with their passkey and back to the page. So is
`/authorize` for the `mcp` and `mcp:read` scopes, because otherwise a stolen
session could finish an OAuth flow with a client the attacker registered and
leave with an admin MCP token (`src/oidc.tsx › needsAdminStepUp`; `prompt=none`
gets `login_required`). Admins can't mint enrollment links for, reset, or
remove passkeys from their own account at all; that is what Account & security
is for (`src/ops.ts › mintEnrollmentLink, revokePasskeys, removePasskey`).

The recheck window is a setting (Settings › Security): 5 minutes by default,
15 minutes, an hour, or off for installs that accept the trade. Changing it is
itself a sensitive action, so a stolen session can't relax it first. The
security settings are readable over MCP but changeable only in the admin UI,
like the Cloudflare token. MCP `settings_set` can still change the name,
accent and the DCR/CIMD toggles: an MCP credential is already an admin
credential that took a recheck to mint (an API token or an `mcp`-scoped
grant), which stands in for the UI's per-action recheck. With the recheck off
and sign-in verification relaxed together, an unlocked device that holds an
admin's passkey is enough to do everything an admin can; the Settings copy
says so.

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
generate tokens: becoming a member is always the admin's explicit intent. A
fresh link is revealed once in the admin UI and never stored in plaintext.
Minting a link deletes the person's older unused ones in the same batch, so
at most one live link per person exists at any time; "Resend" and "Revoke"
on Admin › People › Pending invites act on that one
(`src/ops.ts › mintEnrollmentLink`, `src/invites.ts › revokeInvites`).

With email set up, the admin can have the link emailed instead of copying
it. The email carries the same bearer link, so whoever reads that inbox can
enroll a passkey, exactly as if the admin had pasted the link into a chat;
the admin still sees the link on screen as a fallback. Invites never go to a
public account (it has no address) (`src/invites.ts › deliverLink`).

## Account recovery (optional)

"Lost your passkey?" is off by default; then the sign-in page doesn't offer
it, `/recover` answers 404, and recovery is the admin sending a new
enrollment link. Settings › Sign-in › Lost passkeys has two other modes:

- **An admin approves.** The person enters their email at `/recover`; a
  pending request appears on the Overview and goes to admin alerts.
  Approving mints a one-hour enrollment link (emailed if email is on). The
  admin is asked to confirm the request really came from that person,
  because anyone can type an address in.
- **Email a link right away.** The link goes straight to the address on the
  account. This makes the inbox a way into the account: anyone who can read
  a member's email can add a passkey. The setting says so. Admins are never
  served automatically; their requests wait for another admin, and an admin
  can't approve their own.

Either way the answer at `/recover` is the same whether or not the address
exists, so it can't be used to find accounts. Public accounts and disabled
ones get nothing. The link is an ordinary enrollment link with a one-hour
TTL, so it is single-use, hashed, and replaces any older unused link; the
person's other passkeys keep working. Each person has at most one pending
request. `/recover` is on the authentication rate limit, and every request,
approval and email is audited (`src/recovery.ts`, `src/recover.tsx`).

## Alerts, webhooks and notices

Audited events can reach admins by email, any number of webhooks, and the
person concerned (Settings › Notifications). Sending happens after the
response, through `waitUntil`, so a slow or failing receiver never slows or
fails the action it reports (`src/notify.ts › dispatch`).

Webhook URLs are entered by admins but are still outbound requests from the
root of trust, so they get the same treatment as client metadata fetches:
https only, a public hostname (no IP literals, no localhost, no single-label
names), no credentials in the URL, redirects not followed, a 5-second
timeout, and the response body discarded. Plain-http loopback is accepted
only when the issuer itself is local, for development
(`src/outbound.ts › outboundUrlProblem`). A webhook can carry a signing
secret; requests then include `x-edge-idp-signature: sha256=<HMAC of the
body>`. The secret is shown to admins so the receiver can be configured.

Payloads name the person (and their email) and the app involved, so choose
where you send them. Security notices go only to the person concerned, never
to public accounts, and skip the first passkey of a new account. All of
these settings are behind the admin recheck.

## Public sign-up

An admin can mark one admin-registered client "open to the public". Its
sign-in page then offers "Create an account", which creates a **public
account**: a name and a passkey, nothing else. This is the one self-service
path, and it exists for things like games, where asking for an invitation per
player defeats the point. What keeps it safe is that a public account is
contained rather than trusted:

- **It can only reach apps that opted in.** A public account is refused at
  any client that isn't open to the public, before groups or grants are
  considered, at authorization, code redemption and refresh alike
  (`src/oauth-shared.ts › clientAccessProblem`). That includes Cloudflare
  Access, whose client admits every member. Dynamically registered and CIMD
  clients can't be opened at all.
- **It has no email.** Sign-up never asks for one and Account & security
  never offers to set one, so there is no unverified address to impersonate
  someone with. The required column holds a
  placeholder (`<id>@public.invalid`) that is never put in a token:
  `email`, `email_verified` and `preferred_username` are left out of ID
  tokens, access tokens and `/userinfo` (`src/crypto.ts › mintIdToken`).
  Access policies that match on an email can't be met by one.
- **"Everyone" means members.** Everyone grants don't cover public accounts;
  only a grant naming the account or one of its groups does
  (`src/access.ts › resolveAccess`). New accounts join the `public` group,
  which is what an admin grants a public app to.
- **It can't be an admin.** Making a public account an admin is refused;
  an admin has to make it a member first, and that is the only way out of
  the containment. "Make member" requires the person's real email, because
  from then on apps receive it as verified; the placeholder is refused
  (`src/ops.ts › makeMember`).
- **Creation is atomic and late.** The account, its passkey and its group
  membership are written in one batch only after the passkey verifies, with
  the client re-checked at that moment, so abandoned ceremonies leave nothing
  behind and closing a client takes effect immediately. The passkey must be
  discoverable, since there is no email to look it up by. The name is
  length-capped and control characters are refused, because it reaches the
  admin UI and every app's `name` claim. Both endpoints sit under
  `/webauthn/`, on the authentication rate limit (`src/signup.ts`).

Anyone who can reach an open app's sign-in can create an account; that is
the point. The cost is bounded by the rate limit, and an admin can close the
client, disable or delete accounts, or make individual ones members.

## First admin (one-click installs)

`/setup` creates the first admin, then hands off to normal passkey
enrollment. It exists only while the users table is empty and only when the
installer set a generated 32-byte base64url `SETUP_TOKEN` secret (43
characters) at deploy time. Setup refuses a token that doesn't look generated:
it must be base64url, at least 43 characters, and use at least 16 distinct
characters, which a random token always does and `aaaa…` or a short phrase
padded out doesn't (`src/setup.tsx › strongSetupToken`). The check is on setup
only, not on the D1 key encryption that also uses the token, so an existing
install with a weak token keeps running. The token is compared in constant time, the
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

Emails are set by admins unless an admin turns on self-service changes. ID
tokens assert `email_verified: true`, and Cloudflare Access policies and many
apps trust that claim to match or link accounts, so a change must prove
control of the new address, or any member could claim someone else's.
Account & security's profile form saves only the name
(`src/account.tsx › /account/profile`); an admin edit behind the recheck is
the proof by default.

Self-service change (Settings › Email, off by default, only while email is
sending) needs three things: a passkey recheck in the last 5 minutes, so a
stolen session alone can't start one; a 256-bit single-use link (hashed,
1-hour TTL, `DELETE … RETURNING`) sent to the new address, so nothing changes
until its owner opens it; and a notice to the old address afterwards, so the
owner learns about a change they didn't make. Starting a change is on the
authentication rate limit, so it can't be used to spam an inbox. The address
must still be free when the link is opened. Public accounts can't use it
(`src/email-change.ts › startEmailChange, confirmEmailChange`).

Emails are stored as entered but looked up by a lowercased key, so an admin
who retypes an existing email in different case cannot create a duplicate
account. SQLite's `lower()` folds only ASCII, so the app's key does the same
(`src/util.ts › emailKey`): A–Z case differences are ignored, other letters
must match exactly, and the stored address always finds itself
(`src/db.ts › getUserByEmail`).

## Email (optional)

Email is a delivery channel, never a credential on its own: what it carries
and when is described with each feature that sends it. The sender address
and the on/off switch are settings, so changing them needs the admin
recheck. Messages are rendered with escaping on every value, so a display
name can't inject markup into someone's inbox (`src/email.ts › renderMail`).
A failed send is reported to the admin as Cloudflare returned it and never
retried silently; nothing that needs a link depends on email arriving,
because the same link is always available to an admin as a fallback.

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
because Access never calls userinfo, so admin-registered clients get email,
name and groups whatever scopes they asked for. Clients that introduce
themselves (DCR, CIMD) get only what their scopes cover: `email` for the email
claims, `profile` for the name, `groups` for groups. A tool that asked for
`openid` alone learns the subject and nothing else
(`src/crypto.ts › mintIdToken`, `src/oauth-token.ts › tokenResponse`).

Access-grant claims follow the audience: a token says only what its recipient
needs (`src/access.ts › claimsForClient`). They go only to admin-registered
clients that request the `groups` scope, in the ID token, the access token and
`/userinfo`.

- A client linked to a launcher app (an app that signs in here itself) gets
  `roles`: the user's roles in that app and nothing else. It never learns which
  other apps exist or what the user may do in them.
- An unlinked client, in practice Cloudflare Access fronting many apps, gets
  `apps`: the slugs of the apps the user may open, so one Access policy per app
  can match on it. It gets no roles. Every app behind Access can read the
  identity Access holds, so roles there would leak each app's permissions to
  all the others, and apps that sit only behind Access can't enforce roles
  anyway.
- Clients that introduce themselves (DCR, CIMD) get `groups` when they ask for
  it, but neither claim: a third-party tool has no business learning every service in the
  household or who administers which one.

Like `groups`, these claims are read at sign-in, so Cloudflare Access sees a
grant change only when its own session for that app ends. ID tokens are verified only as an
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

Enrollment links put the bearer token in a URL fragment (`/enroll#<token>`),
from the admin UI, MCP, `/setup` and `scripts/seed-admin.mjs` alike, so the
Worker, Workers Logs and Sentry never receive it. The enrollment page sends
`Referrer-Policy: no-referrer`; the global header is set only when a route
hasn't chosen its own (`src/index.tsx › securityHeaders`). The old path-token
route (`/enroll/:token`) is gone.

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
IdCodeSandbox.callTool, parseOutcome`). A run may make at most 50 tool calls,
counted when each call starts so `Promise.all` can't overshoot it, with 1 s of
CPU and a 10 s wall-clock limit. The wall-clock limit stops waiting for the
run; Dynamic Workers have no cancel, so calls already in flight finish, each
still checked by the host.

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
