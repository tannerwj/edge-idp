/**
 * A throwaway local edge-idp instance for the e2e suites.
 *
 * Generates a signing key, builds the browser bundle, applies migrations to a
 * fresh D1, and boots `cf dev`. Nothing touches your .dev.vars or your local
 * database.
 *
 * cf 1.0.0-beta.13 quirk: `cf dev` ignores --persist-to and always uses
 * ./.wrangler/state, so the server runs from a temp copy of the project
 * (sources symlinked) with its own .dev.vars and state directory.
 */
import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLocal, sqlRows } from "../../scripts/cf-local.mjs";

export async function startLocal({ issuer, rpName = "E2E Identity", port }) {
  const root = process.cwd();
  const work = mkdtempSync(join(tmpdir(), "edge-idp-e2e-"));
  const state = join(work, ".wrangler", "state");
  for (const f of ["src", "public", "migrations", "node_modules", "scripts"]) symlinkSync(join(root, f), join(work, f));
  for (const f of ["cloudflare.config.ts", "package.json", "tsconfig.json"]) copyFileSync(join(root, f), join(work, f));

  const jwk = execFileSync("node", ["scripts/gen-key.mjs"], { encoding: "utf8" }).trim();
  execFileSync("node", ["scripts/build-client.mjs"], { stdio: "ignore" });
  writeFileSync(join(work, ".dev.vars"), `ISSUER="${issuer}"\nRP_NAME="${rpName}"\nSIGNING_KEY_JWK='${jwk}'\n`);
  await migrateLocal(state);

  const server = spawn("npx", ["cf", "dev", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"], cwd: work });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const base = `http://localhost:${port}`;
  const stop = () => {
    server.kill();
    if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error(`cf dev did not start\n${log.slice(-3000)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return {
    base,
    work,
    /** Run SQL against this instance's D1; returns the last statement's rows. */
    sql: (command) => sqlRows(command, { persistTo: state }),
    log: () => log,
    stop,
  };
}
