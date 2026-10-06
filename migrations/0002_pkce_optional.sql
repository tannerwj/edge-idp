-- Per-client PKCE requirement. Cloudflare Access (and some other
-- server-side OIDC clients) don't send code_challenge; they authenticate
-- with client_secret at the token endpoint instead. Default stays strict.
ALTER TABLE oidc_clients ADD COLUMN require_pkce INTEGER NOT NULL DEFAULT 1;
