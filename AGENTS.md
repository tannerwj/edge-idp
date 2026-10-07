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

- **No comments in source code.** Rationale goes in the docs above, with a
  code reference like `src/oauth-token.ts › refreshGrant`. Lint directives
  (`eslint-disable-next-line`) are not comments and stay.
- **Keep docs in sync with behavior.** A change that alters a documented
  decision, default, limit or flow updates the doc in the same commit.
- Keep changes small and in the existing style. The project is deliberately
  passkey-only.
- Default branch is `master`.
- No AI attribution in commits (no `Co-Authored-By` lines or similar).

## Before committing

```bash
npm run typecheck && npm run gates && npm test && npm run test:e2e
```

Also run `npm run test:e2e:setup` and `npm run test:security` when you touch
setup, instance resolution or security-relevant code. The e2e suites need
Chromium (`npx playwright install chromium`).
