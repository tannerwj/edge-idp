#!/usr/bin/env node
/** Local browser ceremonies, sandbox, and cron timing. Synthetic user only. */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { startLocal } from "../tests/e2e/local-instance.mjs";

const port = 10100 + Math.floor(Math.random() * 100);
const instance = await startLocal({ issuer: `http://localhost:${port}`, port });
const enrollment = randomBytes(32).toString("base64url");
const api = `eidp_${randomBytes(32).toString("base64url")}`;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const now = Math.floor(Date.now() / 1000);
let browser;
const timings = { requests: {}, execute_ms: [], cron_ms: null };
try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at)
      VALUES ('review-admin', ${now}, 'Review Admin', 'review@example.test', 1, ${now});
    INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at)
      VALUES ('${hash(enrollment)}', 'review-admin', ${now}, ${now + 3600});
    INSERT INTO api_tokens (id, token_hash, name, created_at, created_by, scope)
      VALUES ('review-api', '${hash(api)}', 'review', ${now}, 'review-admin', 'admin');
  `);
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  page.on("requestfinished", (request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/webauthn/")) return;
    const t = request.timing();
    if (t && t.responseEnd >= 0) (timings.requests[path] ??= []).push(Math.round(t.responseEnd * 10) / 10);
  });
  await page.goto(`${instance.base}/enroll/${enrollment}`);
  await page.click("#enroll-btn");
  await page.waitForURL(`${instance.base}/?**`, { timeout: 15000 });
  await page.click("form[action='/logout'] button");
  await page.waitForURL(/\/login/);
  await page.click("#passkey-btn", { timeout: 3000 }).catch(() => {});
  await page.waitForURL(`${instance.base}/`, { timeout: 15000 });

  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const response = await fetch(`${instance.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${api}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "execute", arguments: { code: "return (await id.users_list({})).length;" } } }),
    });
    const body = await response.json();
    if (response.status !== 200 || body.result?.isError) throw new Error("sandbox benchmark failed");
    timings.execute_ms.push(Math.round((performance.now() - start) * 10) / 10);
  }
  const start = performance.now();
  const cron = await fetch(`${instance.base}/cdn-cgi/local/scheduled`);
  await cron.arrayBuffer();
  timings.cron_ms = Math.round((performance.now() - start) * 10) / 10;
  timings.cron_status = cron.status;
  const output = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    environment: "local cf dev, Chromium virtual authenticator, isolated D1; network timings include browser transport",
    ...timings,
  };
  writeFileSync(new URL("./performance-ceremony.json", import.meta.url), JSON.stringify(output, null, 2) + "\n");
  for (const [path, values] of Object.entries(timings.requests)) console.log(`${path}: ${values.join(", ")} ms`);
  console.log(`execute: ${timings.execute_ms.join(", ")} ms; cron with update check: ${timings.cron_ms} ms/${cron.status}`);
} finally {
  await browser?.close();
  instance.stop();
}
process.exit(0);
