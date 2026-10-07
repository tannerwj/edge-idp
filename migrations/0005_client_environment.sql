-- Distinguish production vs non-production apps.
ALTER TABLE oidc_clients ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';
