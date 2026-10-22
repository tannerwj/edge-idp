-- "Lost my passkey" requests waiting for an admin, and outgoing alert webhooks.
CREATE TABLE IF NOT EXISTS recovery_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  ip_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_recovery_requests_status ON recovery_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_recovery_requests_user ON recovery_requests(user_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'json',
  secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_at INTEGER,
  last_status TEXT
);
