import { Hono } from "hono";
import { count, getClient, listClients, listGroups } from "../db";
import type { Group } from "../db";
import * as ops from "../ops";
import { nowSec } from "../util";
import type { ACtx, AdminVars } from "./shell";
import { act, actor, field, fields, page } from "./shell";
import {
  Callout,
  CopyField,
  Dialog,
  Empty,
  GroupChips,
  GroupPicker,
  PageHead,
  Time,
} from "../ui/components";
import { Icon } from "../ui/icons";
import { ClientDetail, detailHref, host, TypeBadges } from "./client-detail";

function NewClientDialog({ groups }: { groups: Group[] }) {
  return (
    <Dialog
      id="new-client"
      sheet
      title="Register a client"
      lede="You'll get a client ID (and secret, for confidential clients) to paste into the app."
      action="/admin/clients"
      submit="Register"
    >
      <label class="field">
        <span class="label">Name</span>
        <input name="name" required maxLength={120} placeholder="Cloudflare Access" />
        <span class="hint">Shown on the sign-in page ("Continue to …").</span>
      </label>
      <div class="field">
        <span class="label">Type</span>
        <label class="check">
          <input type="radio" name="clientType" value="confidential" checked />
          <span>
            Confidential — has a server that can keep a secret
            <span class="sub">Cloudflare Access, Grafana, Outline, most self-hosted web apps.</span>
          </span>
        </label>
        <label class="check">
          <input type="radio" name="clientType" value="public" />
          <span>
            Public — runs on the user's device
            <span class="sub">SPAs, mobile and CLI apps. Uses PKCE, no secret.</span>
          </span>
        </label>
      </div>
      <label class="field">
        <span class="label">Redirect URIs</span>
        <textarea
          name="redirectUris"
          rows={3}
          required
          placeholder="https://yourteam.cloudflareaccess.com/cdn-cgi/access/callback"
        ></textarea>
        <span class="hint">One per line. Matched exactly (http://localhost may use any port).</span>
      </label>
      <div class="field">
        <span class="label">Allowed groups</span>
        <GroupPicker name="groups" all={groups} selected={[]} />
        <span class="hint">
          None selected = everyone. For Cloudflare Access, leave empty and use Access policies per
          app.
        </span>
      </div>
      <label class="check">
        <input type="checkbox" name="requirePkce" value="1" checked />
        <span>
          Require PKCE
          <span class="sub">
            Turn off only for clients that can't send it — Cloudflare Access is one.
          </span>
        </span>
      </label>
      <label class="field">
        <span class="label">Environment</span>
        <select name="environment">
          <option value="production">Production</option>
          <option value="staging">Staging</option>
          <option value="development">Development</option>
        </select>
      </label>
    </Dialog>
  );
}

export const clientsAdmin = new Hono<AdminVars>();

clientsAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const view = c.req.query("view") === "connected" ? "connected" : "registered";
  const [all, groups] = await Promise.all([listClients(db), listGroups(db)]);
  const registered = all.filter((x) => x.source === "admin");
  const connected = all.filter((x) => x.source !== "admin");
  const shown = view === "connected" ? connected : registered;
  return await page(
    c,
    { active: "clients", title: "Clients" },
    <>
      <PageHead
        title="Clients"
        lede="Anything that signs people in through this server over OpenID Connect / OAuth: Cloudflare Access, your own apps, and AI tools like Claude."
        actions={
          <button
            class="btn primary"
            type="button"
            data-open="new-client"
            {...(c.req.query("new") ? { "data-autoopen": "" } : {})}
          >
            <Icon name="plus" size="sm" />
            Register client
          </button>
        }
      />
      <div class="filters">
        <div class="segmented">
          <a href="/admin/clients" class={view === "registered" ? "active" : ""}>
            Registered <span class="muted">{registered.length}</span>
          </a>
          <a href="/admin/clients?view=connected" class={view === "connected" ? "active" : ""}>
            Connected tools <span class="muted">{connected.length}</span>
          </a>
        </div>
      </div>
      {view === "connected" ? (
        <Callout icon="bot">
          Tools that registered themselves (MCP clients like Claude, Cursor, VS Code) — via dynamic
          registration or a client metadata URL. Only admins can authorize them, every user sees a
          consent screen, and you can revoke any of them here.
        </Callout>
      ) : null}
      <div class="card section-gap">
        {shown.length ? (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Redirects to</th>
                  <th>Who can sign in</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.id} data-href={detailHref(x.id)}>
                    <td>
                      <a class="name" href={detailHref(x.id)}>
                        {x.name}
                      </a>
                      <div class="row-sm wrap small">
                        <TypeBadges c={x} />
                      </div>
                    </td>
                    <td class="small mono text-2">
                      {[...new Set(x.redirect_uris.map(host))].slice(0, 3).map((h) => (
                        <div key={h}>{h}</div>
                      ))}
                    </td>
                    <td>
                      <GroupChips
                        groups={x.allowed_groups}
                        empty={x.source === "admin" ? "Everyone" : "Admins only"}
                      />
                    </td>
                    <td class="muted small nowrap">
                      <Time ts={x.last_used_at} empty="Never" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : view === "connected" ? (
          <Empty icon="bot" title="No connected tools yet">
            Add <code>{c.env.ISSUER}/mcp</code> as a connector in Claude, Claude Code, Cursor or VS
            Code and it will appear here after you approve it.
          </Empty>
        ) : (
          <Empty
            icon="plug"
            title="No clients registered"
            action={
              <button class="btn primary" type="button" data-open="new-client">
                Register a client
              </button>
            }
          >
            Start with Cloudflare Access — see <a href="/admin/connect">Connect</a> for the
            walkthrough.
          </Empty>
        )}
      </div>

      <NewClientDialog groups={groups} />
    </>,
  );
});

