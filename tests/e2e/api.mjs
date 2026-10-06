#!/usr/bin/env node
/**
 * OIDC API end-to-end test. Self-contained:
 *   1. generates a dev signing key (.dev.vars) if missing
 *   2. applies migrations to local D1, seeds a user + client + session
 *   3. starts `wrangler dev --local` on 127.0.0.1:18877
 *   4. exercises discovery, JWKS, /authorize validation, the full code flow
 *      (including PKCE mismatch + code reuse rejection), and /userinfo
 *   5. stops the server; exits non-zero on any failure
 *
 * Usage: node tests/e2e/api.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const PORT = 18877;
const BASE = `http://127.0.0.1:${PORT}`;
const ISSUER = "https://auth.example.test";
const CLIENT_ID = "test-client-" + randomUUID().slice(0, 8);
const CLIENT_SECRET = "test-secret-" + randomUUID().replace(/-/g, "");
const REDIRECT_URI = "https://app.example.test/cdn-cgi/access/callback";
const USER_ID = randomUUID();
const SESSION_TOKEN = randomUUID().replace(/-/g, "");
const VERIFIER = "test-verifier-" + randomUUID().replace(/-/g, "");

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name} ${extra}`);
  }
}

const sha256Hex = (s) =>
  createHash("sha256").update(s).digest("hex");
const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const CHALLENGE = b64url(createHash("sha256").update(VERIFIER).digest());

function wrangler(...args) {
  execFileSync("npx", ["wrangler", ...args], { stdio: "pipe" });
}

console.log("== setup: dev key ==");
if (!existsSync(".dev.vars")) {
  const jwk = execFileSync("node", ["scripts/gen-key.mjs"], { encoding: "utf8" });
  writeFileSync(".dev.vars", `SIGNING_KEY_JWK='${jwk.trim()}'\nISSUER="${ISSUER}"\nRP_NAME="Test Identity"\n`);
  console.log("  wrote .dev.vars");
} else {
  console.log("  .dev.vars exists");
}

console.log("== setup: local D1 ==");
wrangler("d1", "migrations", "apply", "identity", "--local");
// Local D1 persists between runs: clear previous e2e rows so fixed seed
// emails don't collide with UNIQUE constraints.
wrangler("d1", "execute", "identity", "--local", "--command",
  "DELETE FROM group_members; DELETE FROM groups; DELETE FROM auth_codes; " +
  "DELETE FROM sessions; DELETE FROM webauthn_credentials; " +
  "DELETE FROM enrollment_tokens; DELETE FROM oidc_clients; " +
  "DELETE FROM audit_log; DELETE FROM users;");
const now = Math.floor(Date.now() / 1000);
const seed = [
  `INSERT INTO users (id, created_at, name, email, is_admin, updated_at) VALUES ('${USER_ID}', ${now}, 'Test User', 'test@example.test', 1, ${now});`,
  `INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, created_at) VALUES ('${CLIENT_ID}', 'Test App', '${JSON.stringify([REDIRECT_URI])}', '${sha256Hex(CLIENT_SECRET)}', '${CLIENT_SECRET.slice(0, 6)}', ${now});`,
  `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES ('${sha256Hex(SESSION_TOKEN)}', '${USER_ID}', ${now}, ${now + 3600}, ${now});`,
  `INSERT INTO groups (id, name, created_at) VALUES ('${randomUUID()}', 'family', ${now});`,
  `INSERT INTO group_members (group_id, user_id, created_at) VALUES ((SELECT id FROM groups WHERE name='family'), '${USER_ID}', ${now});`,
].join("\n");
wrangler("d1", "execute", "identity", "--local", "--command", seed);
console.log("  seeded user, client, session, group");

console.log("== starting wrangler dev ==");
const server = spawn("npx", ["wrangler", "dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let ready = false;
server.stdout.on("data", (d) => {
  if (d.toString().includes("Ready")) ready = true;
});
server.stderr.on("data", () => {});
const deadline = Date.now() + 60000;
while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
if (!ready) {
  console.error("wrangler dev did not start in 60s");
  server.kill();
  process.exit(1);
}
console.log("  ready");

const sessionHeaders = { cookie: `idp_session=${SESSION_TOKEN}` };

try {
  console.log("== discovery / jwks ==");
  {
    const r = await fetch(`${BASE}/.well-known/openid-configuration`);
    const doc = await r.json();
    check("discovery 200", r.status === 200);
    check("issuer matches", doc.issuer === ISSUER, doc.issuer);
    check("code_challenge_methods S256", (doc.code_challenge_methods_supported ?? []).includes("S256"));
    check("token auth methods", (doc.token_endpoint_auth_methods_supported ?? []).includes("client_secret_basic"));
  }
  {
    const r = await fetch(`${BASE}/jwks`);
    const jwks = await r.json();
    check("jwks RSA key", jwks.keys?.[0]?.kty === "RSA" && jwks.keys[0].alg === "RS256");
  }

  console.log("== /authorize validation ==");
  const authQ = (params) => `${BASE}/authorize?${new URLSearchParams(params)}`;
  {
    const r = await fetch(authQ({ client_id: "nope", redirect_uri: REDIRECT_URI, response_type: "code" }), { redirect: "manual" });
    check("unknown client -> 400 page", r.status === 400);
  }
  {
    const r = await fetch(authQ({ client_id: CLIENT_ID, redirect_uri: "https://evil.test/x", response_type: "code" }), { redirect: "manual" });
    check("unregistered redirect -> 400 page", r.status === 400);
  }
  {
    const r = await fetch(authQ({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code" }), { redirect: "manual" });
    const loc = r.headers.get("location") ?? "";
    check("missing PKCE -> redirect error", r.status === 302 && loc.includes("error=invalid_request"), loc);
  }
  {
    const r = await fetch(
      authQ({ client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code", code_challenge: CHALLENGE, code_challenge_method: "S256" }),
      { redirect: "manual" },
    );
    const loc = r.headers.get("location") ?? "";
    check("no session -> login bounce", r.status === 302 && loc.startsWith("/login?next="), loc);
  }

  console.log("== full code flow ==");
  let code;
  {
    const r = await fetch(
      authQ({
        client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
        code_challenge: CHALLENGE, code_challenge_method: "S256",
        state: "xyz", scope: "openid profile email groups", nonce: "n-123",
      }),
      { redirect: "manual", headers: sessionHeaders },
    );
    const loc = new URL(r.headers.get("location") ?? "", BASE);
    check("authorize -> code redirect", r.status === 302 && loc.searchParams.has("code"), String(r.status));
    check("state round-trips", loc.searchParams.get("state") === "xyz");
    code = loc.searchParams.get("code");
  }

  const tokenForm = (over) =>
    new URLSearchParams({
      grant_type: "authorization_code",
      code, redirect_uri: REDIRECT_URI, code_verifier: VERIFIER, ...over,
    });
  {
    const r = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`${CLIENT_ID}:wrong`).toString("base64") },
      body: tokenForm(),
    });
    check("wrong secret -> 401", r.status === 401, String(r.status));
  }
  {
    const r = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64") },
      body: tokenForm({ code_verifier: "wrong-verifier" }),
    });
    const j = await r.json();
    check("PKCE mismatch -> invalid_grant", r.status === 400 && j.error === "invalid_grant", JSON.stringify(j));
  }

  let idToken, accessToken;
  {
    const r = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64") },
      body: tokenForm(),
    });
    const j = await r.json();
    check("token 200", r.status === 200, `${r.status} ${JSON.stringify(j).slice(0, 120)}`);
    check("id_token + access_token present", typeof j.id_token === "string" && typeof j.access_token === "string");
    idToken = j.id_token;
    accessToken = j.access_token;
    // Verify the ID token signature against the live JWKS (real crypto, no mocks).
    const { createRemoteJWKSet, jwtVerify } = await import("jose");
    const JWKS = createRemoteJWKSet(new URL(`${BASE}/jwks`));
    const { payload } = await jwtVerify(idToken, JWKS, { issuer: ISSUER, audience: CLIENT_ID });
    check("id_token signature valid", true);
    check("id_token sub", payload.sub === USER_ID, String(payload.sub));
    check("id_token email", payload.email === "test@example.test");
    check("id_token groups", JSON.stringify(payload.groups) === JSON.stringify(["family"]), JSON.stringify(payload.groups));
    check("id_token nonce", payload.nonce === "n-123");
    check("id_token alg RS256", true);
  }
  {
    // client_secret_post also works
    const r = await fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenForm({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    check("code reuse -> invalid_grant", r.status === 400, String(r.status));
  }
  {
    const r = await fetch(`${BASE}/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const j = await r.json();
    check("userinfo 200", r.status === 200);
    check("userinfo claims", j.sub === USER_ID && j.email === "test@example.test" && j.groups?.[0] === "family", JSON.stringify(j));
  }
  {
    const r = await fetch(`${BASE}/userinfo`, {
      headers: { authorization: "Bearer bogus" },
    });
    check("userinfo bogus token -> 401", r.status === 401);
  }
} finally {
  server.kill();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
