import { execFileSync } from "node:child_process";
import { startLocal } from "./instances.mjs";

const port = 19216;
const base = `http://localhost:${port}`;
const local = await startLocal({ issuer: base, port });
try {
  await local.sql(
    "INSERT INTO users(id,name,email,is_admin,created_at,updated_at) VALUES ('operator','Smoke operator','owner@example.test',1,unixepoch(),unixepoch())",
  );
  execFileSync("node", ["scripts/smoke.mjs"], {
    env: { ...process.env, E2E_BASE_URL: base },
    stdio: "inherit",
  });
} finally {
  await local.stop();
}
