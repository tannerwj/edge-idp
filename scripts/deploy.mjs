import { execFileSync } from "node:child_process";

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

run("node", ["scripts/build-client.mjs"]);
if (process.env.WORKERS_CI === "1") {
  run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--remote"]);
  run("npx", ["wrangler", "deploy"]);
} else {
  run("npx", ["cf", "deploy", ...process.argv.slice(2)]);
}
