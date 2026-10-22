-- Back-channel logout: where each admin client wants logout tokens, and which
-- clients each person has signed in to.
ALTER TABLE oidc_clients ADD COLUMN backchannel_logout_uri TEXT;

CREATE TABLE IF NOT EXISTS client_signins (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_client_signins_client ON client_signins(client_id);
