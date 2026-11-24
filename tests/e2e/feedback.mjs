import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { globSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { server } from "./instances.mjs";

const dir = mkdtempSync(join(tmpdir(), "edge-feedback-"));
for (const file of ["src", "tsconfig.json", "package.json", "node_modules"])
  symlinkSync(resolve(file), join(dir, file));
const state = join(dir, "state");
const port = 19401 + Math.floor(Math.random() * 60) * 2,
  base = "http://localhost:" + port,
  remote = "http://127.0.0.1:" + (port + 1);
const hub = {
  binding: "DB",
  database_name: "feedback",
  database_id: randomUUID(),
  migrations_dir: resolve("maintainer/migrations"),
};
const identity = {
  binding: "DB",
  database_name: "identity",
  database_id: randomUUID(),
  migrations_dir: resolve("migrations"),
};
const signer = execFileSync("node", ["scripts/gen-key.mjs"], { encoding: "utf8" }).trim();
function config(name, main, databases, vars, extra = {}) {
  const path = join(dir, name + ".json");
  writeFileSync(
    path,
    JSON.stringify({
      name,
      main,
      compatibility_date: "2026-10-06",
      compatibility_flags: ["nodejs_compat"],
      d1_databases: databases,
      vars,
      ...extra,
    }),
    { mode: 0o600 },
  );
  return path;
}
const localConfig = config(
  "feedback-operator",
  "src/index.tsx",
  [identity],
  {
    ISSUER: base,
    RP_NAME: "Test",
    SIGNING_KEY_JWK: signer,
    FEEDBACK_INBOX_URL: remote,
    MAINTAINER_CONSOLE_URL: remote,
  },
  { triggers: { crons: ["17 * * * *"] } },
);
const hubConfig = config(
  "feedback-receiver",
  "src/maintainer/index.tsx",
  [hub],
  {},
  {
    services: [
      { binding: "AUTHORITY", service: "feedback-operator", entrypoint: "MaintainerAuthority" },
    ],
    ratelimits: [
      { name: "INTAKE_LIMITER", namespace_id: "3001", simple: { limit: 30, period: 60 } },
    ],
  },
);
const wrangler = (cfg, args) =>
  execFileSync("npx", ["wrangler", ...args, "--config", cfg, "--local", "--persist-to", state], {
    timeout: 60_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const fixtures = new Map();
function openFixtures() {
  for (const file of globSync("**/*.sqlite", { cwd: state })) {
    const db = new DatabaseSync(join(state, file), { timeout: 5000 });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (tables.some((r) => r.name === "feedback")) fixtures.set(localConfig, db);
    else if (tables.some((r) => r.name === "reports")) fixtures.set(hubConfig, db);
    else db.close();
  }
  assert.equal(fixtures.size, 2);
}
function sql(cfg, statement) {
  const db = fixtures.get(cfg);
  if (statement.startsWith("SELECT ")) return db.prepare(statement).all();
  db.exec(statement);
  return [];
}
const dev = (cfg, p, url) =>
  server(
    "wrangler",
    ["dev", "--config", cfg, "--port", String(p), "--persist-to", state],
    dir,
    url,
  );
const install = dev(localConfig, port, base),
  inbox = dev(hubConfig, port + 1, remote);
const digest = (s) => createHash("sha256").update(s).digest("hex");
function credential(id, admin) {
  const token = randomUUID();
  sql(
    localConfig,
    `INSERT INTO users(id,name,email,is_admin,created_at,updated_at) VALUES('${id}','Person','${id}@example.test',${admin},1,1);
 INSERT INTO sessions(id_hash,user_id,created_at,last_seen_at,expires_at,step_up_at) VALUES('${digest(token)}','${id}',unixepoch(),unixepoch(),unixepoch()+3600,unixepoch());`,
  );
  return (path, form) =>
    fetch(base + path, {
      redirect: "manual",
      headers: { cookie: "__Host-idp_session=" + token, origin: base },
      ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
    });
}
try {
  wrangler(localConfig, ["d1", "migrations", "apply", "DB"]);
  wrangler(hubConfig, ["d1", "migrations", "apply", "DB"]);
  openFixtures();
  console.log("Feedback fixture databases ready");
  const operator = credential("operator", 1),
    member = credential("member", 0);
  await install.start();
  const form = {
    idempotency_key: randomUUID(),
    kind: "bug",
    summary: "A local summary",
    details: "Private local detail",
  };
  assert.equal((await member("/feedback", form)).status, 303);
  await member("/feedback", form);
  assert.equal((await member("/feedback", { ...form, summary: "Changed" })).status, 400);
  const [row] = sql(localConfig, "SELECT id FROM feedback");
  const route = "/admin/feedback/" + row.id + "/share";
  assert.equal((await member(route)).status, 302);
  assert.doesNotMatch(await (await operator("/feedback")).text(), /A local summary/);
  assert.equal(sql(hubConfig, "SELECT count(*) n FROM reports")[0].n, 0);
  const preview = await (await operator(route)).text();
  assert.ok(preview.includes(remote) && preview.includes(form.summary));
  assert.ok(!preview.includes(form.details));
  const share = {
    destination: remote,
    summary: "Safe upstream summary",
    tool_name: "apps_connect",
  };
  await operator(route, share);
  assert.match(await (await member("/feedback")).text(), /Retry scheduled/);
  await inbox.start();
  console.log("Feedback receiver started after offline delivery");
  assert.equal(
    (
      await fetch(remote + "/v1/report", {
        headers: { authorization: "Bearer " + randomBytes(32).toString("base64url") },
      })
    ).status,
    404,
  );
  sql(localConfig, "UPDATE feedback_shares SET next_check=0");
  const cron = async () => {
    const response = await fetch(base + "/cdn-cgi/local/scheduled");
    assert.ok(response.ok, "scheduled handler " + response.status);
  };
  await cron();
  async function waitFor(part) {
    for (let n = 0; n < 40; n++) {
      const html = await (await member("/feedback")).text();
      if (html.includes(part)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.fail(
      "Member feedback did not display " +
        part +
        "; delivery state " +
        JSON.stringify(
          sql(localConfig, "SELECT remote_status,last_error,attempt FROM feedback_shares"),
        ),
    );
  }
  await waitFor("Maintainer inbox · new");
  const [received] = sql(hubConfig, "SELECT * FROM reports");
  assert.equal(received.summary, share.summary);
  assert.ok(!JSON.stringify(received).includes(form.details));
  assert.ok(!JSON.stringify(received).includes("@example.test"));
  await operator(route, share);
  assert.equal(sql(hubConfig, "SELECT count(*) n FROM reports")[0].n, 1);
  assert.equal((await fetch(remote + "/admin")).status, 403);
  assert.equal((await fetch(remote + "/v1/report")).status, 401);
  assert.equal(
    (
      await fetch(remote + "/v1/report", {
        headers: { authorization: "Bearer " + randomBytes(32).toString("base64url") },
      })
    ).status,
    404,
  );
  assert.match(
    await (await member("/")).text(),
    /<a href="\/feedback" class="nav-link">[^]*?<span>Feedback<\/span><\/a>/,
  );
  assert.equal((await member("/admin/maintainer/open", {})).status, 302);
  const launch = await (await operator("/admin/maintainer/open", {})).text();
  const code = launch.match(/name="code" value="([^"]+)"/)?.[1];
  assert.ok(code, "maintainer launch form has a code");
  const exchange = (origin) =>
    fetch(remote + "/admin/session", {
      method: "POST",
      redirect: "manual",
      headers: { origin },
      body: new URLSearchParams({ code }),
    });
  assert.equal((await exchange(remote)).status, 403);
  const signed = await exchange(base);
  assert.equal(signed.status, 303, "private service binding exchanges the launch code");
  const cookie = signed.headers.get("set-cookie").split(";")[0];
  assert.equal((await exchange(base)).status, 403);
  const consoleRequest = (path, form, origin = remote) =>
    fetch(remote + path, {
      redirect: "manual",
      headers: { cookie, origin },
      ...(form ? { method: "POST", body: new URLSearchParams(form) } : {}),
    });
  const central = await (await consoleRequest("/admin")).text();
  assert.ok(central.includes(share.summary));
  assert.equal((await consoleRequest("/admin/" + received.id, {}, base)).status, 403);
  await consoleRequest("/admin/" + received.id, {
    status: "planned",
    reply: "Planned for a release",
    issue: "https://github.com/tannerwj/edge-idp/issues/1",
  });
  sql(localConfig, "UPDATE feedback_shares SET next_check=0");
  await cron();
  await waitFor("Planned for a release");
  const receipt = sql(localConfig, "SELECT receipt FROM feedback_shares")[0].receipt;
  assert.equal(digest(receipt), received.receipt_hash);
  assert.ok(!(await (await member("/feedback")).text()).includes(receipt));
  const put = (token, body) =>
    fetch(remote + "/v1/report", {
      method: "PUT",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const payload = {
    kind: form.kind,
    summary: share.summary,
    tool_name: share.tool_name,
    server_version: received.server_version,
  };
  assert.equal((await put(receipt, payload)).status, 200);
  assert.equal((await put(receipt, { ...payload, summary: "changed" })).status, 409);
  const other = randomBytes(32).toString("base64url");
  assert.equal((await put(other, { ...payload, details: "Private" })).status, 400);
  assert.equal((await put(other, payload)).status, 200);
  const duplicate = sql(hubConfig, "SELECT max(id) id FROM reports")[0].id;
  await consoleRequest("/admin/" + duplicate, {
    status: "new",
    reply: "",
    issue: "",
    duplicate_of: String(received.id),
  });
  const linked = await (
    await fetch(remote + "/v1/report", { headers: { authorization: "Bearer " + other } })
  ).json();
  assert.equal(linked.reply, "Planned for a release");
  sql(
    localConfig,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<19)
    INSERT INTO feedback(user_id,credential,retry_key,kind,summary,details,tool_name,server_version)
    SELECT 'member','member','additional-'||i,'bug','Quota fixture','','','2.5.0' FROM n`,
  );
  assert.equal((await member("/feedback", { ...form, idempotency_key: "over-quota" })).status, 400);
  assert.equal((await member("/feedback", form)).status, 303);
  sql(
    localConfig,
    `UPDATE feedback SET updated_at=1,created_at=1,status='planned' WHERE retry_key='additional-1';
      UPDATE feedback SET updated_at=1,status='done' WHERE retry_key='additional-2';
      UPDATE feedback SET updated_at=1,status='done' WHERE id=${row.id}`,
  );
  await cron();
  const retained = sql(localConfig, "SELECT retry_key FROM feedback").map((r) => r.retry_key);
  assert.ok(retained.includes("additional-1") && retained.includes(form.idempotency_key));
  assert.ok(!retained.includes("additional-2"));
  await install.stop();
  const disabled = JSON.parse(readFileSync(localConfig, "utf8"));
  disabled.vars.UPSTREAM_REPO = "off";
  writeFileSync(localConfig, JSON.stringify(disabled));
  await install.start();
  assert.equal((await operator(route)).status, 404);
  const attempt = () => sql(localConfig, "SELECT attempt FROM feedback_shares")[0].attempt;
  const prev = attempt();
  sql(localConfig, "UPDATE feedback_shares SET next_check=0");
  await cron();
  assert.equal(attempt(), prev);
  sql(localConfig, "UPDATE sessions SET step_up_at=0 WHERE user_id='operator'");
  assert.equal(
    (await consoleRequest("/admin/" + received.id, { status: "done", reply: "Stale", issue: "" }))
      .status,
    403,
  );
  sql(localConfig, "DELETE FROM sessions WHERE user_id='operator'");
  assert.equal((await consoleRequest("/admin")).status, 403);

  console.log(
    "Local feedback isolation, opt-in, failed delivery and retry, safe upstream payload, private receipts, duplicate grouping and replies passed.",
  );
} finally {
  await install.stop();
  await inbox.stop();
  for (const db of fixtures.values()) db.close();
  rmSync(dir, { recursive: true, force: true });
}
