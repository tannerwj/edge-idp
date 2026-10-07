#!/usr/bin/env node
/** Portable Wrangler template baseline, entirely local with a fresh D1. */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "edge-idp-perf-portable-"));
const port = 9800 + Math.floor(Math.random() * 100);
const base = `http://localhost:${port}`;
for (const name of ["src", "public", "migrations", "node_modules", "scripts"]) symlinkSync(join(root, name), join(work, name));
for (const name of ["wrangler.jsonc", "package.json", "tsconfig.json"]) copyFileSync(join(root, name), join(work, name));
const setupToken = randomBytes(32).toString("base64url");
writeFileSync(join(work, ".dev.vars"), `SETUP_TOKEN=${setupToken}\n`);
const run = (args) => execFileSync("npx", ["wrangler", ...args], { cwd: work, stdio: "ignore" });
run(["d1", "migrations", "apply", "DB", "--local"]);
const server = spawn("npx", ["wrangler", "dev", "--port", String(port)], { cwd: work, stdio: "ignore" });
const connected = () => new Promise((resolve) => {
  const s = createConnection(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => { s.destroy(); resolve(false); });
});
const deadline = Date.now() + 90_000;
while (!(await connected())) {
  if (Date.now() > deadline) throw new Error("portable local Worker did not open its port");
  await new Promise((r) => setTimeout(r, 100));
}
const results = {};
const take = async (name, path, count) => {
  const times = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    const r = await fetch(base + path);
    await r.arrayBuffer();
    times.push({ status: r.status, ms: Math.round((performance.now() - start) * 10) / 10 });
  }
  results[name] = times;
};
try {
  await take("first_health_including_key_generation", "/healthz", 1);
  await take("warm_health", "/healthz", 5);
  await take("warm_jwks", "/jwks", 5);
  await take("setup_pending", "/setup", 5);
  const before = (await (await fetch(base + "/jwks")).json()).keys[0].n;
  const newJwk = execFileSync("node", ["scripts/gen-key.mjs"], { cwd: work, encoding: "utf8" }).trim();
  const material = createHash("sha256").update(`edge-idp signing key v1\0${setupToken}`).digest();
  const key = await webcrypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt"]);
  const iv = randomBytes(12);
  const ciphertext = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, Buffer.from(newJwk));
  const stored = `enc:v1:${iv.toString("base64url")}:${Buffer.from(ciphertext).toString("base64url")}`;
  run(["d1", "execute", "DB", "--local", "--command", `UPDATE signing_keys SET jwk = '${stored}' WHERE id = 'current'`]);
  const after = (await (await fetch(base + "/jwks")).json()).keys[0].n;
  results.key_cache_after_local_d1_replacement = { jwksStillOld: before === after };
  if (before === after) throw new Error("JWKS remained stale after key replacement");
  const output = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    branch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(),
    workingTree: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() ? "modified" : "clean",
    environment: "local wrangler dev, fresh D1, no issuer or signing-key secret, no Worker Loader",
    results,
  };
  writeFileSync(new URL("./performance-portable.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
  for (const [name, values] of Object.entries(results)) {
    console.log(Array.isArray(values) ? `${name}: ${values.map((v) => `${v.ms}ms/${v.status}`).join(", ")}` : `${name}: ${JSON.stringify(values)}`);
  }
} finally {
  server.kill();
  rmSync(work, { recursive: true, force: true });
}
process.exit(0);
