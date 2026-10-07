# Contributing

Issues are the easiest way to help: bugs, rough edges, things you wish it
did. Running your own copy? Admin → Settings → About opens a pre-filled issue
here. Please leave out tokens, keys, enrollment links and anything else private.

**Security issues:** please don't open a public issue.
[Report them privately](https://github.com/tannerwj/edge-idp/security/advisories/new).

## Code

1. Fork this repo on GitHub (the Fork button, not Deploy to Cloudflare: a
   button install is a standalone copy with no link back here), then branch.
2. `npm install` and `npx playwright install chromium`.
3. Make the change. Keep it small and in the existing style; the project is
   deliberately passkey-only (see [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)).
   Source code has no comments: put the reasoning in
   [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) or the threat model, and
   update them when behavior changes.
4. Before opening a PR:

   ```bash
   npm run typecheck && npm run gates
   npm test                  # unit tests (parsers / algorithms only)
   npm run test:e2e          # the full end-to-end suite
   npm run test:e2e:setup    # the one-click install path
   npm run test:security     # security regressions
   ```

   The e2e suites boot throwaway local instances and leave nothing behind.
   [docs/TESTING.md](docs/TESTING.md) explains what each one covers.

5. Open a PR describing what changed and why. Auth-relevant changes should
   say what threat they address or touch.

Releases bump `version` in `package.json`; installs compare against it to
show "update available".
