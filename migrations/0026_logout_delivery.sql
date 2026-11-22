CREATE TABLE logout_deliveries (
 id TEXT PRIMARY KEY, batch TEXT NOT NULL, user_id TEXT NOT NULL,
 client_id TEXT, name TEXT NOT NULL, destination TEXT, account_id TEXT,
 reason TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_logout_due ON logout_deliveries(due) WHERE status='Pending';
CREATE INDEX idx_logout_batch ON logout_deliveries(batch);
CREATE INDEX idx_logout_user ON logout_deliveries(user_id,created_at);
