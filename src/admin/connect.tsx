import { Hono } from "hono";
import { getSetting, listClients } from "../db";
import { cfConfigured } from "../cf-access";
import type { AdminVars } from "./shell";
import { page } from "./shell";
import { Callout, CopyField, PageHead } from "../ui/components";
import { Icon } from "../ui/icons";

function McpSection({
  mcpUrl,
  slug,
  dcr,
  cimd,
}: {
  mcpUrl: string;
  slug: string;
  dcr: string;
  cimd: string;
}) {
  return (
    <section class="card" id="mcp">
      <div class="card-head">
        <Icon name="bot" />
        <div class="grow">
          <h2>AI assistants (MCP)</h2>
          <div class="sub">
            Manage this IdP by asking Claude. Sign-in is OAuth with your passkey — no tokens to
            paste.
          </div>
        </div>
        <span class="row-sm">
          <span class={cimd === "1" ? "badge ok dot" : "badge"}>Metadata URLs</span>
          <span class={dcr === "1" ? "badge ok dot" : "badge"}>Dynamic registration</span>
        </span>
      </div>
      <div class="card-body stack">
        <Row label="MCP server URL" value={mcpUrl} />
        <div class="grid-2">
          <div class="stack-sm">
            <h3>Claude (web, desktop, mobile)</h3>
            <p class="text-2">
              Settings → Connectors → <b>Add custom connector</b> → paste the URL above → Connect.
              You'll approve it here with your passkey.
            </p>
          </div>
          <div class="stack-sm">
            <h3>Claude Code</h3>
            <pre class="code">{`claude mcp add --transport http ${slug} ${mcpUrl}\n# then run /mcp and choose Authenticate`}</pre>
          </div>
          <div class="stack-sm">
            <h3>Cursor</h3>
            <pre class="code">
              {JSON.stringify({ mcpServers: { [slug]: { url: mcpUrl } } }, null, 2)}
            </pre>
          </div>
          <div class="stack-sm">
            <h3>VS Code</h3>
            <pre class="code">
              {JSON.stringify({ servers: { [slug]: { type: "http", url: mcpUrl } } }, null, 2)}
            </pre>
          </div>
        </div>
        <Callout icon="shield">
          Only admins can authorize MCP clients. Each one appears under{" "}
          <a href="/admin/clients?view=connected">Clients → Connected tools</a> and in your{" "}
          <a href="/account#connected">connected apps</a>, where you can revoke it. Want an
          assistant that can look but not touch? Use a read-only{" "}
          <a href="/admin/tokens">API token</a> instead.
        </Callout>
      </div>
    </section>
  );
}

export const connectAdmin = new Hono<AdminVars>();

function Step(props: { n: number; title: string; children: unknown }) {
  return (
    <li class="step">
      <span class="step-n">{props.n}</span>
      <div class="grow stack-sm">
        <h3>{props.title}</h3>
        {props.children}
      </div>
    </li>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div class="field">
      <span class="label">{props.label}</span>
      <CopyField value={props.value} label={props.label} />
    </div>
  );
}

