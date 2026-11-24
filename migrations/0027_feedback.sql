CREATE TABLE feedback (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
 credential TEXT NOT NULL,
 retry_key TEXT NOT NULL,
 kind TEXT NOT NULL,
 summary TEXT NOT NULL,
 details TEXT NOT NULL,
 tool_name TEXT NOT NULL,
 server_version TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','acknowledged','planned','done','declined')),
 note TEXT NOT NULL DEFAULT '',
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
 UNIQUE(user_id,credential,retry_key)
);
CREATE INDEX idx_feedback_owner_time ON feedback(user_id,credential,created_at);
CREATE INDEX idx_feedback_status ON feedback(status,id);
