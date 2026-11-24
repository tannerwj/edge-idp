CREATE TABLE feedback_shares (
 feedback_id INTEGER PRIMARY KEY REFERENCES feedback(id) ON DELETE CASCADE,
 destination TEXT NOT NULL, receipt TEXT NOT NULL UNIQUE, payload TEXT NOT NULL,
 remote_status TEXT, reply TEXT, issue TEXT, next_check INTEGER NOT NULL DEFAULT 0,
 attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT
);
CREATE INDEX idx_feedback_shares_due ON feedback_shares(destination,next_check);
