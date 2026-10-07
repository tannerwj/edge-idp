# Deploying your own instance

A friend should be able to go from clone to a live personal identity provider
in about fifteen minutes. Every instance-specific value lives in
`cloudflare.config.ts`; nothing personal is hardcoded in source.

Tooling is Cloudflare's [`cf` CLI](https://github.com/cloudflare/cf)
(installed as a devDependency). `wrangler` is still installed, but only as the
bundler that `cf` calls. You never log into it or run it directly.

## Prerequisites

- A Cloudflare account with Workers + D1 (free tier is fine)
- Node 22+ and `npm`

## 1. Clone and install

```bash
git clone https://github.com/tannerwj/edge-idp
cd edge-idp
npm install
```

## 2. Log in to Cloudflare, scoped to this folder

```bash
npx cf auth create personal                     # OAuth device flow; pick your account
npx cf auth activate personal "$(pwd)"           # this folder (and below) uses it
npx cf auth whoami
```

If you work in more than one Cloudflare account, this is what keeps them
apart. The profile applies only inside this directory, and `accountId` in
`cloudflare.config.ts` (step 4) makes `cf` fail rather than touch another
account. `CLOUDFLARE_API_TOKEN`, if set, overrides profiles.

## 3. Create the D1 database

```bash
npx cf d1 create --name identity
```

Copy the database `uuid` into `cloudflare.config.ts` → `DB: bindings.d1({ id })`.

## 4. Fill in your instance values

In `cloudflare.config.ts`:

- `accountId`: your account ID (`npx cf auth whoami`)
- `ISSUER`: `"https://auth.yourdomain.com"` (no trailing slash; must be https)
- `RP_NAME`: the name shown on the sign-in pages
- the `triggers.fetch` route: `auth.yourdomain.com/*` on your zone

The worker refuses to serve until ISSUER is set correctly (fail-closed).

## 5. Generate the signing key

```bash
node scripts/gen-key.mjs > key.json      # back this up offline (e.g. 1Password)
npx cf workers secrets update SIGNING_KEY_JWK --worker identity --type secret_text --text "$(cat key.json)"
rm key.json
```

Never commit it or put it in the config. Losing it invalidates every issued
token. Rotation is covered under *Rotating the signing key* below.

## 6. Apply the migrations

```bash
npm run db:migrate          # remote D1
npm run db:migrate:local    # local dev database
```

Migrations are never applied automatically. Run this again whenever you pull
new ones. `npx cf d1 migrations list <db-id>` shows what's pending.

## 7. Deploy

```bash
npm run test:e2e:staging   # optional: the full suite against staging (see Staging)
npm run deploy:check   # build + validate bindings, no upload
npm run deploy         # builds the browser bundle, then cf deploy
```

`cf deploy` attaches the route from `cloudflare.config.ts` and applies the cron
trigger. The route's hostname needs a proxied DNS record. If there isn't one
yet, add an `AAAA` record for `auth` pointing to `100::`, with the proxy (orange
cloud) on.

## 8. Create the first admin

```bash
npm run seed:admin -- --email=you@example.com --name="Your Name"
```

This inserts you as an admin and prints a one-time enrollment link (valid 7
days). Open it, set up your passkey — you're in. Then visit `/admin` to create
users, groups, and apps.

## 9. Harden the edge (recommended)

`cloudflare.config.ts` declares two Workers Rate Limiting bindings:
- `AUTH_LIMITER`, 30/min per IP: passkey ceremonies, `/register`, consent;
- `API_LIMITER`, 300/min per IP: `/token`, `/revoke`, `/mcp`.

Remove the `AUTH_LIMITER` / `API_LIMITER` bindings to turn them off; the worker skips the
check when a binding is absent. For a hard backstop, also add **Security → WAF
→ Rate limiting rules** for `auth.yourdomain.com` on `/webauthn/*` and
`/token`.

Don't put a WAF challenge or Bot Fight Mode in front of `/token`,
`/.well-known/*`, `/register` or `/mcp`. Claude's connector backend calls them
server-to-server from `160.79.104.0/21` and can't solve challenges.

The hourly cron (`triggers.scheduled` in `cloudflare.config.ts`) purges expired codes,
sessions, challenges and refresh tokens, and enforces audit retention.

## 10. Register it in Cloudflare Access (Zero Trust)

Zero Trust dashboard → **Access → Identity providers → Add new → OpenID Connect**:

