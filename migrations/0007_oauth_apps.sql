-- OAuth 2.1 authorization-server features (MCP clients), app launcher,
-- scoped API tokens, and passkey/session metadata.
--
-- Additive only: every existing row stays valid and every existing client
-- keeps working exactly as before (confidential, admin-registered).

-- ── Clients ─────────────────────────────────────────────────────────────
-- client_type: 'confidential' (has a secret) | 'public' (PKCE only, e.g.
--   Claude Code, Cursor, claude.ai via CIMD/DCR).
-- source: 'admin' (registered in the UI/MCP) | 'dcr' (RFC 7591 dynamic
--   registration) | 'cimd' (Client ID Metadata Document: the client_id IS an
--   https URL; the row is a cache of the fetched document, refreshed when
--   metadata_expires_at passes — see oauth-clients.ts).
-- Public clients store an empty secret_hash; client auth for them is PKCE.
ALTER TABLE oidc_clients ADD COLUMN client_type TEXT NOT NULL DEFAULT 'confidential';
ALTER TABLE oidc_clients ADD COLUMN source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE oidc_clients ADD COLUMN client_uri TEXT;
ALTER TABLE oidc_clients ADD COLUMN logo_uri TEXT;
ALTER TABLE oidc_clients ADD COLUMN last_used_at INTEGER;
-- Admin-registered first-party clients skip the consent screen (the
-- original behavior). Dynamic/CIMD clients always get consent.
ALTER TABLE oidc_clients ADD COLUMN skip_consent INTEGER NOT NULL DEFAULT 1;
ALTER TABLE oidc_clients ADD COLUMN description TEXT;
ALTER TABLE oidc_clients ADD COLUMN metadata_expires_at INTEGER;

-- ── Authorization codes ────────────────────────────────────────────────
-- resource: RFC 8707 resource indicator; becomes the access token audience.
-- auth_time: when the user last completed a passkey ceremony (OIDC claim).
ALTER TABLE auth_codes ADD COLUMN resource TEXT;
ALTER TABLE auth_codes ADD COLUMN auth_time INTEGER;

-- ── Refresh tokens (rotating, with reuse detection) ────────────────────
-- Only issued for the `mcp` and `offline_access` scopes. Every use rotates
-- the token; presenting an already-rotated token revokes the whole family
-- (RFC 9700 §4.14 / OAuth 2.1 refresh token rotation).
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,   -- SHA-256 hex of the refresh token
  family_id TEXT NOT NULL,       -- shared by every rotation of one grant
  client_id TEXT NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  resource TEXT,
  auth_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,   -- absolute family lifetime, not sliding
  rotated_at INTEGER             -- set when exchanged; reuse => family revoked
);
CREATE INDEX idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_expires ON refresh_tokens(expires_at);

-- ── Consent grants ─────────────────────────────────────────────────────
-- Remembered "Allow" decisions for third-party clients, shown to the user
-- under Account → Connected apps where they can be revoked (which also
-- kills that client's refresh tokens for the user).
CREATE TABLE oauth_grants (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  PRIMARY KEY (user_id, client_id)
);

-- ── App launcher ───────────────────────────────────────────────────────
-- What users see on their home page. An app is a link plus who may see it.
-- Visibility is NOT enforcement: enforcement lives in the OIDC client's
-- allowed_groups (when client_id is set) or in Cloudflare Access.
CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  icon TEXT,                     -- emoji or short text; null => initials
  color TEXT,                    -- accent hue (0-359) for the tile
  allowed_groups TEXT,           -- JSON array of group names; NULL = everyone
  client_id TEXT REFERENCES oidc_clients(id) ON DELETE SET NULL,
  cf_app_id TEXT,                -- Cloudflare Access app uuid when imported
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- ── API tokens: scope + expiry ─────────────────────────────────────────
-- scope: 'admin' (full MCP/tool access) | 'read' (list/get tools only).
ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE api_tokens ADD COLUMN prefix TEXT;

-- ── Sessions: which passkey, for the "your devices" view ───────────────
ALTER TABLE sessions ADD COLUMN credential_id TEXT;

-- ── Users: last sign-in for the admin list ─────────────────────────────
ALTER TABLE users ADD COLUMN last_sign_in_at INTEGER;

-- Seed defaults for new instance settings.
INSERT OR IGNORE INTO instance_settings (key, value, updated_at)
VALUES ('dcr_enabled', '1', strftime('%s', 'now'));
INSERT OR IGNORE INTO instance_settings (key, value, updated_at)
VALUES ('cimd_enabled', '1', strftime('%s', 'now'));
