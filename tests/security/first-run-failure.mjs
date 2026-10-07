#!/usr/bin/env node
/** Local-only first-run partial failure and empty-users recovery check. */
import { randomBytes } from "node:crypto";
import { startPortable } from "../e2e/instances.mjs";

const port = 10000 + Math.floor(Math.random() * 100);
const setupToken = randomBytes(32).toString("base64url");
const inst = await startPortable({ prefix: "first-run", port, vars: { SETUP_TOKEN: setupToken } });
try {
  await inst.start();
  // Simulate a dependency failing after the user insert and before link minting.
  inst.wrangler(["d1", "execute", "DB", "--local", "--command", "DROP TABLE audit_log"], false);
  const attempted = await fetch(`${inst.base}/setup`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: setupToken, name: "Review Admin", email: "review@example.test" }),
  });
  const users = inst.sql("SELECT COUNT(*) AS n FROM users")[0].n;
  const links = inst.sql("SELECT COUNT(*) AS n FROM enrollment_tokens")[0].n;
  const closed = (await fetch(`${inst.base}/setup`)).status;
  const pass = attempted.status === 500 && users === 0 && links === 0 && closed === 200;
  console.log(`first-run partial failure: ${pass ? "PASS" : "FAIL"} (POST ${attempted.status}, users ${users}, links ${links}, setup GET ${closed})`);
  if (!pass) process.exitCode = 1;
} finally {
  await inst.cleanup();
}
process.exit(process.exitCode ?? 0);
