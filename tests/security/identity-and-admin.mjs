#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { startLocal } from "../e2e/instances.mjs";

const port = 9100 + Math.floor(Math.random() * 500);
const instance = await startLocal({ issuer: `http://localhost:${port}`, port });
const base = instance.base;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const checks = [];
const check = (name, actual, expected) => {
  checks.push({ name, actual, expected, pass: actual === expected });
};
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const secret = token();
const cookies = { member: token(), pub: token(), admin: token(), adminStepped: token() };
const apiToken = `eidp_${token()}`;
const cookie = (raw) => ({ cookie: `__Host-idp_session=${raw}` });
const post = (path, raw, fields = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...cookie(raw), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
const get = (path, raw) =>
  fetch(`${base}${path}`, { redirect: "manual", headers: raw ? cookie(raw) : {} });
const location = (r) => r.headers.get("location") ?? "";
const mcpTool = (name, args) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  }).then((r) => r.json());
const toolText = (r) => r?.result?.content?.[0]?.text ?? "";
const scalar = async (q) => Object.values((await instance.sql(q))[0] ?? {})[0];

try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at, public)
      VALUES ('admin-1', ${now}, 'Ada Admin', 'admin@example.test', 1, ${now}, 0),
             ('member-1', ${now}, 'Mo Member', 'member@example.test', 0, ${now}, 0),
             ('public-1', ${now}, 'Pat Player', 'public-1@public.invalid', 0, ${now}, 1);
    INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, step_up_at)
      VALUES ('${hash(cookies.member)}', 'member-1', ${now}, ${now + 3600}, ${now}, NULL),
             ('${hash(cookies.pub)}', 'public-1', ${now}, ${now + 3600}, ${now}, NULL),
             ('${hash(cookies.admin)}', 'admin-1', ${now}, ${now + 3600}, ${now}, NULL),
             ('${hash(cookies.adminStepped)}', 'admin-1', ${now}, ${now + 3600}, ${now}, ${now});
    INSERT INTO api_tokens (id, token_hash, name, created_at, created_by, scope)
      VALUES ('tok-1', '${hash(apiToken)}', 'review', ${now}, 'admin-1', 'admin');
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups,
      created_at, require_pkce, client_type, source, skip_consent, public_signup)
      VALUES ('members', 'Members', '["https://members.example.test/cb", "myapp://cb"]',
        '${hash(secret)}', 'review', NULL, ${now}, 0, 'confidential', 'admin', 1, 0);
    INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups,
      created_at, require_pkce, client_type, source, skip_consent, public_signup)
      VALUES ('third-party', 'Third Party', '["https://tool.example.test/cb"]',
        '', '', NULL, ${now}, 1, 'public', 'dcr', 0, 0);
  `);

  const profile = await post("/account/profile", cookies.member, {
    name: "Mo Member",
    email: "ceo@example.test",
  });
  check("member profile save still succeeds", location(profile), "/account?ok=saved");
  check(
    "…but a member can't change their own email",
    await scalar("SELECT email FROM users WHERE id = 'member-1'"),
    "member@example.test",
  );

  await post("/account/profile", cookies.pub, { name: "Pat", email: "new.hire@example.test" });
  check(
    "a public account can't set an email",
    await scalar("SELECT email FROM users WHERE id = 'public-1'"),
    "public-1@public.invalid",
  );
  const invite = await mcpTool("users_create", {
    name: "New Hire",
    email: "new.hire@example.test",
  });
  check("so the address stays free to invite", toolText(invite).includes("/enroll#"), true);

  const noEmail = await mcpTool("users_make_member", { user_id: "public-1" });
  check("Make member requires an email", noEmail?.result?.isError, true);
  const placeholder = await mcpTool("users_make_member", {
    user_id: "public-1",
    email: "public-1@public.invalid",
  });
  check("…a real one", placeholder?.result?.isError, true);
  const member = await mcpTool("users_make_member", {
    user_id: "public-1",
    email: "pat@example.test",
  });
  check("…and then stores it", member?.result?.isError, undefined);
  check(
    "the account is a member with that email",
    await scalar("SELECT email || ':' || public FROM users WHERE id = 'public-1'"),
    "pat@example.test:0",
  );
  await instance.sql("UPDATE users SET public = 1 WHERE id = 'public-1'");
  const refused = await get(
    `/authorize?${new URLSearchParams({
      client_id: "members",
      redirect_uri: "https://members.example.test/cb",
      response_type: "code",
      scope: "openid",
    })}`,
    cookies.pub,
  );
  check("a public account is refused at a members-only app", refused.status, 403);

  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Totally Legit",
      redirect_uris: ["https://evil.example/cb"],
      token_endpoint_auth_method: "none",
    }),
  }).then((r) => r.json());
  const logout = (clientId, target) =>
    get(
      `/end-session?${new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: target })}`,
    );
  check(
    "a self-registered client can't use /end-session as a redirect",
    location(await logout(reg.client_id, "https://evil.example/fake-login")),
    "/login",
  );
  check(
    "custom-scheme redirect URIs don't make javascript: a match",
    location(await logout("members", "javascript:alert(document.domain)")),
    "/login",
  );
  check(
    "an admin client may return to its own web origin",
    location(await logout("members", "https://members.example.test/bye")),
    "https://members.example.test/bye",
  );

  const tokensBefore = await scalar("SELECT COUNT(*) FROM enrollment_tokens");
  const unstepped = await post("/admin/users/member-1/enrollment", cookies.admin);
  check(
    "an admin session without a recheck is sent to reauthenticate",
    location(unstepped).startsWith("/login?reauth=1"),
    true,
  );
  const createdUnstepped = await post("/admin/users", cookies.admin, {
    name: "Mallory",
    email: "mallory@example.test",
    isAdmin: "1",
  });
  check("…for inviting people too", location(createdUnstepped).startsWith("/login?reauth=1"), true);
  check(
    "…and nothing was written",
    await scalar("SELECT COUNT(*) FROM enrollment_tokens"),
    tokensBefore,
  );
  const self = await post("/admin/users/admin-1/enrollment", cookies.adminStepped);
  check(
    "even after a recheck, an admin can't mint their own link",
    location(self),
    "/admin/users/admin-1",
  );
  check(
    "…so no token exists for them",
    await scalar("SELECT COUNT(*) FROM enrollment_tokens WHERE user_id = 'admin-1'"),
    0,
  );
  const other = await post("/admin/users/member-1/enrollment", cookies.adminStepped);
  check(
    "a rechecked admin can invite someone else",
    (await other.text()).includes("/enroll#"),
    true,
  );

  const mcpAuthz = (extra = {}) =>
    `/authorize?${new URLSearchParams({
      client_id: "members",
      redirect_uri: "https://members.example.test/cb",
      response_type: "code",
      scope: "openid mcp",
      ...extra,
    })}`;
  check(
    "an admin MCP grant needs a recheck",
    location(await get(mcpAuthz(), cookies.admin)).startsWith("/login?"),
    true,
  );
  check(
    "…and prompt=none says login_required",
    new URL(location(await get(mcpAuthz({ prompt: "none" }), cookies.admin))).searchParams.get(
      "error",
    ),
    "login_required",
  );
  check(
    "a rechecked admin gets the code",
    new URL(location(await get(mcpAuthz(), cookies.adminStepped))).searchParams.has("code"),
    true,
  );

  const security = await post("/admin/settings/sign-in", cookies.adminStepped, {
    adminStepUp: "off",
    signInUv: "required",
  });
  check("the recheck window is a setting", location(security), "/admin/settings/sign-in");
  const relaxed = await post("/admin/users/member-1/enrollment", cookies.admin);
  check("with the recheck off, the plain session may act", relaxed.status, 200);
  check(
    "security setting changes are audited",
    await scalar("SELECT COUNT(*) FROM audit_log WHERE event = 'SECURITY_SETTINGS_CHANGED'"),
    1,
  );

  const verifier = token();
  const code = token();
  await instance.sql(`INSERT INTO auth_codes
    (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at, auth_time)
    VALUES ('${hash(code)}', 'third-party', 'admin-1', 'https://tool.example.test/cb',
      '${createHash("sha256").update(verifier).digest("base64url")}', 'openid', ${now + 60}, ${now});`);
  const third = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "third-party",
      code,
      code_verifier: verifier,
    }),
  }).then((r) => r.json());
  const id = third.id_token ? claims(third.id_token) : {};
  check("a third-party openid-only ID token has no email", id.email, undefined);
  check("…no groups", id.groups, undefined);
  check("…and no name", id.name, undefined);

  const exec = await mcpTool("execute", {
    code: "return await Promise.all(Array.from({ length: 60 }, () => id.groups_list({})));",
  });
  const execText = JSON.stringify(exec);
  check(
    "concurrent sandbox calls still hit the 50-call limit",
    execText.includes("tool-call limit"),
    true,
  );

  check("recovery is off by default: no help page", (await get("/recover")).status, 404);
  const offPost = await fetch(`${base}/recover`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "member@example.test" }),
  });
  check("…and no request is taken", offPost.status, 404);
  check("…nor recorded", await scalar("SELECT COUNT(*) FROM recovery_requests"), 0);
  for (const [url, why] of [
    ["http://hooks.example.com/x", "plain http"],
    ["https://10.1.2.3/x", "an IP literal"],
    ["https://user:pw@hooks.example.com/x", "credentials in the URL"],
  ]) {
    await post("/admin/settings/notifications/webhooks", cookies.adminStepped, {
      name: "Bad",
      url,
      format: "json",
    });
    check(`a webhook with ${why} is refused`, await scalar("SELECT COUNT(*) FROM webhooks"), 0);
  }

  const magicOff = await fetch(`${base}/login/email`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "member@example.test", next: "/" }),
  });
  check("email sign-in links are off by default", magicOff.status, 404);
  const junkLink = await fetch(`${base}/login/link`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "x".repeat(43), confirm: "1" }),
  });
  check("an unknown sign-in link signs nobody in", junkLink.status, 400);
  check("…and sets no session", junkLink.headers.get("set-cookie"), null);

  const enroll = await get("/enroll");
  check(
    "the enrollment page keeps no-referrer",
    enroll.headers.get("referrer-policy"),
    "no-referrer",
  );
} finally {
  await instance.stop();
}

let failed = 0;
for (const result of checks) {
  if (!result.pass) failed++;
  console.log(
    `${result.pass ? "PASS" : "FAIL"} ${result.name}: ${JSON.stringify(result.actual)}${
      result.pass ? "" : ` (expected ${JSON.stringify(result.expected)})`
    }`,
  );
}
process.exit(failed ? 1 : 0);
