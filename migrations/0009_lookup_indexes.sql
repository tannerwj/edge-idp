-- Keep the common authorization and hourly cleanup paths indexed.
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id, group_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_tokens_expires ON enrollment_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_rotated ON refresh_tokens(rotated_at);
CREATE INDEX IF NOT EXISTS idx_oidc_clients_source_created ON oidc_clients(source, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_event_created ON audit_log(event, created_at);
