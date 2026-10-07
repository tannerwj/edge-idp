/**
 * MCP (Model Context Protocol) server for Johnson ID administration.
 *
 * Exposes user, group, client, and theme management as MCP tools over
 * Streamable HTTP at POST /mcp. Auth is via Bearer admin API token
 * (created in Admin → API Tokens, stored as SHA-256 hash).
 *
 * This is a minimal JSON-RPC implementation covering initialize, tools/list,
 * and tools/call. It speaks the MCP protocol without the SDK dependency.
 */
import { Hono } from "hono";
import type { Env } from "./config";
import {
  audit,
  getSetting,
  getUserByEmail,
  listClients,
  listUsers,
  setSetting,
} from "./db";
import { getTheme, invalidateThemeCache } from "./theme-cache";
import { newId, nowSec, randomToken, sha256Hex } from "./util";

export const mcp = new Hono<{ Bindings: Env }>();

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (db: D1Database, args: Record<string, unknown>, adminId: string) => Promise<unknown>;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const TOOLS: ToolDef[] = [
  {
    name: "users_list",
    description: "List all users with their admin/disabled status and group memberships.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (db) => {
      const users = await listUsers(db);
      const withGroups = await Promise.all(
        users.map(async (u) => {
          const { results } = await db
            .prepare(
              `SELECT g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?1`,
            )
            .bind(u.id)
            .all<{ name: string }>();
          return {
            id: u.id,
            name: u.name,
            email: u.email,
            is_admin: !!u.is_admin,
            disabled: !!u.disabled,
            groups: results.map((r) => r.name),
          };
        }),
      );
      return withGroups;
    },
  },
  {
    name: "users_create",
    description: "Create a new user and return a one-time enrollment link (valid 7 days).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Display name" },
        email: { type: "string", description: "Email address (must be unique)" },
      },
      required: ["name", "email"],
    },
    handler: async (db, args, adminId) => {
      const name = str(args.name).trim().slice(0, 120);
      const email = str(args.email).trim().slice(0, 254);
      if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new Error("Name and a valid email are required.");
      }
      if (await getUserByEmail(db, email)) throw new Error("Email already in use.");
      const id = newId();
      const now = nowSec();
      await db
        .prepare("INSERT INTO users (id, created_at, name, email, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(id, now, name, email, now)
        .run();
      await audit(db, "USER_CREATED", { userId: id, detail: { by: adminId, via: "mcp" } });
      // Mint enrollment link
      const token = randomToken(32);
      await db
        .prepare(
          `INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(await sha256Hex(token), id, now, now + 7 * 86400)
        .run();
      // ISSUER isn't available here; return the token path and let the caller prefix.
      return { id, name, email, enrollment_token: token };
    },
  },
  {
    name: "users_update",
    description: "Update a user's name and/or email.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
      },
      required: ["user_id"],
    },
    handler: async (db, args, adminId) => {
      const id = str(args.user_id);
      const user = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first();
      if (!user) throw new Error("User not found.");
      const updates: string[] = [];
      const binds: unknown[] = [];
      if (args.name !== undefined) {
        const name = str(args.name).trim().slice(0, 120);
        if (!name) throw new Error("Name cannot be empty.");
        updates.push("name = ?" + (binds.length + 1));
        binds.push(name);
      }
      if (args.email !== undefined) {
        const email = str(args.email).trim().slice(0, 254);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Invalid email.");
        const clash = await db
          .prepare("SELECT id FROM users WHERE lower(email) = lower(?1) AND id != ?2")
          .bind(email, id)
          .first();
        if (clash) throw new Error("Email already in use.");
        updates.push("email = ?" + (binds.length + 1));
        binds.push(email);
      }
      if (!updates.length) throw new Error("Nothing to update.");
      updates.push("updated_at = ?" + (binds.length + 1));
      binds.push(nowSec(), id);
      await db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?${binds.length}`).bind(...binds).run();
      await audit(db, "USER_PROFILE_UPDATED", { userId: id, detail: { by: adminId, via: "mcp" } });
      return { ok: true };
    },
  },
  {
    name: "users_set_disabled",
    description: "Disable or enable a user account. Disabling kills their sessions.",
    inputSchema: {
      type: "object",
      properties: {
        user_id: { type: "string" },
        disabled: { type: "boolean" },
      },
      required: ["user_id", "disabled"],
    },
    handler: async (db, args, adminId) => {
      const id = str(args.user_id);
      const disabled = args.disabled === true ? 1 : 0;
      await db.prepare("UPDATE users SET disabled = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(disabled, nowSec(), id)
        .run();
      if (disabled) {
        await db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id).run();
      }
      await audit(db, disabled ? "USER_DISABLED" : "USER_ENABLED", {
        userId: id,
        detail: { by: adminId, via: "mcp" },
      });
      return { ok: true };
    },
  },
  {
    name: "groups_list",
    description: "List all groups with member counts.",
    inputSchema: { type: "object", properties: {} },
    handler: async (db) => {
      const { results } = await db
        .prepare(
          `SELECT g.id, g.name, g.description, COUNT(m.user_id) AS members
           FROM groups g LEFT JOIN group_members m ON m.group_id = g.id
           GROUP BY g.id ORDER BY g.name ASC`,
        )
        .all<{ id: string; name: string; description: string | null; members: number }>();
      return results;
    },
  },
  {
    name: "groups_create",
    description: "Create a new group.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Lowercase letters, numbers, dash, underscore" },
        description: { type: "string" },
      },
      required: ["name"],
    },
    handler: async (db, args, adminId) => {
      const name = str(args.name).trim().toLowerCase().slice(0, 60);
      if (!/^[a-z0-9_-]{1,60}$/.test(name)) {
        throw new Error("Group names: lowercase letters, numbers, dash, underscore.");
      }
      const id = newId();
      await db
        .prepare("INSERT INTO groups (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(id, name, str(args.description).slice(0, 200) || null, nowSec())
        .run();
      await audit(db, "GROUP_CREATED", { detail: { by: adminId, via: "mcp", name } });
      return { id, name };
    },
  },
  {
    name: "groups_add_member",
    description: "Add a user to a group by email.",
    inputSchema: {
      type: "object",
      properties: {
        group_name: { type: "string" },
        email: { type: "string" },
      },
      required: ["group_name", "email"],
    },
    handler: async (db, args, adminId) => {
      const g = await db.prepare("SELECT id FROM groups WHERE name = ?1").bind(str(args.group_name)).first<{ id: string }>();
      if (!g) throw new Error("Group not found.");
      const user = await getUserByEmail(db, str(args.email));
      if (!user) throw new Error("User not found.");
      await db
        .prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, created_at) VALUES (?1, ?2, ?3)")
        .bind(g.id, user.id, nowSec())
        .run();
      await audit(db, "GROUP_MEMBER_ADDED", {
        userId: user.id,
        detail: { by: adminId, via: "mcp", group: str(args.group_name) },
      });
      return { ok: true };
    },
  },
  {
    name: "clients_list",
    description: "List all registered apps (OIDC clients).",
    inputSchema: { type: "object", properties: {} },
    handler: async (db) => {
      const clients = await listClients(db);
      return clients.map((c) => ({
        id: c.id,
        name: c.name,
        redirect_uris: c.redirect_uris,
        allowed_groups: c.allowed_groups,
        require_pkce: !!c.require_pkce,
        created_at: c.created_at,
      }));
    },
  },
  {
    name: "clients_create",
    description: "Register a new app. Returns the client ID and secret (show the secret once).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        redirect_uris: { type: "array", items: { type: "string" }, description: "HTTPS redirect URIs" },
        allowed_groups: { type: "array", items: { type: "string" }, description: "Group names, empty = everyone" },
        require_pkce: { type: "boolean", description: "Default true; false for server-side clients like Cloudflare Access" },
      },
      required: ["name", "redirect_uris"],
    },
    handler: async (db, args, adminId) => {
      const name = str(args.name).trim().slice(0, 120);
      const uris = Array.isArray(args.redirect_uris) ? args.redirect_uris.filter((u) => typeof u === "string") : [];
      if (!name || !uris.length) throw new Error("Name and at least one redirect URI are required.");
      for (const u of uris) {
        try {
          if (new URL(u).protocol !== "https:") throw new Error();
        } catch {
          throw new Error(`Invalid HTTPS redirect URI: ${u}`);
        }
      }
      const groups = Array.isArray(args.allowed_groups)
        ? args.allowed_groups.filter((g) => typeof g === "string").map((g) => g.toLowerCase())
        : [];
      const id = randomToken(18);
      const secret = randomToken(32);
      const requirePkce = args.require_pkce === false ? 0 : 1;
      await db
        .prepare(
          `INSERT INTO oidc_clients (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups, require_pkce, created_at, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .bind(
          id, name, JSON.stringify([...new Set(uris)]), await sha256Hex(secret),
          secret.slice(0, 6), groups.length ? JSON.stringify(groups) : null,
          requirePkce, nowSec(), adminId,
        )
        .run();
      await audit(db, "CLIENT_CREATED", { clientId: id, detail: { by: adminId, via: "mcp", name } });
      return { id, name, secret };
    },
  },
  {
    name: "theme_get",
    description: "Get the current site-wide theme.",
    inputSchema: { type: "object", properties: {} },
    handler: async (db) => {
      // getTheme needs Env; use getSetting directly here.
      return { theme: await getSetting(db, "theme", "obsidian") };
    },
  },
  {
    name: "theme_set",
    description: "Set the site-wide theme.",
    inputSchema: {
      type: "object",
      properties: {
        theme: { type: "string", enum: ["obsidian", "porcelain", "ledger", "dusk", "manuscript", "monochrome"] },
      },
      required: ["theme"],
    },
    handler: async (db, args, adminId) => {
      const theme = str(args.theme);
      await setSetting(db, "theme", theme);
      invalidateThemeCache();
      await audit(db, "THEME_CHANGED", { userId: adminId, detail: { theme, via: "mcp" } });
      return { ok: true, theme };
    },
  },
];

/** Validate a Bearer API token; returns the admin user ID or null. */
async function authToken(db: D1Database, req: Request): Promise<string | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const raw = header.slice(7);
  const hash = await sha256Hex(raw);
  const row = await db
    .prepare("SELECT id, created_by FROM api_tokens WHERE token_hash = ?1")
    .bind(hash)
    .first<{ id: string; created_by: string }>();
  if (!row) return null;
  await db.prepare("UPDATE api_tokens SET last_used_at = ?1 WHERE id = ?2")
    .bind(nowSec(), row.id)
    .run();
  return row.created_by;
}

mcp.post("/", async (c) => {
  const adminId = await authToken(c.env.DB, c.req.raw);
  if (!adminId) {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: valid Bearer API token required." } },
      401,
    );
  }
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, 400);
  }
  const id = body.id ?? null;
  const ok = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) =>
    c.json({ jsonrpc: "2.0", id, error: { code, message } });

  if (body.method === "initialize") {
    return ok({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "johnson-id", version: "1.0.0" },
    });
  }
  if (body.method === "notifications/initialized") {
    return ok({});
  }
  if (body.method === "tools/list") {
    return ok({
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }
  if (body.method === "tools/call") {
    const params = body.params ?? {};
    const name = str(params.name);
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return err(-32602, `Unknown tool: ${name}`);
    try {
      const result = await tool.handler(
        c.env.DB,
        (params.arguments as Record<string, unknown>) ?? {},
        adminId,
      );
      return ok({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      return ok({
        content: [{ type: "text", text: `Error: ${(e as Error).message}` }],
        isError: true,
      });
    }
  }
  return err(-32601, `Method not found: ${body.method}`);
});
