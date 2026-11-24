CREATE TABLE reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 receipt_hash TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL, summary TEXT NOT NULL, tool_name TEXT NOT NULL, server_version TEXT NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 status TEXT NOT NULL DEFAULT 'new', reply TEXT NOT NULL DEFAULT '', issue TEXT NOT NULL DEFAULT '',
 duplicate_of INTEGER REFERENCES reports(id)
);
CREATE INDEX idx_reports_created ON reports(created_at);
CREATE INDEX idx_reports_duplicates ON reports(duplicate_of);
