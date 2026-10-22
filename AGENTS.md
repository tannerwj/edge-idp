# Agent guide

Instructions for coding agents working in this repo. Human contributors: see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Read first

- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before touching auth, session,
  token, WebAuthn, OAuth or MCP code. Every decision there has a reason; don't
  undo one without addressing it.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before structural changes
  (new modules, middleware order, data model, tooling).
- [docs/TESTING.md](docs/TESTING.md) for what each suite covers and why tests
  do non-obvious things.
- [DEPLOY.md](DEPLOY.md) for configuration and operations.

## Rules

- **No comments in source code or config files.** Rationale goes in the docs
  above, with a code reference like `src/oauth-token.ts › refreshGrant`. Lint
  directives (`eslint-disable-next-line`) are not comments and stay.
- **Keep docs in sync with behavior.** A change that alters a documented
  decision, default, limit or flow updates the doc in the same commit.
- Keep changes small and in the existing style. The project is deliberately
  passkey-first: no passwords, admins sign in only with passkeys, and email
  sign-in links stay an opt-in for members (THREAT_MODEL › Credentials).
- Default branch is `master`.
- No AI attribution in commits (no `Co-Authored-By` lines or similar).
- User-visible changes go in `CHANGELOG.md` under the next version, with
  upgrade notes for anything an operator has to do.

## Before committing

```bash
npm run typecheck && npm run gates && npm run db:check && npm test && npm run test:e2e
```

Also run `npm run test:e2e:setup` and `npm run test:security` when you touch
setup, instance resolution or security-relevant code. The e2e suites need
Chromium (`npx playwright install chromium`).

## Deploying

Follow DEPLOY.md › Staging, then › Upgrading and rollback: staging migrate,
deploy and `test:e2e:staging` first; then a D1 Time Travel bookmark, note the
current version id, `npm run db:migrate`, `npm run deploy`, `npm run smoke`.
Production is deployed from the `cf` CLI, not by pushing `master`.
