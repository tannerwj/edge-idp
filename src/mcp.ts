/**
 * MCP (Model Context Protocol) server for edge-idp administration.
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
  getUser,
  getUserByEmail,
  listClients,
  listUsers,
  setSetting,
} from "./db";
import { getTheme, invalidateThemeCache } from "./theme-cache";
import { verifyAccessToken } from "./crypto";
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

/**
 * Validate a Bearer credential for MCP. Accepts either:
 * 1. An API token (SHA-256 hash lookup in api_tokens), or
 * 2. An IdP-issued JWT access token (RS256, verified via JWKS) for an admin user.
 *
 * Returns {tokenId, adminId, tokenHash} or null. For JWTs, tokenId is "oauth"
 * and tokenHash is the JWT's jti or a hash of the token (for sandbox binding).
 */
async function authToken(
  db: D1Database,
  env: Env,
  req: Request,
): Promise<{ tokenId: string; adminId: string; tokenHash: string } | null> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const raw = header.slice(7);

  // Try API token first (existing behavior).
  const hash = await sha256Hex(raw);
  const row = await db
    .prepare("SELECT id, created_by FROM api_tokens WHERE token_hash = ?1")
    .bind(hash)
    .first<{ id: string; created_by: string }>();
  if (row) {
    await db.prepare("UPDATE api_tokens SET last_used_at = ?1 WHERE id = ?2")
      .bind(nowSec(), row.id)
      .run();
    return { tokenId: row.id, adminId: row.created_by, tokenHash: hash };
  }

  // Try IdP-issued JWT access token (OAuth for MCP).
  try {
    const payload = await verifyAccessToken(env, raw);
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (!sub) return null;
    const user = await getUser(db, sub);
    if (!user || !user.is_admin || user.disabled) return null;
    // For sandbox binding, hash the JWT (it never sees the raw token).
    const jwtHash = await sha256Hex(raw);
    return { tokenId: "oauth", adminId: user.id, tokenHash: jwtHash };
  } catch {
    return null;
  }
}

/** Record an MCP tool call for metrics. Fire-and-forget. */
function trackCall(
  db: D1Database,
  tool: string,
  startedAt: number,
  success: boolean,
  error: string | null,
  tokenId: string,
): void {
  const duration = Date.now() - startedAt;
  db.prepare(
    "INSERT INTO mcp_calls (tool_name, started_at, duration_ms, success, error, token_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(tool, Math.floor(startedAt / 1000), duration, success ? 1 : 0, error, tokenId)
    .run()
    .catch(() => {});
  // Keep the table bounded.
  db.prepare(
    "DELETE FROM mcp_calls WHERE id NOT IN (SELECT id FROM mcp_calls ORDER BY id DESC LIMIT 10000)",
  )
    .run()
    .catch(() => {});
}

mcp.post("/", async (c) => {
  const auth = await authToken(c.env.DB, c.env, c.req.raw);
  if (!auth) {
    // RFC 9728: tell the client where to discover the authorization server.
    const resourceMetadata = `${c.env.ISSUER}/.well-known/oauth-protected-resource/mcp`;
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: Bearer API token or IdP access token required." } },
      401,
      {
        "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
      },
    );
  }
  const { tokenId, adminId, tokenHash } = auth;
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
      serverInfo: { name: "edge-idp", version: "1.0.0" },
      instructions:
        "edge-idp admin MCP. Prefer the `execute` tool: write a single JS snippet " +
        "against the typed `id` proxy (see its description for all tool signatures), " +
        "chain calls and filter in code — only your return value comes back. " +
        "Use individual tools directly only for single calls or debugging. " +
        "`metrics_summary` shows 24h usage analytics.",
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
    // Code mode: `execute` runs through the sandbox, not the plain handler.
    if (name === "execute") {
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const result = await runExecute(
        c.env,
        c.executionCtx as unknown as { exports?: Record<string, unknown>; waitUntil(p: Promise<unknown>): void },
        c.env.DB,
        String(args.code ?? ""),
        auth,
      );
      return ok(result);
    }
    const started = Date.now();
    try {
      const result = await tool.handler(
        c.env.DB,
        (params.arguments as Record<string, unknown>) ?? {},
        adminId,
      );
      trackCall(c.env.DB, name, started, true, null, tokenId);
      return ok({
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      const msg = (e as Error).message;
      trackCall(c.env.DB, name, started, false, msg.slice(0, 200), tokenId);
      return ok({
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      });
    }
  }
  return err(-32601, `Method not found: ${body.method}`);
});

/* ------------------------------------------------------------------ */
/* Code mode: run model-written JS in an isolated Dynamic Worker.      */
/*                                                                     */
/* The `execute` tool takes a JS snippet that calls the IdP tools via  */
/* the `id` proxy. Intermediate results never re-enter model context — */
/* only the final return value comes back. The sandbox has no network  */
/* (globalOutbound: null), no env vars, and never sees the API token.  */
/* Every side effect runs through the existing permission-checked tool  */
/* handlers with the caller's own credential.                          */
/* ------------------------------------------------------------------ */

import { WorkerEntrypoint } from "cloudflare:workers";

/** RPC stub the sandbox calls to invoke tools host-side. */
export class IdCodeSandbox extends WorkerEntrypoint<Env> {
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const name = String(toolName);
    // No recursion: execute can't call itself.
    if (name === "execute") {
      throw new Error("execute is not available inside execute");
    }
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    // The credential lives in ctx.props, invisible across the RPC boundary.
    // For API tokens it's the hash (looked up); for OAuth it's the adminId directly.
    const props = this.ctx.props as { tokenHash?: string; adminId?: string } | undefined;
    let adminId: string | null = null;
    if (props?.adminId) {
      // OAuth: adminId was validated host-side before isolate spin-up.
      adminId = props.adminId;
    } else if (props?.tokenHash) {
      // API token: re-derive adminId from the hash.
      const row = await this.env.DB.prepare(
        "SELECT created_by FROM api_tokens WHERE token_hash = ?1",
      )
        .bind(props.tokenHash)
        .first<{ created_by: string }>();
      if (row) adminId = row.created_by;
    }
    if (!adminId) throw new Error("credential rejected");
    return await tool.handler(this.env.DB, args ?? {}, adminId);
  }
}

