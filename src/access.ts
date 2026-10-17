import { listApps, listClients } from "./db";
import type { App } from "./db";

export interface Grant {
  id: string;
  app_id: string | null;
  app_group_id: string | null;
  user_id: string | null;
  group_id: string | null;
  everyone: number;
  role: string | null;
  created_at: number;
}

export interface Subject {
  userId: string;
  groupIds: string[];
}

export interface AppGroup {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  created_at: number;
}

export const DEFAULT_ROLES = ["admin", "writer", "reader"];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const ROLE_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function matchesSubject(g: Grant, s: Subject): boolean {
  if (g.everyone === 1) return true;
  if (g.user_id !== null) return g.user_id === s.userId;
  return g.group_id !== null && s.groupIds.includes(g.group_id);
}

function coversApp(g: Grant, app: Pick<App, "id" | "app_group_id">): boolean {
  if (g.app_id !== null) return g.app_id === app.id;
  return g.app_group_id !== null && g.app_group_id === app.app_group_id;
}

export function resolveAccess(
  apps: Pick<App, "id" | "app_group_id">[],
  grants: Grant[],
  subject: Subject,
): Map<string, string[]> {
  const mine = grants.filter((g) => matchesSubject(g, subject));
  const out = new Map<string, string[]>();
  for (const app of apps) {
    const hits = mine.filter((g) => coversApp(g, app));
    if (!hits.length) continue;
    const roles = new Set(hits.flatMap((g) => (g.role ? [g.role] : [])));
    out.set(app.id, [...roles].sort());
  }
  return out;
}

export function accessClaims(
  apps: Pick<App, "id" | "slug">[],
  access: Map<string, string[]>,
): { apps: string[]; roles: string[] } {
  const slugs = new Set<string>();
  const roles = new Set<string>();
  for (const app of apps) {
    const granted = access.get(app.id);
    if (!granted || !app.slug) continue;
    slugs.add(app.slug);
    for (const r of granted) roles.add(`${app.slug}:${r}`);
  }
  return { apps: [...slugs].sort(), roles: [...roles].sort() };
}

export async function listGrants(db: D1Database): Promise<Grant[]> {
  const { results } = await db
    .prepare("SELECT * FROM app_grants ORDER BY created_at ASC")
    .all<Grant>();
  return results;
}

export async function listAppGroups(db: D1Database): Promise<AppGroup[]> {
  const { results } = await db
    .prepare("SELECT * FROM app_groups ORDER BY sort_order ASC, name COLLATE NOCASE ASC")
    .all<AppGroup>();
  return results;
}

async function groupIdsOf(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT group_id FROM group_members WHERE user_id = ?1")
    .bind(userId)
    .all<{ group_id: string }>();
  return results.map((r) => r.group_id);
}

export async function userAccess(
  db: D1Database,
  userId: string,
): Promise<{ apps: App[]; access: Map<string, string[]> }> {
  const [apps, grants, groupIds] = await Promise.all([
    listApps(db),
    listGrants(db),
    groupIdsOf(db, userId),
  ]);
  return { apps, access: resolveAccess(apps, grants, { userId, groupIds }) };
}

export async function userAccessClaims(
  db: D1Database,
  userId: string,
): Promise<{ apps: string[]; roles: string[] }> {
  const { apps, access } = await userAccess(db, userId);
  return accessClaims(apps, access);
}

export async function appsForUser(
  db: D1Database,
  userId: string,
  userGroups: string[],
): Promise<App[]> {
  const [{ apps, access }, clients] = await Promise.all([userAccess(db, userId), listClients(db)]);
  const byId = new Map(clients.map((c) => [c.id, c]));
  return apps.filter((a) => {
    if (!a.client_id) return access.has(a.id);
    const groups = byId.get(a.client_id)?.allowed_groups ?? null;
    return !groups?.length || groups.some((g) => userGroups.includes(g));
  });
}