| Field              | Value                                              |
|--------------------|----------------------------------------------------|
| Auth URL           | `https://auth.yourdomain.com/authorize`            |
| Token URL          | `https://auth.yourdomain.com/token`                |
| Certificate URL    | `https://auth.yourdomain.com/jwks`                 |
| Client ID          | (from your app's registration — see below)         |
| Client Secret      | (shown once at registration)                      |
| PKCE               | **Off** (Access doesn't send it; register the client with PKCE unchecked) |
| Email claim name   | `email` (default)                                  |
| Scopes             | `openid profile email groups`                      |
| OIDC Claims        | add `groups` so policies can match on it           |

Register Access **once** before filling in that form: open
`https://auth.yourdomain.com/admin` → **Clients** → **Register client**.
Choose confidential, uncheck PKCE, and use the redirect URI
`https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback`. Copy the
client ID + secret into the IdP form above. Every Access app shares this one
client, so do per-app access in each Access policy: add an **Include → OIDC
Claims** rule with `groups` = `family`, matching on groups from the admin UI.
Then make this IdP the app's only login method and enable instant auth so
nobody sees the Access chooser. **Connect** in the admin UI walks through all
of this with copy buttons.

## 11. Optional: Cloudflare Access import

To list your Access applications (and which groups their policies require) and
add them to the launcher in one click:

```bash
npx cf workers secrets update CF_API_TOKEN --worker identity --type secret_text --text "$CF_ACCESS_READ_TOKEN"
# token needs: Access: Apps and Policies Read
                                       # + Access: Organizations, Identity Providers, and Groups Read
```

Then add `CF_ACCOUNT_ID: bindings.text("<your account id>")` to the worker's `env` in `cloudflare.config.ts`. The integration
is read-only: Access stays the source of truth for its policies.

## Rotating the signing key

1. `node scripts/gen-key.mjs` and set a new `kid` in the JSON (e.g. `sig-2`).
2. Store the **current** key as `SIGNING_KEY_JWK_PREVIOUS` (`npx cf workers secrets update SIGNING_KEY_JWK_PREVIOUS --worker identity --type secret_text --text "$(cat old.json)"`).
3. Store the **new** key as `SIGNING_KEY_JWK` the same way.

Both public keys are now in JWKS. New tokens are signed with the new key, and
old tokens keep verifying until they expire (at most 1 hour).

4. After an hour, `npx cf workers secrets delete SIGNING_KEY_JWK_PREVIOUS --worker identity`.

To roll back during the overlap, swap the two secrets back.

## Upgrading from v1 (the original UI)

1. Run `npm run db:migrate`. Migration `0007_oauth_apps.sql` is additive:
   existing users, passkeys and clients are untouched, and existing clients stay
   confidential, first-party and consent-free.
2. Run `npm run deploy`.
3. Everyone signs in once more. The session cookie is now `__Host-idp_session`,
   so old cookies are ignored. Passkeys are unchanged; it's one tap.

Cloudflare Access keeps working throughout. Its client, secret and redirect
URI don't change.

**Rollback:** point the Worker back at the previous version. Cloudflare keeps
every uploaded version, so no rebuild is needed:

```bash
npx cf workers deployments list --worker identity        # find the prior version_id
npx cf workers deployments create --worker identity --strategy percentage \
  --versions '[{"version_id":"<previous version_id>","percentage":100}]'
```

The new tables and columns are ignored by v1, so the migration doesn't need
undoing. Sessions created by v2 won't be recognized by v1, so everyone signs in
once more.

## Local development

```bash
npm run db:migrate:local   # once, and after pulling new migrations
npm run dev                # http://localhost:8787
```

`.dev.vars` (gitignored) holds local config:

```
SIGNING_KEY_JWK='<output of scripts/gen-key.mjs>'
ISSUER="http://localhost:8787"
RP_NAME="Dev Identity"
```

Use `localhost`, not `127.0.0.1`. It's a secure context, so passkeys work
locally over plain http, and the issuer check allows it. Seed yourself with
`node scripts/seed-admin.mjs --local --email=… --name=…`. Local D1 lives in
`.wrangler/state`; the scripts pin it there because `cf dev` reads that
location while `cf d1 --local` defaults elsewhere (cf beta). Local `cf d1`
commands also don't exit on their own yet, so `scripts/cf-local.mjs` wraps
them.

`npm run test:e2e:local` runs the full suite in its own throwaway instance:
real passkey ceremonies via a virtual authenticator, OIDC, OAuth/MCP, and
security regressions.

## Staging

A second Worker (`identity-staging`, workers.dev only, its own D1) runs the
same e2e suite against real Cloudflare: real D1, rate limiters, the sandbox
loader and the edge. Its values live in the `staging` entry of `STAGES` in
`cloudflare.config.ts`; `--mode staging` selects it.

One-time setup:

```bash
npx cf d1 create --name identity-staging   # put the id in STAGES.staging.d1
npm run staging:migrate
# first deploy: upload a fresh signing key with the version, then delete it
(umask 077; node -e 'const k=require("child_process").execFileSync("node",["scripts/gen-key.mjs"],{encoding:"utf8"}).trim(); console.log(JSON.stringify({SIGNING_KEY_JWK:k}))' > staging-secrets.json)
npm run build:client && npx cf deploy --mode staging --secrets-file staging-secrets.json
rm staging-secrets.json
```

Then, before each production deploy:

```bash
npm run staging:migrate     # if there are new migrations
npm run staging:deploy
npm run test:e2e:staging    # wipes staging data first; refuses any other stage
```

The cron check is skipped there (it's a local-only trigger); the deployed cron
fires at :17 and shows up in Workers Logs. Staging uses its own rate-limit
namespaces (2001/2002) and has preview URLs off, because a preview hostname
isn't the issuer and passkeys wouldn't work on it.
