import { listApps } from "../db";
import { DEFAULT_ROLES, listAppGroups, listGrants, resolveAccess, subjectOf } from "../access";
import type { Grant } from "../access";
import { cfConfigured, listAccessApps } from "../cf-access";
import * as ops from "../ops";
import { TEMPLATES } from "../app-templates";
import { groupByRef, obj, str, strList, USER_REF, userByRef } from "./common";
import type { ToolDef } from "./common";

async function grantView(db: D1Database, grants: Grant[]) {
  const [apps, appGroups, { results: groups }, { results: users }] = await Promise.all([
    listApps(db),
    listAppGroups(db),
    db.prepare("SELECT id, name FROM groups").all<{ id: string; name: string }>(),
    db.prepare("SELECT id, email FROM users").all<{ id: string; email: string }>(),
  ]);
  const appName = new Map(apps.map((a) => [a.id, a.slug ?? a.name]));
  const appGroupName = new Map(appGroups.map((g) => [g.id, g.name]));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const userEmail = new Map(users.map((u) => [u.id, u.email]));
  const subject = (g: Grant) => {
    if (g.everyone) return "everyone";
    if (g.user_id) return { user: userEmail.get(g.user_id) ?? g.user_id };
    return { group: groupName.get(g.group_id ?? "") ?? g.group_id };
  };
  return grants.map((g) => ({
    id: g.id,
    target: g.app_id
      ? { app: appName.get(g.app_id) ?? g.app_id }
      : { app_group: appGroupName.get(g.app_group_id ?? "") ?? g.app_group_id },
    subject: subject(g),
    role: g.role,
  }));
}

const TARGET = {
  app: { type: "string", description: "App id, slug or name" },
  app_group: { type: "string", description: "…or an app group id or name" },
};

const SUBJECT = {
  ...USER_REF,
  group: { type: "string", description: "…or a user group name" },
  everyone: { type: "boolean", description: "…or everyone who can sign in" },
};

async function grantInput(db: D1Database, args: Record<string, unknown>): Promise<ops.GrantInput> {
  const appId = str(args.app) ? (await ops.appByRef(db, str(args.app))).id : null;
  const appGroupId = str(args.app_group) ? await ops.appGroupIdOf(db, str(args.app_group)) : null;
  const userId = str(args.user_id) || str(args.email) ? (await userByRef(db, args)).id : null;
  const groupId = str(args.group) ? (await groupByRef(db, str(args.group))).id : null;
  return { appId, appGroupId, userId, groupId, everyone: args.everyone === true };
}

const CONNECT_TOOLS: ToolDef[] = [
  {
    name: "app_templates_list",
    write: false,
    description:
      "Apps Johnson ID knows how to connect with apps_connect: id, how the settings are applied (api, env or ui), redirect URIs it registers, and notes.",
    inputSchema: obj(),
    handler: async () =>
      TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        apply: t.apply,
        pkce: t.pkce,
        redirects_for_example: t.redirects("https://app.example.com"),
        notes: t.notes,
        docs: t.docs,
      })),
  },
  {
    name: "apps_connect",
    write: true,
    description:
      "Connect an app so it signs in with Johnson ID: creates (or reuses) its launcher tile, registers an OIDC client linked to it with the template's redirect URIs, and returns the app-side config. Who may sign in = the tile's grants; the app's token carries only its own roles. The client secret is NOT returned: POST token=<secret_pickup.token> to secret_pickup.url once (10 minutes) and pipe the response into the app, replacing ${CLIENT_SECRET} in config. Re-running on a connected app rotates the secret and refreshes redirect URIs.",
    inputSchema: obj(
      {
        template: {
          type: "string",
          description: "From app_templates_list, e.g. grafana or generic",
        },
        base_url: {
          type: "string",
          description: "The app's URL, e.g. https://grafana.example.com",
        },
        app: {
          type: "string",
          description: "Existing tile (id, slug or name); omit to create one",
        },
        name: { type: "string", description: "Tile name when creating" },
        app_group: { type: "string", description: "App group for a new tile" },
        icon: { type: "string" },
        groups: {
          type: "array",
          items: { type: "string" },
          description:
            "Groups to grant on a new tile (default: the app group's grants, or everyone)",
        },
        redirect_uris: {
          type: "array",
          items: { type: "string" },
          description: "Required for the generic template",
        },
      },
      ["template", "base_url"],
    ),
    handler: async ({ db, env, actor }, args) =>
      ops.connectApp(
        db,
        env.ISSUER,
        {
          template: str(args.template),
          baseUrl: str(args.base_url),
          app: str(args.app) || undefined,
          name: str(args.name) || undefined,
          appGroup: str(args.app_group) || undefined,
          icon: str(args.icon) || undefined,
          groups: strList(args.groups),
          redirectUris: strList(args.redirect_uris),
        },
        actor,
      ),
  },
];

