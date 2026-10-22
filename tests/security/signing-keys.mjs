#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { startLocal } from "../e2e/instances.mjs";

const port = 9100 + Math.floor(Math.random() * 500);
const setupToken = randomBytes(32).toString("base64url");
const instance = await startLocal({
  issuer: `http://localhost:${port}`,
  port,
  vars: { SETUP_TOKEN: setupToken },
});
const base = instance.base;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const checks = [];
const check = (name, actual, expected) => {
  checks.push({ name, actual, expected, pass: actual === expected });
};
const secret = token();
const admin = token();
const scalar = async (q) => Object.values((await instance.sql(q))[0] ?? {})[0];
const kids = async () => (await (await fetch(`${base}/jwks`)).json()).keys.map((k) => k.kid);
const post = (path) =>
  fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: `__Host-idp_session=${admin}` },
  });
const mint = async () => {
  const code = token();
  await instance.sql(`INSERT INTO auth_codes
    (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, auth_time)
    VALUES ('${hash(code)}', 'app', 'admin-1', 'https://app.example.test/cb', '', 'openid',
      ${Math.floor(Date.now() / 1000) + 60}, ${now});`);
  const r = await fetch(`${base}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`app:${secret}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }),
  });
  return (await r.json()).id_token;
};
const verifies = async (jwt) => {
  const jwks = createLocalJWKSet(await (await fetch(`${base}/jwks`)).json());
  try {
    await jwtVerify(jwt, jwks, { issuer: base });
    return true;
  } catch {
    return false;
  }
};

try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at)
      VALUES ('admin-1', ${now}, 'Ada', 'ada@example.test', 1, ${now});
    INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, step_up_at)
      VALUES ('${hash(admin)}', 'admin-1', ${now}, ${now + 3600}, ${now}, ${now + 3600});
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups,
      created_at, require_pkce, client_type, source, skip_consent)
      VALUES ('app', 'App', '["https://app.example.test/cb"]', '${hash(secret)}', 'x', NULL,
        ${now}, 0, 'confidential', 'admin', 1);
  `);
  const [secretKid] = await kids();
  const early = await mint();
  await post("/admin/settings/keys/rotate");
  check(
    "a secret-held key can't be rotated from the UI",
    await scalar("SELECT COUNT(*) FROM signing_keys"),
    0,
  );
  await post("/admin/settings/keys/move");
  check(
    "moving the key stores it encrypted in the database",
    String(await scalar("SELECT jwk FROM signing_keys WHERE id = 'current'")).startsWith("enc:v1:"),
    true,
  );
  await instance.restart((vars) => {
    const { SIGNING_KEY_JWK: _drop, ...rest } = vars;
    return rest;
  });
  check("without the secret, the same key signs from the database", (await kids())[0], secretKid);
  check("a token signed before the move still verifies", await verifies(early), true);
  await post("/admin/settings/keys/rotate");
  const after = await kids();
  check("rotation publishes the new key first and keeps the old one", after[1], secretKid);
  const fresh = await mint();
  check("new tokens are signed with the new key", decodeProtectedHeader(fresh).kid, after[0]);
  check("the old token still verifies during the overlap", await verifies(early), true);
  await instance.sql("UPDATE signing_keys SET retire_at = 1 WHERE id = 'previous'");
  check(
    "once retired, the old key leaves JWKS",
    JSON.stringify(await kids()),
    JSON.stringify([after[0]]),
  );
  check("…and its tokens stop verifying", await verifies(early), false);
} finally {
  await instance.stop();
}

let failed = 0;
for (const r of checks) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name}: ${JSON.stringify(r.actual)}`);
}
process.exit(failed ? 1 : 0);
