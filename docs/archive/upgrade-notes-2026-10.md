# Upgrade notes, October 2026 (archived)

One-time upgrade procedures from `DEPLOY.md`. Both have been carried out or no
longer apply; they're kept for anyone running an install from that window.

## Portable signing-key upgrade

This is required only for portable instances installed before D1 key
encryption. Plan a maintenance window before merging an upstream update:

1. Back up the D1 database and Worker secrets securely; record the
   current issuer and public JWKS `kid`. Set that exact issuer as the explicit
   `ISSUER` variable before upgrading if this existing install has no D1
   issuer pin. The new Worker fails closed on an initialized database without
   an explicit or pinned issuer. Keep private JWK data out of logs,
   issue comments, and command output. Confirm you can restore the backup.
2. While the old Worker still runs, move the **existing** private key from
   `signing_keys.current` into the `SIGNING_KEY_JWK_PREVIOUS` Worker secret.
   Use an operator-controlled secret transfer; never paste it into a shell
   command or commit it. Verify that JWKS still publishes its public key.
3. Generate a fresh key with `node scripts/gen-key.mjs`, store it as the
   `SIGNING_KEY_JWK` Worker secret, and verify JWKS publishes both old and new
   `kid` values. New tokens now use the new key. Existing tokens remain valid
   for their one-hour lifetime through the previous key.
4. Deploy the new code and additive migrations. Check health, discovery,
   passkey login, token issuance, and JWKS on the canonical hostname. After
   at least one hour, remove `SIGNING_KEY_JWK_PREVIOUS` and verify the old
   `kid` is gone. Retain the new secret and its offline backup. The old
   plaintext D1 row and historical backups still contain the former private
   key; restrict and retire them under your backup policy.

`SIGNING_KEY_JWK` takes precedence over the legacy D1 row, so this path
avoids the new code's fail-closed error. Installing a fresh `SETUP_TOKEN` does
not repair a legacy plaintext row. If a step fails, restore the last working
Worker version and matching secrets; restore D1 only from a verified backup
when needed. Never change the issuer as part of a key upgrade.

## Upgrading from v1 (the original UI)

1. Run `npm run db:migrate`. Migration `0007_oauth_apps.sql` is additive:
   existing users, passkeys and clients are untouched, and existing clients stay
   confidential, first-party and consent-free.
2. Run `npm run deploy`.
3. Everyone signs in once more. The session cookie is now `__Host-idp_session`,
   so old cookies are ignored. Passkeys are unchanged; it's one tap.

Cloudflare Access keeps working throughout. Its client, secret and redirect
URI don't change.

**Rollback:** point the Worker back at the previous version. Cloudflare keeps
every uploaded version, so no rebuild is needed:

```bash
npx cf workers deployments list --worker identity        # find the prior version_id
npx cf workers deployments create --worker identity --strategy percentage \
  --versions '[{"version_id":"<previous version_id>","percentage":100}]'
```

The new tables and columns are ignored by v1, so the migration doesn't need
undoing. Sessions created by v2 won't be recognized by v1, so everyone signs in
once more.
