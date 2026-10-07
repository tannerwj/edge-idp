#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { startLocal, startRemote } from "./instances.mjs";
import { createRemoteJWKSet, jwtVerify, decodeJwt } from "jose";

const STAGE = process.env.E2E_STAGE;
const PORT = 8790 + Math.floor(Math.random() * 100);
const instance = STAGE
  ? await startRemote({ stage: STAGE })
  : await startLocal({ issuer: `http://localhost:${PORT}`, port: PORT });
const BASE = instance.base;
const MCP = `${BASE}/mcp`;

let failures = 0;
let section = "";
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(
      `  FAIL [${section}] ${name} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`,
    );
  }
}
function step(name) {
  section = name;
  console.log(`\n== ${name} ==`);
}

const sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const pkce = () => {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
};
const form = (o) => new URLSearchParams(o).toString();

step("setup");
const sql = instance.sql;
const now = Math.floor(Date.now() / 1000);
const adminToken = b64url(randomBytes(32));
await sql(
  `INSERT INTO users (id, created_at, name, email, is_admin, updated_at) VALUES ('admin-1', ${now}, 'Ada Admin', 'ada@example.test', 1, ${now});` +
    `INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at) VALUES ('${sha256Hex(adminToken)}', 'admin-1', ${now}, ${now + 3600});`,
);
console.log(`  ${instance.remote ? "deployed" : "cf dev"} on ${BASE} (${instance.work})`);

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

async function authorizeInBrowser(params, { approve } = {}) {
  const redirect = new URL(params.redirect_uri);
  let captured = null;
  const onReq = (r) => {
    const u = new URL(r.url());
    if (u.origin === redirect.origin && u.pathname === redirect.pathname) captured = u;
  };
  page.on("request", onReq);
  await page.goto(`${BASE}/authorize?${new URLSearchParams(params)}`).catch(() => {});
  if (
    !captured &&
    approve !== undefined &&
    (await page
      .waitForSelector("form[action='/authorize/decision']", { timeout: 5000 })
      .catch(() => null))
  ) {
    await page.click(`button[value='${approve ? "allow" : "deny"}']`).catch(() => {});
    for (let i = 0; i < 50 && !captured; i++) await page.waitForTimeout(100);
  }
  page.off("request", onReq);
  await page.waitForLoadState("load").catch(() => {});
  return captured;
}

async function mcpCall(token, method, params = {}, headers = {}) {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return {
    status: r.status,
    www: r.headers.get("www-authenticate"),
    body: await r.json().catch(() => null),
  };
}

