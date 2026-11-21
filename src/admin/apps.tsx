import { Hono } from "hono";
import { getApp, listApps, listClients, listGroups, listUsers } from "../db";
import type { App, OidcClient } from "../db";
import { listAppGroups, listGrants } from "../access";
import type { AppGroup } from "../access";
import * as ops from "../ops";
import { cfConfigured, listAccessApps } from "../cf-access";

import type { AdminVars } from "./shell";
import { act, actor, field, fields, page } from "./shell";
import { Dialog, Empty, PageHead, PostButton } from "../ui/components";
import { AppForm, Glyph } from "./apps-form";
import { Icon } from "../ui/icons";
import { CloudflareSection, importAdmin } from "./apps-cloudflare";
import {
  AccessDialog,
  AppGroupForm,
  appsAccessAdmin,
  GrantChips,
  RoleSuggestions,
} from "./apps-access";
import type { AccessData } from "./apps-access";

export const appsAdmin = new Hono<AdminVars>();
appsAdmin.route("/", appsAccessAdmin);
appsAdmin.route("/import", importAdmin);

interface PageData extends AccessData {
  editor: string;
  apps: App[];
  clients: OidcClient[];
  clientById: Map<string, OidcClient>;
}

function EditorLink({
  id,
  active,
  label,
  className,
}: {
  id: string;
  active: string;
  label: string;
  className: string;
}) {
  return id === active ? (
    <button type="button" class={className} data-open={id} data-autoopen>
      {label}
    </button>
  ) : (
    <a class={className} data-open={id} href={`/admin/apps?editor=${encodeURIComponent(id)}`}>
      {label}
    </a>
  );
}

function AppRow(props: { a: App; data: PageData }) {
  const { a, data } = props;
  const cl = a.client_id ? data.clientById.get(a.client_id) : null;
  const own = data.grants.filter((g) => g.app_id === a.id);
  const group = data.appGroups.find((g) => g.id === a.app_group_id);
  const inherited = group ? data.grants.filter((g) => g.app_group_id === group.id) : [];
  return (
    <li>
      <Glyph app={a} />
      <div class="grow">
        <div class="title row-sm">
          {a.name}
          {a.slug ? <code class="small muted">{a.slug}</code> : null}
          {a.cf_app_id ? <span class="badge">Cloudflare Access</span> : null}
          {cl ? <span class="badge">Client: {cl.name}</span> : null}
        </div>
        <div class="meta truncate">
          <a href={a.url} target="_blank" rel="noopener">
            {a.url}
          </a>
        </div>
      </div>
      <div class="hide-sm">
        <GrantChips grants={[...own, ...inherited]} d={data} />
      </div>
      <EditorLink
        id={`access-${a.id}`}
        active={data.editor}
        label="Access"
        className="btn ghost sm"
      />
      <EditorLink id={`edit-${a.id}`} active={data.editor} label="Edit" className="btn ghost sm" />
      <PostButton
        action={`/admin/apps/${a.id}/delete`}
        label=""
        icon="trash"
        class="btn ghost icon sm"
        title="Remove"
        confirm={`Remove ${a.name} from the launcher? Its access grants go with it.`}
      />
      {data.editor === `edit-${a.id}` ? (
        <Dialog id={`edit-${a.id}`} sheet title={`Edit ${a.name}`} action={`/admin/apps/${a.id}`}>
          <AppForm app={a} groups={data.groups} clients={data.clients} appGroups={data.appGroups} />
        </Dialog>
      ) : null}
      {data.editor === `access-${a.id}` ? (
        <AccessDialog
          id={`access-${a.id}`}
          title={`Access to ${a.name}`}
          action={`/admin/apps/${a.id}/grants`}
          own={own}
          inherited={group ? { from: group.name, grants: inherited } : undefined}
          d={data}
        />
      ) : null}
    </li>
  );
}

function GroupHead(props: { g: AppGroup; data: PageData }) {
  const { g, data } = props;
  const grants = data.grants.filter((x) => x.app_group_id === g.id);
  return (
    <div class="card-head">
      <Icon name="layers" />
      <div class="grow">
        <h2>{g.name}</h2>
        {g.description ? <div class="sub">{g.description}</div> : null}
        <div class="sub">
          <GrantChips grants={grants} d={data} empty="No group-wide access" />
        </div>
      </div>
      <EditorLink
        id={`access-group-${g.id}`}
        active={data.editor}
        label="Access"
        className="btn ghost sm"
      />
      <EditorLink
        id={`edit-group-${g.id}`}
        active={data.editor}
        label="Edit"
        className="btn ghost sm"
      />
      <PostButton
        action={`/admin/apps/groups/${g.id}/delete`}
        label=""
        icon="trash"
        class="btn ghost icon sm"
        title="Delete app group"
        confirm={`Delete ${g.name}? Its apps stay, ungrouped; access granted on the group is removed.`}
      />
      {data.editor === `edit-group-${g.id}` ? (
        <Dialog
          id={`edit-group-${g.id}`}
          title={`Edit ${g.name}`}
          action={`/admin/apps/groups/${g.id}`}
        >
          <AppGroupForm group={g} />
        </Dialog>
      ) : null}
      {data.editor === `access-group-${g.id}` ? (
        <AccessDialog
          id={`access-group-${g.id}`}
          title={`Access to everything in ${g.name}`}
          action={`/admin/apps/groups/${g.id}/grants`}
          own={grants}
          d={data}
        />
      ) : null}
    </div>
  );
}

