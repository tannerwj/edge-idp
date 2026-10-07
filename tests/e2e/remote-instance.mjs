/**
 * The deployed staging Worker as an e2e target (same shape as startLocal).
 *
 * Staging's D1 persists between runs, so every run starts by wiping it back
 * to a freshly migrated state (schema, migration history and settings
 * defaults are kept). Refuses any stage but staging: this must never be
 * pointed at production data.
 *
 * Deploy first: npm run staging:deploy (see DEPLOY.md → Staging).
 */
import { sqlRows, stageConfig } from "../../scripts/cf-local.mjs";

const KEEP = new Set(["d1_migrations", "instance_settings"]);

export async function startRemote({ stage = "staging" } = {}) {
  if (stage !== "staging") throw new Error(`refusing to run e2e against stage "${stage}"`);
  const cfg = stageConfig(stage);
  const sql = (command) => sqlRows(command, { local: false, stage });

  const health = await fetch(`${cfg.issuer}/healthz`).catch((e) => ({ ok: false, status: String(e) }));
  if (!health.ok) throw new Error(`${cfg.issuer} is not up (${health.status}); run npm run staging:deploy`);

  const tables = (await sql("SELECT name FROM sqlite_master WHERE type = 'table'"))
    .map((r) => r.name)
    .filter((n) => !KEEP.has(n) && !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
  if (tables.length) await sql(["PRAGMA defer_foreign_keys = on;", ...tables.map((t) => `DELETE FROM "${t}";`)].join("\n"));

  return {
    base: cfg.issuer,
    work: `${cfg.name} (D1 ${cfg.d1Id})`,
    sql,
    /** Remote logs aren't streamed here; check Workers Logs after a run. */
    log: () => "",
    stop: () => {},
    remote: true,
  };
}
