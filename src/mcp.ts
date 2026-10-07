/**
 * MCP (Model Context Protocol) server for edge-idp administration.
 *
 * Streamable HTTP at POST /mcp, JSON responses only, stateless. Speaks both
 * protocol eras: the `initialize` handshake (2024-11-05 … 2025-11-25) that
 * every shipping client uses today, and the stateless 2026-07-28 revision
 * (header/body agreement, server/discover).
 *
 * Auth (Bearer), either:
 *  1. An API token (Admin → API tokens): `admin` or `read` scope, optional
 *     expiry, re-checked against its creator on every call (a demoted or
 *     disabled admin's tokens die with their rights).
 *  2. An OAuth access token minted by this IdP for THIS resource: aud must be
 *     `${ISSUER}/mcp` and scope must include `mcp` (full) or `mcp:read`.
 *     Tokens issued to other apps at sign-in are rejected (no passthrough).
 *
 * Read-only callers hitting a write tool get a 403 insufficient_scope
 * challenge, which MCP clients turn into a step-up re-authorization.
 */
import { Hono } from "hono";
import { VERSION } from "./assets.gen";
import type { Context } from "hono";
import type { Env } from "./config";
import { verifyAccessToken } from "./crypto";
import { mcpResource } from "./oauth-shared";
import * as ops from "./ops";
import { nowSec, sha256Hex } from "./util";
import { activeAdmin, str, trackCall } from "./mcp/common";
import type { McpAuth } from "./mcp/common";
import { TOOLS } from "./mcp/tools";
import { runExecute } from "./mcp/sandbox";

export { IdCodeSandbox } from "./mcp/sandbox";

export const mcp = new Hono<{ Bindings: Env }>();

/** API token by hash → auth, re-checking expiry and the creator's rights. */
export async function authApiToken(db: D1Database, hash: string): Promise<McpAuth | null> {
  const row = await db
    .prepare("SELECT id, created_by, scope, expires_at FROM api_tokens WHERE token_hash = ?1")
    .bind(hash)
    .first<{ id: string; created_by: string; scope: string; expires_at: number | null }>();
  if (!row) return null;
  if (row.expires_at && row.expires_at < nowSec()) return null;
  if (!(await activeAdmin(db, row.created_by))) return null;
  return { tokenId: row.id, adminId: row.created_by, readOnly: row.scope !== "admin" };
}

async function authenticate(c: Context<{ Bindings: Env }>): Promise<McpAuth | null> {
  const header = c.req.header("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const raw = header.slice(7).trim();
  if (!raw) return null;

  // API tokens are opaque; JWTs have two dots. Try the cheap path first.
  if (raw.split(".").length !== 3) {
    const auth = await authApiToken(c.env.DB, await sha256Hex(raw));
    if (auth) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare("UPDATE api_tokens SET last_used_at = ?1 WHERE id = ?2").bind(nowSec(), auth.tokenId).run().catch(() => {}),
      );
    }
    return auth;
  }
  try {
    const p = await verifyAccessToken(c.env, raw, mcpResource(c.env));
    const scopes = typeof p.scope === "string" ? p.scope.split(" ") : [];
    if (!scopes.includes("mcp") && !scopes.includes("mcp:read")) return null;
    if (typeof p.sub !== "string" || !(await activeAdmin(c.env.DB, p.sub))) return null;
    return { tokenId: `oauth:${typeof p.client_id === "string" ? p.client_id : "?"}`, adminId: p.sub, readOnly: !scopes.includes("mcp") };
  } catch {
    return null;
  }
}

/* ───────────────────────────── protocol ───────────────────────────── */

const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MODERN_VERSION = "2026-07-28";
const SERVER_INFO = { name: "edge-idp", title: "edge-idp admin", version: VERSION };
const INSTRUCTIONS =
  "Administer this identity provider: users, groups, OAuth/OIDC clients, launcher apps, audit log. " +
  "Prefer the `execute` tool: one JS snippet against the typed `id` proxy (see its description), chaining calls and " +
  "filtering in code — only the return value comes back. Use individual tools for single calls.";

type RpcId = string | number | null;
interface RpcBody {
  /** undefined for notifications. */
  id: RpcId | undefined;
  method: string;
  params: Record<string, unknown>;
}
type C = Context<{ Bindings: Env }>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function wwwAuthenticate(env: Env, extra = ""): string {
  return `Bearer resource_metadata="${env.ISSUER}/.well-known/oauth-protected-resource/mcp", scope="mcp"${extra}`;
}

function rpcError(c: C, id: RpcId, code: number, message: string, status: 200 | 400 | 403 | 404 = 200, data?: unknown) {
  return c.json({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }, status);
}

/** Parse a single JSON-RPC message (batches are refused). */
async function readBody(c: C): Promise<RpcBody | Response> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    return rpcError(c, null, -32700, "Parse error.", 400);
  }
  if (Array.isArray(parsed)) return rpcError(c, null, -32600, "Batching is not supported.", 400);
  const b = isRecord(parsed) ? parsed : {};
  const id = typeof b.id === "string" || typeof b.id === "number" || b.id === null ? b.id : undefined;
  return { id, method: typeof b.method === "string" ? b.method : "", params: isRecord(b.params) ? b.params : {} };
}

