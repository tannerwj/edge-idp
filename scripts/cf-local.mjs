/**
 * Helpers for driving the `cf` CLI from scripts and the e2e harness.
 *
 * Workaround (cf 1.0.0-beta.13): `cf d1 … --local` prints its JSON result
 * but leaves the local Miniflare instance running, so the process never
 * exits. We read stdout until it parses as JSON, then stop the process.
 * Delete this shim when cf exits cleanly on its own.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * One stage's values from the STAGES table in cloudflare.config.ts (single
 * source of truth): Worker name, ISSUER and D1 id.
 */
export function stageConfig(stage = "production", configPath = "cloudflare.config.ts") {
  const src = readFileSync(configPath, "utf8");
  const start = src.indexOf(`\n  ${stage}: {`);
  if (start < 0) throw new Error(`no stage "${stage}" in ${configPath}`);
  const block = src.slice(start, src.indexOf("\n  },", start));
  const pick = (re) => {
    const m = re.exec(block);
    if (!m) throw new Error(`stage "${stage}" in ${configPath} is missing ${re}`);
    return m[1];
  };
  return {
    stage,
    name: pick(/\bname:\s*"([^"]+)"/),
    issuer: pick(/\bissuer:\s*"([^"]+)"/),
    d1Id: pick(/\bd1:\s*\{[^}]*\bid:\s*"([^"]+)"/),
  };
}

/** The D1 database id for a stage. */
export function d1Id(stage = "production") {
  return stageConfig(stage).d1Id;
}

/** `--stage=staging` from argv (default production), as cf's --mode. */
export function stageArg(argv = process.argv) {
  const m = argv.map((a) => /^--stage=(.+)$/.exec(a)).find(Boolean);
  return m ? m[1] : "production";
}

/** Run `cf <args>` and resolve with its parsed JSON output. */
export function cfJson(args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["cf", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fn(v);
    };
    const tryParse = () => {
      const start = out.search(/[[{]/);
      if (start < 0) return;
      try {
        finish(resolve, JSON.parse(out.slice(start)));
      } catch {
        /* not complete yet */
      }
    };
    const timer = setTimeout(() => finish(reject, new Error(`cf ${args.join(" ")} timed out\n${err.slice(-2000)}`)), timeoutMs);
    child.stdout.on("data", (d) => {
      out += d;
      tryParse();
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("exit", (code) => {
      tryParse();
      if (!done) finish(code === 0 ? resolve : reject, code === 0 ? null : new Error(`cf ${args.join(" ")} exited ${code}\n${err.slice(-2000)}`));
    });
  });
}

/** Apply migrations to local D1 state. */
export function migrateLocal(persistTo) {
  return cfJson(["d1", "migrations", "apply", d1Id(), "--local", ...(persistTo ? ["--persist-to", persistTo] : [])]);
}

/**
 * Run SQL against local (or remote) D1 and return the LAST statement's rows
 * as objects. cf's `d1 raw` returns columns + rows arrays.
 */
export async function sqlRows(sql, { local = true, persistTo, stage = "production" } = {}) {
  const res = await cfJson([
    "d1", "raw", d1Id(stage), "--sql", sql, "--mode", stage,
    ...(local ? ["--local"] : []),
    ...(local && persistTo ? ["--persist-to", persistTo] : []),
  ]);
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  const { columns = [], rows = [] } = last?.results ?? {};
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}
