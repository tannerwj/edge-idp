import { Hono } from "hono";
import { getApp, listApps, listClients, listGroups } from "../db";
import type { App, Group, OidcClient } from "../db";
import * as ops from "../ops";
import { cfConfigured, listAccessApps } from "../cf-access";

type AccessList = Awaited<ReturnType<typeof listAccessApps>>;
import type { AdminVars } from "./shell";
import { act, actor, field, fields, page } from "./shell";
import { Callout, Dialog, Empty, GroupChips, GroupPicker, hueOf, PageHead, PostButton } from "../ui/components";
import { Icon } from "../ui/icons";

function CloudflareSection({ cf, cfError, imported }: { cf: AccessList | null; cfError: string | null; imported: Set<string | null> }) {
  return (
    <section class="card section-gap" id="cloudflare">
      <div class="card-head">
        <Icon name="cloud" />
        <div class="grow">
          <h2>Cloudflare Access applications</h2>
          <div class="sub">
            {cf?.idp ? (
              <>
                This IdP is registered in Access as <b>{cf.idp.name}</b>. Groups below come from policies with an <code>oidc groups</code>{" "}
                rule for it.
              </>
            ) : cf ? (
              "No Access identity provider points at this server yet — see Connect."
            ) : null}
          </div>
        </div>
      </div>
      {cfError ? (
        <div class="card-body">
          <Callout tone="bad">Couldn't reach the Cloudflare API: {cfError}</Callout>
        </div>
      ) : cf && cf.apps.length ? (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Application</th>
                <th>Signs in with us</th>
                <th>Policies</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cf.apps.map((x) => (
                <tr key={x.id}>
                  <td>
                    <div class="name">{x.name}</div>
                    <div class="muted small mono">{x.domain ?? x.type}</div>
                  </td>
                  <td>{x.usesUs ? <span class="badge ok dot">Yes</span> : <span class="badge">No</span>}</td>
                  <td class="small text-2">
                    {x.policies.length ? x.policies.map((p) => <div key={p}>{p}</div>) : <span class="muted">No allow policies</span>}
                  </td>
                  <td class="actions">
                    {imported.has(x.id) ? (
                      <span class="badge ok">In launcher</span>
                    ) : x.domain ? (
                      <PostButton
                        action="/admin/apps/import"
                        fields={{ cfAppId: x.id, name: x.name, url: `https://${x.domain}`, groups: x.groups.join(",") }}
                        label="Add to launcher"
                        class="btn sm"
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty icon="cloud" title="No Access applications found" />
      )}
    </section>
  );
}

export const appsAdmin = new Hono<AdminVars>();

const HUES = [15, 45, 75, 115, 150, 180, 210, 240, 265, 295, 325, 350];

function hueBucket(app: App): string {
  return app.color ? String(Math.round(parseInt(app.color, 10) / 30) % 12) : hueOf(app.name);
}

function Glyph(props: { app: App }) {
  const a = props.app;
  const emoji = !!a.icon && /\p{Extended_Pictographic}/u.test(a.icon);
  return (
    <span class="tile-mini" data-hue={hueBucket(a)}>
      <span class={emoji ? "glyph emoji" : "glyph"}>{a.icon || a.name.slice(0, 1).toUpperCase()}</span>
    </span>
  );
}

function AppForm(props: { app?: App; groups: Group[]; clients: OidcClient[] }) {
  const a = props.app;
  const linked = !!a?.client_id;
  return (
    <>
      <div class="grid-2">
        <label class="field">
          <span class="label">Name</span>
          <input name="name" required maxLength={80} value={a?.name ?? ""} placeholder="Home Assistant" />
        </label>
        <label class="field">
          <span class="label">Icon</span>
          <input name="icon" maxLength={8} value={a?.icon ?? ""} placeholder="🏠  (emoji or letters)" />
        </label>
      </div>
      <label class="field">
        <span class="label">URL</span>
        <input name="url" type="url" required value={a?.url ?? ""} placeholder="https://home.example.com" />
      </label>
      <label class="field">
        <span class="label">Description</span>
        <input name="description" maxLength={200} value={a?.description ?? ""} placeholder="Optional one-liner" />
      </label>
      <div class="field">
        <span class="label">Color</span>
        <div class="swatches">
          <label class="swatch" title="Automatic">
            <input type="radio" name="color" value="" checked={!a?.color} />
            <span class="auto"></span>
          </label>
          {HUES.map((h, i) => (
            <label key={String(h)} class="swatch" data-hue={String(i)}>
              <input type="radio" name="color" value={String(h)} checked={a?.color === String(h)} />
              <span></span>
            </label>
          ))}
        </div>
      </div>
      <div class="field">
        <span class="label">Who sees it</span>
        <select name="clientId">
          <option value="" selected={!linked}>
            Choose groups below
          </option>
          {props.clients
            .filter((c) => c.source === "admin")
            .map((c) => (
              <option key={c.id} value={c.id} selected={a?.client_id === c.id}>
                Same as client “{c.name}” ({c.allowed_groups?.join(", ") || "everyone"})
              </option>
            ))}
        </select>
        <span class="hint">Linking a client keeps launcher visibility in sync with what the IdP actually enforces.</span>
      </div>
      <div class="field">
        <span class="label">Groups (when not linked — none selected means everyone)</span>
        <GroupPicker name="groups" all={props.groups} selected={a?.allowed_groups} />
      </div>
      <Callout icon="info">
        The launcher controls <b>visibility</b>, not access. Enforcement happens in the linked client's allowed groups or your
        Cloudflare Access policy.
      </Callout>
    </>
  );
}

appsAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const [apps, groups, clients] = await Promise.all([listApps(db), listGroups(db), listClients(db)]);
  const clientById = new Map(clients.map((x) => [x.id, x]));
  let cf: Awaited<ReturnType<typeof listAccessApps>> | null = null;
  let cfError: string | null = null;
  if (cfConfigured(c.env) && c.req.query("cf") === "1") {
    try {
      cf = await listAccessApps(c.env);
    } catch (e) {
      cfError = e instanceof Error ? e.message : String(e);
    }
  }
  const imported = new Set(apps.map((a) => a.cf_app_id).filter(Boolean));
  return await page(
    c,
    { active: "apps", title: "Apps" },
    <>
      <PageHead
        title="Apps"
        lede="The home screen everyone sees after signing in. Add anything — apps that sign in here, Cloudflare Access apps, or plain links."
        actions={
          <>
            {cfConfigured(c.env) ? (
              <a class="btn" href="/admin/apps?cf=1#cloudflare">
                <Icon name="cloud" size="sm" />
                Import from Cloudflare
              </a>
            ) : null}
            <button class="btn primary" type="button" data-open="new-app" {...(c.req.query("new") ? { "data-autoopen": "" } : {})}>
              <Icon name="plus" size="sm" />
              Add app
            </button>
          </>
        }
      />
      <div class="card">
        {apps.length ? (
          <ul class="list">
            {apps.map((a) => {
              const cl = a.client_id ? clientById.get(a.client_id) : null;
              return (
                <li key={a.id}>
                  <Glyph app={a} />
                  <div class="grow">
                    <div class="title row-sm">
                      {a.name}
                      {a.cf_app_id ? <span class="badge">Cloudflare Access</span> : null}
                      {cl ? <span class="badge">Client: {cl.name}</span> : null}
                    </div>
                    <div class="meta truncate">
                      <a href={a.url} rel="noopener">
                        {a.url}
                      </a>
                    </div>
                  </div>
                  <div class="hide-sm">
                    <GroupChips groups={cl ? cl.allowed_groups : a.allowed_groups} />
                  </div>
                  <button class="btn ghost sm" type="button" data-open={`edit-${a.id}`}>
                    Edit
                  </button>
                  <PostButton action={`/admin/apps/${a.id}/delete`} label="" icon="trash" class="btn ghost icon sm" title="Remove" confirm={`Remove ${a.name} from the launcher?`} />
                  <Dialog id={`edit-${a.id}`} sheet title={`Edit ${a.name}`} action={`/admin/apps/${a.id}`}>
                    <AppForm app={a} groups={groups} clients={clients} />
                  </Dialog>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty icon="grid" title="No apps yet" action={<button class="btn primary" type="button" data-open="new-app">Add your first app</button>}>
            Add the things you and your people use — Home Assistant, Immich, Jellyfin, your router. Each shows up for the groups you pick.
          </Empty>
        )}
      </div>

      {cfConfigured(c.env) && c.req.query("cf") === "1" ? (
        <CloudflareSection cf={cf} cfError={cfError} imported={imported} />
      ) : null}

      <Dialog id="new-app" sheet title="Add an app" lede="It appears on the home screen of everyone allowed to see it." action="/admin/apps" submit="Add app">
        <AppForm groups={groups} clients={clients} />
      </Dialog>
    </>,
  );
});

function input(form: Record<string, string | File | (string | File)[] | undefined>): ops.AppInput {
  return {
    name: field(form, "name"),
    url: field(form, "url"),
    description: field(form, "description"),
    icon: field(form, "icon"),
    color: field(form, "color"),
    allowedGroups: fields(form, "groups"),
    clientId: field(form, "clientId") || null,
  };
}

appsAdmin.post("/", async (c) => {
  const form = await c.req.parseBody({ all: true });
  return act(c, "/admin/apps", "App added", () => ops.createApp(c.env.DB, input(form), actor(c)));
});

appsAdmin.post("/import", async (c) => {
  const form = await c.req.parseBody();
  const known = new Set((await listGroups(c.env.DB)).map((g) => g.name));
  const groups = field(form, "groups").split(",").filter((g) => known.has(g));
  return act(c, "/admin/apps?cf=1#cloudflare", "Added to launcher", () =>
    ops.createApp(c.env.DB, { name: field(form, "name"), url: field(form, "url"), allowedGroups: groups, cfAppId: field(form, "cfAppId") }, actor(c)),
  );
});

appsAdmin.post("/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await getApp(c.env.DB, id))) return c.notFound();
  const form = await c.req.parseBody({ all: true });
  return act(c, "/admin/apps", "App saved", () => ops.updateApp(c.env.DB, id, input(form), actor(c)));
});

appsAdmin.post("/:id/delete", async (c) => {
  return act(c, "/admin/apps", "App removed", () => ops.deleteApp(c.env.DB, c.req.param("id"), actor(c)));
});
