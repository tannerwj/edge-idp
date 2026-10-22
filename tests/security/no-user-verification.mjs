#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { startLocal } from "../e2e/instances.mjs";
import { chromium } from "playwright";

const port = 10300 + Math.floor(Math.random() * 100);
const instance = await startLocal({ issuer: `http://localhost:${port}`, port });
const enrollment = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(enrollment).digest("hex");
const second = randomBytes(32).toString("base64url");
const now = Math.floor(Date.now() / 1000);
let browser;
try {
  await instance.sql(`
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at)
      VALUES ('review-no-uv', ${now}, 'Review No UV', 'no-uv@example.test', 0, ${now});
    INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at)
      VALUES ('${hash}', 'review-no-uv', ${now}, ${now + 3600});
    INSERT INTO users (id, created_at, name, email, is_admin, updated_at)
      VALUES ('review-skip-uv', ${now}, 'Review Skip UV', 'skip-uv@example.test', 0, ${now});
    INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at)
      VALUES ('${createHash("sha256").update(second).digest("hex")}', 'review-skip-uv', ${now}, ${now + 3600});
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
  await page.goto(`${instance.base}/enroll#${enrollment}`);
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

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  const cdp2 = await ctx2.newCDPSession(page2);
  await cdp2.send("WebAuthn.enable");
  const { authenticatorId } = await cdp2.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page2.goto(`${instance.base}/enroll#${second}`);
  await page2.click("#enroll-btn");
  await page2.waitForURL(`${instance.base}/?**`, { timeout: 15000 });
  await cdp2.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await page2.addInitScript(() => {
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = (options) =>
      get({ ...options, publicKey: { ...options.publicKey, userVerification: "discouraged" } });
  });
  const signIn = async (path) => {
    const verify = page2.waitForResponse((r) => r.url().endsWith("/webauthn/auth/verify"), {
      timeout: 8000,
    });
    await page2.goto(`${instance.base}${path}`);
    await page2.click("#passkey-btn", { timeout: 3000 }).catch(() => {});
    const res = await verify.catch(() => null);
    lastError = res ? ((await res.json().catch(() => ({}))).error ?? null) : null;
    return res?.status() ?? null;
  };
  let lastError = null;
  await ctx2.clearCookies();
  const strict = await signIn("/login");
  if (strict !== 401) throw new Error(`server didn't refuse sign-in without UV: ${strict}`);
  console.log("sign-in without UV refused by default: PASS");

  await instance.sql(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ('sign_in_uv', 'discouraged', ${now})`,
  );
  await new Promise((r) => setTimeout(r, 11_000));
  const relaxed = await signIn("/login");
  if (relaxed !== 200) throw new Error(`relaxed sign-in without UV failed: ${relaxed}`);
  console.log("sign-in without UV allowed when the setting is relaxed: PASS");

  const recheck = await signIn(`/login?reauth=1&next=${encodeURIComponent("/account")}`);
  if (recheck !== 401) throw new Error(`server didn't refuse a recheck without UV: ${recheck}`);
  console.log("passkey recheck still requires UV: PASS");

  await instance.sql("UPDATE users SET is_admin = 1 WHERE id = 'review-skip-uv'");
  await ctx2.clearCookies();
  const admin = await signIn("/login");
  if (admin !== 401 || lastError !== "uv_required")
    throw new Error(`an admin signed in without UV: ${admin} ${lastError}`);
  console.log("admins still have to verify by default: PASS");

  await instance.sql(
    `INSERT INTO instance_settings (key, value, updated_at) VALUES ('admins_always_verify', '0', ${now})`,
  );
  await new Promise((r) => setTimeout(r, 11_000));
  await ctx2.clearCookies();
  const relaxedAdmin = await signIn("/login");
  if (relaxedAdmin !== 200) throw new Error(`relaxed admin sign-in failed: ${relaxedAdmin}`);
  console.log("…unless that setting is turned off: PASS");
} finally {
  await browser?.close();
  await instance.stop();
}
process.exit(0);
