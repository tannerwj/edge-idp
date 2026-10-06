# Deploying your own instance

A friend should be able to go from clone to a live personal identity provider
in about fifteen minutes. Every instance-specific value is marked `REPLACE_` in
`wrangler.toml` — nothing personal is hardcoded in source.

## Prerequisites

- A Cloudflare account with Workers + D1 (free tier is fine)
- Node 22+, `npm`, and `wrangler` (installed as a devDependency)

## 1. Clone and install

```bash
git clone https://github.com/tannerwj/identity
cd identity
npm install
```

## 2. Log in to Cloudflare

```bash
npx wrangler login
```

## 3. Create the D1 database

```bash
npx wrangler d1 create identity
```

Copy the `database_id` from the output into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "identity"
database_id = "PASTE_IT_HERE"
```

## 4. Fill in your instance values

In `wrangler.toml`:

```toml
[vars]
ISSUER = "https://auth.yourdomain.com"   # no trailing slash; must be https
RP_NAME = "Your Identity"                # shown on the sign-in pages
```

The worker refuses to serve until these are set (fail-closed).

## 5. Generate the signing key

```bash
node scripts/gen-key.mjs
```

Store the printed JWK as a secret (never commit it, never put it in `wrangler.toml`):

```bash
npx wrangler secret put SIGNING_KEY_JWK
# paste the JSON when prompted
```

Keep an offline backup. Losing it invalidates every issued token; rotating it
is just generating a new one and repeating this step (tokens live 1 hour, so
the blast radius is small).

## 6. Apply the migrations

```bash
npm run db:migrate        # remote D1
# npm run db:migrate:local  # for local dev
```

Wrangler never auto-applies migrations — if you add one later, run this again
and verify the tables exist (`npx wrangler d1 execute identity --remote
--command "SELECT name FROM sqlite_master WHERE type='table'"`).

## 7. Deploy

```bash
npm run deploy   # builds the browser client bundle, then wrangler deploy
```

Your worker is now live at `identity.<your-subdomain>.workers.dev`.

## 8. Attach your custom domain

In the Cloudflare dashboard for your zone:

1. **Workers Routes → Add route**: `auth.yourdomain.com/*` → worker `identity`.
2. **DNS → Add record**: CNAME `auth` → `identity.<your-subdomain>.workers.dev`, proxied (orange cloud) on.

Or via API:

```bash
# route on the zone
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/workers/routes" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  --data '{"pattern":"auth.yourdomain.com/*","script":"identity"}'
# proxied DNS record
curl -X POST "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/dns_records" \
  -H "Authorization: Bearer <API_TOKEN>" -H "Content-Type: application/json" \
  --data '{"type":"CNAME","name":"auth","content":"identity.<sub>.workers.dev","proxied":true}'
```

## 9. Create the first admin

```bash
npm run seed:admin -- --email=you@example.com --name="Your Name"
```

This inserts you as an admin and prints a one-time enrollment link (valid 7
days). Open it, set up your passkey — you're in. Then visit `/admin` to create
users, groups, and apps.

## 10. Harden the edge (recommended)

In the Cloudflare dashboard, add **Security → WAF → Rate limiting rules** for
`auth.yourdomain.com`:

- `/webauthn/*` — e.g. 20 requests/min per IP (slows challenge-spam)
- `/token` — e.g. 30 requests/min per IP

The worker itself does opportunistic cleanup of expired challenges; edge rate
limiting is the real DoS backstop (see `docs/THREAT_MODEL.md`).

## 11. Register it in Cloudflare Access (Zero Trust)

Zero Trust dashboard → **Access → Identity providers → Add new → OpenID Connect**:

| Field              | Value                                              |
|--------------------|----------------------------------------------------|
| Auth URL           | `https://auth.yourdomain.com/authorize`            |
| Token URL          | `https://auth.yourdomain.com/token`                |
| Certificate URL    | `https://auth.yourdomain.com/jwks`                 |
| Client ID          | (from your app's registration — see below)         |
| Client Secret      | (shown once at registration)                      |
| PKCE               | **On** (the server requires S256 on every flow)    |
| Email claim name   | `email` (default)                                  |
| Scopes             | `openid profile email groups`                      |

Then register each app: open `https://auth.yourdomain.com/admin` → **Apps** →
**Register app** with the redirect URI
`https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback`, copy the
client ID + secret into the IdP form above, and optionally restrict the app to
groups (e.g. `family`, `finance`). Access policies can then match on those
groups — they arrive in the ID token's `groups` claim.

## Local development

```bash
npm run dev   # builds the client, applies nothing — run db:migrate:local once
```

`.dev.vars` (gitignored) holds local secrets:

```
SIGNING_KEY_JWK='<output of scripts/gen-key.mjs>'
ISSUER="http://127.0.0.1:8787"
RP_NAME="Dev Identity"
```

Note: WebAuthn ceremonies need a real browser context, so the full passkey
flow is tested against a deployed URL (see `tests/e2e/`); `npm test` covers
unit tests and `node tests/e2e/api.mjs` covers the OIDC API against local dev.
