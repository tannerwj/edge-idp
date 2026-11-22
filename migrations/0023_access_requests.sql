ALTER TABLE apps ADD COLUMN requestable INTEGER NOT NULL DEFAULT 0;
CREATE TABLE access_requests (
 id TEXT PRIMARY KEY,
 app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 requested_at INTEGER NOT NULL,
 decided_at INTEGER,
 decision TEXT CHECK(decision IN ('approved','denied'))
);
CREATE UNIQUE INDEX idx_request_pending ON access_requests(app_id,user_id) WHERE decision IS NULL;
CREATE TABLE temporary_app_grants (
 id TEXT PRIMARY KEY,
 app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX idx_temporary_grants_expiry ON temporary_app_grants(expires_at);