function AppSection(props: { g: AppGroup | null; apps: App[]; data: PageData }) {
  return (
    <section class="card">
      {props.g ? (
        <GroupHead g={props.g} data={props.data} />
      ) : (
        <div class="card-head">
          <Icon name="grid" />
          <h2 class="grow">Not in an app group</h2>
        </div>
      )}
      {props.apps.length ? (
        <ul class="list">
          {props.apps.map((a) => (
            <AppRow key={a.id} a={a} data={props.data} />
          ))}
        </ul>
      ) : (
        <div class="card-body muted small">No apps here yet. Pick this group when editing one.</div>
      )}
    </section>
  );
}

function AppSections(props: { data: PageData }) {
  const { data } = props;
  const ungrouped = data.apps.filter(
    (a) => !a.app_group_id || !data.appGroups.some((g) => g.id === a.app_group_id),
  );
  if (!data.apps.length && !data.appGroups.length)
    return (
      <div class="card">
        <Empty
          icon="grid"
          title="No apps yet"
          action={
            <a class="btn primary" href="/admin/apps?editor=new-app">
              Add your first app
            </a>
          }
        >
          Add the things you and your people use — Home Assistant, Immich, Jellyfin, your router.
          Then decide who gets each one, and with which role.
        </Empty>
      </div>
    );
  return (
    <div class="stack">
      {data.appGroups.map((g) => (
        <AppSection
          key={g.id}
          g={g}
          apps={data.apps.filter((a) => a.app_group_id === g.id)}
          data={data}
        />
      ))}
      {ungrouped.length ? <AppSection g={null} apps={ungrouped} data={data} /> : null}
    </div>
  );
}

async function pageData(db: D1Database, editor: string): Promise<PageData> {
  const [apps, groups, clients, users, appGroups, grants] = await Promise.all([
    listApps(db),
    listGroups(db),
    listClients(db),
    listUsers(db),
    listAppGroups(db),
    listGrants(db),
  ]);
  return {
    apps,
    groups,
    clients,
    users,
    appGroups,
    grants,
    editor,
    clientById: new Map(clients.map((x) => [x.id, x])),
  };
}

function HeadActions(props: { cf: boolean; editor: string }) {
  return (
    <>
      {props.cf ? (
        <a class="btn" href="/admin/apps?cf=1#cloudflare">
          <Icon name="cloud" size="sm" />
          Import from Cloudflare
        </a>
      ) : (
        <a class="btn ghost" href="/admin/settings/cloudflare">
          <Icon name="cloud" size="sm" />
          Connect Cloudflare
        </a>
      )}
      <EditorLink id="new-app-group" active={props.editor} label="New app group" className="btn" />
      <EditorLink id="new-app" active={props.editor} label="Add app" className="btn primary" />
    </>
  );
}

appsAdmin.get("/", async (c) => {
  const data = await pageData(
    c.env.DB,
    c.req.query("editor") ?? (c.req.query("new") ? "new-app" : ""),
  );
  const showCf = cfConfigured(c.env) && c.req.query("cf") === "1";
  let cf: Awaited<ReturnType<typeof listAccessApps>> | null = null;
  let cfError: string | null = null;
  if (showCf) {
    try {
      cf = await listAccessApps(c.env);
    } catch (e) {
      cfError = e instanceof Error ? e.message : String(e);
    }
  }
  const imported = new Set(data.apps.map((a) => a.cf_app_id).filter(Boolean));
  return await page(
    c,
    { active: "apps", title: "Apps" },
    <>
      <PageHead
        title="Apps"
        lede="The home screen everyone sees after signing in. Group apps into sections, then grant people or groups access — with a role when the app cares."
        actions={<HeadActions cf={cfConfigured(c.env)} editor={data.editor} />}
      />
      <AppSections data={data} />
      {showCf ? (
        <CloudflareSection groups={data.groups} cf={cf} cfError={cfError} imported={imported} />
      ) : null}
      <RoleSuggestions />
      {data.editor === "new-app" ? (
        <Dialog
          id="new-app"
          sheet
          title="Add an app"
          lede="It appears on the home screen of everyone allowed to open it."
          action="/admin/apps"
          submit="Add app"
        >
          <AppForm groups={data.groups} clients={data.clients} appGroups={data.appGroups} />
        </Dialog>
      ) : null}
      {data.editor === "new-app-group" ? (
        <Dialog
          id="new-app-group"
          title="New app group"
          lede="A section on the home screen. Granting access to the group grants every app in it."
          action="/admin/apps/groups"
          submit="Create"
        >
          <AppGroupForm />
        </Dialog>
      ) : null}
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
    slug: field(form, "slug"),
    appGroup: field(form, "appGroup"),
  };
}

appsAdmin.post("/", async (c) => {
  const form = await c.req.parseBody({ all: true });
  return act(c, "/admin/apps", "App added", () => ops.createApp(c.env.DB, input(form), actor(c)));
});

appsAdmin.post("/:id", async (c) => {
  const app = await getApp(c.env.DB, c.req.param("id"));
  if (!app) return c.notFound();
  const form = await c.req.parseBody({ all: true });
  return act(c, "/admin/apps", "App saved", () =>
    ops.updateApp(c.env.DB, app, input(form), actor(c)),
  );
});

appsAdmin.post("/:id/delete", async (c) => {
  return act(c, "/admin/apps", "App removed", () =>
    ops.deleteApp(c.env.DB, c.req.param("id"), actor(c)),
  );
});
