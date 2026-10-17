-- Self-registered ("public") accounts, and the clients that may create and admit them.
-- Both default to 0, so every existing account stays a member and every client stays closed.
ALTER TABLE users ADD COLUMN public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oidc_clients ADD COLUMN public_signup INTEGER NOT NULL DEFAULT 0;