function AccessSection(props: {
  iss: string;
  accessClient: { id: string; name: string } | undefined;
  cfConnected: boolean;
}) {
  const { iss, accessClient } = props;
  return (
    <section class="card" id="access">
      <div class="card-head">
        <Icon name="cloud" />
        <div class="grow">
          <h2>Cloudflare Access</h2>
          <div class="sub">Replace one-time PINs with passkeys on every Access app.</div>
        </div>
        {accessClient ? (
          <a class="badge ok dot" href={`/admin/clients/${encodeURIComponent(accessClient.id)}`}>
            Client registered
          </a>
        ) : null}
      </div>
      <ol class="steps-list">
        <Step n={1} title="Register Access as a client">
          <p class="text-2">
            Confidential client, <b>PKCE off</b> (Access doesn't send it), redirect URI{" "}
            <code>https://&lt;your-team&gt;.cloudflareaccess.com/cdn-cgi/access/callback</code>.
          </p>
          <div>
            {accessClient ? (
              <a class="btn sm" href={`/admin/clients/${encodeURIComponent(accessClient.id)}`}>
                Open {accessClient.name}
              </a>
            ) : (
              <a class="btn primary sm" href="/admin/clients?new=1">
                Register client
              </a>
            )}
          </div>
        </Step>
        <Step n={2} title="Add it as an OpenID Connect login method">
          <p class="text-2">
            Zero Trust → Settings → Authentication → Login methods → Add new → OpenID Connect.
          </p>
          <div class="grid-2">
            <Row label="Auth URL" value={`${iss}/authorize`} />
            <Row label="Token URL" value={`${iss}/token`} />
            <Row label="Certificate URL" value={`${iss}/jwks`} />
            <Row label="Scopes" value="openid email profile groups" />
          </div>
          <p class="text-2">
            Paste the client ID + secret as App ID / Client secret. Under <b>OIDC Claims</b>, add{" "}
            <code>groups</code> so policies can see it. Leave PKCE off.
          </p>
        </Step>
        <Step n={3} title="Use groups in Access policies">
          <p class="text-2">
            In each Access application's policy, add an <b>Include → OIDC Claims</b> rule: claim
            name <code>groups</code>, value <code>family</code> (any group from{" "}
            <a href="/admin/groups">Groups</a>). Then set this IdP as the only login method and turn
            on <b>instant auth</b> to skip the Access chooser screen.
          </p>
        </Step>
        <Step n={4} title="Show those apps on the home screen">
          <p class="text-2">
            {props.cfConnected ? (
              <>
                The Cloudflare API is connected —{" "}
                <a href="/admin/apps?cf=1#cloudflare">import your Access apps</a>.
              </>
            ) : (
              <>
                Add them under <a href="/admin/apps">Apps</a>, or{" "}
                <a href="/admin/settings#cloudflare">connect Cloudflare</a> (read-only) to import
                them and see their policies here.
              </>
            )}
          </p>
        </Step>
      </ol>
    </section>
  );
}

function OidcSection({ iss }: { iss: string }) {
  return (
    <section class="card" id="oidc">
      <div class="card-head">
        <Icon name="plug" />
        <div class="grow">
          <h2>Any OpenID Connect app</h2>
          <div class="sub">
            Grafana, Outline, Immich, Proxmox, Jellyfin plugins, Tailscale, your own code…
          </div>
        </div>
      </div>
      <div class="card-body stack">
        <div class="grid-2">
          <Row label="Issuer" value={iss} />
          <Row label="Discovery URL" value={`${iss}/.well-known/openid-configuration`} />
        </div>
        <p class="text-2">
          Register a client under <a href="/admin/clients?new=1">Clients</a>, then point the app at
          the discovery URL. Tokens are RS256, carry <code>email</code>, <code>name</code>,{" "}
          <code>groups</code> and <code>auth_time</code>; apps can force a fresh passkey with{" "}
          <code>prompt=login</code> or <code>max_age</code>, and sign users out via{" "}
          <code>{iss}/end-session</code>.
        </p>
      </div>
    </section>
  );
}

connectAdmin.get("/", async (c) => {
  const iss = c.env.ISSUER;
  const slug =
    c.env.RP_NAME.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "idp";
  const [clients, dcr, cimd] = await Promise.all([
    listClients(c.env.DB),
    getSetting(c.env.DB, "dcr_enabled", "1"),
    getSetting(c.env.DB, "cimd_enabled", "1"),
  ]);
  const accessClient = clients.find((x) =>
    x.redirect_uris.some((u) => u.includes("cloudflareaccess.com")),
  );
  const mcpUrl = `${iss}/mcp`;
  return await page(
    c,
    { active: "connect", title: "Connect" },
    <>
      <PageHead title="Connect" lede="Recipes for plugging things into this identity provider." />
      <nav class="segmented connect-nav">
        <a href="#access">Cloudflare Access</a>
        <a href="#oidc">Any OIDC app</a>
        <a href="#mcp">AI assistants</a>
      </nav>
      <div class="stack-lg">
        <AccessSection iss={iss} accessClient={accessClient} cfConnected={cfConfigured(c.env)} />

        <OidcSection iss={iss} />

        <McpSection mcpUrl={mcpUrl} slug={slug} dcr={dcr} cimd={cimd} />
      </div>
    </>,
  );
});