// Runs INSIDE the sandbox isolate. Plain string (no backticks/${} inside).
const ID_SANDBOX_BOOTSTRAP = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { run } from "./user-code.js";
export class Agent extends WorkerEntrypoint {
  async run() {
    const ID = this.env.ID;
    const logs = [];
    const toolCalls = [];
    const fmt = (a) => {
      if (typeof a === "string") return a;
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    };
    const capture = {
      log(...a) { logs.push(a.map(fmt).join(" ")); },
      info(...a) { logs.push(a.map(fmt).join(" ")); },
      warn(...a) { logs.push("WARN: " + a.map(fmt).join(" ")); },
      error(...a) { logs.push("ERROR: " + a.map(fmt).join(" ")); },
    };
    const id = new Proxy({}, {
      get(t, name) {
        if (name === "then") return undefined;
        const tool = String(name);
        return async (args) => {
          const t0 = Date.now();
          try {
            const r = await ID.callTool(tool, args || {});
            toolCalls.push({ tool, ms: Date.now() - t0 });
            return r;
          } catch (e) {
            toolCalls.push({ tool, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 500) });
            throw e;
          }
        };
      },
    });
    let outcome;
    try {
      const value = await run(id, capture);
      let out = null;
      try { out = value === undefined ? null : JSON.parse(JSON.stringify(value)); }
      catch (e) { out = String(value); }
      outcome = { ok: true, value: out, logs, toolCalls };
    } catch (e) {
      outcome = { ok: false, error: String((e && e.message) || e).slice(0, 2000), logs, toolCalls };
    }
    return outcome;
  }
}
`;

/** Minimal JSON-schema → TypeScript declaration renderer for tool docs. */
function schemaToTs(schema: Record<string, unknown>, indent = ""): string {
  const t = schema.type as string;
  if (t === "string") {
    const en = schema.enum as string[] | undefined;
    if (en) return en.map((e) => JSON.stringify(e)).join(" | ");
    return "string";
  }
  if (t === "number" || t === "integer") return "number";
  if (t === "boolean") return "boolean";
  if (t === "array") {
    const items = schema.items as Record<string, unknown> | undefined;
    return `(${items ? schemaToTs(items, indent) : "unknown"})[]`;
  }
  if (t === "object" || schema.properties) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const lines = Object.entries(props).map(([k, v]) => {
      const opt = required.has(k) ? "" : "?";
      const desc = typeof v.description === "string" ? ` /** ${v.description} */` : "";
      return `${indent}  ${k}${opt}: ${schemaToTs(v, indent + " ")};${desc}`;
    });
    return `{\n${lines.join("\n")}\n${indent}}`;
  }
  return "unknown";
}

/** Generate typed TS declarations for every tool (for the `execute` docs). */
function toolDeclarations(): string {
  return TOOLS.filter((t) => t.name !== "execute")
    .map((t) => {
      const args = schemaToTs(t.inputSchema as Record<string, unknown>);
      return `/** ${t.description} */\n${t.name}(args: ${args}): Promise<any>;`;
    })
    .join("\n\n");
}

const EXECUTE_TOOL: ToolDef = {
  name: "execute",
  description:
    "Run JavaScript in an isolated sandbox with a typed `id` proxy for all IdP tools. " +
    "Write a single async snippet: `id.users_list({})`, `id.groups_create({name})`, etc. " +
    "Chain calls, filter in code — only your return value comes back to context. " +
    "No network, no env access. Max 200KB code, 25s wall time.\n\n" +
    "Available tools:\n```ts\n" + toolDeclarations() + "\n```",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "JS snippet: statements using `id` and `console`. The last expression's value is returned.",
      },
    },
    required: ["code"],
  },
  handler: async (db, args, adminId) => {
    // This handler is never called directly — execute is intercepted in the
    // POST handler where we have access to env.LOADER and ctx.exports.
    throw new Error("execute must go through the sandbox runner");
  },
};

// Register execute in the catalog (after TOOLS is defined).
TOOLS.push(EXECUTE_TOOL);

/** metrics_summary: per-tool calls, latency p50/p95, errors, execute composition. */
const METRICS_TOOL: ToolDef = {
  name: "metrics_summary",
  description:
    "MCP usage analytics for the last 24h: per-tool call counts, latency " +
    "(avg/p50/p95/max), error counts with top error messages, and execute " +
    "composition (avg inner tool calls per run, most-chained tools). " +
    "Use this to find slow tools, error-prone tools, and discoverability gaps.",
  inputSchema: { type: "object", properties: {} },
  handler: async (db) => {
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    const perTool = await db
      .prepare(
        `SELECT tool_name, COUNT(*) AS calls, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors,
                AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms
         FROM mcp_calls WHERE started_at >= ?1 AND tool_name != 'execute'
         GROUP BY tool_name ORDER BY calls DESC`,
      )
      .bind(dayAgo)
      .all<{ tool_name: string; calls: number; errors: number; avg_ms: number; max_ms: number }>();
    // p50/p95 need ordered values; fetch durations per tool (bounded).
    const withPercentiles = await Promise.all(
      perTool.results.map(async (r) => {
        const durs = await db
          .prepare(
            `SELECT duration_ms FROM mcp_calls
             WHERE started_at >= ?1 AND tool_name = ?2 ORDER BY duration_ms ASC LIMIT 1000`,
          )
          .bind(dayAgo, r.tool_name)
          .all<{ duration_ms: number }>();
        const vals = durs.results.map((d) => d.duration_ms).sort((a, b) => a - b);
        const pct = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 0);
        const topErrors = await db
          .prepare(
            `SELECT error, COUNT(*) AS n FROM mcp_calls
             WHERE started_at >= ?1 AND tool_name = ?2 AND success = 0 AND error IS NOT NULL
             GROUP BY error ORDER BY n DESC LIMIT 3`,
          )
          .bind(dayAgo, r.tool_name)
          .all<{ error: string; n: number }>();
        return {
          tool: r.tool_name,
          calls: r.calls,
          errors: r.errors,
          latency_ms: {
            avg: Math.round(r.avg_ms),
            p50: pct(0.5),
            p95: pct(0.95),
            max: r.max_ms,
          },
          top_errors: topErrors.results,
        };
      }),
    );
    // Execute composition: how many inner calls per execute run.
    const execStats = await db
      .prepare(
        `SELECT COUNT(*) AS runs FROM mcp_calls
         WHERE started_at >= ?1 AND tool_name = 'execute' AND success = 1`,
      )
      .bind(dayAgo)
      .first<{ runs: number }>();
    const innerCalls = await db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM mcp_calls
         WHERE started_at >= ?1 AND tool_name != 'execute'
         GROUP BY tool_name ORDER BY n DESC LIMIT 5`,
      )
      .bind(dayAgo)
      .all<{ tool_name: string; n: number }>();
    return {
      window: "last 24h",
      per_tool: withPercentiles,
      execute_runs: execStats?.runs ?? 0,
      most_chained_tools: innerCalls.results,
    };
  },
};
TOOLS.push(METRICS_TOOL);

