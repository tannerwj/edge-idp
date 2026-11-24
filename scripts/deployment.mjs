import { existsSync, readFileSync } from "node:fs";

const path = ".deployment.local.json";
export const deployment = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
