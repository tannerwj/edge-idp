-- Signing key generated on first use without SIGNING_KEY_JWK (one-click).
-- New rows are AES-GCM encrypted under the SETUP_TOKEN Worker secret.
-- Legacy plaintext rows require rotation before upgrading; see DEPLOY.md.
CREATE TABLE IF NOT EXISTS signing_keys (
  id TEXT PRIMARY KEY,
  jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
