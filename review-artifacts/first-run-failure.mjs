#!/usr/bin/env node
/** Local-only first-run partial failure and empty-users recovery check. */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "edge-idp-first-run-"));
const port = 10000 + Math.floor(Math.random() * 100);
const base = `http://localhost:${port}`;
const setupToken = randomBytes(32).toString("base64url");
for (const name of ["src", "public", "migrations", "node_modules", "scripts"]) symlinkSync(join(root, name), join(work, name));
for (const name of ["wrangler.jsonc", "package.json", "tsconfig.json"]) copyFileSync(join(root, name), join(work, name));
writeFileSync(join(work, ".dev.vars"), `SETUP_TOKEN=${setupToken}\n`);
const wrangler = (args, capture = false) => execFileSync("npx", ["wrangler", ...args], {
  cwd: work, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
});
const sql = (command) => JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--json", "--command", command], true))[0].results;
wrangler(["d1", "migrations", "apply", "DB", "--local"]);
const server = spawn("npx", ["wrangler", "dev", "--port", String(port)], { cwd: work, stdio: "ignore" });
try {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error("local Worker did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  // Simulate a dependency failing after the user insert and before link minting.
  wrangler(["d1", "execute", "DB", "--local", "--command", "DROP TABLE audit_log"]);
  const attempted = await fetch(`${base}/setup`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: setupToken, name: "Review Admin", email: "review@example.test" }),
  });
  const users = sql("SELECT COUNT(*) AS n FROM users")[0].n;
  const links = sql("SELECT COUNT(*) AS n FROM enrollment_tokens")[0].n;
  const closed = (await fetch(`${base}/setup`)).status;
  const pass = attempted.status === 500 && users === 0 && links === 0 && closed === 200;
  console.log(`first-run partial failure: ${pass ? "PASS" : "FAIL"} (POST ${attempted.status}, users ${users}, links ${links}, setup GET ${closed})`);
  if (!pass) process.exitCode = 1;
} finally {
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
