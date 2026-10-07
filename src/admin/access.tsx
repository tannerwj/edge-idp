import { Hono } from "hono";
import type { AdminVars } from "./shell";
import { p } from "./shell";

export const accessAdmin = new Hono<AdminVars>();

accessAdmin.get("/", async (c) => {
  const issuer = c.env.ISSUER;
  return await p(
    c,
    "access",
    "Cloudflare Access",
    <>
      <p class="muted">
        Connect this identity provider to Cloudflare Zero Trust so your apps
        can use it for sign-in.
      </p>
      <h2>IdP endpoints</h2>
      <p class="muted small">
        In Zero Trust → Settings → Authentication → Add new → OpenID Connect,
        paste these three URLs:
      </p>
      <label class="field">
        <span>Authorization URL</span>
        <input readonly value={`${issuer}/authorize`} data-select />
      </label>
      <label class="field">
        <span>Token URL</span>
        <input readonly value={`${issuer}/token`} data-select />
      </label>
      <label class="field">
        <span>JWKS URL</span>
        <input readonly value={`${issuer}/jwks`} data-select />
      </label>
      <label class="field">
        <span>Scopes</span>
        <input readonly value="openid profile email groups" data-select />
      </label>
      <h2>App setup</h2>
      <p class="muted small">
        For each app in Access, set the redirect URI to:
      </p>
      <label class="field">
        <span>Redirect URI pattern</span>
        <input
          readonly
          value="https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback"
          data-select
        />
      </label>
      <p class="muted small">
        Then register the app above in the <a href="/admin/clients">Apps</a>{" "}
        tab with PKCE <strong>unchecked</strong> (Access doesn't send PKCE).
      </p>
    </>,
  );
});
