# Deploying your own instance

## One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tannerwj/edge-idp)

Cloudflare copies the repo into your GitHub, creates the Worker and its D1
database from `wrangler.jsonc`, and asks for one secret:

- **SETUP_TOKEN**: generate a 32-byte random base64url value with
  `node scripts/gen-setup-token.mjs`. Back it up in a password manager. The
  Worker retains it to encrypt its D1-held signing key after setup.

Every deploy (including later pushes to your copy) runs `npm run deploy`,
which applies the D1 migrations and then `wrangler deploy`. When it's live:

1. Choose the permanent hostname first. For a custom domain, configure it and
   set `ISSUER` in `wrangler.jsonc` before enrollment. Otherwise open
   `https://edge-idp.<your-subdomain>.workers.dev`; a fresh install sends you
   to **/setup**.
2. Enter the setup token, your name and email, then create your passkey.
   You're the admin; /setup closes while this database has a user. Preserve
   the database and setup secret together: restoring an empty database
   reopens first-run setup.
3. Optional:
   - A later hostname or issuer change needs a planned migration: existing
     passkeys are bound to the old RP ID and clients use the old issuer.
   - Rename the instance with `RP_NAME`.
   - Turn on MCP code mode by adding the `worker_loaders` binding (commented
     out in `wrangler.jsonc`).
   - Do the edge hardening in section 9 below.

Your copy also contains `cloudflare.config.ts`, which belongs to the
reference instance and is pinned to its Cloudflare account. Delete it (or
replace its values with yours if you want the `cf` CLI path below); Workers
Builds only reads `wrangler.jsonc`.

What the one-click install fills in for you: before setup, `ISSUER` defaults
to the request origin. Setup pins it in D1; other hostnames redirect to that
origin. The token-signing key is generated on first use and AES-GCM encrypted
in D1 with the `SETUP_TOKEN` Worker secret. D1 read access alone cannot export
the signing key. To use your own key instead, set the `SIGNING_KEY_JWK`
secret; it always wins. Do not rotate or remove `SETUP_TOKEN` while that D1
key is in use; restoring the database also requires the matching secret.