/** Run the execute tool: validate, sandbox, return {value, logs, toolCalls}. */
async function runExecute(
  env: Env,
  ctx: { exports?: Record<string, unknown>; waitUntil(p: Promise<unknown>): void },
  db: D1Database,
  code: string,
  auth: { tokenId: string; adminId: string; tokenHash: string },
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const { tokenId, adminId, tokenHash } = auth;
  const started = Date.now();
  const fail = (text: string) => {
    trackCall(db, "execute", started, false, text.slice(0, 200), tokenId);
    return { content: [{ type: "text", text }], isError: true };
  };
  if (!code || typeof code !== "string" || !code.trim()) {
    return fail("Error: code is required and must be a non-empty string.");
  }
  if (code.length > 200000) {
    return fail("Error: code exceeds 200KB.");
  }
  if (!env.LOADER) {
    return fail("Error: the code-execution sandbox is not configured on this worker.");
  }
  const sandboxExport = ctx.exports?.IdCodeSandbox as
    | ((opts: { props: { tokenHash?: string; adminId?: string } }) => unknown)
    | undefined;
  if (!sandboxExport) {
    return fail("Error: sandbox entrypoint unavailable.");
  }
  let worker: { getEntrypoint(name: string, opts: unknown): { run(): Promise<unknown> } };
  try {
    // For OAuth (tokenId "oauth"), pass adminId directly; for API tokens, pass the hash.
    const props = tokenId === "oauth" ? { adminId } : { tokenHash };
    const idStub = sandboxExport({ props });
    worker = (env.LOADER as unknown as {
      load(opts: Record<string, unknown>): {
        getEntrypoint(name: string, opts: unknown): { run(): Promise<unknown> };
      };
    }).load({
      compatibilityDate: "2026-10-06",
      mainModule: "bootstrap.js",
      modules: {
        "bootstrap.js": ID_SANDBOX_BOOTSTRAP,
        "user-code.js": `export async function run(id, console) {\n${code}\n}`,
      },
      env: { ID: idStub },
      globalOutbound: null,
    });
  } catch (e) {
    return fail("Error: failed to start sandbox: " + String((e as Error)?.message ?? e).slice(0, 300));
  }
  let result: unknown;
  try {
    const entry = worker.getEntrypoint("Agent", { limits: { cpuMs: 20000, subRequests: 500 } });
    result = await Promise.race([
      entry.run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("execution timed out after 25s")), 25000),
      ),
    ]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    return fail("Error: " + msg.slice(0, 500));
  }
  const r = result as { ok: boolean; value?: unknown; error?: string; logs: string[]; toolCalls: { tool: string; ms: number; error?: string }[] };
  // Track inner tool usage for metrics.
  for (const tc of r.toolCalls ?? []) {
    trackCall(db, tc.tool, started, !tc.error, tc.error ?? null, tokenId);
  }
  trackCall(db, "execute", started, r.ok, r.ok ? null : (r.error ?? "sandbox error").slice(0, 200), tokenId);
  if (r.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ value: r.value, logs: r.logs, toolCalls: r.toolCalls }, null, 2),
        },
      ],
    };
  }
  return { content: [{ type: "text", text: `Error: ${r.error}` }], isError: true };
}
