CREATE TABLE maintainer_sessions (
 session_hash TEXT PRIMARY KEY REFERENCES sessions(id_hash) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 redeemed INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL
);
