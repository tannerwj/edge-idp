-- Signing key generated on first use when the SIGNING_KEY_JWK secret isn't set
-- (one-click installs). Never shown in the UI or MCP. See src/instance.ts.
CREATE TABLE IF NOT EXISTS signing_keys (
  id TEXT PRIMARY KEY,
  jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
