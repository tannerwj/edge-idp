-- API tokens for MCP and programmatic admin access.
-- Tokens are random 256-bit values; only the SHA-256 hash is stored.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash);
