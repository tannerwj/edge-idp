-- Identity provider initial schema (D1 / SQLite).
--
-- Design notes (see docs/THREAT_MODEL.md for the security reasoning):
-- - No password column anywhere: passkeys are the only credential.
-- - Bearer tokens (session ids, auth codes, enrollment tokens) are stored as
--   SHA-256 hashes; only the hash can ever leak from a DB read.
-- - Authorization codes are single-use, short-lived, and bound to the client,
--   redirect URI, and PKCE challenge that created them.
-- - Timestamps are unix seconds (INTEGER), never wall-clock strings.

CREATE TABLE users (
  id TEXT PRIMARY KEY,          -- UUIDv4
  created_at INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,   -- case-insensitive compare in app code
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,          -- UUIDv4 (internal handle)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id BLOB NOT NULL UNIQUE,
  public_key BLOB NOT NULL,     -- COSE-encoded public key bytes
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,              -- JSON array, e.g. ["internal","hybrid"]
  name TEXT NOT NULL,           -- human label shown in the UI
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backup_state INTEGER NOT NULL DEFAULT 0,
  aaguid TEXT,                  -- authenticator model id, for display only
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX idx_webauthn_credentials_user ON webauthn_credentials(user_id);

CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,   -- base64url challenge string
  type TEXT NOT NULL,           -- 'registration' | 'authentication'
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,           -- JSON: rp_id, user_verification, allow list, etc.
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,          -- UUIDv4
  name TEXT NOT NULL UNIQUE,    -- e.g. 'family', 'friends', 'finance'
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE oidc_clients (
  id TEXT PRIMARY KEY,          -- client_id: 32 random url-safe chars
  name TEXT NOT NULL,           -- human name shown on the sign-in page
  redirect_uris TEXT NOT NULL,  -- JSON array; redirect_uri must match exactly
  secret_hash TEXT NOT NULL,    -- SHA-256 hex of the client secret
  secret_prefix TEXT NOT NULL,  -- first 6 chars, for admin recognition
  allowed_groups TEXT,          -- JSON array of group names; NULL/empty = everyone
  created_at INTEGER NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE auth_codes (
  code_hash TEXT PRIMARY KEY,   -- SHA-256 hex of the authorization code
  client_id TEXT NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL, -- PKCE S256 is REQUIRED for every flow
  scope TEXT NOT NULL,          -- space-separated granted scopes
  nonce TEXT,                   -- round-tripped into the ID token when present
  expires_at INTEGER NOT NULL,  -- 60 seconds
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_auth_codes_expires ON auth_codes(expires_at);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,     -- SHA-256 hex of the session token in the cookie
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,  -- 30 days, sliding
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT,
  ip_hash TEXT                  -- SHA-256 of the IP, for the admin UI; never raw
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE enrollment_tokens (
  token_hash TEXT PRIMARY KEY,  -- SHA-256 hex of the one-time enrollment token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,  -- 7 days
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  event TEXT NOT NULL,          -- SIGN_IN, SIGN_OUT, PASSKEY_REGISTERED,
                                -- PASSKEY_REMOVED, USER_CREATED, USER_DISABLED,
                                -- CLIENT_CREATED, CLIENT_SECRET_ROTATED,
                                -- ENROLLMENT_STARTED, CODE_ISSUED, TOKEN_ISSUED
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  client_id TEXT,
  ip_hash TEXT,
  user_agent TEXT,
  detail TEXT                   -- JSON with event-specific fields
);
CREATE INDEX idx_audit_log_created ON audit_log(created_at);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
