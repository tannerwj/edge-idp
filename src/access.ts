import { getUser, listApps } from "./db";
import type { App, User } from "./db";

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
  isPublic: boolean;
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
  if (g.everyone === 1) return !s.isPublic;
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

export function appSlugs(
  apps: Pick<App, "id" | "slug">[],
  access: Map<string, string[]>,
): string[] {
  return [...new Set(apps.flatMap((a) => (a.slug && access.has(a.id) ? [a.slug] : [])))].sort();
}

export function claimsForClient(
  apps: Pick<App, "id" | "slug" | "client_id">[],
  access: Map<string, string[]>,
  clientId: string,
): { apps?: string[]; roles?: string[] } {
  const linked = apps.filter((a) => a.client_id === clientId);
  if (!linked.length) return { apps: appSlugs(apps, access) };
  return { roles: [...new Set(linked.flatMap((a) => access.get(a.id) ?? []))].sort() };
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

export interface UserContext {
  user: User;
  groups: string[];
  apps: App[];
  grants: Grant[];
  subject: Subject;
  access: Map<string, string[]>;
}

export async function loadUserContext(db: D1Database, userId: string): Promise<UserContext | null> {
  const [user, { results: memberships }, apps, grants] = await Promise.all([
    getUser(db, userId),
    db
      .prepare(
        `SELECT g.id AS id, g.name AS name FROM groups g
         JOIN group_members m ON m.group_id = g.id
         WHERE m.user_id = ?1 ORDER BY g.name ASC`,
      )
      .bind(userId)
      .all<{ id: string; name: string }>(),
    listApps(db),
    listGrants(db),
  ]);
  if (!user) return null;
  const subject = { userId, groupIds: memberships.map((m) => m.id), isPublic: user.public === 1 };
  return {
    user,
    groups: memberships.map((m) => m.name),
    apps,
    grants,
    subject,
    access: resolveAccess(apps, grants, subject),
  };
}

export async function appsForUser(db: D1Database, userId: string): Promise<App[]> {
  const ctx = await loadUserContext(db, userId);
  return ctx ? ctx.apps.filter((a) => ctx.access.has(a.id)) : [];
}
