# edge-idp

A passkey-only identity provider for your personal stuff, on Cloudflare
Workers + D1. One sign-in (Face ID / Touch ID / a security key) for every app
you and your people use: Cloudflare Access apps, anything that speaks OpenID
Connect, and AI assistants over MCP.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tannerwj/edge-idp)

**One click, or by hand:** the button creates the Worker and D1 database and
asks for one generated setup token; open the new URL and `/setup` makes you the admin.
Or clone, set a few values in `cloudflare.config.ts`, run migrations,
`cf deploy`. See [DEPLOY.md](DEPLOY.md).

## What you get

**For everyone who signs in**

- Passkeys only: no passwords, no codes, no reset emails to phish
- A home screen of the apps they're allowed to use
- Account & security: passkeys (with provider names like iCloud Keychain or
  YubiKey), where they're signed in, connected apps and AI tools, recent activity
- "Continue to Grafana" context on the sign-in page, and consent screens for
  third-party apps

**For you (admin)**

- People: invite with a one-time link (copy, email, share sheet, or QR for a
  phone), groups, roles, recovery (reset passkeys), disable, delete
- Groups in ID tokens and in access tokens granted the `groups` scope, so
  Access policies and authorized apps can match on them
- Apps: the launcher, with per-group visibility; optional import of your
  Cloudflare Access apps and their policies (read-only)
- Clients: OIDC/OAuth clients, both confidential and public, with exact
  redirect matching, per-client groups, PKCE and consent settings
- Overview: sign-in trends, most-used apps, and "needs attention" items (only
  one admin, people without a passkey, expiring tokens, security events)
- Audit log with categories, search and CSV export
- ⌘K command palette, light and dark modes, an accent color

**Standards**

- OIDC: discovery, JWKS (with key rotation), authorization code + PKCE S256,
  `prompt` / `max_age`, userinfo, RP-initiated logout (`end-session`)
- OAuth 2.1 for MCP:
  - RFC 8414 metadata
  - RFC 9728 protected-resource metadata
  - Client ID Metadata Documents (how claude.ai, Claude Code and VS Code identify themselves)
  - RFC 7591 dynamic registration (Cursor)
  - RFC 8707 resource indicators
  - Rotating refresh tokens with reuse detection
  - RFC 7009 revocation
  - RFC 9207 `iss` in the authorization response
- Admin MCP server (works with both the current and the 2026-07-28 protocol
  versions):
  - about 30 tools
  - a sandboxed `execute` code mode
  - read-only tokens, with step-up to write access when needed

## What it deliberately doesn't do

Passwords, TOTP, magic links, SAML, LDAP, social logins. See
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for the reasoning behind every
auth decision.

## Develop

```bash
npm install
npx playwright install chromium   # once, for the e2e suites
npx cf auth create personal && npx cf auth activate personal "$(pwd)"   # once: scope a Cloudflare login to this folder
npm run db:migrate:local          # local D1
npm run dev                       # cf dev on http://localhost:8787 (see DEPLOY.md → Local development)
```

Checks, all self-contained (each boots a throwaway local instance and leaves
nothing behind):

```bash
npm run typecheck && npm run gates   # types, lint, complexity, dead code, secrets, …
npm test                             # unit tests (parsers / algorithms only)
npm run test:e2e                     # full flow (passkeys, admin UI, OIDC, OAuth/MCP) + OIDC API suite
npm run test:e2e:setup               # the one-click install path (wrangler.jsonc, /setup)
npm run test:security                # security-review regressions (tests/security)
npm run deploy:check                 # build + validate bindings without uploading
npm run smoke                        # read-only checks against the live deployment
```

What each suite covers and needs: [docs/TESTING.md](docs/TESTING.md).

## Layout

A file-by-file module map and the reasoning behind the design are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
src/
  index.tsx          app assembly: security headers, same-origin guard, rate limits, cron
  oidc.tsx           discovery, /authorize (+consent), /end-session
  oauth-token.ts     /token, /userinfo, /revoke
  oauth-clients.ts   CIMD resolution, dynamic client registration, redirect matching
  webauthn.ts        passkey ceremonies + enrollment
  session.ts         __Host- cookie sessions (hashed at rest)
  crypto.ts          RS256 ID/access tokens, JWKS with rotation
  mcp.ts             admin MCP server + code-mode sandbox
  ops.ts             domain operations shared by the admin UI and MCP
  account.tsx        account & security routes (views in account-sections.tsx)
  home.tsx           home launcher
  pages.tsx          sign-in, enrollment, consent, sign-out, errors
  admin/             admin UI (overview, people, groups, apps, clients, audit, connect, tokens, settings)
  ui/                layout, components, icons
  client/            browser bundle + app.css (esbuild → inlined via assets.gen.ts)
  cf-access.ts       optional read-only Cloudflare Access integration
  maintenance.ts     hourly cleanup + retention
  instance.ts        pinned issuer / encrypted D1 signing-key fallback (one-click installs)
  setup.tsx          first-run /setup (first admin)
migrations/          D1 schema (apply manually: npm run db:migrate)
cloudflare.config.ts Worker config for the cf CLI (bindings, route, cron, account pin, staging)
wrangler.jsonc       portable template for the Deploy to Cloudflare button and forks
tests/
  e2e/               full, api and one-click suites + instances.mjs (throwaway servers)
  security/          regression scripts from the October 2026 security review
  smoke/             read-only post-deploy checks (tester-army/e2e)
  unit.test.ts       unit tests
scripts/             build, deploy, migrations, keys, seeding, smoke runner
docs/                threat model, architecture, testing; archive/ holds superseded research and reviews
```

## Feedback and contributing

Running your own copy? Admin → Settings → About has "Report a bug" and
"Suggest a feature" links that open issues here, and the overview tells you
when there's a newer version ([how to update](DEPLOY.md#staying-up-to-date)).
Code contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security issues:
[report privately](https://github.com/tannerwj/edge-idp/security/advisories/new).

## License

MIT — see [LICENSE](LICENSE).
