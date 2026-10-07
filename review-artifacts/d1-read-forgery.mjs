#!/usr/bin/env node
/** Asserts a local D1 read cannot reveal the portable signing key. Prints no key or token. */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "edge-idp-d1-read-"));
const port = 9900 + Math.floor(Math.random() * 90);
const issuer = `http://localhost:${port}`;
for (const name of ["src", "public", "migrations", "node_modules", "scripts"]) symlinkSync(join(root, name), join(work, name));
for (const name of ["wrangler.jsonc", "package.json", "tsconfig.json"]) copyFileSync(join(root, name), join(work, name));
writeFileSync(join(work, ".dev.vars"), `SETUP_TOKEN=${randomBytes(32).toString("base64url")}\n`);
const wrangler = (args, capture = false) => execFileSync("npx", ["wrangler", ...args], {
  cwd: work, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "ignore"] : "ignore",
});
wrangler(["d1", "migrations", "apply", "DB", "--local"]);
const server = spawn("npx", ["wrangler", "dev", "--port", String(port)], { cwd: work, stdio: "ignore" });
try {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if ((await fetch(`${issuer}/healthz`)).ok) break; } catch { /* startup */ }
    if (Date.now() > deadline) throw new Error("local Worker did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  const rows = JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--json", "--command",
    "SELECT jwk FROM signing_keys WHERE id = 'current'"], true))[0].results;
  const stored = rows[0].jwk;
  const jwks = await (await fetch(`${issuer}/jwks`)).json();
  const pass = stored.startsWith("enc:v1:") && !stored.includes('"d"') && jwks.keys?.length === 1;
  console.log(`D1-read signing material unavailable: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
} finally {
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
