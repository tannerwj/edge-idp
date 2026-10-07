import { getClient, getUser, getUserByEmail } from "../db";
import type { Env } from "../config";
import * as ops from "../ops";

export interface Actor {
  adminId: string;
  via: "mcp";
}

export interface ToolCtx {
  db: D1Database;
  env: Env;
  actor: Actor;
}

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write: boolean;
  handler: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<unknown>;
};

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

export async function userByRef(db: D1Database, args: Record<string, unknown>) {
  const ref = str(args.user_id) || str(args.email);
  const user = ref.includes("@") ? await getUserByEmail(db, ref) : await getUser(db, ref);
  if (!user) throw new ops.OpError("User not found (pass user_id or email).");
  return user;
}

export async function groupByRef(db: D1Database, ref: string) {
  const g = await db
    .prepare("SELECT id, name FROM groups WHERE id = ?1 OR name = ?2")
    .bind(ref, ref.toLowerCase())
    .first<{ id: string; name: string }>();
  if (!g) throw new ops.OpError(`Group not found: ${ref}`);
  return g;
}

export async function clientByRef(db: D1Database, id: string) {
  const c = await getClient(db, id);
  if (!c) throw new ops.OpError("Client not found.");
  return c;
}

export const USER_REF = {
  user_id: { type: "string", description: "User id" },
  email: { type: "string", description: "…or the user's email" },
};

export interface McpAuth {
  tokenId: string;
  adminId: string;
  readOnly: boolean;
}

export async function activeAdmin(db: D1Database, userId: string): Promise<boolean> {
  const u = await getUser(db, userId);
  return !!u && !!u.is_admin && !u.disabled;
}

export type WaitCtx = { waitUntil(p: Promise<unknown>): void };

export function trackCall(
  ctx: WaitCtx,
  db: D1Database,
  tool: string,
  startedAt: number,
  error: string | null,
  tokenId: string,
): void {
  ctx.waitUntil(
    db
      .prepare(
        "INSERT INTO mcp_calls (tool_name, started_at, duration_ms, success, error, token_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      )
      .bind(
        tool,
        Math.floor(startedAt / 1000),
        Date.now() - startedAt,
        error ? 0 : 1,
        error,
        tokenId.startsWith("oauth:") ? null : tokenId,
      )
      .run()
      .catch(() => {}),
  );
}
