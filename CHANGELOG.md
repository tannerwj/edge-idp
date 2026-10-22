# Changelog

What changed in each version, for people running their own copy. How to
update: [DEPLOY.md › Staying up to date](DEPLOY.md#staying-up-to-date).

## 2.2.0 — 2026-10-22

### Upgrade notes

- **Apply migrations 0014–0019 before deploying** (`npm run db:migrate`, or
  automatically under Workers Builds). All are additive; the previous version
  keeps running on the new schema.
- **Email is admin-only** unless you turn on self-service changes in
  Settings › Email. Members can no longer change their own address from
  Account & security.
- **Sensitive admin actions ask for a passkey recheck** (5 minutes by
  default; Settings › Sign-in & security can lengthen or turn it off). This
  includes connecting an AI tool with admin MCP access.
- **MCP `users_make_member` now requires `email`.**
- **Old `/enroll/<token>` links are gone.** Every link is `/enroll#<token>`;
  `scripts/seed-admin.mjs` prints the new form.
- **Admin settings moved** into tabs under `/admin/settings/…`. Old anchors
  (`#cloudflare`, `#about`) now live at `/admin/settings/cloudflare` and
  `/admin/settings/about`.

### Added

- **Settings, one tab per area**, with status badges: general, sign-in &
  security, email, notifications, client onboarding, identity & keys,
  backup, Cloudflare, about.
- **Optional email** through Cloudflare Email Service: emailed invites and
  new enrollment links, a pending-invites list with resend and revoke, bulk
  invite, self-service email change with a confirmation link, and a test
  message.
- **Lost passkeys**: off, a "Lost your passkey?" request an admin approves,
  or an emailed one-hour link straight away (never for admins).
- **Alerts** for chosen events by email to admins and to webhooks (Discord,
  Slack, ntfy, or signed JSON), and **security notices** to the person
  affected.
- **Email sign-in links** for members (off by default, never admins), with a
  confirmation page, a notice on every use, and `amr: ["otp"]` in tokens.
- **Per-app sign-in policy**: require a passkey sign-in or a recent sign-in.
- **Sign-in verification settings**: relax Face ID / Touch ID / PIN for
  sign-in, while admins always verify (optional).
- **Sign-out that reaches apps**: OIDC back-channel logout, and optional
  Cloudflare Access session revocation, when someone is disabled, deleted,
  reset or signed out everywhere; "Sign out everywhere" on Account &
  security.
- **Signing-key rotation** from the UI or on a schedule for database-held
  keys, and moving a secret-held key into the database.
- **Backup and restore** of people, passkeys' public keys, groups, apps,
  grants, clients, webhooks and settings.
- MCP: `invites_list`, `invites_revoke`, `recovery_requests_list`,
  `recovery_requests_resolve`, `clients_sign_in_policy`; `send_email` on
  `users_create` and `users_enrollment_link`.

### Security

Fixes from the October 2026 review (`docs/archive/2026-10-21-review/`):
members could assert any unused email as verified; public accounts could
claim real addresses; step-up didn't cover admin actions; `/end-session` was
an open redirect; the sandbox call cap could be exceeded with concurrent
calls; and smaller hardening (ID-token scopes for third-party clients,
setup-token strength, a cap on unused dynamic registrations).

### Changed

- Faster: one user-access load per token request, sessions and users in one
  query, no table scans for the audit page or the hourly audit trim, new
  indexes, a minified bundle on the one-click path.
- CI pins actions by commit, runs `npm audit` and checks migrations are
  additive.

## 2.1.0 and earlier

See the git history.
