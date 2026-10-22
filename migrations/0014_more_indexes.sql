-- Indexes for cascade deletes, the DCR cleanup, email lookup and audit search.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_client ON refresh_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_auth_codes_user ON auth_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_codes_client ON auth_codes(client_id);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_token ON mcp_calls(token_id);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_client ON oauth_grants(client_id);
CREATE INDEX IF NOT EXISTS idx_app_favorites_app ON app_favorites(app_id);
CREATE INDEX IF NOT EXISTS idx_users_email_key ON users(lower(email));
CREATE INDEX IF NOT EXISTS idx_audit_log_client ON audit_log(client_id);
