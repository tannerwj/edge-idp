import { Hono } from "hono";
import { getSetting } from "../../db";
import { SETTING_KEYS } from "../../settings-cache";
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

cloudflareSettings.get("/cloudflare", async (c) => {
  const [token, accountId] = await Promise.all([
    getSetting(c.env.DB, SETTING_KEYS.cfApiToken, ""),
    getSetting(c.env.DB, SETTING_KEYS.cfAccountId, ""),
  ]);
  return settingsPage(
    c,
    "cloudflare",
    <CloudflareCard
      source={token ? "settings" : c.env.CF_API_TOKEN ? "secret" : null}
      accountId={accountId || c.env.CF_ACCOUNT_ID || null}
    />,
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
