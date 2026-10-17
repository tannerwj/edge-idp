import { audit } from "./db";
import type { App, OidcClient } from "./db";
import { newId, nowSec, randomToken, sha256Hex } from "./util";
import { by, OpError, parseGroupList, parseRedirectUris } from "./ops-core";
import { appGroupIdOf, checkSlug, seedAppGrants, uniqueSlug } from "./ops-access";
import type { Actor } from "./ops-core";

export const ENVIRONMENTS = ["production", "staging", "development"] as const;

function knownEnv(v: string | undefined): v is (typeof ENVIRONMENTS)[number] {
  return (ENVIRONMENTS as readonly (string | undefined)[]).includes(v);
}

export interface ClientInput {
  name: string;
  redirectUris: string | string[];
  allowedGroups?: string | string[];
  requirePkce?: boolean;
  clientType?: "confidential" | "public";
  environment?: string;
  description?: string;
}

export async function createClient(
  db: D1Database,
  input: ClientInput,
  a: Actor,
): Promise<{ id: string; secret: string | null }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new OpError("Name is required.");
  const uris = parseRedirectUris(input.redirectUris);
  const groups = await parseGroupList(db, input.allowedGroups ?? []);
  const isPublic = input.clientType === "public";
  const env = knownEnv(input.environment) ? input.environment : "production";
  const id = randomToken(18);
  const secret = isPublic ? null : randomToken(32);
  await db
    .prepare(
      `INSERT INTO oidc_clients
         (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups, require_pkce,
          environment, created_at, created_by, client_type, source, skip_consent, description)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'admin', 1, ?12)`,
    )
    .bind(
      id,
      name,
      JSON.stringify(uris),
      secret ? await sha256Hex(secret) : "",
      secret ? secret.slice(0, 6) : "",
      groups.length ? JSON.stringify(groups) : null,
      isPublic || input.requirePkce !== false ? 1 : 0,
      env,
      nowSec(),
      a.adminId,
      isPublic ? "public" : "confidential",
      input.description?.trim().slice(0, 300) || null,
    )
    .run();
  await audit(db, "CLIENT_CREATED", { clientId: id, detail: by(a, { name }) });
  return { id, secret };
}

export async function updateClient(
  db: D1Database,
  client: OidcClient,
  input: Partial<ClientInput> & { skipConsent?: boolean; publicSignup?: boolean },
  a: Actor,
): Promise<void> {
  const name = input.name === undefined ? client.name : input.name.trim().slice(0, 120);
  if (!name) throw new OpError("Name is required.");
  const uris =
    input.redirectUris === undefined ? client.redirect_uris : parseRedirectUris(input.redirectUris);
  const groups =
    input.allowedGroups === undefined
      ? (client.allowed_groups ?? [])
      : await parseGroupList(db, input.allowedGroups);
  const env = knownEnv(input.environment) ? input.environment : client.environment;
  const requirePkce =
    client.client_type === "public" ? true : (input.requirePkce ?? client.require_pkce);
  const skipConsent = input.skipConsent ?? client.skip_consent;
  const publicSignup =
    client.source === "admin" ? (input.publicSignup ?? client.public_signup) : false;
  await db
    .prepare(
      `UPDATE oidc_clients SET name = ?1, redirect_uris = ?2, allowed_groups = ?3, environment = ?4,
         require_pkce = ?5, skip_consent = ?6, description = ?7, public_signup = ?9 WHERE id = ?8`,
    )
    .bind(
      name,
      JSON.stringify(uris),
      groups.length ? JSON.stringify(groups) : null,
      env,
      requirePkce ? 1 : 0,
      skipConsent ? 1 : 0,
      input.description === undefined
        ? client.description
        : input.description.trim().slice(0, 300) || null,
      client.id,
      publicSignup ? 1 : 0,
    )
    .run();
  await audit(db, "CLIENT_UPDATED", { clientId: client.id, detail: by(a) });
}

export async function rotateClientSecret(
  db: D1Database,
  client: OidcClient,
  a: Actor,
): Promise<string> {
  if (client.client_type === "public") throw new OpError("Public clients don't have a secret.");
  const secret = randomToken(32);
  await db
    .prepare("UPDATE oidc_clients SET secret_hash = ?1, secret_prefix = ?2 WHERE id = ?3")
    .bind(await sha256Hex(secret), secret.slice(0, 6), client.id)
    .run();
  await audit(db, "CLIENT_SECRET_ROTATED", { clientId: client.id, detail: by(a) });
  return secret;
}