try {
  step("enroll + sign in with a passkey");
  await page.goto(`${BASE}/enroll/${adminToken}`);
  await page.fill("#key-name", "E2E key");
  await page.click("#enroll-btn");
  await page.waitForURL(`${BASE}/?**`, { timeout: 15000 }).catch(() => {});
  check("enrollment lands on home", new URL(page.url()).pathname === "/", page.url());
  check("home greets the user", (await page.textContent("h1"))?.includes("Ada"));
  const creds = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  check(
    "authenticator holds one resident credential",
    creds.credentials.length === 1 && creds.credentials[0].isResidentCredential,
  );
  const reuse = await page.request.get(`${BASE}/enroll/${adminToken}`);
  check("enrollment link is single-use", reuse.status() === 400);

  await page.click("form[action='/logout'] button");
  await page.waitForURL(/\/login/);
  check("logout lands on sign-in", page.url().includes("/login"));
  await page.click("#passkey-btn", { timeout: 3000 }).catch(() => {});
  await page.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
  check("passkey sign-in works", new URL(page.url()).pathname === "/", page.url());
  const cookies = await ctx.cookies(BASE);
  const sess = cookies.find((c) => c.name === "__Host-idp_session");
  check(
    "session cookie is __Host-, HttpOnly, Secure",
    !!sess && sess.httpOnly && sess.secure && sess.path === "/",
    sess,
  );

  step("credential changes require a fresh passkey recheck");
  const beforeStepUp = await page.request.post(`${BASE}/webauthn/register/options`, { data: {} });
  check(
    "fresh login session alone cannot add a passkey",
    beforeStepUp.status() === 401 && (await beforeStepUp.json()).error === "reauth_required",
  );
  await page.goto(`${BASE}/login?reauth=1&next=${encodeURIComponent("/account#passkeys")}`);
  await page.click("#passkey-btn", { timeout: 3000 }).catch(() => {});
  await page.waitForURL(/\/account/, { timeout: 15000 });
  const afterStepUp = await page.request.post(`${BASE}/webauthn/register/options`, { data: {} });
  check("explicit passkey recheck allows add-key options", afterStepUp.status() === 200);

  step("admin UI");
  for (const p of [
    "/admin",
    "/admin/users",
    "/admin/users/admin-1",
    "/admin/groups",
    "/admin/apps",
    "/admin/clients",
    "/admin/audit",
    "/admin/connect",
    "/admin/tokens",
    "/admin/metrics",
    "/admin/settings",
    "/account",
  ]) {
    const r = await page.goto(BASE + p);
    check(`GET ${p} renders`, r?.status() === 200, String(r?.status()));
  }
  check(
    "every page is standards mode",
    await page.evaluate(() => document.compatMode === "CSS1Compat"),
  );

  await page.goto(`${BASE}/admin/groups`);
  await page.click("[data-open='new-group']");
  await page.fill("#new-group input[name=name]", "family");
  await page.click("#new-group button[type=submit]");
  await page.waitForLoadState();
  check("group created via UI", (await page.textContent("body")).includes("family"));

  await page.goto(`${BASE}/admin/users/admin-1`);
  await page.click("label.chip-toggle:has-text('family')");
  await page.click("form[action='/admin/users/admin-1/groups'] button[type=submit]");
  await page.waitForLoadState();

  await page.goto(`${BASE}/admin/users`);
  await page.click("button[data-open='invite']");
  await page.fill("#invite input[name=name]", "Bob Member");
  await page.fill("#invite input[name=email]", "bob@example.test");
  await page.click("#invite button[type=submit]");
  await page.waitForLoadState();
  const invite = await page.getAttribute("[data-copy]", "data-copy");
  check("invite keeps bearer out of request path", !!invite?.startsWith(`${BASE}/enroll#`), invite);

  await page.goto(`${BASE}/admin/clients`);
  await page.click("button[data-open='new-client']");
  await page.fill("#new-client input[name=name]", "Test App");
  await page.fill("#new-client textarea[name=redirectUris]", "https://app.example.test/callback");
  await page.click("#new-client label.chip-toggle:has-text('family')");
  await page.click("#new-client button[type=submit]");
  await page.waitForLoadState();
  const copies = await page.$$eval("[data-copy]", (els) =>
    els.map((e) => e.getAttribute("data-copy")),
  );
  const CLIENT_ID = copies[0];
  const CLIENT_SECRET = copies[1];
  check(
    "client registered with id + secret",
    !!CLIENT_ID && !!CLIENT_SECRET && CLIENT_SECRET.length > 30,
  );
  const detail = await page.goto(`${BASE}/admin/clients/${encodeURIComponent(CLIENT_ID)}`);
  check("client detail page", detail?.status() === 200);

  step("same-origin guard");
  {
    const r = await page.request.post(`${BASE}/admin/groups`, {
      form: { name: "evil" },
      headers: { origin: "https://evil.example.test", "sec-fetch-site": "same-site" },
      maxRedirects: 0,
    });
    check("cross-origin admin POST is refused", r.status() === 403, String(r.status()));
    const g = (await sql("SELECT COUNT(*) AS n FROM groups WHERE name = 'evil'"))[0]?.n;
    check("…and changed nothing", g === 0);
  }

  step("OIDC authorization code flow");
  const JWKS = createRemoteJWKSet(new URL(`${BASE}/jwks`));
  const { verifier, challenge } = pkce();
  const cb = await authorizeInBrowser({
    client_id: CLIENT_ID,
    redirect_uri: "https://app.example.test/callback",
    response_type: "code",
    scope: "openid profile email groups",
    state: "s1",
    nonce: "n1",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  check("redirected with code", !!cb?.searchParams.get("code"), cb?.toString());
  check(
    "state + iss echoed",
    cb?.searchParams.get("state") === "s1" && cb?.searchParams.get("iss") === BASE,
  );
  const code = cb?.searchParams.get("code");
  const basic = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const tokenReq = (body, auth = basic) =>
    fetch(`${BASE}/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(auth ? { authorization: auth } : {}),
      },
      body: form(body),
    });
  const tr = await tokenReq({
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://app.example.test/callback",
    code_verifier: verifier,
  });
  const tok = await tr.json();
  check("token endpoint 200", tr.status === 200, tok);
  check("token response is no-store", tr.headers.get("cache-control") === "no-store");
  const { payload: idp } = await jwtVerify(tok.id_token, JWKS, {
    issuer: BASE,
    audience: CLIENT_ID,
  });
  check(
    "id_token claims",
    idp.email === "ada@example.test" && idp.nonce === "n1" && idp.groups?.includes("family"),
    idp,
  );
  check(
    "auth_time is the ceremony time, not mint time",
    typeof idp.auth_time === "number" && idp.auth_time <= idp.iat,
    idp,
  );
  check("no refresh token without offline_access", !tok.refresh_token);
  const replay = await tokenReq({
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://app.example.test/callback",
    code_verifier: verifier,
  });
  check("auth code is single-use", replay.status === 400);
  const ui = await fetch(`${BASE}/userinfo`, {
    headers: { authorization: `Bearer ${tok.access_token}` },
  });
  check(
    "userinfo with access token",
    ui.status === 200 && (await ui.json()).email === "ada@example.test",
  );
  const uiId = await fetch(`${BASE}/userinfo`, {
    headers: { authorization: `Bearer ${tok.id_token}` },
  });
  check("an ID token is NOT accepted as an access token", uiId.status === 401);

  step("regression: app tokens can't drive the admin API");
  {
    const r = await mcpCall(tok.access_token, "tools/list");
    check("app access token rejected at /mcp", r.status === 401, r);
    check(
      "401 advertises resource metadata + scope",
      r.www?.includes("resource_metadata=") && r.www?.includes('scope="mcp"'),
      r.www,
    );
  }

  step("prompt / max_age");
  {
    const pn = await fetch(
      `${BASE}/authorize?${new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: "https://app.example.test/callback", response_type: "code", scope: "openid", prompt: "none", code_challenge: challenge, code_challenge_method: "S256" })}`,
      { redirect: "manual" },
    );
    check(
      "prompt=none without a session → login_required",
      (pn.headers.get("location") ?? "").includes("error=login_required"),
    );
    const reauth = await ctx.newPage();
    await reauth.goto(
      `${BASE}/authorize?${new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: "https://app.example.test/callback", response_type: "code", scope: "openid", prompt: "login", code_challenge: challenge, code_challenge_method: "S256" })}`,
    );
    check(
      "prompt=login forces the sign-in page",
      reauth.url().includes("/login") && reauth.url().includes("reauth=1"),
      reauth.url(),
    );
    check(
      "sign-in page names the app",
      ((await reauth.textContent("body").catch(() => "")) ?? "").includes("Test App"),
    );
    await reauth.close();
  }

  step("MCP discovery");
  {
    const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    check(
      "PRM resource is the MCP URL",
      prm.resource === MCP && prm.authorization_servers?.[0] === BASE,
    );
    const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    check(
      "AS metadata: CIMD + none + S256 + offline_access",
      as.client_id_metadata_document_supported === true &&
        as.token_endpoint_auth_methods_supported.includes("none") &&
        as.code_challenge_methods_supported.includes("S256") &&
        as.scopes_supported.includes("offline_access"),
    );
  }

  step("MCP via dynamic client registration (Cursor/Claude Code style)");
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "E2E Agent",
      redirect_uris: ["http://localhost/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  const dcr = await reg.json();
  check("DCR 201 public client", reg.status === 201 && dcr.client_id && !dcr.client_secret, dcr);
  const badReg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }),
  });
  check("DCR rejects dangerous redirect schemes", badReg.status === 400);

  const p2 = pkce();
  const redirect = "http://localhost:53682/callback";
  const mcpAuth = {
    client_id: dcr.client_id,
    redirect_uri: redirect,
    response_type: "code",
    scope: "mcp offline_access",
    resource: MCP,
    state: "m1",
    code_challenge: p2.challenge,
    code_challenge_method: "S256",
  };
  await page.goto(`${BASE}/authorize?${new URLSearchParams(mcpAuth)}`);
  check(
    "third-party client gets a consent screen",
    !!(await page.$("form[action='/authorize/decision']")),
  );
  check(
    "consent warns about a local redirect",
    (await page.textContent("body")).includes("runs on your computer"),
  );
  const denied = await authorizeInBrowser(mcpAuth, { approve: false });
  check(
    "deny → access_denied",
    denied?.searchParams.get("error") === "access_denied",
    denied?.toString(),
  );
  const allowed = await authorizeInBrowser(mcpAuth, { approve: true });
  const mcode = allowed?.searchParams.get("code");
  check("allow → code", !!mcode, allowed?.toString());
  const noPkce = await tokenReq(
    { grant_type: "authorization_code", code: "x", client_id: dcr.client_id },
    null,
  );
  check("public client without a valid code fails", noPkce.status === 400);
  const mt = await (
    await tokenReq(
      {
        grant_type: "authorization_code",
        code: mcode,
        client_id: dcr.client_id,
        code_verifier: p2.verifier,
        redirect_uri: redirect,
        resource: MCP,
      },
      null,
    )
  ).json();
  check("MCP token issued with refresh token", !!mt.access_token && !!mt.refresh_token, mt);
  const claims = decodeJwt(mt.access_token);
  check(
    "access token audience is the MCP resource",
    claims.aud === MCP && String(claims.scope).includes("mcp"),
    claims,
  );
  check("no ID token without openid scope", !mt.id_token);

  const init = await mcpCall(mt.access_token, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  check(
    "initialize negotiates 2025-11-25",
    init.body?.result?.protocolVersion === "2025-11-25",
    init.body,
  );
  const list = await mcpCall(mt.access_token, "tools/list");
  const names = (list.body?.result?.tools ?? []).map((t) => t.name);
  check(
    "tools/list includes users + execute",
    names.includes("users_list") && names.includes("execute"),
    names,
  );
  const call = await mcpCall(mt.access_token, "tools/call", { name: "users_list", arguments: {} });
  const users = JSON.parse(call.body?.result?.content?.[0]?.text ?? "[]");
  check(
    "tools/call users_list",
    users.some((u) => u.email === "bob@example.test"),
    call.body,
  );
  const created = await mcpCall(mt.access_token, "tools/call", {
    name: "groups_create",
    arguments: { name: "friends" },
  });
  check("write tool works with mcp scope", !created.body?.result?.isError, created.body);
  const exec = await mcpCall(mt.access_token, "tools/call", {
    name: "execute",
    arguments: {
      code: `return (await id.users_create({ name: "Cody Mode", email: "cody@example.test" })).enrollment_link;`,
    },
  });
  const execOut = exec.body?.result?.content?.[0]?.text ?? "";
  check(
    "execute: tool calls inside the sandbox see the issuer",
    !exec.body?.result?.isError && execOut.includes(`${BASE}/enroll#`),
    exec.body,
  );
  const sandboxed = async (code) =>
    JSON.parse(
      (await mcpCall(mt.access_token, "tools/call", { name: "execute", arguments: { code } })).body
        ?.result?.content?.[0]?.text ?? "{}",
    );
  check(
    "execute: sandbox has no network",
    (
      await sandboxed(
        `try { await fetch("https://example.com"); return "open"; } catch { return "blocked"; }`,
      )
    ).value === "blocked",
  );
  const recursion = await mcpCall(mt.access_token, "tools/call", {
    name: "execute",
    arguments: { code: `return await id.execute({ code: "1" });` },
  });
  check(
    "execute: can't call execute",
    (recursion.body?.result?.content?.[0]?.text ?? "").includes("not available inside execute"),
    recursion.body,
  );
  await sql(
    `INSERT INTO mcp_calls (tool_name, started_at, duration_ms, success) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200) SELECT 'percentile_probe', ${Math.floor(Date.now() / 1000)}, i, 1 FROM n`,
  );
  const metrics = await mcpCall(mt.access_token, "tools/call", {
    name: "metrics_summary",
    arguments: {},
  });
  const probe = (JSON.parse(metrics.body?.result?.content?.[0]?.text ?? "{}").per_tool ?? []).find(
    (t) => t.tool === "percentile_probe",
  );
  check(
    "metrics_summary percentiles cover every call, not the fastest 1000",
    probe?.calls === 1200 && probe?.latency_ms?.p50 === 601 && probe?.latency_ms?.p95 === 1141,
    probe,
  );
  const modern = await mcpCall(
    mt.access_token,
    "tools/call",
    { name: "groups_list", arguments: {} },
    { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "wrong" },
  );
  check(
    "2026-07-28: header/body mismatch → -32020",
    modern.status === 400 && modern.body?.error?.code === -32020,
    modern.body,
  );
  const notif = await fetch(MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${mt.access_token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  check("notifications → 202", notif.status === 202);
  const xo = await mcpCall(
    mt.access_token,
    "tools/list",
    {},
    { origin: "https://evil.example.test" },
  );
  check("browser cross-origin MCP call refused", xo.status === 403);

  step("refresh token rotation + reuse detection");
  const r1 = await (
    await tokenReq(
      { grant_type: "refresh_token", refresh_token: mt.refresh_token, client_id: dcr.client_id },
      null,
    )
  ).json();
  check("refresh rotates", !!r1.refresh_token && r1.refresh_token !== mt.refresh_token, r1);
  const reused = await tokenReq(
    { grant_type: "refresh_token", refresh_token: mt.refresh_token, client_id: dcr.client_id },
    null,
  );
  check("replaying a rotated refresh token fails", reused.status === 400);
  const afterReuse = await tokenReq(
    { grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: dcr.client_id },
    null,
  );
  check("…and revokes the whole family", afterReuse.status === 400);

  step("revoking consent kills the grant");
  {
    const p3 = pkce();
    const a3 = await authorizeInBrowser({ ...mcpAuth, code_challenge: p3.challenge });
    check("remembered consent: no second prompt", !!a3?.searchParams.get("code"), a3?.toString());
    const t3 = await (
      await tokenReq(
        {
          grant_type: "authorization_code",
          code: a3?.searchParams.get("code"),
          client_id: dcr.client_id,
          code_verifier: p3.verifier,
          redirect_uri: redirect,
        },
        null,
      )
    ).json();
    await page.goto(`${BASE}/account#connected`);
    let nativeDialog = false;
    const onNative = (d) => {
      nativeDialog = true;
      void d.dismiss();
    };
    page.on("dialog", onNative);
    const revoke = "form[action='/account/grants/revoke'] button";
    await page.click(revoke);
    await page.waitForSelector("#confirm-dialog[open]");
    check("confirmation is the styled dialog, not window.confirm", !nativeDialog);
    check(
      "confirm dialog names the action",
      (await page.textContent("#confirm-title"))?.startsWith("Disconnect") &&
        (await page.textContent("#confirm-ok"))?.trim().length > 0,
    );
    await page.click("#confirm-dialog [data-close]");
    await page.waitForSelector("#confirm-dialog", { state: "hidden" });
    check("cancel keeps the grant", !!(await page.$(revoke)));
    await page.click(revoke);
    await page.waitForSelector("#confirm-dialog[open]");
    await Promise.all([page.waitForNavigation(), page.click("#confirm-ok")]);
    page.off("dialog", onNative);
    const after = await tokenReq(
      { grant_type: "refresh_token", refresh_token: t3.refresh_token, client_id: dcr.client_id },
      null,
    );
    check("refresh fails after the user disconnects the app", after.status === 400);
  }

  step("API tokens");
  {
    await page.goto(`${BASE}/admin/tokens`);
    await page.click("button[data-open='new-token']");
    await page.fill("#new-token input[name=name]", "read bot");
    await page.click("#new-token button[type=submit]");
    await page.waitForLoadState();
    const ro = await page.getAttribute("[data-copy]", "data-copy");
    check("read-only token minted (eidp_ prefix)", !!ro?.startsWith("eidp_"), ro);
    const read = await mcpCall(ro, "tools/call", { name: "users_list", arguments: {} });
    check("read tool allowed", read.status === 200 && !read.body?.result?.isError);
    const write = await mcpCall(ro, "tools/call", {
      name: "groups_create",
      arguments: { name: "nope" },
    });
    check(
      "write tool → 403 insufficient_scope step-up",
      write.status === 403 && (write.www ?? "").includes("insufficient_scope"),
      write,
    );
    const listed = await mcpCall(ro, "tools/list");
    check(
      "read-only tools/list hides write tools",
      !(listed.body?.result?.tools ?? []).some((t) => t.name === "groups_create"),
    );
  }

  step("CIMD (claude.ai-hosted metadata document)");
  if (process.env.E2E_OFFLINE) {
    console.log("  skip (E2E_OFFLINE)");
  } else {
    const cimdId = "https://claude.ai/oauth/claude-code-client-metadata";
    const p4 = pkce();
    await page.goto(
      `${BASE}/authorize?${new URLSearchParams({ client_id: cimdId, redirect_uri: "http://localhost:40123/callback", response_type: "code", scope: "mcp", resource: MCP, code_challenge: p4.challenge, code_challenge_method: "S256" })}`,
    );
    const body = await page.textContent("body");
    check(
      "CIMD client resolves and shows its publisher",
      body.includes("claude.ai") && body.includes("Claude Code"),
      body.slice(0, 400),
    );
    const bad = await fetch(
      `${BASE}/authorize?${new URLSearchParams({ client_id: cimdId, redirect_uri: "https://evil.example.test/cb", response_type: "code", scope: "mcp", code_challenge: p4.challenge, code_challenge_method: "S256" })}`,
      { redirect: "manual" },
    );
    check("CIMD client can't use an unlisted redirect", bad.status === 400);
  }

  step("audit trail");
  {
    const events = (await sql("SELECT DISTINCT event FROM audit_log")).map((r) => r.event);
    for (const e of [
      "PASSKEY_REGISTERED",
      "SIGN_IN",
      "CLIENT_CREATED",
      "CLIENT_REGISTERED",
      "CONSENT_GRANTED",
      "CONSENT_DENIED",
      "REFRESH_REUSE_DETECTED",
      "CONSENT_REVOKED",
    ]) {
      check(`audited: ${e}`, events.includes(e));
    }
    const csv = await page.request.get(`${BASE}/admin/audit.csv`);
    check("audit CSV export", csv.status() === 200 && (await csv.text()).startsWith("time,event"));
  }

  step("maintenance cron");
  if (instance.remote) {
    console.log("  skip (local-only trigger; check the :17 run in Workers Logs)");
  } else {
    const r = await fetch(`${BASE}/cdn-cgi/local/scheduled`);
    check("scheduled handler runs", r.ok, String(r.status));
  }

  step("instance settings");
  {
    const setting = async (key) =>
      (await sql(`SELECT value FROM instance_settings WHERE key = '${key}'`))[0]?.value ?? null;
    const saveSettings = () =>
      Promise.all([
        page.waitForNavigation(),
        page.click("form[action='/admin/settings'] button[type=submit]"),
      ]);
    await page.goto(`${BASE}/admin/settings`);
    await page.fill("input[name=name]", "Renamed ID");
    await saveSettings();
    check("rename applies across the app", (await page.title()).endsWith("Renamed ID"));
    let renamedEverywhere = false;
    for (let i = 0; i < 30 && !renamedEverywhere; i++) {
      renamedEverywhere = (await (await fetch(`${BASE}/login`)).text()).includes("Renamed ID");
      if (!renamedEverywhere) await new Promise((r) => setTimeout(r, 500));
    }
    check("sign-in page shows the new name within the cache window", renamedEverywhere);
    await page.request.post(`${BASE}/admin/settings`, { form: { name: "   ", accent: "indigo" } });
    check("a blank name is refused", (await setting("instance_name")) === "Renamed ID");
    await page.goto(`${BASE}/admin/settings`);
    await page.fill("input[name=name]", "E2E Identity");
    await saveSettings();

    check(
      "Cloudflare card offers to connect",
      !!(await page.$("#cloudflare form[action='/admin/settings/cloudflare']")),
    );
    if (!process.env.E2E_OFFLINE) {
      await page.fill("#cloudflare input[name=token]", "e2eNotARealCloudflareToken0123456789abcd");
      await page.fill("#cloudflare input[name=accountId]", "0123456789abcdef0123456789abcdef");
      await Promise.all([page.waitForNavigation(), page.click("#cloudflare button[type=submit]")]);
      check(
        "a token Cloudflare rejects is not saved",
        (await setting("cf_api_token")) === null &&
          ((await page.getAttribute("body", "data-flash")) ?? "").includes("Cloudflare rejected"),
      );
    }
    await sql(
      "INSERT INTO instance_settings (key, value, updated_at) VALUES ('cf_api_token', 'seeded-token-value-0123456789', 0), ('cf_account_id', 'fedcba9876543210fedcba9876543210', 0)",
    );
    await page.goto(`${BASE}/admin/settings`);
    const card = (await page.textContent("#cloudflare")) ?? "";
    check(
      "a saved connection shows as connected, never the token",
      card.includes("fedcba9876543210fedcba9876543210") &&
        !card.includes("seeded-token-value") &&
        !(await page.content()).includes("seeded-token-value"),
    );
    await page.click("form[action='/admin/settings/cloudflare/remove'] button");
    await page.waitForSelector("#confirm-dialog[open]");
    await Promise.all([page.waitForNavigation(), page.click("#confirm-ok")]);
    check(
      "disconnect clears the stored credentials",
      (await setting("cf_api_token")) === null && (await setting("cf_account_id")) === null,
    );
  }

  step("feedback + update notice");
  {
    if (!instance.remote) {
      const stamped = (
        await sql("SELECT value FROM instance_settings WHERE key = 'upstream_checked_at'")
      )[0]?.value;
      check("cron ran the daily update check", Number(stamped) > 0, String(stamped));
      if (!process.env.E2E_OFFLINE) {
        const seen = (
          await sql("SELECT value FROM instance_settings WHERE key = 'upstream_version'")
        )[0]?.value;
        check("…and recorded upstream's version", /^\d+\.\d+\.\d+/.test(seen ?? ""), String(seen));
      }
    }
    await page.goto(`${BASE}/admin/settings`);
    const bug = await page.getAttribute("#about a[href*='template=bug.yml']", "href");
    const version = (await page.textContent("#about .badge.mono"))?.replace(/^v/, "");
    check(
      "About shows the version and a pre-filled bug link",
      !!version && !!bug && new URL(bug).searchParams.get("version") === version,
      { bug, version },
    );
    check(
      "feature link goes upstream",
      !!(await page.$(
        "#about a[href^='https://github.com/tannerwj/edge-idp/issues/new?template=feature.yml']",
      )),
    );
    await sql(
      "INSERT INTO instance_settings (key, value, updated_at) VALUES ('upstream_version', '999.0.0', 0) ON CONFLICT(key) DO UPDATE SET value = '999.0.0'",
    );
    await page.goto(`${BASE}/admin`);
    check(
      "overview says a newer version is out",
      (await page.textContent("body")).includes("v999.0.0 is available"),
    );
    await page.goto(`${BASE}/admin/settings`);
    check(
      "settings links to how to update",
      !!(await page.$("#about a[href$='DEPLOY.md#staying-up-to-date']")),
    );
  }

  check("no uncaught browser errors", pageErrors.length === 0, pageErrors);
} catch (e) {
  failures++;
  console.error(`  FAIL [${section}] threw:`, e);
} finally {
  await browser.close();
  await instance.stop();
}

const EXPECTED_ERRORS = ["execute is not available inside execute"];
const serverErrors = instance
  .log()
  .split("\n")
  .filter((l) => /ERROR|Uncaught/.test(l) && !EXPECTED_ERRORS.some((e) => l.includes(e)));
if (serverErrors.length) {
  console.error("\nserver log contained errors:\n" + serverErrors.slice(0, 20).join("\n"));
  failures++;
}
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
