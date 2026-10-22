import { Hono } from "hono";
import { jwksDocument } from "../../crypto";
import { rpIdFromIssuer } from "../../util";
import type { AdminVars } from "../shell";
import { SettingsCard, settingsPage } from "./shell";

export const keySettings = new Hono<AdminVars>();

keySettings.get("/keys", async (c) => {
  const jwks = await jwksDocument(c.env);
  return settingsPage(
    c,
    "keys",
    <SettingsCard
      icon="fingerprint"
      title="Identity"
      sub="Apps trust tokens from this issuer, signed by these keys. Passkeys are bound to the passkey domain, so changing the issuer needs a planned migration (DEPLOY.md)."
    >
      <div class="card-body">
        <dl class="kv">
          <dt>Issuer</dt>
          <dd class="mono small">{c.env.ISSUER}</dd>
          <dt>Passkey domain (RP ID)</dt>
          <dd class="mono small">{rpIdFromIssuer(c.env.ISSUER)}</dd>
          <dt>Signing keys</dt>
          <dd class="row-sm wrap">
            {jwks.keys.map((k, i) => (
              <span key={k.kid ?? String(i)} class={i === 0 ? "badge ok mono" : "badge mono"}>
                {k.kid} {i === 0 ? "· signing" : "· verify only"}
              </span>
            ))}
          </dd>
        </dl>
      </div>
    </SettingsCard>,
  );
});
