import { auditStmt, getApp, getClient } from "./db";
import type { App } from "./db";
import { templateById } from "./app-templates";
import { preparePickup, PICKUP_TTL } from "./secret-pickup";
import { prepareClient } from "./ops-apps";
import { appByRef, appGroupIdOf, uniqueSlug } from "./ops-access";
import { by, OpError, parseGroupList, parseRedirectUris } from "./ops-core";
import type { Actor } from "./ops-core";
import { newId, nowSec, sha256Hex } from "./util";

export interface ConnectInput {
  template: string;
  baseUrl: string;
  app?: string;
  name?: string;
  appGroup?: string;
  icon?: string;
  groups?: string[];
  redirectUris?: string[];
  preview?: boolean;
}

function baseUrlOf(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "localhost"))
      throw new Error();
    if (u.username || u.password || u.search || u.hash) throw new Error();
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    throw new OpError("Use the app's HTTPS base URL without credentials, a query or a fragment.");
  }
}

async function tileFor(db: D1Database, base: string, ref?: string) {
  if (ref) return appByRef(db, ref);
  const rows = await db
    .prepare("SELECT id FROM apps WHERE rtrim(url, '/') = ?1 LIMIT 2")
    .bind(base)
    .all<{ id: string }>();
  if (rows.results.length > 1)
    throw new OpError("Several tiles use this URL. Choose an app by id.");
  return rows.results[0] ? getApp(db, rows.results[0].id) : null;
}

async function connectionPlan(db: D1Database, input: ConnectInput) {
  const template = templateById(input.template);
  if (!template) throw new OpError("Unknown template. See app_templates_list.");
  const base = baseUrlOf(input.baseUrl);
  const redirects = parseRedirectUris(
    template.id === "generic" ? (input.redirectUris ?? []) : template.redirects(base),
  );
  const tile = await tileFor(db, base, input.app);
  const id = tile?.id ?? "connect-" + (await sha256Hex(base));
  const name = tile?.name ?? (input.name || template.name).trim().slice(0, 80);
  if (!name) throw new OpError("Name is required.");
  const app = { id, name, slug: tile ? tile.slug : await uniqueSlug(db, name) };
  const group = !tile && input.appGroup ? await appGroupIdOf(db, input.appGroup) : null;
  const groups = tile ? [] : await parseGroupList(db, input.groups ?? []);
  return {
    base,
    template,
    redirects,
    tile,
    app,
    group,
    groups,
    icon: (input.icon || template.icon).slice(0, 8),
  };
}

type Plan = Awaited<ReturnType<typeof connectionPlan>>;

function tileStatements(db: D1Database, p: Plan, a: Actor) {
  if (p.tile) return [];
  const { id, slug, name } = p.app;
  const statements = [
    db
      .prepare(`INSERT INTO apps(id,name,slug,url,app_group_id,icon,sort_order,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,COALESCE(MAX(sort_order),0)+1,unixepoch() FROM apps
    HAVING NOT EXISTS (SELECT 1 FROM apps WHERE slug=?3)`)
      .bind(id, name, slug, p.base, p.group, p.icon),
    auditStmt(db, "APP_CREATED", { detail: by(a, { name }) }),
  ];
  const subjects: (string | null)[] = p.groups.length || p.group ? p.groups : [null];
  for (const group of subjects) {
    const grant = newId();
    statements.push(
      db
        .prepare(`INSERT INTO app_grants(id,app_id,group_id,everyone,created_at)
      VALUES (?1,?2,(SELECT id FROM groups WHERE name=?3),?4,?5)`)
        .bind(grant, id, group, group === null ? 1 : 0, nowSec()),
      auditStmt(db, "APP_GRANT_ADDED", {
        detail: by(a, { grant, appId: id, group, everyone: group === null }),
      }),
    );
  }
  return statements;
}

function settings(p: Plan, issuer: string, clientId: string) {
  const t = p.template;
  return {
    app: p.app,
    client_id: clientId,
    rotated: false,
    redirect_uris: p.redirects,
    issuer,
    discovery: issuer + "/.well-known/openid-configuration",
    apply: t.apply,
    config: t.config({ issuer, clientId, baseUrl: p.base }),
    secret_placeholder: "${CLIENT_SECRET}",
    notes: t.notes,
    docs: t.docs,
  };
}

async function connected(db: D1Database, p: Plan, tile: App, issuer: string) {
  const client = tile.client_id && (await getClient(db, tile.client_id));
  if (!client || client.source !== "admin" || client.client_type !== "confidential")
    throw new OpError("This tile requires a confidential, admin-registered client.");
  if (
    client.require_pkce !== p.template.pkce ||
    !p.redirects.every((uri) => client.redirect_uris.includes(uri))
  )
    throw new OpError(
      "The linked client's settings differ. Review its redirect URIs and PKCE policy in Clients.",
    );
  return {
    ...settings(p, issuer, client.id),
    app: { id: tile.id, name: tile.name, slug: tile.slug },
    status: "connected",
    secret_pickup: null,
    next: "Use the existing app credential. If the initial pickup was lost, explicitly rotate the client secret before configuring the app.",
  };
}

export async function connectApp(db: D1Database, issuer: string, input: ConnectInput, a: Actor) {
  const p = await connectionPlan(db, input);
  if (p.tile?.client_id) return connected(db, p, p.tile, issuer);
  if (input.preview)
    return {
      ...settings(p, issuer, "<new client id>"),
      status: "preview",
      secret_pickup: null,
      creates_tile: !p.tile,
      audience: p.tile
        ? "existing grants"
        : { groups: p.groups, app_group: p.group, all_members: !p.groups.length && !p.group },
    };
  const client = await prepareClient(
    db,
    {
      name: p.app.name,
      redirectUris: p.redirects,
      requirePkce: p.template.pkce,
      description: `Connected with the ${p.template.name} template`,
    },
    a,
    p.app.id,
  );
  if (!client.secret) throw new Error("Expected a confidential client");
  const pickup = await preparePickup(db, client.id, client.secret);
  try {
    await db.batch([
      ...tileStatements(db, p, a),
      client.statement,
      auditStmt(db, "CLIENT_CREATED", { clientId: client.id, detail: by(a, { name: p.app.name }) }),
      db
        .prepare("UPDATE apps SET client_id=?1 WHERE id=?2 AND client_id IS NULL")
        .bind(client.id, p.app.id),
      pickup.statement,
      auditStmt(db, "APP_CONNECTED", {
        clientId: client.id,
        detail: by(a, { app: p.app.slug, template: p.template.id }),
      }),
    ]);
  } catch (e) {
    const other = await getApp(db, p.app.id);
    if (other?.client_id && (input.app || other.url.replace(/\/+$/, "") === p.base))
      return connected(db, p, other, issuer);
    if (!other && (await db.prepare("SELECT 1 FROM apps WHERE slug=?1").bind(p.app.slug).first()))
      throw new OpError(
        "Another app was created with this slug. Retry to choose the next available slug.",
      );
    throw e;
  }
  return {
    ...settings(p, issuer, client.id),
    status: "created",
    secret_pickup: {
      url: issuer + "/client-secret/pickup",
      token: pickup.token,
      expires_in: PICKUP_TTL,
    },
    next: "Redeem the one-time pickup and apply the settings to the app.",
  };
}
