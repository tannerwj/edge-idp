-- How each session signed in, carried through codes and refresh tokens; per-client
-- sign-in policy; one-time email sign-in links.
ALTER TABLE sessions ADD COLUMN method TEXT NOT NULL DEFAULT 'passkey';
ALTER TABLE auth_codes ADD COLUMN method TEXT;
ALTER TABLE refresh_tokens ADD COLUMN method TEXT;
ALTER TABLE oidc_clients ADD COLUMN require_passkey INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oidc_clients ADD COLUMN max_auth_age INTEGER;

CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  next TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_magic_links_user ON magic_links(user_id);
CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);
