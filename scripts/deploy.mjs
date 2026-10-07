/**
 * `npm run deploy`, for both ways this repo gets deployed:
 *
 * - Workers Builds (the Deploy to Cloudflare button, or a fork connected to
 *   Git; WORKERS_CI=1): apply D1 migrations, then `wrangler deploy` with
 *   wrangler.jsonc. Migrations go by binding name (DB) so they work whatever
 *   the installer named their database.
 * - Anywhere else: `cf deploy` with cloudflare.config.ts (the reference
 *   instance; pinned to its account, so it fails safely on any other).
 */
import { execFileSync } from "node:child_process";

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

run("node", ["scripts/build-client.mjs"]);
if (process.env.WORKERS_CI === "1") {
  run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]);
  run("npx", ["wrangler", "deploy"]);
} else {
  run("npx", ["cf", "deploy", ...process.argv.slice(2)]);
}
