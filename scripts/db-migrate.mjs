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
