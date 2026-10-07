# Deploying your own instance

## One click

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tannerwj/edge-idp)

Cloudflare copies the repo into your GitHub, creates the Worker and its D1
database from `wrangler.jsonc`, and asks for one secret:

- **SETUP_TOKEN**: generate a 32-byte random base64url value with
  `node scripts/gen-setup-token.mjs`. Back it up in a password manager. The
  Worker retains it to encrypt its D1-held signing key after setup. It must
  match `^[A-Za-z0-9_-]{43,}$` (43 characters is what 32 random bytes
  encode to). Length is only a minimum: always generate it, never pick one by
  hand. `/setup` stays closed until a token of that length is set.

Every deploy (including later pushes to your copy) runs `npm run deploy`.
Under Workers Builds (`WORKERS_CI=1`) that builds the browser bundle, applies
the D1 migrations with `wrangler d1 migrations apply DB --remote`, and runs
`wrangler deploy` with `wrangler.jsonc`. Migrations are addressed by the
binding name `DB`, so they work whatever you named the database. When it's
live:

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
   - Rename the instance in Admin → Settings → Name.
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
key is in use; restoring the database also requires the matching secret. If
the Worker can't decrypt the D1 key, `SETUP_TOKEN` has changed: restore the
original value, or set `SIGNING_KEY_JWK` to supply a key directly.

Installs from before October 7, 2026 with a plaintext `signing_keys.current`
row must follow the
[archived upgrade notes](docs/archive/upgrade-notes-2026-10.md) first; the
Worker refuses that legacy row rather than keep using an exposed key.

## Staying up to date

