CREATE TABLE app_invitations (
 app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 invited_at INTEGER NOT NULL,
 first_signin_at INTEGER,
 PRIMARY KEY(app_id,user_id)
);
CREATE INDEX idx_audit_connection ON audit_log(client_id,id);
ALTER TABLE audit_log ADD COLUMN support_ref TEXT;
CREATE INDEX idx_support_ref ON audit_log(support_ref) WHERE support_ref IS NOT NULL;