/**
 * Protocol era: the 2026-07-28 revision is stateless and requires the
 * routing headers to agree with the body. Returns whether the request is
 * modern, or an error response.
 */
function checkProtocol(c: C, body: RpcBody): boolean | Response {
  const id = body.id ?? null;
  const version = c.req.header("mcp-protocol-version");
  const modern = version === MODERN_VERSION;
  if (version && !modern && !LEGACY_VERSIONS.includes(version)) {
    return rpcError(c, id, -32022, `Unsupported protocol version ${version}`, 400, { supported: [MODERN_VERSION, ...LEGACY_VERSIONS] });
  }
  if (modern) {
    const bodyName = typeof body.params.name === "string" ? body.params.name : undefined;
    if (c.req.header("mcp-method") !== body.method || (body.method === "tools/call" && c.req.header("mcp-name") !== bodyName)) {
      return rpcError(c, id, -32020, "Mcp-Method / Mcp-Name headers must match the request body.", 400);
    }
  }
  return modern;
}

/** Results for the simple (non tools/call) methods; undefined = unknown method. */
/** `sandbox`: whether this Worker has a LOADER binding (the `execute` tool needs one). */
function simpleResult(body: RpcBody, auth: McpAuth, sandbox: boolean): unknown {
  switch (body.method) {
    case "initialize": {
      const asked = typeof body.params.protocolVersion === "string" ? body.params.protocolVersion : "";
      return {
        protocolVersion: LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case "server/discover":
      return {
        supportedVersions: [MODERN_VERSION, ...LEGACY_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.filter((t) => (t.name === "execute" ? sandbox : !auth.readOnly || !t.write)).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !t.write, destructiveHint: t.write && /delete|reset|disabled|admin|rotate/.test(t.name) },
        })),
      };
    default:
      return undefined;
  }
}

async function callTool(c: C, auth: McpAuth, id: RpcId, params: Record<string, unknown>): Promise<Response> {
  const name = str(params.name);
  const args = isRecord(params.arguments) ? params.arguments : {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return rpcError(c, id, -32602, `Unknown tool: ${name}`);
  if (tool.write && auth.readOnly) {
    // MCP step-up: clients re-authorize with the scopes we name here.
    return c.json(
      { jsonrpc: "2.0", id, error: { code: -32001, message: `${name} needs the "mcp" scope; this token is read-only.` } },
      403,
      { "WWW-Authenticate": wwwAuthenticate(c.env, ', error="insufficient_scope"') },
    );
  }
  const ok = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
  if (name === "execute") return ok(await runExecute(c.env, c.executionCtx, str(args.code), auth));
  const started = Date.now();
  try {
    const result = await tool.handler({ db: c.env.DB, env: c.env, actor: { adminId: auth.adminId, via: "mcp" } }, args);
    trackCall(c.executionCtx, c.env.DB, name, started, null, auth.tokenId);
    return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: wrapStructured(result) });
  } catch (e) {
    const msg = e instanceof ops.OpError ? e.message : `Internal error: ${e instanceof Error ? e.message : String(e)}`;
    trackCall(c.executionCtx, c.env.DB, name, started, msg.slice(0, 200), auth.tokenId);
    return ok({ content: [{ type: "text", text: `Error: ${msg}` }], isError: true });
  }
}

mcp.get("/", (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Use POST." } }, 405, { allow: "POST" }));
mcp.delete("/", (c) => c.body(null, 405, { allow: "POST" }));

mcp.post("/", async (c) => {
  // Browsers must not drive this endpoint cross-origin (DNS-rebinding /
  // drive-by): any Origin that isn't ours is refused outright.
  const origin = c.req.header("origin");
  if (origin && origin !== c.env.ISSUER) return rpcError(c, null, -32000, "Origin not allowed.", 403);
  const auth = await authenticate(c);
  if (!auth) {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: Bearer API token or OAuth access token for this resource required." } },
      401,
      { "WWW-Authenticate": wwwAuthenticate(c.env) },
    );
  }
  const body = await readBody(c);
  if (body instanceof Response) return body;
  const modern = checkProtocol(c, body);
  if (modern instanceof Response) return modern;
  // Notifications (no id) get 202 and no body.
  if (body.id === undefined && body.method.startsWith("notifications/")) return c.body(null, 202);
  const id = body.id ?? null;
  if (body.method === "tools/call") return callTool(c, auth, id, body.params);
  const result = simpleResult(body, auth, !!c.env.LOADER);
  if (result !== undefined) return c.json({ jsonrpc: "2.0", id, result });
  return rpcError(c, id, -32601, `Method not found: ${body.method}`, modern ? 404 : 200);
});

/** structuredContent must be an object. */
function wrapStructured(result: unknown): Record<string, unknown> {
  return isRecord(result) ? result : { result };
}
