/** Shared pieces of the domain operations (see ops.ts). */
import { validRedirectUri } from "./oauth-clients";

export class OpError extends Error {}

export interface Actor {
  adminId: string;
  via: "ui" | "mcp";
}

export const by = (a: Actor, extra: Record<string, unknown> = {}) => ({
  by: a.adminId,
  via: a.via,
  ...extra,
});

/* ───────────────────────────── input parsing ───────────────────────────── */

export function parseRedirectUris(input: string | string[]): string[] {
  const list = (Array.isArray(input) ? input : input.split(/[\r\n,]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) throw new OpError("Add at least one redirect URI.");
  const bad = list.find((u) => !validRedirectUri(u));
  if (bad)
    throw new OpError(
      `Not an allowed redirect URI: ${bad} (https, http://localhost, or an app scheme).`,
    );
  return [...new Set(list)];
}

export async function parseGroupList(db: D1Database, input: string | string[]): Promise<string[]> {
  const list = [
    ...new Set(
      (Array.isArray(input) ? input : input.split(/[\s,]+/))
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!list.length) return [];
  const { results } = await db.prepare("SELECT name FROM groups").all<{ name: string }>();
  const known = new Set(results.map((g) => g.name));
  const missing = list.filter((n) => !known.has(n));
  if (missing.length) throw new OpError(`Unknown group: ${missing.join(", ")}`);
  return list;
}
