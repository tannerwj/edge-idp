import { createRemoteJWKSet, jwtVerify } from "jose";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { startLocal } from "./instances.mjs";

export async function restoreDrill(browser, backup, credentials, app, secret) {
  const port = 19214;
  const base = `http://localhost:${port}`;
  const destination = await startLocal({ issuer: base, port });
  const context = await browser.newContext();
  try {
    const token = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(token).digest("hex");
    await destination.sql(`INSERT INTO users (id,name,email,is_admin,created_at,updated_at) VALUES
      ('drill-owner','Restore operator','restore@example.test',1,unixepoch(),unixepoch());
      INSERT INTO sessions (id_hash,user_id,created_at,last_seen_at,expires_at,step_up_at)
      VALUES ('${hash}','drill-owner',unixepoch(),unixepoch(),unixepoch()+3600,unixepoch());`);
    const raw = JSON.stringify(backup);
    const file = { name: "instance.json", mimeType: "application/json", buffer: Buffer.from(raw) };
    const headers = { cookie: `__Host-idp_session=${token}` };
    const preview = await context.request.post(base + "/admin/settings/backup/preview", {
      headers,
      multipart: { file },
    });
    assert.match(await preview.text(), /Restore preview/);
    assert.equal((await destination.sql("SELECT COUNT(*) AS n FROM apps"))[0].n, 0);
    const receipt = await context.request.post(base + "/admin/settings/backup/import", {
      headers,
      multipart: { file, digest: createHash("sha256").update(raw).digest("hex") },
    });
    assert.match(await receipt.text(), /Restore receipt/);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    for (const credential of credentials)
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
    await page.goto(base + "/login");
    await page
      .locator("#passkey-btn")
      .click({ timeout: 3000 })
      .catch(() => {});
    await page.waitForURL(base + "/");
    assert.match(await page.locator("h1").innerText(), /Ada/);
    const verifier = randomBytes(32).toString("base64url");
    const query = new URLSearchParams({
      client_id: app.client_id,
      redirect_uri: app.redirect_uris[0],
      scope: "openid groups",
      response_type: "code",
      state: "drill",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const redirect = await context.request.get(base + "/authorize?" + query, { maxRedirects: 0 });
    const callback = new URL(redirect.headers().location);
    assert.equal(callback.origin, new URL(app.redirect_uris[0]).origin);
    const code = callback.searchParams.get("code");
    assert.ok(code);
    const tokenResponse = await context.request.post(base + "/token", {
      form: {
        grant_type: "authorization_code",
        client_id: app.client_id,
        client_secret: secret,
        code,
        redirect_uri: app.redirect_uris[0],
        code_verifier: verifier,
      },
    });
    assert.equal(tokenResponse.status(), 200);
    const { id_token } = await tokenResponse.json();
    const { payload } = await jwtVerify(id_token, createRemoteJWKSet(new URL(base + "/jwks")), {
      issuer: base,
      audience: app.client_id,
    });
    assert.equal(payload.sub, "admin-1");
    assert.deepEqual(payload.roles, ["reader"]);
  } finally {
    await context.close();
    await destination.stop();
  }
}
