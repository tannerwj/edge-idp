#!/usr/bin/env node
/** Small sequential local baseline. No production or staging requests. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { startLocal } from "../tests/e2e/local-instance.mjs";

const port = 9500 + Math.floor(Math.random() * 400);
const instance = await startLocal({ issuer: `http://localhost:${port}`, port });
const base = instance.base;
const rawSession = randomBytes(32).toString("base64url");
const apiToken = `eidp_${randomBytes(32).toString("base64url")}`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const challenge = createHash("sha256").update("a".repeat(43)).digest("base64url");
const now = Math.floor(Date.now() / 1000);
const cookie = { cookie: `__Host-idp_session=${rawSession}` };
const params = new URLSearchParams({
  client_id: "review-client", redirect_uri: "https://review.example.test/cb", response_type: "code",
  scope: "openid profile email groups", code_challenge: challenge, code_challenge_method: "S256",
});
const samples = {};
const measure = async (name, makeRequest, count = 5, prepare = null) => {
  const values = [];
  for (let i = 0; i < count; i++) {
    if (prepare) await prepare();
    const start = performance.now();
    const response = await makeRequest();
    await response.arrayBuffer();
    values.push(Math.round((performance.now() - start) * 10) / 10);
  }
  const sorted = [...values].sort((a, b) => a - b);
  samples[name] = { count, milliseconds: values, median: sorted[Math.floor(count / 2)], min: sorted[0], max: sorted.at(-1) };
};

try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at)
      VALUES ('review-admin', ${now}, 'Review Admin', 'review@example.test', 1, ${now});
    INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at)
      VALUES ('${hash(rawSession)}', 'review-admin', ${now}, ${now + 3600}, ${now});
    INSERT INTO api_tokens (id, token_hash, name, created_at, created_by, scope)
      VALUES ('review-api', '${hash(apiToken)}', 'review', ${now}, 'review-admin', 'read');
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, created_at,
      require_pkce, client_type, source, skip_consent)
      VALUES ('review-client', 'Review Client', '["https://review.example.test/cb"]', '', '', ${now},
      1, 'public', 'admin', 1);
  `);
  await measure("health", () => fetch(`${base}/healthz`));
  await measure("jwks", () => fetch(`${base}/jwks`));
  await measure("login", () => fetch(`${base}/login`));
  await measure("setup_closed", () => fetch(`${base}/setup`));
  await measure("passkey_auth_options", () => fetch(`${base}/webauthn/auth/options`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  await measure("passkey_register_options", () => fetch(`${base}/webauthn/register/options`, {
    method: "POST", headers: { ...cookie, "content-type": "application/json" }, body: "{}",
  }));
  await measure("authorize", () => fetch(`${base}/authorize?${params}`, { headers: cookie, redirect: "manual" }));
  let oneTimeCode;
  await measure("token_success", () => {
    return fetch(`${base}/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "review-client", grant_type: "authorization_code", code: oneTimeCode,
        code_verifier: "a".repeat(43) }),
    });
  }, 5, async () => {
    const issuedCode = await fetch(`${base}/authorize?${params}`, { headers: cookie, redirect: "manual" });
    oneTimeCode = new URL(issuedCode.headers.get("location")).searchParams.get("code");
  });
  await measure("admin_dashboard", () => fetch(`${base}/admin`, { headers: cookie }));
  await measure("admin_audit", () => fetch(`${base}/admin/audit`, { headers: cookie }));
  await measure("account", () => fetch(`${base}/account`, { headers: cookie }));
  await measure("mcp_tools_list", () => fetch(`${base}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }));
  const codeResponse = await fetch(`${base}/authorize?${params}`, { headers: cookie, redirect: "manual" });
  const code = new URL(codeResponse.headers.get("location")).searchParams.get("code");
  const tokenResponse = await fetch(`${base}/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: "review-client", grant_type: "authorization_code", code,
      code_verifier: "a".repeat(43) }),
  });
  const issued = await tokenResponse.json();
  if (tokenResponse.status !== 200 || !issued.access_token) throw new Error("could not establish userinfo baseline");
  await measure("userinfo", () => fetch(`${base}/userinfo`, { headers: { authorization: `Bearer ${issued.access_token}` } }));
  const output = { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), environment: "local cf dev, isolated D1, sequential requests, warm process", samples };
  const path = new URL("./performance-local.json", import.meta.url);
  writeFileSync(path, JSON.stringify(output, null, 2) + "\n");
  for (const [name, v] of Object.entries(samples)) console.log(`${name}: median ${v.median} ms (min ${v.min}, max ${v.max}; n=${v.count})`);
} finally {
  instance.stop();
}
process.exit(process.exitCode ?? 0);
