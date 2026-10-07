#!/usr/bin/env node
/**
 * One-click install, end to end: the wrangler.jsonc template exactly as the
 * Deploy to Cloudflare button ships it (no ISSUER, no signing key, no
 * users, only SETUP_TOKEN), run with `wrangler dev` from a temp copy that has
 * no cloudflare.config.ts.
 *
 * Checks: issuer derived from the host, signing key generated once and
 * persisted across restarts, /login → /setup, wrong token refused, right
 * token → passkey enrollment → admin, /setup gone afterwards, no `execute`
 * tool without a Worker Loader. A second boot adds the loader binding (the
 * template's documented opt-in) to prove code mode works with no ISSUER set.
 *
 * Usage: npm run test:e2e:setup   (E2E_KEEP=1 keeps the temp dir)
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 8890 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const SETUP_TOKEN = "e2e-setup-token-0123456789";

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`);
  }
}

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "edge-idp-setup-"));
for (const f of ["src", "public", "migrations", "node_modules", "scripts"]) symlinkSync(join(root, f), join(work, f));
for (const f of ["wrangler.jsonc", "package.json", "tsconfig.json"]) copyFileSync(join(root, f), join(work, f));
writeFileSync(join(work, ".dev.vars"), `SETUP_TOKEN="${SETUP_TOKEN}"\n`);
execFileSync("node", ["scripts/build-client.mjs"], { stdio: "ignore" });
const wrangler = (args) => execFileSync("npx", ["wrangler", ...args], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
wrangler(["d1", "migrations", "apply", "DB", "--local"]);
const sql = (q) => JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--json", "--command", q]))[0].results;

let server = null;
let log = "";
async function start() {
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`wrangler dev did not start\n${log.slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
async function stop() {
  if (!server) return;
  const exited = new Promise((r) => server.once("exit", r));
  server.kill();
  await exited;
  server = null;
}

async function mcpCall(token, method, params = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return r.json().catch(() => null);
}

const jwkN = async () => (await (await fetch(`${BASE}/jwks`)).json()).keys?.[0]?.n;

let browser;
try {
  console.log(`\n== fresh install on ${BASE} (${work}) ==`);
  await start();
  const disco = await (await fetch(`${BASE}/.well-known/openid-configuration`)).json();
  check("issuer defaults to the serving origin", disco.issuer === BASE, disco.issuer);
  const n1 = await jwkN();
  check("signing key generated on first use", !!n1);
  check("…and stored in D1", sql("SELECT COUNT(*) AS n FROM signing_keys")[0].n === 1);
  check("…and stable across requests", (await jwkN()) === n1);

  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  console.log("\n== /setup ==");
  await page.goto(`${BASE}/login`);
  check("/login sends a fresh install to /setup", new URL(page.url()).pathname === "/setup", page.url());
  await page.fill("input[name=token]", "wrong-token-123456");
  await page.fill("input[name=name]", "Sam Setup");
  await page.fill("input[name=email]", "sam@example.test");
  const bad = await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]).then(([r]) => r);
  check("wrong setup token → 401", bad?.status() === 401, String(bad?.status()));
  check("…and says so", (await page.textContent("body")).includes("doesn't match"));
  check("…and creates no user", sql("SELECT COUNT(*) AS n FROM users")[0].n === 0);
  const cross = await page.request.post(`${BASE}/setup`, { form: { token: SETUP_TOKEN, name: "X", email: "x@example.test" }, headers: { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" } });
  check("cross-origin setup POST refused", cross.status() === 403, String(cross.status()));

  await page.fill("input[name=token]", SETUP_TOKEN);
  await Promise.all([page.waitForURL(/\/enroll\//), page.click("button[type=submit]")]);
  check("right token → passkey enrollment", new URL(page.url()).pathname.startsWith("/enroll/"), page.url());
  await page.fill("#key-name", "Setup key");
  await page.click("#enroll-btn");
  await page.waitForURL(`${BASE}/?**`, { timeout: 15000 }).catch(() => {});
  check("enrollment lands on home", new URL(page.url()).pathname === "/", page.url());
  check("home greets the new admin", (await page.textContent("h1"))?.includes("Sam"));
  const admin = await page.goto(`${BASE}/admin`);
  check("first user is an admin", admin?.status() === 200 && new URL(page.url()).pathname === "/admin", page.url());

  const gone = await fetch(`${BASE}/setup`);
  check("/setup is gone once a user exists", gone.status === 404, String(gone.status));
  const gonePost = await page.request.post(`${BASE}/setup`, { form: { token: SETUP_TOKEN, name: "Eve", email: "eve@example.test" } });
  check("…for POST too, even with the right token", gonePost.status() === 404 && sql("SELECT COUNT(*) AS n FROM users")[0].n === 1);
  const events = sql("SELECT event FROM audit_log").map((r) => r.event);
  check("audited: SETUP_REJECTED, SETUP_COMPLETED", events.includes("SETUP_REJECTED") && events.includes("SETUP_COMPLETED"), events);

  await page.goto(`${BASE}/admin/tokens`);
  await page.click("button[data-open='new-token']");
  await page.fill("#new-token input[name=name]", "setup bot");
  await page.check("#new-token input[name=scope][value=admin]");
  await page.click("#new-token button[type=submit]");
  await page.waitForLoadState();
  const token = await page.getAttribute("[data-copy]", "data-copy");
  const tools = ((await mcpCall(token, "tools/list"))?.result?.tools ?? []).map((t) => t.name);
  check("MCP works; no execute tool without a Worker Loader", tools.includes("users_list") && !tools.includes("execute"), tools);

  console.log("\n== restart, with the optional Worker Loader ==");
  await stop();
  const cfgPath = join(work, "wrangler.jsonc");
  const withLoader = readFileSync(cfgPath, "utf8").replace('"triggers": { "crons": ["17 * * * *"] }', '"triggers": { "crons": ["17 * * * *"] },\n  "worker_loaders": [{ "binding": "LOADER" }]');
  if (!withLoader.includes("worker_loaders\": [{")) throw new Error("couldn't add worker_loaders to the template");
  writeFileSync(cfgPath, withLoader);
  await start();
  check("signing key survives a restart", (await jwkN()) === n1);
  const exec = await mcpCall(token, "tools/call", { name: "execute", arguments: { code: `return (await id.users_create({ name: "Cody Mode", email: "cody@example.test" })).enrollment_link;` } });
  const out = exec?.result?.content?.[0]?.text ?? "";
  check("execute: sandboxed tool calls get the derived issuer", !exec?.result?.isError && out.includes(`${BASE}/enroll/`), exec);
} catch (e) {
  failures++;
  console.error("  FAIL threw:", e);
} finally {
  await browser?.close();
  await stop();
  if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
}

if (/ERROR|Uncaught/.test(log)) {
  console.error("\nserver log contained errors:\n" + log.split("\n").filter((l) => /ERROR|Uncaught/.test(l)).slice(0, 20).join("\n"));
  failures++;
}
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
