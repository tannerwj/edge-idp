#!/usr/bin/env node
/** Local-only review reproduction. Creates and destroys an isolated cf dev + D1. */
import { createHash, randomBytes } from "node:crypto";
import { startLocal } from "../e2e/instances.mjs";

const port = 9100 + Math.floor(Math.random() * 500);
const instance = await startLocal({ issuer: `http://localhost:${port}`, port });
const hash = (s) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const checks = [];
const check = (name, actual, expected) => {
  checks.push({ name, actual, expected, pass: actual === expected });
};
const post = async (client, fields) => {
  const response = await fetch(`${instance.base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client, ...fields }),
  });
  return { status: response.status, body: await response.json() };
};

try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at)
      VALUES ('review-user', ${now}, 'Review User', 'review@example.test', 0, ${now});
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups,
      created_at, require_pkce, client_type, source, skip_consent)
      VALUES ('client-a', 'A', '["https://a.example.test/cb"]', '', '', '["family"]', ${now}, 1, 'public', 'admin', 1);
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups,
      created_at, require_pkce, client_type, source, skip_consent)
      VALUES ('client-b', 'B', '["https://b.example.test/cb"]', '', '', NULL, ${now}, 1, 'public', 'admin', 1);
    INSERT INTO groups (id, name, created_at) VALUES ('group-family', 'family', ${now});
    INSERT INTO group_members (group_id, user_id, created_at)
      VALUES ('group-family', 'review-user', ${now});
  `);

  const verifier = token();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const code = token();
  await instance.sql(`INSERT INTO auth_codes
    (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, auth_time)
    VALUES ('${hash(code)}', 'client-a', 'review-user', 'https://a.example.test/cb',
      '${challenge}', 'openid', ${now + 60}, ${now});`);
  const wrongCode = await post("client-b", {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  });
  check("wrong client code response", wrongCode.status, 400);
  check(
    "wrong client leaves code unused",
    (await instance.sql(`SELECT used FROM auth_codes WHERE code_hash = '${hash(code)}'`))[0].used,
    0,
  );
  const rightCode = await post("client-a", {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  });
  check("right client after wrong-client attempt", rightCode.status, 200);

  // The main E2E uses PKCE. Confidential clients may omit it after authenticating;
  // the database stores that case as an empty challenge string.
  const confidentialSecret = token();
  const confidentialCode = token();
  await instance.sql(`INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix,
      created_at, require_pkce, client_type, source, skip_consent)
    VALUES ('client-confidential', 'Confidential', '["https://conf.example.test/cb"]',
      '${hash(confidentialSecret)}', 'review', ${now}, 0, 'confidential', 'admin', 1);
    INSERT INTO auth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, auth_time)
    VALUES ('${hash(confidentialCode)}', 'client-confidential', 'review-user',
      'https://conf.example.test/cb', '', 'openid', ${now + 60}, ${now});`);
  const confidential = await post("client-confidential", {
    client_secret: confidentialSecret,
    grant_type: "authorization_code",
    code: confidentialCode,
  });
  check("confidential no-PKCE code redeems", confidential.status, 200);

  const refresh = token();
  await instance.sql(`INSERT INTO refresh_tokens
    (token_hash, family_id, client_id, user_id, scope, auth_time, created_at, expires_at)
    VALUES ('${hash(refresh)}', 'review-family-1', 'client-a', 'review-user',
      'offline_access', ${now}, ${now}, ${now + 3600});`);
  const wrongRefresh = await post("client-b", {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  check("wrong client refresh response", wrongRefresh.status, 400);
  check(
    "wrong client leaves refresh unrotated",
    Number(
      (
        await instance.sql(
          `SELECT rotated_at IS NOT NULL AS rotated FROM refresh_tokens WHERE token_hash = '${hash(refresh)}'`,
        )
      )[0].rotated,
    ),
    0,
  );
  const rightRefresh = await post("client-a", {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  check("right client refreshes after wrong-client attempt", rightRefresh.status, 200);
  check(
    "family survives wrong-client attempt",
    (
      await instance.sql(
        "SELECT COUNT(*) AS n FROM refresh_tokens WHERE family_id = 'review-family-1'",
      )
    )[0].n,
    2,
  );

  const groupRefresh = token();
  await instance.sql(`INSERT INTO refresh_tokens
    (token_hash, family_id, client_id, user_id, scope, auth_time, created_at, expires_at)
    VALUES ('${hash(groupRefresh)}', 'review-family-2', 'client-a', 'review-user',
      'openid offline_access', ${now}, ${now}, ${now + 3600});
    DELETE FROM group_members WHERE user_id = 'review-user';`);
  const afterRemoval = await post("client-a", {
    grant_type: "refresh_token",
    refresh_token: groupRefresh,
  });
  check("group-restricted client refresh denied after removal", afterRemoval.status, 400);
  check(
    "group-restricted refresh family revoked",
    (
      await instance.sql(
        "SELECT COUNT(*) AS n FROM refresh_tokens WHERE family_id = 'review-family-2'",
      )
    )[0].n,
    0,
  );

  const narrowRefresh = token();
  await instance.sql(`INSERT INTO refresh_tokens
    (token_hash, family_id, client_id, user_id, scope, auth_time, created_at, expires_at)
    VALUES ('${hash(narrowRefresh)}', 'review-family-3', 'client-b', 'review-user',
      'offline_access', ${now}, ${now}, ${now + 3600});`);
  const narrow = await post("client-b", {
    grant_type: "refresh_token",
    refresh_token: narrowRefresh,
  });
  const userinfo = await fetch(`${instance.base}/userinfo`, {
    headers: { authorization: `Bearer ${narrow.body.access_token}` },
  });
  await userinfo.json();
  check("userinfo rejects offline_access-only token", userinfo.status, 401);
  check(
    "access token omits email outside granted scopes",
    JSON.parse(Buffer.from(narrow.body.access_token.split(".")[1], "base64url").toString()).email,
    undefined,
  );

  const readToken = `eidp_${token()}`;
  await instance.sql(`INSERT INTO api_tokens (id, token_hash, name, created_at, created_by, scope)
    VALUES ('review-read-token', '${hash(readToken)}', 'review', ${now}, 'review-user', 'read');
    UPDATE users SET is_admin = 1 WHERE id = 'review-user';`);
  const execute = async (source) => {
    const r = await fetch(`${instance.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${readToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "execute", arguments: { code: source } },
      }),
    });
    return r.json();
  };
  const attemptedWrite = await execute(
    'return await id.users_create({name:"Forbidden",email:"forbidden@example.test"});',
  );
  check("read-only sandbox write rejected", attemptedWrite.result?.isError, true);
  check(
    "read-only sandbox write made no user",
    (
      await instance.sql("SELECT COUNT(*) AS n FROM users WHERE email = 'forbidden@example.test'")
    )[0].n,
    0,
  );
  const networkProbe = await execute(
    'try { await fetch("https://example.com"); return "open"; } catch { return "blocked"; }',
  );
  check(
    "sandbox outbound fetch blocked",
    JSON.parse(networkProbe.result.content[0].text).value,
    "blocked",
  );

  for (const result of checks)
    console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}: ${result.actual}`);
  if (checks.some((x) => !x.pass)) process.exitCode = 1;
} finally {
  instance.stop();
}
process.exit(process.exitCode ?? 0);
