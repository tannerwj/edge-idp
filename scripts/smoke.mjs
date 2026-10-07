import { execFileSync } from "node:child_process";
import { stageArg, stageConfig } from "./cf-local.mjs";

const base = process.env.E2E_BASE_URL ?? stageConfig(stageArg()).issuer;
console.log(`smoke: ${base}`);
execFileSync("npx", ["e2e", "run"], {
  stdio: "inherit",
  env: { ...process.env, E2E_BASE_URL: base, E2E_TELEMETRY_DISABLED: "1" },
});
