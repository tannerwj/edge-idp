import { Hono } from "hono";
import { getSetting } from "../../db";
import { getInstanceSettings, SETTING_KEYS } from "../../settings-cache";
import { cfConfigured } from "../../cf-access";
import type { AdminVars } from "../shell";
import { act, actor, field } from "../shell";
import * as ops from "../../ops";
import { PostButton } from "../../ui/components";
import { Icon } from "../../ui/icons";
import { settingsPage } from "./shell";

export const cloudflareSettings = new Hono<AdminVars>();

function CloudflareCard(props: { source: "settings" | "secret" | null; accountId: string | null }) {
  return (
    <section class="card" id="cloudflare">
      <div class="card-head">
        <Icon name="cloud" />
        <div class="grow">
          <h2>Cloudflare Access</h2>
          <div class="sub">
            Optional, read-only. Lets Admin → Apps list your Access applications and the groups
            their policies require, and add them to the launcher in one click. Nothing is ever
            changed in Cloudflare.
          </div>
        </div>
        {props.source ? (
          <span class="badge ok dot">Connected</span>
        ) : (
          <span class="badge">Not connected</span>
        )}
      </div>
      {props.source === "secret" ? (
        <div class="card-body">
          <p class="muted small">
            Connected through the <code>CF_API_TOKEN</code> Worker secret, which takes precedence.
            Remove that secret to manage the connection here instead.
          </p>
        </div>
      ) : (
        <CloudflareForm connected={props.source === "settings"} accountId={props.accountId} />
      )}
    </section>
  );
}

function CloudflareForm(props: { connected: boolean; accountId: string | null }) {
  return (
    <>
      <form method="post" action="/admin/settings/cloudflare" class="card-body stack">
        <label class="field">
          <span class="label">API token</span>
          <input
            name="token"
            type="password"
            required
            autocomplete="off"
            spellcheck={false}
            placeholder={props.connected ? "Saved. Paste a new token to replace it" : ""}
          />
          <span class="hint">
            Stored for this instance only and never shown again. Use a token with read permissions
            only.
          </span>
        </label>
        <label class="field">
          <span class="label">Account ID (optional)</span>
          <input
            name="accountId"
            value={props.accountId ?? ""}
            autocomplete="off"
            spellcheck={false}
            placeholder="Detected from the token when left empty"
          />
        </label>
        <details class="small">
          <summary>How to create the token</summary>
          <ol class="stack-sm">
            <li>
              Open{" "}
              <a
                href="https://dash.cloudflare.com/profile/api-tokens"
                target="_blank"
                rel="noopener"
              >
                Cloudflare → My Profile → API Tokens
              </a>{" "}
              and choose <b>Create Token → Custom token</b>.
            </li>
            <li>
              Add two account permissions: <b>Access: Apps and Policies → Read</b> and{" "}
              <b>Access: Organizations, Identity Providers, and Groups → Read</b>.
            </li>
            <li>Limit it to your account, create it, and paste it above.</li>
          </ol>
        </details>
        <div class="row-sm">
          <button class="btn primary" type="submit">
            {props.connected ? "Replace and test" : "Connect and test"}
          </button>
        </div>
      </form>
      {props.connected ? (
        <div class="card-foot">
          <span class="muted small">Account {props.accountId}</span>
          <PostButton
            action="/admin/settings/cloudflare/remove"
            label="Disconnect"
            icon="x"
            class="btn sm danger right"
            confirm="Disconnect Cloudflare? The Access import goes away; nothing changes in Cloudflare."
          />
        </div>
      ) : null}
    </>
  );
}

function RevocationCard(props: { on: boolean; secretToken: boolean }) {
  return (
    <form method="post" action="/admin/settings/cloudflare/revoke" class="card">
      <div class="card-head">
        <Icon name="logOut" />
        <div class="grow">
          <h2>Sign people out of Access</h2>
          <div class="sub">
            When someone is disabled, deleted, has their passkeys reset or is signed out everywhere,
            also end their Cloudflare Access sessions, so every app behind Access asks them to sign
            in again.
          </div>
        </div>
        {props.on ? <span class="badge ok dot">On</span> : <span class="badge">Off</span>}
      </div>
      <div class="card-body stack">
        {props.secretToken ? (
          <label class="switch">
            <input type="checkbox" name="on" value="1" checked={props.on} />
            <span class="track"></span>
            <span>
              End Access sessions too
              <span class="sub">
                The token also needs{" "}
                <b>Access: Organizations, Identity Providers, and Groups → Edit</b>; turning this on
                checks that it has it.
              </span>
            </span>
          </label>
        ) : (
          <p class="muted small">
            This needs a token that can also change Access identity providers and groups, so it only
            works with a token set as the <code>CF_API_TOKEN</code> Worker secret, never one saved
            here (DEPLOY.md › 11).
          </p>
        )}
      </div>
      {props.secretToken ? (
        <div class="card-foot">
          <button class="btn primary right" type="submit">
            Save
          </button>
        </div>
      ) : null}
    </form>
  );
}

cloudflareSettings.get("/cloudflare", async (c) => {
  const [token, accountId] = await Promise.all([
    getSetting(c.env.DB, SETTING_KEYS.cfApiToken, ""),
    getSetting(c.env.DB, SETTING_KEYS.cfAccountId, ""),
  ]);
  const s = await getInstanceSettings(c.env.DB);
  return settingsPage(
    c,
    "cloudflare",
    <>
      <CloudflareCard
        source={token ? "settings" : c.env.CF_API_TOKEN ? "secret" : null}
        accountId={accountId || c.env.CF_ACCOUNT_ID || null}
      />
      <RevocationCard on={s.cfAccessRevoke} secretToken={!token && cfConfigured(c.env)} />
    </>,
  );
});

cloudflareSettings.post("/cloudflare", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/cloudflare", "Cloudflare connected", () =>
    ops.connectCloudflare(
      c.env.DB,
      { token: field(form, "token"), accountId: field(form, "accountId") },
      actor(c),
    ),
  );
});

cloudflareSettings.post("/cloudflare/remove", (c) =>
  act(c, "/admin/settings/cloudflare", "Cloudflare disconnected", () =>
    ops.disconnectCloudflare(c.env.DB, actor(c)),
  ),
);

cloudflareSettings.post("/cloudflare/revoke", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings/cloudflare", "Saved", () =>
    ops.setAccessRevocation(c.env, field(form, "on") === "1", actor(c)),
  );
});
