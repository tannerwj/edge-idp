import { Hono } from "hono";
import { audit, getSetting, setSetting } from "../db";
import { jwksDocument } from "../crypto";
import { cfConfigured } from "../cf-access";
import { ACCENTS, invalidateSettingsCache } from "../settings-cache";
import { rpIdFromIssuer } from "../util";
import type { Env } from "../config";
import type { AdminVars } from "./shell";
import { act, actor, field, page } from "./shell";
import * as ops from "../ops";
import { SETTING_KEYS } from "../settings-cache";
import { PageHead, PostButton } from "../ui/components";
import { Icon } from "../ui/icons";
import { VERSION } from "../assets.gen";
import { availableUpdate, upstreamLinks, upstreamRepo } from "../upstream";

export const settingsAdmin = new Hono<AdminVars>();

const ok = (on: boolean, yes: string, no: string) =>
  on ? <span class="badge ok dot">{yes}</span> : <span class="badge">{no}</span>;

function About(props: {
  version: string;
  repo: string | null;
  update: string | null;
  checkedAt: number | null;
}) {
  const links = props.repo ? upstreamLinks(props.repo) : null;
  return (
    <section class="card" id="about">
      <div class="card-head">
        <Icon name="info" />
        <div class="grow">
          <h2>About & feedback</h2>
          <div class="sub">
            {links ? (
              <>
                Built from <a href={links.source}>{props.repo}</a>. Found a bug or want something?
                Tell upstream; no fork needed.
              </>
            ) : (
              "Update checks and feedback links are off (UPSTREAM_REPO=off)."
            )}
          </div>
        </div>
      </div>
      <div class="card-body stack">
        <dl class="kv">
          <dt>Version</dt>
          <dd class="row-sm wrap">
            <span class="badge mono">v{props.version}</span>
            {props.update && links ? (
              <a class="badge accent dot" href={links.updating}>
                v{props.update} available
              </a>
            ) : links ? (
              <span class="badge ok dot">{props.checkedAt ? "Up to date" : "Not checked yet"}</span>
            ) : null}
          </dd>
        </dl>
        {links ? (
          <div class="row-sm wrap">
            <a class="btn" href={links.bug} target="_blank" rel="noopener">
              <Icon name="alert" />
              <span>Report a bug</span>
            </a>
            <a class="btn" href={links.feature} target="_blank" rel="noopener">
              <Icon name="sparkles" />
              <span>Suggest a feature</span>
            </a>
            <a
              class="btn ghost"
              href={props.update ? links.updating : links.changes}
              target="_blank"
              rel="noopener"
            >
              <Icon name="arrowUpRight" />
              <span>{props.update ? "How to update" : "What's new"}</span>
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SettingsForm(props: { name: string; accent: string; dcr: string; cimd: string }) {
  return (
    <form class="card" method="post" action="/admin/settings">
      <div class="card-head">
        <Icon name="fingerprint" />
        <div class="grow">
          <h2>Name</h2>
          <div class="sub">
            Shown on sign-in pages, invites and the admin, and used by password managers to label
            new passkeys. Existing passkeys keep the label they were saved with.
          </div>
        </div>
      </div>
      <div class="card-body">
        <label class="field">
          <span class="label">Instance name</span>
          <input name="name" value={props.name} required maxLength={60} autocomplete="off" />
        </label>
      </div>
      <div class="card-head card-head-mid">
        <Icon name="sparkles" />
        <div class="grow">
          <h2>Appearance</h2>
          <div class="sub">
            Accent color for everyone. Light/dark follows each person's device (or the toggle in the
            sidebar).
          </div>
        </div>
      </div>
      <div class="card-body">
        <div class="swatches">
          {ACCENTS.map((a) => (
            <label key={a} class="swatch" data-accent={a} title={a}>
              <input type="radio" name="accent" value={a} checked={props.accent === a} />
              <span></span>
            </label>
          ))}
        </div>
      </div>
      <div class="card-head card-head-mid">
        <Icon name="bot" />
        <div class="grow">
          <h2>OAuth client onboarding</h2>
          <div class="sub">
            How AI tools and other third-party clients may introduce themselves. Users still approve
            each one.
          </div>
        </div>
      </div>
      <div class="card-body stack">
        <label class="switch">
          <input type="checkbox" name="cimd" value="1" checked={props.cimd === "1"} />
          <span class="track"></span>
          <span>
            Client ID metadata documents
            <span class="sub">
              Clients identified by an https URL they control (claude.ai, Claude Code, VS Code).
              Recommended.
            </span>
          </span>
        </label>
        <label class="switch">
          <input type="checkbox" name="dcr" value="1" checked={props.dcr === "1"} />
          <span class="track"></span>
          <span>
            Dynamic client registration
            <span class="sub">
              Anyone can register a client (Cursor needs this). Unused ones are cleaned up after 30
              days.
            </span>
          </span>
        </label>
      </div>
      <div class="card-foot">
        <button class="btn primary right" type="submit">
          Save settings
        </button>
      </div>
    </form>
  );
}

function IdentityCard(props: { env: Env; keys: { kid?: string }[] }) {
  return (
    <section class="card">
      <div class="card-head">
        <Icon name="fingerprint" />
        <h2>Identity</h2>
      </div>
      <div class="card-body">
        <dl class="kv">
          <dt>Issuer</dt>
          <dd class="mono small">{props.env.ISSUER}</dd>
          <dt>Passkey domain (RP ID)</dt>
          <dd class="mono small">{rpIdFromIssuer(props.env.ISSUER)}</dd>
          <dt>Signing keys</dt>
          <dd class="row-sm wrap">
            {props.keys.map((k, i) => (
              <span key={k.kid ?? String(i)} class={i === 0 ? "badge ok mono" : "badge mono"}>
                {k.kid} {i === 0 ? "· active" : "· verify only"}
              </span>
            ))}
          </dd>
          <dt>Rate limiting</dt>
          <dd>
            {ok(
              !!props.env.AUTH_LIMITER,
              "Workers rate limiter bound",
              "Not bound — use WAF rules",
            )}
          </dd>
          <dt>Cloudflare API</dt>
          <dd class="row-sm wrap">
            {ok(cfConfigured(props.env), "Connected (read-only)", "Not configured")}
            <a class="small" href="#cloudflare">
              Manage
            </a>
          </dd>
          <dt>Error tracking</dt>
          <dd>{ok(!!props.env.SENTRY_DSN, "Sentry", "Off")}</dd>
        </dl>
      </div>
    </section>
  );
}

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

settingsAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const [name, storedToken, accountId, accent, dcr, cimd, jwks, update, checkedAt] =
    await Promise.all([
      getSetting(db, SETTING_KEYS.name, ""),
      getSetting(db, SETTING_KEYS.cfApiToken, ""),
      getSetting(db, SETTING_KEYS.cfAccountId, ""),
      getSetting(db, "accent", "indigo"),
      getSetting(db, "dcr_enabled", "1"),
      getSetting(db, "cimd_enabled", "1"),
      jwksDocument(c.env),
      availableUpdate(c.env),
      getSetting(db, "upstream_checked_at", ""),
    ]);
  const repo = upstreamRepo(c.env);
  return await page(
    c,
    { active: "settings", title: "Settings", narrow: true },
    <>
      <PageHead
        title="Settings"
        lede="Instance-wide settings. The issuer and signing keys come from the Worker config and secrets."
      />
      <div class="stack-lg">
        <SettingsForm name={name || c.env.RP_NAME} accent={accent} dcr={dcr} cimd={cimd} />

        <CloudflareCard
          source={storedToken ? "settings" : c.env.CF_API_TOKEN ? "secret" : null}
          accountId={accountId || c.env.CF_ACCOUNT_ID || null}
        />

        <About
          version={VERSION}
          repo={repo}
          update={update}
          checkedAt={Number(checkedAt) || null}
        />

        <IdentityCard env={c.env} keys={jwks.keys} />
      </div>
    </>,
  );
});

settingsAdmin.post("/", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings", "Settings saved", async () => {
    const name = field(form, "name");
    if (name !== c.env.RP_NAME) await ops.setInstanceName(c.env.DB, name, actor(c));
    const accent = field(form, "accent");
    if ((ACCENTS as readonly string[]).includes(accent))
      await setSetting(c.env.DB, "accent", accent);
    await setSetting(c.env.DB, "cimd_enabled", field(form, "cimd") === "1" ? "1" : "0");
    await setSetting(c.env.DB, "dcr_enabled", field(form, "dcr") === "1" ? "1" : "0");
    invalidateSettingsCache();
    await audit(c.env.DB, "SETTINGS_CHANGED", { userId: c.get("admin").id, detail: { accent } });
  });
});

settingsAdmin.post("/cloudflare", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings#cloudflare", "Cloudflare connected", () =>
    ops.connectCloudflare(
      c.env.DB,
      { token: field(form, "token"), accountId: field(form, "accountId") },
      actor(c),
    ),
  );
});

settingsAdmin.post("/cloudflare/remove", (c) =>
  act(c, "/admin/settings#cloudflare", "Cloudflare disconnected", () =>
    ops.disconnectCloudflare(c.env.DB, actor(c)),
  ),
);
