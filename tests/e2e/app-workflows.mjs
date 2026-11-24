import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const challenge = (value) => createHash("sha256").update(value).digest("base64url");
const copyValue = (html) => {
  const value = html.match(/data-copy="([^"]+)"/)?.[1];
  assert.ok(value);
  return value.replaceAll("&amp;", "&");
};

export async function appWorkflows({ base, instance, request }) {
  const verifier = random(),
    secret = random(),
    client = "workflow-client";
  const exchange = async (body) =>
    fetch(base + "/token", { method: "POST", body: new URLSearchParams(body) });
  const rp = createServer(async (req, res) => {
    try {
      if (req.url === "/") {
        const query = new URLSearchParams({
          client_id: client,
          redirect_uri: appUrl + "/cb",
          scope: "openid",
          response_type: "code",
          code_challenge: challenge(verifier),
          code_challenge_method: "S256",
        });
        res.writeHead(302, { location: base + "/authorize?" + query }).end();
        return;
      }
      const code = new URL(req.url, appUrl).searchParams.get("code");
      if (!code) {
        res.writeHead(404).end();
        return;
      }
      const result = await exchange({
        grant_type: "authorization_code",
        client_id: client,
        client_secret: secret,
        redirect_uri: appUrl + "/cb",
        code,
        code_verifier: verifier,
      });
      const tokens = await result.json();
      res
        .writeHead(result.ok && tokens.id_token ? 200 : 400)
        .end(tokens.id_token ? "Signed in to the app" : "Sign-in failed");
    } catch {
      res.writeHead(500).end();
    }
  });
  rp.listen(0, "127.0.0.1");
  await once(rp, "listening");
  const appUrl = "http://localhost:" + rp.address().port;
  const browser = await chromium.launch();
  try {
    await instance.sql(
      `INSERT INTO oidc_clients(id,name,redirect_uris,secret_hash,secret_prefix,require_pkce,created_at) VALUES ('workflow-client','Workflow app','["${appUrl}/cb"]','${digest(secret)}','test',1,unixepoch()); INSERT INTO apps(id,name,url,client_id,created_at,requestable) VALUES('workflow','Workflow app','${appUrl}','workflow-client',unixepoch(),1);`,
    );
    const invite = { email: "new-member@example.test", name: "New Member" };
    assert.match(
      await (await request("/admin/apps/workflow/invite-preview", invite)).text(),
      /new member account/i,
    );
    assert.equal(
      (await instance.sql("SELECT id FROM users WHERE email='new-member@example.test'")).length,
      0,
    );
    const link = copyValue(await (await request("/admin/apps/workflow/invite", invite)).text());
    const context = await browser.newContext();
    context.setDefaultTimeout(15000);
    const page = await context.newPage(),
      cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(link);
    await page.click("#enroll-btn");
    await page.waitForURL(appUrl + "/cb?**");
    assert.equal(await page.textContent("body"), "Signed in to the app");
    assert.match(
      await (await request("/admin/apps/workflow/onboarding?since=1")).text(),
      /First client sign-in observed/,
    );
    const repeat = copyValue(await (await request("/admin/apps/workflow/invite", invite)).text());
    assert.equal(repeat, base + "/open/workflow");
    assert.equal(
      (await instance.sql("SELECT id FROM app_grants WHERE app_id='workflow'")).length,
      1,
    );
    const mismatch = await fetch(
      base + "/authorize?client_id=workflow-client&redirect_uri=https://elsewhere.example.test",
    );
    const ref = (await mismatch.text()).match(/ref-[0-9a-f]{16}/)?.[0];
    assert.ok(ref);
    assert.match(await (await request("/admin/audit?q=" + ref)).text(), /Redirect not allowed/);
    const status = await (await request("/admin/apps/workflow/onboarding?since=1")).text();
    for (const mark of ["Callback matched", "Authorization code issued", "redeemed the code"])
      assert.ok(status.includes(mark), mark);
    await request("/admin/apps/tile-1/requestable", { enabled: "1" });
    const home = await (await page.request.get(base)).text();
    assert.ok(home.includes("/apps/tile-1/request"));
    assert.ok(!home.includes("/apps/tile-2/request"));
    assert.equal((await page.request.post(base + "/apps/tile-2/request")).status(), 404);
    await page.request.post(base + "/apps/tile-1/request");
    await page.request.post(base + "/apps/tile-1/request");
    const pending = await instance.sql("SELECT id FROM access_requests WHERE app_id='tile-1'");
    assert.equal(pending.length, 1);
    const history = async () => (await page.request.get(base + "/requests")).text();
    assert.match(await history(), /Pending/);
    assert.match(await (await request("/admin")).text(), /1 pending access request/);
    const approve = "/admin/requests/" + pending[0].id;
    const approvals = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(approve, {
          decision: "approve",
          until: "2099-01-01",
          note: "For the January project",
        }),
      ),
    );
    assert.deepEqual(
      approvals.map((r) => r.status),
      [303, 303],
    );
    assert.equal(
      (await instance.sql("SELECT decision FROM access_requests WHERE app_id='tile-1'"))[0]
        .decision,
      "approved",
    );
    assert.equal(
      (
        await instance.sql("SELECT COUNT(*) n FROM audit_log WHERE event='ACCESS_REQUEST_DECIDED'")
      )[0].n,
      1,
    );
    assert.equal(
      (await instance.sql("SELECT id FROM temporary_app_grants WHERE app_id='tile-1'")).length,
      1,
    );
    const decisionPage = await history();
    for (const label of ["2099-01-01", "For the January project", "Open app", "Request extension"])
      assert.ok(decisionPage.includes(label), label);
    const extend = base + "/requests/" + pending[0].id + "/extend";
    await Promise.all([page.request.post(extend), page.request.post(extend)]);
    const extensions = await instance.sql(
      "SELECT id FROM access_requests WHERE previous_end IS NOT NULL",
    );
    assert.equal(extensions.length, 1);
    const decideExtension = "/admin/requests/" + extensions[0].id;
    assert.equal(
      (await request(decideExtension, { decision: "approve", until: "2099-01-01" })).status,
      400,
    );
    await request(decideExtension, { decision: "approve", until: "2099-02-01" });
    assert.match(await history(), /2099-02-01/);
    await page.request.post(base + "/requests/" + extensions[0].id + "/extend");
    const denied = (await instance.sql("SELECT id FROM access_requests WHERE decision IS NULL"))[0];
    await request("/admin/requests/" + denied.id, { decision: "deny", note: "Project complete" });
    assert.match(await history(), /Project complete/);
    const open = () => page.request.get(base + "/open/tile-1", { maxRedirects: 0 });
    assert.equal((await open()).status(), 302);
    await instance.sql("UPDATE temporary_app_grants SET expires_at=unixepoch()-1");
    assert.equal((await open()).status(), 404);
    const newSecret = copyValueForSecret(
      await (await request("/admin/clients/workflow-client/rotate", { overlap: "1" })).text(),
    );
    const checkSecret = async (value) =>
      (
        await exchange({
          client_id: client,
          client_secret: value,
          grant_type: "authorization_code",
          code: "unused",
        })
      ).json();
    assert.equal((await checkSecret(secret)).error, "invalid_grant");
    assert.equal((await checkSecret(newSecret)).error, "invalid_grant");
    const [state] = await instance.sql(
      "SELECT previous_secret_until,replacement_used_at FROM oidc_clients WHERE id='workflow-client'",
    );
    assert.ok(state.replacement_used_at);
    await request("/admin/clients/workflow-client/retire", {
      until: String(state.previous_secret_until),
      current: newSecret.slice(0, 6),
    });
    assert.equal((await checkSecret(secret)).error, "invalid_client");
    assert.equal((await checkSecret(newSecret)).error, "invalid_grant");
    const timed = copyValueForSecret(
      await (await request("/admin/clients/workflow-client/rotate", { overlap: "1" })).text(),
    );
    await instance.sql(
      "UPDATE oidc_clients SET previous_secret_until=unixepoch()-1 WHERE id='workflow-client'",
    );
    assert.equal((await checkSecret(newSecret)).error, "invalid_client");
    assert.equal((await checkSecret(timed)).error, "invalid_grant");
    await scopedAssistant(base, request);
    console.log(
      "Real app invite, passkey enrollment, OAuth callback, support lookup, access expiry, secret overlap and scoped assistants passed",
    );
  } finally {
    await browser.close();
    rp.closeAllConnections();
    await new Promise((resolve) => rp.close(resolve));
  }
}
function copyValueForSecret(html) {
  const match = html.match(/data-copy="([\w-]{43})"/);
  assert.ok(match);
  return match[1];
}
async function scopedAssistant(base, request) {
  const redirect = "http://localhost/cb";
  const reg = await fetch(base + "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Workflow assistant",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id } = await reg.json();
  assert.ok(client_id);
  const verifier = random();
  const params = {
    client_id,
    redirect_uri: redirect,
    scope: "mcp offline_access",
    resource: base + "/mcp",
    response_type: "code",
    code_challenge: challenge(verifier),
    code_challenge_method: "S256",
  };
  assert.match(
    await (await request("/authorize?" + new URLSearchParams(params))).text(),
    /Assistant permissions/,
  );
  const granted = await request("/authorize/decision", {
    ...params,
    job: "inspect",
    jobApp: "workflow",
    decision: "allow",
  });
  const code = new URL(granted.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const token = async (body) =>
    (
      await fetch(base + "/token", {
        method: "POST",
        body: new URLSearchParams({ client_id, ...body }),
      })
    ).json();
  const result = await token({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
  });
  assert.ok(result.access_token);
  assert.equal(result.scope, "offline_access mcp:inspect:workflow");
  assert.match(
    await (await request("/account")).text(),
    /Inspect connection health for Workflow app/,
  );
  const rpc = async (raw, method, params = {}) =>
    fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + raw },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const tools = await (await rpc(result.access_token, "tools/list")).json();
  assert.deepEqual(tools.result.tools.map((t) => t.name).sort(), [
    "app_connection_status",
    "execute",
    "feedback_list",
    "feedback_submit",
  ]);
  const call = (name, args) => rpc(result.access_token, "tools/call", { name, arguments: args });
  assert.ok(
    (await (await call("app_connection_status", { app: "workflow" })).json()).result
      .structuredContent,
  );
  assert.equal((await call("app_connection_status", { app: "tile-1" })).status, 403);
  const denied = await (
    await call("execute", { code: 'return await id.app_connection_status({app:"tile-1"});' })
  ).json();
  assert.match(JSON.stringify(denied.result), /Outside granted app permissions/);
  const allowed = await (
    await call("execute", { code: 'return await id.app_connection_status({app:"workflow"});' })
  ).json();
  assert.match(JSON.stringify(allowed.result), /Workflow app/);
  assert.equal(
    (
      await token({
        grant_type: "refresh_token",
        refresh_token: result.refresh_token,
        scope: "mcp",
      })
    ).error,
    "invalid_scope",
  );
  const refreshed = await token({
    grant_type: "refresh_token",
    refresh_token: result.refresh_token,
  });
  assert.equal(refreshed.scope, result.scope);
  const report = {
    kind: "bug",
    summary: "Scoped feedback",
    details: "Sanitized description",
    idempotency_key: "retry-feedback",
  };
  const filed = await (await call("feedback_submit", report)).json();
  const fid = filed.result.structuredContent.id;
  assert.ok(fid);
  const retry = await (
    await call("execute", {
      code: "return await id.feedback_submit(" + JSON.stringify(report) + ");",
    })
  ).json();
  assert.match(JSON.stringify(retry.result), /Scoped feedback|recorded|status/);
  assert.equal(
    (await (await call("feedback_submit", { ...report, summary: "different" })).json()).result
      .isError,
    true,
  );
  assert.equal((await call("feedback_inbox", {})).status, 403);
  assert.equal((await call("feedback_resolve", { id: fid, resolution: "done" })).status, 403);
  assert.match(await (await request("/admin/feedback")).text(), /Scoped feedback/);
  assert.doesNotMatch(await (await request("/feedback")).text(), /Scoped feedback/);
  await request("/admin/feedback/" + fid, { status: "planned", note: "Ship in next release" });
  assert.match(await (await call("feedback_list", {})).text(), /Ship in next release/);
  const changed = await request("/authorize/decision", {
    ...params,
    job: "inspect",
    jobApp: "tile-1",
    decision: "allow",
  });
  const changedCode = new URL(changed.headers.get("location")).searchParams.get("code");
  const changedToken = await token({
    grant_type: "authorization_code",
    code: changedCode,
    code_verifier: verifier,
    redirect_uri: redirect,
  });
  assert.equal((await rpc(changedToken.access_token, "tools/list")).status, 200);
  assert.equal((await rpc(result.access_token, "tools/list")).status, 401);
  assert.equal(
    (await token({ grant_type: "refresh_token", refresh_token: refreshed.refresh_token })).error,
    "invalid_grant",
  );
  const api = copyValue(
    await (
      await request("/admin/tokens", {
        name: "Invite assistant",
        scope: "invite",
        apps: "tile-2",
        expires: "30",
      })
    ).text(),
  );
  assert.match(await (await request("/admin/tokens")).text(), /Invite existing members to App 2/);
  assert.doesNotMatch(
    await (await rpc(api, "tools/call", { name: "feedback_list", arguments: {} })).text(),
    /Scoped feedback/,
  );
  const invite = (app) =>
    rpc(api, "tools/call", {
      name: "app_invite_member",
      arguments: { app, email: "new-member@example.test" },
    });
  assert.ok((await (await invite("tile-2")).json()).result.structuredContent);
  assert.equal((await invite("workflow")).status, 403);
}