async function revealSecret(
  c: ACtx,
  client: { id: string; name: string },
  secret: string | null,
  rotated: boolean,
) {
  return await page(
    c,
    {
      active: "clients",
      title: rotated ? "Secret rotated" : "Client registered",
      crumbs: [
        { label: "Clients", href: "/admin/clients" },
        { label: client.name, href: detailHref(client.id) },
        { label: "Credentials" },
      ],
      narrow: true,
    },
    <div class="card">
      <div class="card-body stack">
        <div class="hero-icon ok">
          <Icon name="key" />
        </div>
        <div>
          <h1>{rotated ? "New secret ready" : `${client.name} is registered`}</h1>
          <p class="muted">
            {secret
              ? "Copy the secret now — only its hash is stored, so it can never be shown again."
              : "Public client: no secret, it proves itself with PKCE."}
            {rotated ? " The old secret has stopped working." : ""}
          </p>
        </div>
        <div class="field">
          <span class="label">Client ID</span>
          <CopyField value={client.id} label="client ID" />
        </div>
        {secret ? (
          <div class="field">
            <span class="label">Client secret</span>
            <CopyField value={secret} big label="client secret" />
          </div>
        ) : null}
        <div class="field">
          <span class="label">Discovery URL</span>
          <CopyField
            value={`${c.env.ISSUER}/.well-known/openid-configuration`}
            label="discovery URL"
          />
        </div>
        <div class="row">
          <a class="btn primary right" href={detailHref(client.id)}>
            Done
          </a>
        </div>
      </div>
    </div>,
  );
}

clientsAdmin.post("/", async (c) => {
  const form = await c.req.parseBody({ all: true });
  try {
    const name = field(form, "name");
    const r = await ops.createClient(
      c.env.DB,
      {
        name,
        redirectUris: field(form, "redirectUris"),
        allowedGroups: fields(form, "groups"),
        requirePkce: field(form, "requirePkce") === "1",
        clientType: field(form, "clientType") === "public" ? "public" : "confidential",
        environment: field(form, "environment"),
      },
      actor(c),
    );
    return revealSecret(c, { id: r.id, name }, r.secret, false);
  } catch (e) {
    if (e instanceof ops.OpError)
      return act(c, "/admin/clients?new=1", "", async () => {
        throw e;
      });
    throw e;
  }
});

clientsAdmin.get("/:id", async (c) => {
  const db = c.env.DB;
  const client = await getClient(db, c.req.param("id"));
  if (!client) return c.notFound();
  const [groups, grants, refresh, signIns] = await Promise.all([
    listGroups(db),
    count(db, "SELECT COUNT(*) AS n FROM oauth_grants WHERE client_id = ?1", client.id),
    count(
      db,
      "SELECT COUNT(DISTINCT family_id) AS n FROM refresh_tokens WHERE client_id = ?1 AND rotated_at IS NULL AND expires_at > ?2",
      client.id,
      nowSec(),
    ),
    count(
      db,
      "SELECT COUNT(*) AS n FROM audit_log WHERE client_id = ?1 AND event = 'CODE_ISSUED' AND created_at > ?2",
      client.id,
      nowSec() - 30 * 86400,
    ),
  ]);
  return await page(
    c,
    {
      active: "clients",
      title: client.name,
      crumbs: [
        {
          label: "Clients",
          href: client.source === "admin" ? "/admin/clients" : "/admin/clients?view=connected",
        },
        { label: client.name },
      ],
    },
    <ClientDetail
      client={client}
      groups={groups}
      grants={grants}
      refresh={refresh}
      signIns={signIns}
      iss={c.env.ISSUER}
    />,
  );
});

clientsAdmin.post("/:id", async (c) => {
  const client = await getClient(c.env.DB, c.req.param("id"));
  if (!client) return c.notFound();
  const form = await c.req.parseBody({ all: true });
  return act(c, detailHref(client.id), "Client saved", () =>
    ops.updateClient(
      c.env.DB,
      client,
      {
        name: field(form, "name"),
        redirectUris: field(form, "redirectUris"),
        allowedGroups: fields(form, "groups"),
        environment: field(form, "environment"),
        requirePkce: field(form, "requirePkce") === "1",
        skipConsent: field(form, "skipConsent") === "1",
      },
      actor(c),
    ),
  );
});

clientsAdmin.post("/:id/rotate", async (c) => {
  const client = await getClient(c.env.DB, c.req.param("id"));
  if (!client) return c.notFound();
  try {
    const secret = await ops.rotateClientSecret(c.env.DB, client, actor(c));
    return revealSecret(c, client, secret, true);
  } catch (e) {
    if (e instanceof ops.OpError)
      return act(c, detailHref(client.id), "", async () => {
        throw e;
      });
    throw e;
  }
});

clientsAdmin.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  return act(c, "/admin/clients", "Client deleted", () => ops.deleteClient(c.env.DB, id, actor(c)));
});
