import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLocal, sqlRows, stageConfig } from "../../scripts/cf-local.mjs";

const LINKED = ["src", "migrations", "node_modules", "scripts"];
const REMOTE_KEEP = new Set(["d1_migrations", "instance_settings"]);

function projectCopy(prefix, config, vars) {
  const root = process.cwd();
  const work = mkdtempSync(join(tmpdir(), `edge-idp-${prefix}-`));
  for (const f of LINKED) symlinkSync(join(root, f), join(work, f));
  for (const f of [config, "package.json", "tsconfig.json"])
    copyFileSync(join(root, f), join(work, f));
  writeFileSync(
    join(work, ".dev.vars"),
    Object.entries(vars)
      .map(([k, v]) => `${k}='${v}'\n`)
      .join(""),
  );
  execFileSync("node", ["scripts/build-client.mjs"], { stdio: "ignore" });
  return work;
}

function server(cmd, args, work, base) {
  let proc = null;
  let log = "";
  const start = async () => {
    proc = spawn("npx", [cmd, ...args], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => (log += d));
    proc.stderr.on("data", (d) => (log += d));
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        if ((await fetch(`${base}/healthz`, { redirect: "manual" })).ok) return;
      } catch {}
      if (Date.now() > deadline) throw new Error(`${cmd} dev did not start\n${log.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  const stop = async () => {
    if (!proc) return;
    const exited = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await exited;
    proc = null;
  };
  return { start, stop, log: () => log };
}

function cleanup(work) {
  if (!process.env.E2E_KEEP) rmSync(work, { recursive: true, force: true });
}

export async function startLocal({ issuer, rpName = "E2E Identity", port }) {
  const jwk = execFileSync("node", ["scripts/gen-key.mjs"], { encoding: "utf8" }).trim();
  const work = projectCopy("e2e", "cloudflare.config.ts", {
    ISSUER: issuer,
    RP_NAME: rpName,
    SIGNING_KEY_JWK: jwk,
  });
  const state = join(work, ".wrangler", "state");
  await migrateLocal(state);
  const base = `http://localhost:${port}`;
  const srv = server("cf", ["dev", "--port", String(port)], work, base);
  try {
    await srv.start();
  } catch (e) {
    cleanup(work);
    throw e;
  }
  return {
    base,
    work,
    sql: (command) => sqlRows(command, { persistTo: state }),
    log: srv.log,
    stop: () => {
      void srv.stop();
      cleanup(work);
    },
  };
}

export async function startPortable({ prefix = "portable", port, vars }) {
  const work = projectCopy(prefix, "wrangler.jsonc", vars);
  const wrangler = (args, capture = true) =>
    execFileSync("npx", ["wrangler", ...args], {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", capture ? "pipe" : "ignore", "pipe"],
    });
  wrangler(["d1", "migrations", "apply", "DB", "--local"], false);
  const base = `http://localhost:${port}`;
  const srv = server("wrangler", ["dev", "--port", String(port)], work, base);
  return {
    base,
    work,
    wrangler,
    sql: (command) =>
      JSON.parse(wrangler(["d1", "execute", "DB", "--local", "--json", "--command", command]))[0]
        .results,
    start: srv.start,
    stop: srv.stop,
    log: srv.log,
    cleanup: async () => {
      await srv.stop();
      cleanup(work);
    },
  };
}

export async function startRemote({ stage = "staging" } = {}) {
  if (stage !== "staging") throw new Error(`refusing to run e2e against stage "${stage}"`);
  const cfg = stageConfig(stage);
  const sql = (command) => sqlRows(command, { local: false, stage });
  const health = await fetch(`${cfg.issuer}/healthz`).catch((e) => ({
    ok: false,
    status: String(e),
  }));
  if (!health.ok)
    throw new Error(`${cfg.issuer} is not up (${health.status}); run npm run staging:deploy`);
  const tables = (await sql("SELECT name FROM sqlite_master WHERE type = 'table'"))
    .map((r) => r.name)
    .filter((n) => !REMOTE_KEEP.has(n) && !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
  if (tables.length)
    await sql(
      ["PRAGMA defer_foreign_keys = on;", ...tables.map((t) => `DELETE FROM "${t}";`)].join("\n"),
    );
  return {
    base: cfg.issuer,
    work: `${cfg.name} (D1 ${cfg.d1Id})`,
    sql,
    log: () => "",
    stop: () => {},
    remote: true,
  };
}
