-- Pending self-service email changes, confirmed from the new address.
CREATE TABLE IF NOT EXISTS email_changes (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  new_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_changes_user ON email_changes(user_id);
CREATE INDEX IF NOT EXISTS idx_email_changes_expires ON email_changes(expires_at);
CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_user ON enrollment_tokens(user_id);
