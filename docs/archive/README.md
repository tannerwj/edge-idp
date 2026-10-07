# Archive

Superseded material, kept for history. Nothing here is current guidance or
part of the build, lint or test runs.

- `2026-10-security-review/`: the October 2026 security review (`REVIEW.md`,
  written against `89481cc`) and its remediation notes and local performance
  measurements. The fixes shipped in `f421d76`; the regression checks live on
  in `tests/security/`. Versions deployed before that commit carry the
  reviewed issues.
- `access-proof.py`: a one-off proof that Cloudflare Access → this IdP →
  passkey → app works end to end. Hardcoded to one Access app; not maintained.
- `theme-research.md`, `mcp-code-mode-research.md`, `name-availability.md`:
  research from the October 2026 redesign. The multi-theme system it
  describes was replaced by one light/dark design.
