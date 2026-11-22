CREATE TABLE oauth_disconnects (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 client_id TEXT NOT NULL REFERENCES oidc_clients(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL,
 PRIMARY KEY(user_id,client_id)
);
ALTER TABLE auth_codes ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refresh_tokens ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
INSERT INTO oauth_disconnects
 SELECT DISTINCT a.user_id,a.client_id,1 FROM audit_log a
 JOIN users u ON u.id=a.user_id JOIN oidc_clients c ON c.id=a.client_id
 WHERE a.event='CONSENT_REVOKED';
UPDATE refresh_tokens SET generation=1 WHERE EXISTS
 (SELECT 1 FROM oauth_disconnects d WHERE d.user_id=refresh_tokens.user_id AND d.client_id=refresh_tokens.client_id);
