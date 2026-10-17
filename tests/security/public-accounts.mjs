#!/usr/bin/env node
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
const secret = token();
const redeem = async (client, code, redirect) => {
  const response = await fetch(`${instance.base}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`${client}:${secret}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect }),
  });
  return { status: response.status, body: await response.json() };
};
const issueCode = async (client, redirect) => {
  const code = token();
  await instance.sql(`INSERT INTO auth_codes
    (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, auth_time)
    VALUES ('${hash(code)}', '${client}', 'public-user', '${redirect}', '',
      'openid profile email groups', ${now + 60}, ${now});`);
  return code;
};
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at, public)
      VALUES ('public-user', ${now}, 'Pat Player', 'owner@example.test', 0, ${now}, 1);
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups,
      created_at, require_pkce, client_type, source, skip_consent, public_signup)
      VALUES ('access-like', 'Cloudflare Access', '["https://team.example.test/cb"]',
        '${hash(secret)}', 'review', NULL, ${now}, 0, 'confidential', 'admin', 1, 0);
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups,
      created_at, require_pkce, client_type, source, skip_consent, public_signup)
      VALUES ('game', 'Game', '["https://game.example.test/cb"]',
        '${hash(secret)}', 'review', NULL, ${now}, 0, 'confidential', 'admin', 1, 1);
  `);

  const accessCode = await issueCode("access-like", "https://team.example.test/cb");
  const access = await redeem("access-like", accessCode, "https://team.example.test/cb");
  check("public account can't redeem a code at a members-only client", access.status, 400);
  check("…and gets no token", access.body.id_token, undefined);

  const gameCode = await issueCode("game", "https://game.example.test/cb");
  const game = await redeem("game", gameCode, "https://game.example.test/cb");
  check("public account redeems at a client open to the public", game.status, 200);
  const id = game.body.id_token ? claims(game.body.id_token) : {};
  check("its ID token never carries the stored email", id.email, undefined);
  check("…nor preferred_username", id.preferred_username, undefined);
  check("…nor email_verified", id.email_verified, undefined);
} finally {
  await instance.stop();
}

let failed = 0;
for (const result of checks) {
  if (!result.pass) failed++;
  console.log(`${result.pass ? "PASS" : "FAIL"} ${result.name}: ${result.actual}`);
}
process.exit(failed ? 1 : 0);
