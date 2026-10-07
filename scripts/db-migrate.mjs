/**
 * Apply D1 migrations with the cf CLI.
 *
 *   node scripts/db-migrate.mjs                  # remote production database
 *   node scripts/db-migrate.mjs --stage=staging  # remote staging database
 *   node scripts/db-migrate.mjs --local   # local dev database (.wrangler/state)
 *
 * The database id comes from cloudflare.config.ts. Local state lives in
 * .wrangler/state because that's where `cf dev` reads it (cf beta: its own
 * default for --local is elsewhere, so we pin it).
 */
import { execFileSync } from "node:child_process";
import { d1Id, migrateLocal, stageArg } from "./cf-local.mjs";

if (process.argv.includes("--local")) {
  const res = await migrateLocal(".wrangler/state");
  console.log(JSON.stringify(res, null, 2));
} else {
  const stage = stageArg();
  execFileSync("npx", ["cf", "d1", "migrations", "apply", d1Id(stage), "--mode", stage], {
    stdio: "inherit",
  });
}
