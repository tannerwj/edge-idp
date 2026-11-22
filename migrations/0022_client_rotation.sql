ALTER TABLE oidc_clients ADD COLUMN previous_secret_hash TEXT;
ALTER TABLE oidc_clients ADD COLUMN previous_secret_until INTEGER;
ALTER TABLE oidc_clients ADD COLUMN replacement_used_at INTEGER;
