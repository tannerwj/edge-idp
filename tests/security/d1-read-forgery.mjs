#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { startPortable } from "../e2e/instances.mjs";

const port = 9900 + Math.floor(Math.random() * 90);
const inst = await startPortable({
  prefix: "d1-read",
  port,
  vars: { SETUP_TOKEN: randomBytes(32).toString("base64url") },
});
try {
  await inst.start();
  const stored = inst.sql("SELECT jwk FROM signing_keys WHERE id = 'current'")[0].jwk;
  const jwks = await (await fetch(`${inst.base}/jwks`)).json();
  const pass = stored.startsWith("enc:v1:") && !stored.includes('"d"') && jwks.keys?.length === 1;
  console.log(`D1-read signing material unavailable: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
} finally {
  await inst.cleanup();
}
process.exit(process.exitCode ?? 0);
