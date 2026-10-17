import { audit, getSetting, listApps, listClients, setSetting } from "../db";
import * as ops from "../ops";
import { nowSec } from "../util";
import { listAppGroups } from "../access";
import { createPickup, PICKUP_TTL } from "../secret-pickup";
import { clientByRef, obj, str, strList } from "./common";
import type { ToolDef } from "./common";

export const APP_TOOLS: ToolDef[] = [
  {
    name: "clients_list",
    write: false,
    description:
      "List OAuth/OIDC clients: admin-registered, dynamically registered (DCR), and URL-based (CIMD).",
    inputSchema: obj(),
    handler: async ({ db }) =>
      (await listClients(db)).map((c) => ({
        id: c.id,
        name: c.name,
        type: c.client_type,
        source: c.source,
        environment: c.environment,
        redirect_uris: c.redirect_uris,
        allowed_groups: c.allowed_groups,
        require_pkce: c.require_pkce,
        skip_consent: c.skip_consent,
        public_signup: c.public_signup,
        last_used_at: c.last_used_at,
      })),
  },
  {
    name: "clients_create",
    write: true,
    description:
      "Register an app. Confidential clients get a secret (returned once). For Cloudflare Access: confidential, require_pkce false, redirect https://<team>.cloudflareaccess.com/cdn-cgi/access/callback.",
    inputSchema: obj(
      {
        name: { type: "string" },
        redirect_uris: { type: "array", items: { type: "string" } },
        allowed_groups: {
          type: "array",
          items: { type: "string" },
          description: "Empty = everyone",
        },
        type: { type: "string", enum: ["confidential", "public"] },
        require_pkce: { type: "boolean", description: "Default true" },
        environment: { type: "string", enum: ["production", "staging", "development"] },
      },
      ["name", "redirect_uris"],
    ),
    handler: async ({ db, actor }, args) =>
      ops.createClient(
        db,
        {
          name: str(args.name),
          redirectUris: strList(args.redirect_uris),
          allowedGroups: strList(args.allowed_groups),
          clientType: args.type === "public" ? "public" : "confidential",
          requirePkce: args.require_pkce !== false,
          environment: str(args.environment),
        },
        actor,
      ),
  },
  {
    name: "clients_update",
    write: true,
    description:
      "Update a client's name, redirect URIs, allowed groups, PKCE requirement, consent behavior or environment. A client linked to a launcher app ignores allowed groups: that app's grants decide who signs in.",
    inputSchema: obj(
      {
        client_id: { type: "string" },
        name: { type: "string" },
        redirect_uris: { type: "array", items: { type: "string" } },
        allowed_groups: { type: "array", items: { type: "string" } },
        require_pkce: { type: "boolean" },
        skip_consent: { type: "boolean" },
        public_signup: {
          type: "boolean",
          description:
            "Open to the public: anyone can create an account from this app's sign-in, and public accounts may sign in to it",
        },
        environment: { type: "string", enum: ["production", "staging", "development"] },
      },
      ["client_id"],
    ),
    handler: async ({ db, actor }, args) => {
      const c = await clientByRef(db, str(args.client_id));
      await ops.updateClient(
        db,
        c,
        {
          ...(args.name !== undefined ? { name: str(args.name) } : {}),
          ...(args.redirect_uris !== undefined
            ? { redirectUris: strList(args.redirect_uris) }
            : {}),
          ...(args.allowed_groups !== undefined
            ? { allowedGroups: strList(args.allowed_groups) }
            : {}),
          ...(typeof args.require_pkce === "boolean" ? { requirePkce: args.require_pkce } : {}),
          ...(typeof args.skip_consent === "boolean" ? { skipConsent: args.skip_consent } : {}),
          ...(typeof args.public_signup === "boolean" ? { publicSignup: args.public_signup } : {}),
          ...(args.environment !== undefined ? { environment: str(args.environment) } : {}),
        },
        actor,
      );
      return { ok: true };
    },
  },
  {
    name: "clients_rotate_secret",
    write: true,
    description:
      "Issue a new client secret. The old one stops working immediately. With pickup: true the secret is not returned; you get a one-time pickup token (10 minutes) to POST to /client-secret/pickup, so the secret can be piped into the app without passing through the model.",
    inputSchema: obj({ client_id: { type: "string" }, pickup: { type: "boolean" } }, ["client_id"]),
    handler: async ({ db, env, actor }, args) => {
      const client = await clientByRef(db, str(args.client_id));
      const secret = await ops.rotateClientSecret(db, client, actor);
      if (args.pickup !== true) return { secret };
      return {
        secret_pickup: {
          url: `${env.ISSUER}/client-secret/pickup`,
          token: await createPickup(db, client.id, secret),
          expires_in: PICKUP_TTL,
        },
      };
    },
  },
  {
    name: "clients_delete",
    write: true,
    description: "Delete a client and everything issued to it (codes, refresh tokens, consents).",
    inputSchema: obj({ client_id: { type: "string" } }, ["client_id"]),
    handler: async ({ db, actor }, args) => {
      await ops.deleteClient(db, (await clientByRef(db, str(args.client_id))).id, actor);
      return { ok: true };
    },
  },
  {
    name: "apps_list",
    write: false,
    description:
      "List launcher apps: slug (used in the `apps`/`roles` token claims), app group, Cloudflare Access link and URL. Use grants_list for who can open each.",
    inputSchema: obj(),
    handler: async ({ db }) => {
      const [apps, groups] = await Promise.all([listApps(db), listAppGroups(db)]);
      const groupName = new Map(groups.map((g) => [g.id, g.name]));
      return apps.map((a) => ({
        id: a.id,
        slug: a.slug,
        name: a.name,
        url: a.url,
        description: a.description,
        icon: a.icon,
        app_group: a.app_group_id ? (groupName.get(a.app_group_id) ?? null) : null,
        client_id: a.client_id,
        cf_app_id: a.cf_app_id,
      }));
    },
  },
  {
    name: "apps_create",
    write: true,
    description:
      "Add an app tile to the launcher. allowed_groups seeds grants (empty = everyone); refine with grants_add. Link it to a client_id to follow that client's allowed groups instead. Pass cf_app_id when the tile fronts a Cloudflare Access application so the admin UI shows it as imported.",
    inputSchema: obj(
      {
        name: { type: "string" },
        url: { type: "string" },
        description: { type: "string" },
        icon: { type: "string", description: "Emoji (optional)" },
        allowed_groups: { type: "array", items: { type: "string" } },
        client_id: { type: "string" },
        cf_app_id: { type: "string", description: "Cloudflare Access application id (optional)" },
        slug: { type: "string", description: "Claim name; defaults from the name" },
        app_group: { type: "string", description: "App group id or name (optional)" },
      },
      ["name", "url"],
    ),
    handler: async ({ db, actor }, args) => ({
      id: await ops.createApp(
        db,
        {
          name: str(args.name),
          url: str(args.url),
          description: str(args.description),
          icon: str(args.icon),
          allowedGroups: strList(args.allowed_groups),
          clientId: str(args.client_id) || null,
          cfAppId: str(args.cf_app_id) || null,
          slug: str(args.slug),
          appGroup: str(args.app_group),
        },
        actor,
      ),
    }),
  },
  {
    name: "apps_update",
    write: true,
    description:
      "Change an app tile: name, url, description, icon, slug, app group (empty string ungroups), Cloudflare Access link. Only the fields you pass change.",
    inputSchema: obj(
      {
        app: { type: "string", description: "App id, slug or name" },
        name: { type: "string" },
        url: { type: "string" },
        description: { type: "string" },
        icon: { type: "string" },
        slug: { type: "string" },
        app_group: { type: "string" },
        cf_app_id: { type: "string" },
      },
      ["app"],
    ),
    handler: async ({ db, actor }, args) => {
      const app = await ops.appByRef(db, str(args.app));
      const pick = (k: string) => (typeof args[k] === "string" ? str(args[k]) : undefined);
      await ops.updateApp(
        db,
        app,
        {
          name: pick("name"),
          url: pick("url"),
          description: pick("description"),
          icon: pick("icon"),
          slug: pick("slug"),
          appGroup: pick("app_group"),
          cfAppId: pick("cf_app_id"),
        },
        actor,
      );
      return { ok: true };
    },
  },
  {
    name: "apps_delete",
    write: true,
    description: "Remove an app from the launcher (its grants and favorites go with it).",
    inputSchema: obj({ app_id: { type: "string", description: "App id, slug or name" } }, [
      "app_id",
    ]),
    handler: async ({ db, actor }, args) => {
      await ops.deleteApp(db, (await ops.appByRef(db, str(args.app_id))).id, actor);
      return { ok: true };
    },
  },
  {
    name: "audit_query",
    write: false,
    description:
      "Recent audit events, newest first. Filter by event name (e.g. SIGN_IN, ACCESS_DENIED), user email, and age.",
    inputSchema: obj({
      event: { type: "string" },
      email: { type: "string" },
      since_hours: { type: "number", description: "Default 168 (7 days)" },
      limit: { type: "number", description: "Default 50, max 500" },
    }),
    handler: async ({ db }, args) => {
      const since =
        nowSec() -
        Math.round((typeof args.since_hours === "number" ? args.since_hours : 168) * 3600);
      const limit = Math.min(
        500,
        Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 50),
      );
      const where = ["a.created_at >= ?1"];
      const binds: unknown[] = [since];
      if (str(args.event)) {
        binds.push(str(args.event).toUpperCase());
        where.push(`a.event = ?${binds.length}`);
      }
      if (str(args.email)) {
        binds.push(str(args.email).toLowerCase());
        where.push(`lower(u.email) = ?${binds.length}`);
      }
      binds.push(limit);
      const { results } = await db
        .prepare(
          `SELECT a.created_at, a.event, u.email, a.client_id, a.detail FROM audit_log a
           LEFT JOIN users u ON u.id = a.user_id WHERE ${where.join(" AND ")}
           ORDER BY a.id DESC LIMIT ?${binds.length}`,
        )
        .bind(...binds)
        .all<{
          created_at: number;
          event: string;
          email: string | null;
          client_id: string | null;
          detail: string | null;
        }>();
      return results.map((r) => ({
        ...r,
        at: new Date(r.created_at * 1000).toISOString(),
        detail: r.detail ? JSON.parse(r.detail) : null,
      }));
    },
  },
  {
    name: "settings_get",
    write: false,
    description:
      "Instance settings: name, accent color, dynamic client registration, CIMD support, whether the read-only Cloudflare Access connection is set up.",
    inputSchema: obj(),
    handler: async ({ db, env }) => ({
      name: env.RP_NAME,
      cloudflare_connected: !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID),
      accent: await getSetting(db, "accent", "indigo"),
      dcr_enabled: (await getSetting(db, "dcr_enabled", "1")) === "1",
      cimd_enabled: (await getSetting(db, "cimd_enabled", "1")) === "1",
    }),
  },
  {
    name: "settings_set",
    write: true,
    description:
      "Change instance settings. `name` is shown on sign-in pages, invites and in password managers for new passkeys.",
    inputSchema: obj({
      name: { type: "string", maxLength: 60 },
      accent: {
        type: "string",
        enum: ["indigo", "iris", "blue", "teal", "green", "amber", "orange", "rose", "graphite"],
      },
      dcr_enabled: { type: "boolean" },
      cimd_enabled: { type: "boolean" },
    }),
    handler: async ({ db, actor }, args) => {
      if (typeof args.name === "string") await ops.setInstanceName(db, args.name, actor);
      if (str(args.accent)) await setSetting(db, "accent", str(args.accent));
      if (typeof args.dcr_enabled === "boolean")
        await setSetting(db, "dcr_enabled", args.dcr_enabled ? "1" : "0");
      if (typeof args.cimd_enabled === "boolean")
        await setSetting(db, "cimd_enabled", args.cimd_enabled ? "1" : "0");
      await audit(db, "SETTINGS_CHANGED", { userId: actor.adminId, detail: { via: "mcp" } });
      return { ok: true };
    },
  },
];
