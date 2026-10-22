#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { startLocal } from "../../../tests/e2e/instances.mjs";

const port = 9600 + Math.floor(Math.random() * 300);
const instance = await startLocal({ issuer: `http://localhost:${port}`, port });
const base = instance.base;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const checks = [];
const check = (name, actual, expected) =>
  checks.push({ name, actual, expected, pass: actual === expected });
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const secret = token();
const memberCookie = token();
const publicCookie = token();
const apiToken = `eidp_${token()}`;
const cookie = (raw) => ({ cookie: `__Host-idp_session=${raw}` });

try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at, public)
      VALUES ('admin-1', ${now}, 'Ada Admin', 'admin@example.test', 1, ${now}, 0),
             ('member-1', ${now}, 'Mo Member', 'member@example.test', 0, ${now}, 0),
             ('public-1', ${now}, 'Pat Player', 'public-1@public.invalid', 0, ${now}, 1);
    INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at)
      VALUES ('${hash(memberCookie)}', 'member-1', ${now}, ${now + 3600}, ${now}),
             ('${hash(publicCookie)}', 'public-1', ${now}, ${now + 3600}, ${now});
    INSERT INTO api_tokens (id, token_hash, name, created_at, created_by, scope)
      VALUES ('tok-1', '${hash(apiToken)}', 'review', ${now}, 'admin-1', 'admin');
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups,
      created_at, require_pkce, client_type, source, skip_consent, public_signup)
      VALUES ('access-like', 'Cloudflare Access', '["https://team.example.test/cb"]',
        '${hash(secret)}', 'review', NULL, ${now}, 0, 'confidential', 'admin', 1, 0);
  `);

  const profile = await fetch(`${base}/account/profile`, {
    method: "POST",
    redirect: "manual",
    headers: { ...cookie(memberCookie), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Mo Member", email: "ceo@example.test" }),
  });
  check("member changes own email without verification", profile.headers.get("location"), "/account?ok=saved");

  const authz = await fetch(
    `${base}/authorize?` +
      new URLSearchParams({
        client_id: "access-like",
        redirect_uri: "https://team.example.test/cb",
        response_type: "code",
        scope: "openid email profile",
      }),
    { redirect: "manual", headers: cookie(memberCookie) },
  );
  const code = new URL(authz.headers.get("location")).searchParams.get("code");
  const tok = await fetch(`${base}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`access-like:${secret}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code }),
  }).then((r) => r.json());
  const id = claims(tok.id_token);
  check("ID token asserts the self-chosen email", id.email, "ceo@example.test");
  check("…as verified", id.email_verified, true);

  const pub = await fetch(`${base}/account/profile`, {
    method: "POST",
    redirect: "manual",
    headers: { ...cookie(publicCookie), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ name: "Pat Player", email: "new.hire@example.test" }),
  });
  check("public account claims a real email", pub.headers.get("location"), "/account?ok=saved");
  const mcpCall = (name, args) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }).then((r) => r.json());
  const create = await mcpCall("users_create", { name: "New Hire", email: "new.hire@example.test" });
  check(
    "admin can no longer invite that address",
    JSON.stringify(create).includes("already exists"),
    true,
  );

  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Totally Legit",
      redirect_uris: ["https://evil.example/cb", "evilapp://cb"],
      token_endpoint_auth_method: "none",
    }),
  }).then((r) => r.json());
  check("anonymous DCR registration succeeds", typeof reg.client_id, "string");
  const out = await fetch(
    `${base}/end-session?` +
      new URLSearchParams({ client_id: reg.client_id, post_logout_redirect_uri: "https://evil.example/fake-login" }),
    { redirect: "manual" },
  );
  check("/end-session redirects off-site", out.headers.get("location"), "https://evil.example/fake-login");
  const opaque = await fetch(
    `${base}/end-session?` +
      new URLSearchParams({ client_id: reg.client_id, post_logout_redirect_uri: "javascript:alert(document.domain)" }),
    { redirect: "manual" },
  );
  check("opaque-origin match accepts javascript:", opaque.headers.get("location"), "javascript:alert(document.domain)");

  const adminCookie = token();
  await instance.sql(`INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at)
    VALUES ('${hash(adminCookie)}', 'admin-1', ${now - 7200}, ${now + 3600}, ${now});`);
  const selfStepUp = await fetch(`${base}/webauthn/register/options`, {
    method: "POST",
    headers: { ...cookie(adminCookie), "content-type": "application/json" },
    body: "{}",
  });
  check("account path: adding a passkey needs step-up", selfStepUp.status, 401);
  const selfLink = await fetch(`${base}/admin/users/admin-1/enrollment`, {
    method: "POST",
    redirect: "manual",
    headers: cookie(adminCookie),
  });
  const html = await selfLink.text();
  const enrollToken = html.match(/\/enroll#([A-Za-z0-9_-]{43})/)?.[1];
  check("admin path: same session mints itself an enrollment link", typeof enrollToken, "string");
  const opts = await fetch(`${base}/webauthn/register/options`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollmentToken: enrollToken }),
  });
  check("…which starts a passkey registration on the admin, no step-up", opts.status, 200);
} finally {
  await instance.stop();
}

let failed = 0;
for (const r of checks) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? "REPRODUCED" : "NOT REPRODUCED"} ${r.name}: ${JSON.stringify(r.actual)}`);
}
process.exit(failed ? 1 : 0);