export const ACCESS_TOOLS: ToolDef[] = [
  ...CONNECT_TOOLS,
  {
    name: "app_groups_list",
    write: false,
    description:
      "List app groups: named collections of apps shown as sections on the launcher. Granting an app group grants every app in it.",
    inputSchema: obj(),
    handler: async ({ db }) => {
      const [groups, apps] = await Promise.all([listAppGroups(db), listApps(db)]);
      return groups.map((g) => ({
        ...g,
        apps: apps.filter((a) => a.app_group_id === g.id).map((a) => a.slug ?? a.name),
      }));
    },
  },
  {
    name: "app_groups_create",
    write: true,
    description: "Create an app group (a launcher section such as Home, Media or Dev tools).",
    inputSchema: obj({ name: { type: "string" }, description: { type: "string" } }, ["name"]),
    handler: async ({ db, actor }, args) => ({
      id: await ops.createAppGroup(
        db,
        { name: str(args.name), description: str(args.description) },
        actor,
      ),
    }),
  },
  {
    name: "app_groups_update",
    write: true,
    description: "Rename an app group or change its description.",
    inputSchema: obj(
      {
        app_group: { type: "string", description: "Id or name" },
        name: { type: "string" },
        description: { type: "string" },
      },
      ["app_group", "name"],
    ),
    handler: async ({ db, actor }, args) => {
      const id = await ops.appGroupIdOf(db, str(args.app_group));
      if (!id) throw new ops.OpError("App group is required.");
      await ops.updateAppGroup(
        db,
        id,
        { name: str(args.name), description: str(args.description) },
        actor,
      );
      return { ok: true };
    },
  },
  {
    name: "app_groups_delete",
    write: true,
    description:
      "Delete an app group. Its apps stay (ungrouped); grants made on the group are removed.",
    inputSchema: obj({ app_group: { type: "string", description: "Id or name" } }, ["app_group"]),
    handler: async ({ db, actor }, args) => {
      const id = await ops.appGroupIdOf(db, str(args.app_group));
      if (!id) throw new ops.OpError("App group is required.");
      await ops.deleteAppGroup(db, id, actor);
      return { ok: true };
    },
  },
  {
    name: "grants_list",
    write: false,
    description:
      "List access grants. Each grant gives one user, one user group or everyone access to one app or one app group, optionally with a role. Filter by app or app group.",
    inputSchema: obj(TARGET),
    handler: async ({ db }, args) => {
      let grants = await listGrants(db);
      if (str(args.app)) {
        const app = await ops.appByRef(db, str(args.app));
        grants = grants.filter(
          (g) => g.app_id === app.id || (!!app.app_group_id && g.app_group_id === app.app_group_id),
        );
      }
      if (str(args.app_group)) {
        const id = await ops.appGroupIdOf(db, str(args.app_group));
        grants = grants.filter((g) => g.app_group_id === id);
      }
      return grantView(db, grants);
    },
  },
  {
    name: "grants_add",
    write: true,
    description:
      "Grant access: pick one target (app or app_group) and one subject (user_id/email, group, or everyone). Optional role (e.g. admin, writer, reader) appears in tokens as roles: ['<app-slug>:<role>']; apps decide what a role means. Idempotent.",
    inputSchema: obj({
      ...TARGET,
      ...SUBJECT,
      role: {
        type: "string",
        description: `Optional: ${DEFAULT_ROLES.join(", ")} or an app-specific role`,
      },
    }),
    handler: async ({ db, actor }, args) => ({
      id: await ops.addGrant(db, { ...(await grantInput(db, args)), role: str(args.role) }, actor),
    }),
  },
  {
    name: "grants_remove",
    write: true,
    description: "Remove one access grant by id (from grants_list).",
    inputSchema: obj({ grant_id: { type: "string" } }, ["grant_id"]),
    handler: async ({ db, actor }, args) => {
      await ops.removeGrant(db, str(args.grant_id), actor);
      return { ok: true };
    },
  },
  {
    name: "access_explain",
    write: false,
    description:
      "Effective access for one user: every app they can open, their roles there, and the grants that give it. Cloudflare Access gets the app list as the `apps` claim; an app connected with its own client gets only its roles as `roles`.",
    inputSchema: obj(USER_REF),
    handler: async ({ db }, args) => {
      const user = await userByRef(db, args);
      const [apps, grants, subject] = await Promise.all([
        listApps(db),
        listGrants(db),
        subjectOf(db, user.id),
      ]);
      const access = resolveAccess(apps, grants, subject);
      const views = new Map((await grantView(db, grants)).map((v) => [v.id, v]));
      return apps
        .filter((a) => access.has(a.id))
        .map((a) => ({
          app: a.slug,
          name: a.name,
          roles: access.get(a.id),
          via: grants
            .filter((g) => resolveAccess([a], [g], subject).size > 0)
            .map((g) => views.get(g.id)),
        }));
    },
  },
  {
    name: "cloudflare_access_apps",
    write: false,
    description:
      "Read-only view of Cloudflare Access applications through this instance's Cloudflare connection: domain, whether they sign in with this IdP, the groups their policies require, and allow policies. Requires the connection in Settings.",
    inputSchema: obj(),
    handler: async ({ env, db }) => {
      if (!cfConfigured(env))
        throw new ops.OpError("Cloudflare isn't connected. Connect it in Settings → Cloudflare.");
      const [{ idp, apps }, tiles] = await Promise.all([listAccessApps(env), listApps(db)]);
      return {
        idp,
        apps: apps.map((x) => ({
          ...x,
          launcher_tile: tiles.find((t) => t.cf_app_id === x.id)?.slug ?? null,
        })),
      };
    },
  },
];
