import { audit, getApp, listApps } from "./db";
import type { App } from "./db";
import { ROLE_RE, SLUG_RE, slugify } from "./access";
import { newId, nowSec } from "./util";
import { by, OpError } from "./ops-core";
import type { Actor } from "./ops-core";

export async function uniqueSlug(db: D1Database, wanted: string, appId?: string): Promise<string> {
  const base = slugify(wanted) || "app";
  const { results } = await db
    .prepare("SELECT slug FROM apps WHERE slug IS NOT NULL AND id != ?1")
    .bind(appId ?? "")
    .all<{ slug: string }>();
  const taken = new Set(results.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const next = `${base.slice(0, 36)}-${i}`;
    if (!taken.has(next)) return next;
  }
}

export async function checkSlug(db: D1Database, slug: string, appId: string): Promise<string> {
  const s = slug.trim().toLowerCase();
  if (!SLUG_RE.test(s))
    throw new OpError("Slug must be lowercase letters, numbers and dashes (max 40).");
  const clash = await db
    .prepare("SELECT name FROM apps WHERE slug = ?1 AND id != ?2")
    .bind(s, appId)
    .first<{ name: string }>();
  if (clash) throw new OpError(`Slug “${s}” is already used by ${clash.name}.`);
  return s;
}

export async function appGroupIdOf(db: D1Database, ref: string): Promise<string | null> {
  if (!ref.trim()) return null;
  const g = await db
    .prepare("SELECT id FROM app_groups WHERE id = ?1 OR name = ?1 COLLATE NOCASE")
    .bind(ref.trim())
    .first<{ id: string }>();
  if (!g) throw new OpError(`App group not found: ${ref}`);
  return g.id;
}

function groupName(raw: string): string {
  const name = raw.trim().slice(0, 60);
  if (!name) throw new OpError("Name is required.");
  return name;
}

export async function createAppGroup(
  db: D1Database,
  input: { name: string; description?: string },
  a: Actor,
): Promise<string> {
  const name = groupName(input.name);
  const clash = await db
    .prepare("SELECT 1 FROM app_groups WHERE name = ?1 COLLATE NOCASE")
    .bind(name)
    .first();
  if (clash) throw new OpError(`An app group named “${name}” already exists.`);
  const id = newId();
  const { n } = (await db
    .prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM app_groups")
    .first<{ n: number }>()) ?? { n: 0 };
  await db
    .prepare(
      "INSERT INTO app_groups (id, name, description, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(id, name, input.description?.trim().slice(0, 200) || null, n, nowSec())
    .run();
  await audit(db, "APP_GROUP_CREATED", { detail: by(a, { name }) });
  return id;
}

export async function updateAppGroup(
  db: D1Database,
  id: string,
  input: { name: string; description?: string },
  a: Actor,
): Promise<void> {
  const name = groupName(input.name);
  const clash = await db
    .prepare("SELECT 1 FROM app_groups WHERE name = ?1 COLLATE NOCASE AND id != ?2")
    .bind(name, id)
    .first();
  if (clash) throw new OpError(`An app group named “${name}” already exists.`);
  await db
    .prepare("UPDATE app_groups SET name = ?1, description = ?2 WHERE id = ?3")
    .bind(name, input.description?.trim().slice(0, 200) || null, id)
    .run();
  await audit(db, "APP_GROUP_UPDATED", { detail: by(a, { name }) });
}

export async function deleteAppGroup(db: D1Database, id: string, a: Actor): Promise<void> {
  const g = await db
    .prepare("SELECT name FROM app_groups WHERE id = ?1")
    .bind(id)
    .first<{ name: string }>();
  if (!g) throw new OpError("App group not found.");
  await db.prepare("DELETE FROM app_groups WHERE id = ?1").bind(id).run();
  await audit(db, "APP_GROUP_DELETED", { detail: by(a, { name: g.name }) });
}

export interface GrantInput {
  appId?: string | null;
  appGroupId?: string | null;
  userId?: string | null;
  groupId?: string | null;
  everyone?: boolean;
  role?: string | null;
}

function grantShape(input: GrantInput) {
  const targets = [input.appId, input.appGroupId].filter(Boolean).length;
  if (targets !== 1) throw new OpError("Grant exactly one app or one app group.");
  const subjects = [input.userId, input.groupId, input.everyone || null].filter(Boolean).length;
  if (subjects !== 1) throw new OpError("Grant to exactly one user, one group, or everyone.");
  const role = input.role?.trim().toLowerCase() || null;
  if (role && !ROLE_RE.test(role))
    throw new OpError("Role must be lowercase letters, numbers, dash or underscore (max 30).");
  return {
    appId: input.appId || null,
    appGroupId: input.appGroupId || null,
    userId: input.userId || null,
    groupId: input.groupId || null,
    everyone: input.everyone ? 1 : 0,
    role,
  };
}

export async function addGrant(db: D1Database, input: GrantInput, a: Actor): Promise<string> {
  const g = grantShape(input);
  const existing = await db
    .prepare(
      `SELECT id FROM app_grants WHERE app_id IS ?1 AND app_group_id IS ?2 AND user_id IS ?3
         AND group_id IS ?4 AND everyone = ?5 AND role IS ?6`,
    )
    .bind(g.appId, g.appGroupId, g.userId, g.groupId, g.everyone, g.role)
    .first<{ id: string }>();
  if (existing) return existing.id;
  const id = newId();
  await db
    .prepare(
      `INSERT INTO app_grants (id, app_id, app_group_id, user_id, group_id, everyone, role, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(id, g.appId, g.appGroupId, g.userId, g.groupId, g.everyone, g.role, nowSec())
    .run();
  await audit(db, "APP_GRANT_ADDED", { userId: g.userId, detail: by(a, { grant: id, ...g }) });
  return id;
}

export async function removeGrant(db: D1Database, id: string, a: Actor): Promise<void> {
  const row = await db
    .prepare("DELETE FROM app_grants WHERE id = ?1 RETURNING user_id")
    .bind(id)
    .first<{ user_id: string | null }>();
  if (!row) throw new OpError("Grant not found.");
  await audit(db, "APP_GRANT_REMOVED", { userId: row.user_id, detail: by(a, { grant: id }) });
}

export async function seedAppGrants(
  db: D1Database,
  appId: string,
  groupNames: string[],
  a: Actor,
): Promise<void> {
  if (!groupNames.length) {
    await addGrant(db, { appId, everyone: true }, a);
    return;
  }
  const { results } = await db
    .prepare("SELECT id, name FROM groups")
    .all<{ id: string; name: string }>();
  for (const g of results.filter((x) => groupNames.includes(x.name)))
    await addGrant(db, { appId, groupId: g.id }, a);
}

export async function setFavorite(
  db: D1Database,
  userId: string,
  appId: string,
  on: boolean,
): Promise<void> {
  const stmt = on
    ? db
        .prepare(
          "INSERT OR IGNORE INTO app_favorites (user_id, app_id, created_at) VALUES (?1, ?2, ?3)",
        )
        .bind(userId, appId, nowSec())
    : db
        .prepare("DELETE FROM app_favorites WHERE user_id = ?1 AND app_id = ?2")
        .bind(userId, appId);
  await stmt.run();
}

export async function appByRef(db: D1Database, ref: string): Promise<App> {
  const byId = await getApp(db, ref);
  if (byId) return byId;
  const key = ref.trim().toLowerCase();
  const app = (await listApps(db)).find((a) => a.slug === key || a.name.toLowerCase() === key);
  if (!app) throw new OpError(`App not found: ${ref}`);
  return app;
}