export async function deleteClient(db: D1Database, id: string, a: Actor): Promise<void> {
  await db.prepare("DELETE FROM oidc_clients WHERE id = ?1").bind(id).run();
  await audit(db, "CLIENT_DELETED", { clientId: id, detail: by(a) });
}

export interface AppInput {
  name: string;
  url: string;
  description?: string;
  icon?: string;
  color?: string;
  allowedGroups?: string | string[];
  clientId?: string | null;
  cfAppId?: string | null;
  slug?: string;
  appGroup?: string;
  seedGrants?: boolean;
}

function validAppUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    return u.toString();
  } catch {
    throw new OpError("App URL must be a full http(s) URL.");
  }
}

function normColor(raw: string | undefined): string | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? String(((n % 360) + 360) % 360) : null;
}

export async function createApp(db: D1Database, input: AppInput, a: Actor): Promise<string> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new OpError("Name is required.");
  const url = validAppUrl(input.url);
  const groups = input.clientId ? [] : await parseGroupList(db, input.allowedGroups ?? []);
  const id = newId();
  const slug = input.slug ? await checkSlug(db, input.slug, id) : await uniqueSlug(db, name);
  const appGroupId = input.appGroup ? await appGroupIdOf(db, input.appGroup) : null;
  const { n } = (await db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM apps")
    .first<{ n: number }>()) ?? { n: 0 };
  await db
    .prepare(
      `INSERT INTO apps (id, name, url, description, icon, color, allowed_groups, client_id, cf_app_id, sort_order, created_at, slug, app_group_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      id,
      name,
      url,
      input.description?.trim().slice(0, 200) || null,
      input.icon?.trim().slice(0, 8) || null,
      normColor(input.color),
      groups.length ? JSON.stringify(groups) : null,
      input.clientId || null,
      input.cfAppId || null,
      n,
      nowSec(),
      slug,
      appGroupId,
    )
    .run();
  if (!input.clientId && input.seedGrants !== false) await seedAppGrants(db, id, groups, a);
  await audit(db, "APP_CREATED", { detail: by(a, { name }) });
  return id;
}

function pick(v: string | undefined, current: string | null, max: number): string | null {
  return v === undefined ? current : v.trim().slice(0, max) || null;
}

export async function updateApp(
  db: D1Database,
  app: App,
  input: Partial<AppInput>,
  a: Actor,
): Promise<void> {
  const name = input.name === undefined ? app.name : input.name.trim().slice(0, 80);
  if (!name) throw new OpError("Name is required.");
  const url = input.url === undefined ? app.url : validAppUrl(input.url);
  const slug = input.slug ? await checkSlug(db, input.slug, app.id) : app.slug;
  const appGroupId =
    input.appGroup === undefined ? app.app_group_id : await appGroupIdOf(db, input.appGroup);
  await db
    .prepare(
      `UPDATE apps SET name = ?1, url = ?2, description = ?3, icon = ?4, color = ?5, client_id = ?6,
         cf_app_id = ?7, slug = ?8, app_group_id = ?9 WHERE id = ?10`,
    )
    .bind(
      name,
      url,
      pick(input.description, app.description, 200),
      pick(input.icon, app.icon, 8),
      input.color === undefined ? app.color : normColor(input.color),
      input.clientId === undefined ? app.client_id : input.clientId || null,
      input.cfAppId === undefined ? app.cf_app_id : input.cfAppId || null,
      slug,
      appGroupId,
      app.id,
    )
    .run();
  await audit(db, "APP_UPDATED", { detail: by(a, { name }) });
}

export async function deleteApp(db: D1Database, id: string, a: Actor): Promise<void> {
  await db.prepare("DELETE FROM apps WHERE id = ?1").bind(id).run();
  await audit(db, "APP_DELETED", { detail: by(a, { app: id }) });
}

export async function createApiToken(
  db: D1Database,
  input: { name: string; scope: "admin" | "read"; expiresInDays: number | null },
  a: Actor,
): Promise<string> {
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new OpError("Name is required.");
  const raw = `eidp_${randomToken(32)}`;
  const now = nowSec();
  await db
    .prepare(
      "INSERT INTO api_tokens (id, token_hash, name, created_at, created_by, scope, expires_at, prefix) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(
      newId(),
      await sha256Hex(raw),
      name,
      now,
      a.adminId,
      input.scope,
      input.expiresInDays ? now + input.expiresInDays * 86400 : null,
      raw.slice(0, 10),
    )
    .run();
  await audit(db, "API_TOKEN_CREATED", {
    userId: a.adminId,
    detail: by(a, { name, scope: input.scope }),
  });
  return raw;
}