Before updating an **existing portable installation** that has a plaintext
`signing_keys.current` row, follow [Portable signing-key upgrade](#portable-signing-key-upgrade).
The new Worker intentionally refuses that legacy row instead of silently
continuing with an exposed signing key.

## Staying up to date

The button made your repo as a copy, not a GitHub fork, so it doesn't follow
upstream on its own. Admin → Overview tells you when a newer version is out
(the hourly job checks this repo's version once a day; set the `UPSTREAM_REPO`
var to `off` to disable). To update:

```bash
git clone https://github.com/<you>/<your-copy> && cd <your-copy>
git remote add upstream https://github.com/tannerwj/edge-idp.git
git fetch upstream
git merge upstream/master
# First time only, if Git refuses with "unrelated histories":
#   git merge upstream/master --allow-unrelated-histories
# Keep your own wrangler.jsonc on a conflict (it holds your database id),
# then copy over any new bindings from upstream's version:
#   git checkout --ours wrangler.jsonc && git add wrangler.jsonc && git commit
git push
```

The push redeploys through Workers Builds, and `npm run deploy` applies any
new migrations first.

**Feedback goes upstream without a fork:** Admin → Settings → About has
"Report a bug" (it fills in your version) and "Suggest a feature", both
opening issues on [tannerwj/edge-idp](https://github.com/tannerwj/edge-idp).
To contribute code, see [CONTRIBUTING.md](CONTRIBUTING.md).

## By hand, with the cf CLI

A friend should be able to go from clone to a live personal identity provider
in about fifteen minutes. Every instance-specific value lives in
`cloudflare.config.ts`; nothing personal is hardcoded in source.
(`wrangler.jsonc` is the template the button uses. `cf` reads
`cloudflare.config.ts` and ignores it.)

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
token. Rotation is covered under _Rotating the signing key_ below.

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
npm run deploy         # builds the browser bundle, then cf deploy (wrangler in Workers Builds)
npm run smoke          # read-only checks against the live issuer
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

Keep both bindings. `/setup` and `/register` return 503 without
`AUTH_LIMITER`; other paths skip a missing limiter. For a hard backstop, add **Security → WAF
→ Rate limiting rules** for `auth.yourdomain.com` on `/webauthn/*` and
`/token`.

Don't put a WAF challenge or Bot Fight Mode in front of `/token`,
`/.well-known/*`, `/register` or `/mcp`. Claude's connector backend calls them
server-to-server from `160.79.104.0/21` and can't solve challenges.

The hourly cron (`triggers.scheduled` in `cloudflare.config.ts`) purges expired codes,
sessions, challenges and refresh tokens, and enforces audit retention.

## 10. Register it in Cloudflare Access (Zero Trust)

Zero Trust dashboard → **Access → Identity providers → Add new → OpenID Connect**:

| Field            | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| Auth URL         | `https://auth.yourdomain.com/authorize`                                   |
| Token URL        | `https://auth.yourdomain.com/token`                                       |
| Certificate URL  | `https://auth.yourdomain.com/jwks`                                        |
| Client ID        | (from your app's registration — see below)                                |
| Client Secret    | (shown once at registration)                                              |
| PKCE             | **Off** (Access doesn't send it; register the client with PKCE unchecked) |
| Email claim name | `email` (default)                                                         |
| Scopes           | `openid profile email groups`                                             |
| OIDC Claims      | add `groups` so policies can match on it                                  |

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

1. `node scripts/gen-key.mjs` creates a fresh key with a unique `kid`. Keep the
   old private key offline during the overlap.
2. Store the **current** key as `SIGNING_KEY_JWK_PREVIOUS` (`npx cf workers secrets update SIGNING_KEY_JWK_PREVIOUS --worker identity --type secret_text --text "$(cat old.json)"`).
3. Store the **new** key as `SIGNING_KEY_JWK` the same way.

Both public keys are now in JWKS. New tokens are signed with the new key, and
old tokens keep verifying until they expire (at most 1 hour).

4. After an hour, `npx cf workers secrets delete SIGNING_KEY_JWK_PREVIOUS --worker identity`.

To roll back during the overlap, swap the two secrets back.

## Portable signing-key upgrade

This is required only for portable instances installed before D1 key
encryption. Plan a maintenance window before merging an upstream update:

1. Back up the D1 database and Worker secrets securely; record the
   current issuer and public JWKS `kid`. Set that exact issuer as the explicit
   `ISSUER` variable before upgrading if this existing install has no D1
   issuer pin. The new Worker fails closed on an initialized database without
   an explicit or pinned issuer. Keep private JWK data out of logs,
   issue comments, and command output. Confirm you can restore the backup.
2. While the old Worker still runs, move the **existing** private key from
   `signing_keys.current` into the `SIGNING_KEY_JWK_PREVIOUS` Worker secret.
   Use an operator-controlled secret transfer; never paste it into a shell
   command or commit it. Verify that JWKS still publishes its public key.
3. Generate a fresh key with `node scripts/gen-key.mjs`, store it as the
   `SIGNING_KEY_JWK` Worker secret, and verify JWKS publishes both old and new
   `kid` values. New tokens now use the new key. Existing tokens remain valid
   for their one-hour lifetime through the previous key.
4. Deploy the new code and additive migrations. Check health, discovery,
   passkey login, token issuance, and JWKS on the canonical hostname. After
   at least one hour, remove `SIGNING_KEY_JWK_PREVIOUS` and verify the old
   `kid` is gone. Retain the new secret and its offline backup. The old
   plaintext D1 row and historical backups still contain the former private
   key; restrict and retire them under your backup policy.

`SIGNING_KEY_JWK` takes precedence over the legacy D1 row, so this path
avoids the new code's fail-closed error. Installing a fresh `SETUP_TOKEN` does
not repair a legacy plaintext row. If a step fails, restore the last working
Worker version and matching secrets; restore D1 only from a verified backup
when needed. Never change the issuer as part of a key upgrade.

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
ISSUER="http://localhost:8787"
RP_NAME="Dev Identity"
# optional for the reference config; otherwise the SETUP_TOKEN secret is
# required to encrypt a generated local D1 key
SIGNING_KEY_JWK='<output of scripts/gen-key.mjs>'
```

`ISSUER` is required here because `cloudflare.config.ts` sets the production
one. For a fork without that file, `wrangler dev` with `wrangler.jsonc` needs
a generated `SETUP_TOKEN` (see `npm run test:e2e:setup`).

Use `localhost`, not `127.0.0.1`. It's a secure context, so passkeys work
locally over plain http, and the issuer check allows it. Seed yourself with
`node scripts/seed-admin.mjs --local --email=… --name=…`. Local D1 lives in
`.wrangler/state`; the scripts pin it there because `cf dev` reads that
location while `cf d1 --local` defaults elsewhere (cf beta). Local `cf d1`
commands also don't exit on their own yet, so `scripts/cf-local.mjs` wraps
them.

`npm run test:e2e` runs the full suite in its own throwaway instance:
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
