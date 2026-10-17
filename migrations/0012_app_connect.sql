-- One-time client secret pickups, and grants for client-linked apps.
-- A pickup row holds the secret encrypted under a key derived from the pickup token,
-- so the row alone can't reveal it; it is deleted on first use or by the hourly cron.
CREATE TABLE secret_pickups (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_secret_pickups_expires ON secret_pickups(expires_at);

-- Client-linked apps now take who may sign in from grants; seed them from the
-- client's allowed groups (none = everyone), which is what /authorize enforced before.
-- The m12- id prefix keeps one insert's rows from hiding an app from the other.
INSERT INTO app_grants (id, app_id, everyone, created_at)
SELECT 'm12-' || lower(hex(randomblob(16))), a.id, 1, a.created_at
FROM apps a JOIN oidc_clients c ON c.id = a.client_id
WHERE (c.allowed_groups IS NULL OR c.allowed_groups = '[]')
  AND NOT EXISTS (SELECT 1 FROM app_grants g WHERE g.app_id = a.id AND g.id NOT LIKE 'm12-%');

INSERT INTO app_grants (id, app_id, group_id, created_at)
SELECT 'm12-' || lower(hex(randomblob(16))), a.id, g.id, a.created_at
FROM apps a JOIN oidc_clients c ON c.id = a.client_id, json_each(c.allowed_groups) j
JOIN groups g ON g.name = j.value
WHERE c.allowed_groups IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM app_grants x WHERE x.app_id = a.id AND x.id NOT LIKE 'm12-%');
