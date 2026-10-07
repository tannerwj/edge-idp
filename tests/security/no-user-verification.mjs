#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { startLocal } from "../e2e/instances.mjs";
import { chromium } from "playwright";

const port = 10300 + Math.floor(Math.random() * 100);
const instance = await startLocal({ issuer: `http://localhost:${port}`, port });
const enrollment = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(enrollment).digest("hex");
const now = Math.floor(Date.now() / 1000);
let browser;
try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at)
      VALUES ('review-no-uv', ${now}, 'Review No UV', 'no-uv@example.test', 0, ${now});
    INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at)
      VALUES ('${hash}', 'review-no-uv', ${now}, ${now + 3600});
  `);
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: true,
      hasUserVerification: false,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(`${instance.base}/enroll/${enrollment}`);
  const options = page.waitForResponse((response) =>
    response.url().endsWith("/webauthn/register/options"),
  );
  await page.click("#enroll-btn");
  const requested = await (await options).json();
  if (requested.authenticatorSelection?.userVerification !== "required")
    throw new Error("registration did not require UV");
  await page.locator("#enroll-status.error").waitFor({ timeout: 15000 });
  const count = (
    await instance.sql(
      "SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = 'review-no-uv'",
    )
  )[0].n;
  if (count !== 0) throw new Error("no-UV credential was enrolled");
  console.log("no-user-verification enrollment rejected: PASS");
} finally {
  await browser?.close();
  instance.stop();
}
process.exit(0);