The button made your repo as a copy, not a GitHub fork, so it doesn't follow
upstream on its own. Admin → Overview tells you when a newer version is out
(the hourly job checks this repo's version once a day). To update:

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

**The update check and `UPSTREAM_REPO`.** Once a day the cron sends one GET to
`raw.githubusercontent.com` for upstream's `package.json`, which exposes the
configured repo name and normal request metadata to GitHub. Set the
`UPSTREAM_REPO` var to `off` to disable both the check and the feedback links
below. A fork that becomes its own project should set `UPSTREAM_REPO` to its
own `owner/repo`.

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
- `ISSUER`: `"https://auth.yourdomain.com"` (no trailing slash, no path; must
  be https). The passkey RP ID is its hostname, so pick the permanent one now.
- `RP_NAME`: the default name shown on the sign-in pages (admins can change
  it later in Admin → Settings)
- the `triggers.fetch` route: `auth.yourdomain.com/*` on your zone

The worker refuses to serve until ISSUER is set correctly (fail-closed).

## 5. Generate the signing key

```bash
node scripts/gen-key.mjs > key.json      # back this up offline (e.g. 1Password)
npx cf workers secrets update SIGNING_KEY_JWK --worker identity --type secret_text --text "$(cat key.json)"
rm key.json
```

The output is an RSA-2048 RS256 private JWK with `use: sig` and a `kid` of
`sig-<16 hex>`. Never commit it or put it in the config. Losing it invalidates
every issued token. Rotation is covered under _Rotating the signing key_
below.

## 6. Apply the migrations

```bash
npm run db:migrate          # remote D1 (production)
npm run db:migrate:local    # local dev database (.wrangler/state)
npm run staging:migrate     # remote staging D1 (same as db:migrate -- --stage=staging)
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

Outside Workers Builds, `npm run deploy` builds the browser bundle and runs
`cf deploy` with `cloudflare.config.ts`, passing extra arguments through
(`npm run deploy -- --mode staging`). Because that config is pinned to one
account, running it from an unconfigured fork fails safely. `cf deploy`
attaches the route from `cloudflare.config.ts` and applies the cron
trigger. The route's hostname needs a proxied DNS record. If there isn't one
yet, add an `AAAA` record for `auth` pointing to `100::`, with the proxy (orange
cloud) on.

## 8. Create the first admin

```bash
npm run seed:admin -- --email=you@example.com --name="Your Name"
```

This inserts you as an admin and prints a one-time enrollment link (valid 7
days). Open it, set up your passkey, and you're in. Then visit `/admin` to
create users, groups, and apps.

Run it after the migrations. It targets remote production by default; add
`--local` for the local database or `--stage=staging` for staging. The link
uses `ISSUER` from `.dev.vars` with `--local`, otherwise the stage's issuer in
`cloudflare.config.ts`, and the script refuses to run while that issuer still
contains `REPLACE`.

## 9. Harden the edge (recommended)

`cloudflare.config.ts` declares two Workers Rate Limiting bindings:

- `AUTH_LIMITER`, 30/min per IP: passkey ceremonies, `/register`, consent,
  `/setup`;
- `API_LIMITER`, 300/min per IP: `/authorize`, `/token`, `/revoke`, `/mcp`.

The limits are deliberately generous because Claude's connector egress
(`160.79.104.0/21`) shares IPs across many users. Keep both bindings. `/setup` and `/register` return 503 without
`AUTH_LIMITER`; other paths skip a missing limiter. For a hard backstop, add **Security → WAF
→ Rate limiting rules** for `auth.yourdomain.com` on `/webauthn/*` and
`/token`.

Don't put a WAF challenge or Bot Fight Mode in front of `/token`,
`/.well-known/*`, `/register` or `/mcp`. Claude's connector backend calls them
server-to-server from `160.79.104.0/21` and can't solve challenges.

The hourly cron (`triggers.scheduled` in `cloudflare.config.ts`, minute 17)
purges expired codes, sessions, challenges, enrollment links and refresh
tokens, enforces audit retention (365 days or 50,000 events) and MCP call
metrics retention (30 days), and removes dynamically registered clients that
are older than 30 days and were never consented to. It also runs the daily
upstream version check. The full list is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#data-model-and-maintenance).

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
add them to the launcher in one click, connect a read-only Cloudflare API token
in **Admin → Settings → Cloudflare Access**. The page explains how to create
the token; it needs only two account permissions: **Access: Apps and Policies
→ Read** and **Access: Organizations, Identity Providers, and Groups → Read**.
The account ID is detected from the token (enter it if the token can see more
than one account). The token is tested against Cloudflare before it's saved
and is never shown again; Disconnect removes it.

To keep the token out of D1 instead, set it as Worker secrets; they take
precedence and the Settings card then shows the connection as managed by the
secret:

```bash
npx cf workers secrets update CF_API_TOKEN --worker identity --type secret_text --text "$CF_ACCESS_READ_TOKEN"
```

plus `CF_ACCOUNT_ID: bindings.text("<your account id>")` in the worker's `env`
(or under `vars` in `wrangler.jsonc`). Either way the integration is
read-only: Access stays the source of truth for its policies.

## 12. Optional: error tracking with Sentry

Set a `SENTRY_DSN` secret to send unhandled errors to Sentry (10% of requests
are traced):

```bash
npx cf workers secrets update SENTRY_DSN --worker identity --type secret_text --text "<your DSN>"
```

Admin → Settings shows whether Sentry is on. Without the secret, errors still
go to Workers Logs.

## Configuration reference

Vars and bindings live in `cloudflare.config.ts` (or `wrangler.jsonc` for
one-click installs). Secrets are set with `npx cf workers secrets update
<NAME> --worker identity --type secret_text --text …` (or in the dashboard)
and are never committed.

| Name                          | Kind                  | Required                                        | Purpose                                                                                                                                          |
| ----------------------------- | --------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ISSUER`                      | var                   | reference: yes; one-click: no (pinned at setup) | Public base URL, https, no trailing slash or path. Plain-http `localhost` is allowed for local dev.                                              |
| `RP_NAME`                     | var                   | no (defaults to "Identity")                     | Default instance name; Admin → Settings overrides it. Shown on sign-in and enrollment pages and in passkey managers.                             |
| `SIGNING_KEY_JWK`             | secret                | reference: yes; one-click: no                   | RS256 private JWK from `scripts/gen-key.mjs`. Always wins over the D1 key.                                                                       |
| `SIGNING_KEY_JWK_PREVIOUS`    | secret                | no                                              | Previous key during a rotation; published in JWKS, never used to sign.                                                                           |
| `SETUP_TOKEN`                 | secret                | one-click: yes                                  | Authorizes `/setup` and encrypts the generated D1 signing key. Keep it after setup and back it up separately from D1.                            |
| `SENTRY_DSN`                  | secret                | no                                              | Sentry error tracking.                                                                                                                           |
| `CF_API_TOKEN`                | secret                | no                                              | Read-only Cloudflare Access integration. Usually set in Admin → Settings instead; the secret wins when both exist.                               |
| `CF_ACCOUNT_ID`               | var                   | no                                              | Account for the Access integration. Detected from the token when connected in Settings.                                                          |
| `UPSTREAM_REPO`               | var                   | no                                              | `owner/repo` for feedback links and the update check, or `off`. Defaults to the upstream project.                                                |
| `DB`                          | D1 binding            | yes                                             | The database.                                                                                                                                    |
| `AUTH_LIMITER`, `API_LIMITER` | rate-limit bindings   | recommended                                     | See section 9. `/setup` and `/register` return 503 without `AUTH_LIMITER`.                                                                       |
| `LOADER`                      | Worker Loader binding | no                                              | MCP code mode (`execute`). The reference config always binds it; `wrangler.jsonc` leaves it commented out. Without it, `execute` is not offered. |

The Worker refuses to serve if `ISSUER`, `RP_NAME` or the signing key is still
missing after it fills in defaults, or still contains the placeholder
`REPLACE`; the error names the key. How defaults are resolved per request is
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#configuration-and-per-request-env).

## Rotating the signing key

1. `node scripts/gen-key.mjs` creates a fresh key with a unique `kid`. Keep the
   old private key offline during the overlap.
2. Store the **current** key as `SIGNING_KEY_JWK_PREVIOUS` (`npx cf workers secrets update SIGNING_KEY_JWK_PREVIOUS --worker identity --type secret_text --text "$(cat old.json)"`).
3. Store the **new** key as `SIGNING_KEY_JWK` the same way.

Both public keys are now in JWKS. New tokens are signed with the new key, and
old tokens keep verifying until they expire (at most 1 hour).

4. After an hour, `npx cf workers secrets delete SIGNING_KEY_JWK_PREVIOUS --worker identity`.

To roll back during the overlap, swap the two secrets back.

## Upgrading and rollback

```bash
git pull
npm run db:migrate     # migrations are additive; the previous version runs on the new schema
npm run deploy
npm run smoke
```

**Rollback:** point the Worker back at the previous version. Cloudflare keeps
every uploaded version, so no rebuild is needed, and the schema stays:

```bash
npx cf workers deployments list --worker identity        # find the prior version_id
npx cf workers deployments create --worker identity --strategy percentage \
  --versions '[{"version_id":"<previous version_id>","percentage":100}]'
```

Take a D1 Time Travel bookmark before migrating
(`npx cf d1 time-travel get-bookmark <database id>`) so data can be restored
too if it ever has to be.

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
them. Both workarounds and when to remove them are listed in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#tooling).

`npm run test:e2e` runs the full suite and the OIDC API suite, each in its own
throwaway instance: real passkey ceremonies via a virtual authenticator, OIDC,
OAuth/MCP, and security regressions. All suites are described in
[docs/TESTING.md](docs/TESTING.md).

## Staging

A second Worker (`identity-staging`, workers.dev only, its own D1) runs the
same e2e suite against real Cloudflare: real D1, rate limiters, the sandbox
loader and the edge. Its values live in the `staging` entry of `STAGES` in
`cloudflare.config.ts`; `--mode staging` selects it, and `--stage=staging`
does the same for the npm scripts. Scripts read `STAGES` as text, so keep its
layout (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#tooling)). Production
keeps both its zone route and workers.dev enabled; staging is workers.dev only,
with no route.

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
fires at :17 and shows up in Workers Logs. Rate-limit namespace ids are unique
per account, so staging uses its own pair (2001/2002, production 1001/1002).
Preview URLs are off because a preview hostname isn't the issuer and passkeys
wouldn't work on it.

Smoke checks work against any stage: `npm run smoke` (production issuer),
`npm run smoke -- --stage=staging`, or `E2E_BASE_URL=https://… npm run smoke`.
