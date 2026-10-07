/**
 * Read-only smoke checks against a deployed instance (`npm run smoke`).
 *
 *   npm run smoke                    # production (ISSUER from cloudflare.config.ts)
 *   npm run smoke -- --stage=staging # staging
 *   E2E_BASE_URL=https://… npm run smoke
 */
import { execFileSync } from "node:child_process";
import { stageArg, stageConfig } from "./cf-local.mjs";

const base = process.env.E2E_BASE_URL ?? stageConfig(stageArg()).issuer;
console.log(`smoke: ${base}`);
execFileSync("npx", ["e2e", "run"], { stdio: "inherit", env: { ...process.env, E2E_BASE_URL: base, E2E_TELEMETRY_DISABLED: "1" } });
