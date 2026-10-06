# Identity — “Sign in with Johnson”

A minimal, passkey-only OIDC identity provider on Cloudflare Workers + D1.
Users authenticate once with a passkey; Cloudflare Access — configured with
this server as a generic OIDC IdP — enforces per-app access. The server does
identity; Access does enforcement.

**Portable by design:** clone the repo, run migrations, set a few config
values, `wrangler deploy`, and run your own instance on your own Cloudflare
account. See [DEPLOY.md](DEPLOY.md).

## What it does

- Admin-managed users (name + email); users enroll passkeys via one-time links
- Passkey registration + authentication (SimpleWebAuthn v14, Face ID / Touch ID first-class)
- OIDC: `/.well-known/openid-configuration`, `/jwks`, `/authorize`, `/token`, `/userinfo` — authorization code + mandatory PKCE S256
- OIDC client registry (admin registers apps: name, exact redirect URIs, allowed groups)
- Groups → `groups` claim in ID tokens, so Access policies can match on them
- Minimal admin UI: users, groups, apps, audit log
- Account recovery: admin-assisted (revoke keys + fresh enrollment link)

## What it deliberately doesn't do

Passwords, TOTP, magic links. SAML, LDAP, social logins. Refresh tokens.
Consent screens (clients are admin-registered; the passkey ceremony is the
consent). See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the reasoning.

## Develop

```bash
npm install
npm run build:client   # bundle the browser passkey client
npm run dev            # wrangler dev (local D1)
npm test               # unit tests
node tests/e2e/api.mjs # OIDC API e2e against local wrangler dev
npm run typecheck
npm run gates          # abacus quality gates
```

## Layout

```
src/
  index.ts      # app assembly, security-headers middleware, page routes
  oidc.ts       # discovery, JWKS, /authorize, /token, /userinfo
  webauthn.ts   # passkey ceremonies + enrollment tokens
  session.ts    # IdP browser sessions (hashed tokens, sliding expiry)
  admin.tsx     # admin UI (users, groups, apps, audit log)
  pages.tsx     # sign-in / enrollment / account pages
  crypto.ts     # RS256 token minting (jose), JWKS
  db.ts         # D1 access helpers
  client/webauthn.ts  # browser bundle (esbuild → public/webauthn.js)
migrations/     # D1 schema (applied manually — wrangler never auto-applies)
scripts/        # build-client, gen-key, seed-admin
tests/          # unit + e2e
```

## License

MIT — see [LICENSE](LICENSE).
