import { Hono } from "hono";
import { readBodyLimited } from "./http-body";
import type { Env } from "./config";
import { audit, getClient, getSetting, rowToClient } from "./db";
import type { OidcClient } from "./db";
import { nowSec, randomToken, sha256Hex } from "./util";

/**
 * Where OAuth clients come from, beyond the admin UI:
 *
 * 1. Dynamic Client Registration (RFC 7591) at POST /register — what Claude
 *    Code, Cursor and most MCP clients use today.
 * 2. Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-
 *    document) — the client_id IS an https URL serving the client's metadata.
 *    claude.ai and newer MCP clients prefer this: no registration round trip,
 *    and the client's identity is anchored to a domain the user can see.
 *
 * Threat notes:
 * - Dynamic clients are third-party by definition: they always get the
 *   consent screen (skip_consent = 0), are public (PKCE, no secret) unless
 *   they ask for a secret, and only admins can authorize them (enforced in
 *   oidc.ts) until an admin assigns groups.
 * - CIMD fetches are SSRF-shaped: https only, no credentials, no redirects,
 *   hard size + time limits, hostname must not be an IP literal or
 *   localhost, and the document's client_id must equal the URL exactly.
 *   (Workers' fetch can't reach private networks, which covers DNS names
 *   that resolve to RFC 1918 space.) Unsupported extra grant types in the
 *   document (claude.ai lists jwt-bearer) are ignored, not rejected.
 * - Redirect URIs: https, http loopback (any port, RFC 8252 §7.3), or a
 *   private-use scheme for native apps (cursor://, vscode://). Dangerous
 *   schemes are rejected outright.
 */

const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 5000;
const CIMD_DEFAULT_TTL = 24 * 3600;
const CIMD_MIN_TTL = 300;
const MAX_REDIRECTS = 10;

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hostOf(u: string): string {
  try {
    return new URL(u).host || u;
  } catch {
    return u;
  }
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Is this an acceptable redirect URI for a dynamic/CIMD client? */
export function validRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return isLoopbackHost(u.hostname);
  return !BLOCKED_SCHEMES.has(u.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(u.protocol);
}

/**
 * Exact-match a requested redirect_uri against the registered list, with
 * the one RFC 8252 exception: loopback http URIs match on any port, because
 * native apps bind an ephemeral port per sign-in.
 */
export function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  if (req.protocol !== "http:" || !isLoopbackHost(req.hostname)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return (
        reg.protocol === "http:" &&
        reg.hostname === req.hostname &&
        reg.pathname === req.pathname &&
        reg.search === req.search
      );
    } catch {
      return false;
    }
  });
}

/** A client_id that looks like a CIMD URL. */
export function isCimdClientId(id: string): boolean {
  if (!id.startsWith("https://")) return false;
  try {
    const u = new URL(id);
    // draft-ietf-oauth-client-id-metadata-document-02 §3: path required, no
    // userinfo/fragment/dot segments; compared as a plain string.
    return (
      u.toString() === id &&
      u.pathname.length > 1 &&
      !u.hash &&
      !u.search &&
      !u.username &&
      !u.password &&
      !/\/\.\.?(\/|$)/.test(id.slice(8))
    );
  } catch {
    return false;
  }
}

function cimdHostAllowed(host: string): boolean {
  if (isLoopbackHost(host)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (host.startsWith("[")) return false; // IPv6 literal
  if (!host.includes(".")) return false; // single-label / intranet
  return true;
}

function strField(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

function httpsUrlField(v: unknown): string | null {
  const s = strField(v, 500);
  if (!s) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

function cacheTtl(res: Response): number {
  const cc = res.headers.get("cache-control") ?? "";
  const m = /max-age=(\d+)/.exec(cc);
  const ttl = m?.[1] ? parseInt(m[1], 10) : CIMD_DEFAULT_TTL;
  return Math.min(Math.max(ttl, CIMD_MIN_TTL), 7 * 86400);
}

/** Fetch + validate a Client ID Metadata Document. Throws a short reason. */
async function fetchCimd(clientId: string): Promise<{
  name: string;
  redirectUris: string[];
  clientUri: string | null;
  logoUri: string | null;
  ttl: number;
}> {
  const url = new URL(clientId);
  if (!cimdHostAllowed(url.hostname)) throw new Error("client_id host not allowed");
  const res = await fetch(clientId, {
    headers: { accept: "application/json", "user-agent": "edge-idp (+cimd)" },
    redirect: "manual",
    signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
  });
  if (res.status !== 200) throw new Error(`metadata fetch returned ${res.status}`);
  const buf = await readBodyLimited(res, CIMD_MAX_BYTES);
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new Error("metadata document is not JSON");
  }
  if (!isRecord(doc)) throw new Error("metadata document is not an object");
  const d = doc;
  if (d.client_id !== clientId) throw new Error("metadata client_id does not match URL");
  if ("client_secret" in d || "client_secret_expires_at" in d) {
    throw new Error("metadata must not contain a client secret");
  }
  // CIMD clients authenticate with nothing (public) or private_key_jwt; we
  // don't support the latter, and a shared secret is meaningless here.
  const method = d.token_endpoint_auth_method ?? "none";
  if (method !== "none") throw new Error(`unsupported token_endpoint_auth_method: ${JSON.stringify(method)}`);
  const uris = Array.isArray(d.redirect_uris)
    ? d.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (!uris.length || uris.length > MAX_REDIRECTS || !uris.every(validRedirectUri)) {
    throw new Error("metadata redirect_uris missing or invalid");
  }
  return {
    name: strField(d.client_name, 100) ?? url.hostname,
    redirectUris: uris,
    clientUri: httpsUrlField(d.client_uri),
    logoUri: httpsUrlField(d.logo_uri),
    ttl: cacheTtl(res),
  };
}

/**
 * Resolve a client_id to a client: a stored row, or a CIMD URL fetched (and
 * cached as a row) on demand. Returns an error string for display when a
 * CIMD document can't be used.
 */
export async function resolveClient(
  db: D1Database,
  clientId: string,
): Promise<{ client: OidcClient } | { error: string } | null> {
  if (!clientId) return null;
  const stored = await getClient(db, clientId);
  const fresh = stored && (stored.source !== "cimd" || (stored.metadata_expires_at ?? 0) > nowSec());
  if (stored && fresh) return { client: stored };
  if (!isCimdClientId(clientId)) return stored ? { client: stored } : null;
  if ((await getSetting(db, "cimd_enabled", "1")) !== "1") {
    return { error: "This server doesn't accept URL-based client IDs." };
  }
  let meta;
  try {
    meta = await fetchCimd(clientId);
  } catch (e) {
    // A short outage may use cached metadata, but a dead publisher cannot
    // retain redirects and display names indefinitely.
    if (stored && (stored.metadata_expires_at ?? 0) + 86400 > nowSec()) return { client: stored };
    return { error: `Couldn't load the client's metadata: ${e instanceof Error ? e.message : "unknown error"}.` };
  }
  const now = nowSec();
  const row = await db
    .prepare(
      `INSERT INTO oidc_clients
         (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups, require_pkce,
          environment, created_at, created_by, client_type, source, client_uri, logo_uri,
          skip_consent, metadata_expires_at)
       VALUES (?1, ?2, ?3, '', '', NULL, 1, 'production', ?4, NULL, 'public', 'cimd', ?5, ?6, 0, ?7)
       ON CONFLICT(id) DO UPDATE SET name = ?2, redirect_uris = ?3, client_uri = ?5,
         logo_uri = ?6, metadata_expires_at = ?7
       RETURNING *`,
    )
    .bind(clientId, meta.name, JSON.stringify(meta.redirectUris), now, meta.clientUri, meta.logoUri, now + meta.ttl)
    .first();
  if (!row) return { error: "Couldn't store the client." };
  if (!stored) await audit(db, "CLIENT_DISCOVERED", { clientId, detail: { name: meta.name, via: "cimd" } });
  return { client: rowToClient(row) };
}

/** RFC 7591 Dynamic Client Registration. */
export const registration = new Hono<{ Bindings: Env }>();

registration.post("/register", async (c) => {
  const fail = (error: string, description: string) =>
    c.json({ error, error_description: description }, 400);
  if ((await getSetting(c.env.DB, "dcr_enabled", "1")) !== "1") {
    return c.json({ error: "access_denied", error_description: "Dynamic registration is disabled." }, 403);
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await readBodyLimited(c.req.raw, 16 * 1024)));
    if (!isRecord(parsed)) throw new Error("not an object");
    body = parsed;
  } catch {
    return fail("invalid_client_metadata", "Body must be a JSON object.");
  }
  const uris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (!uris.length || uris.length > MAX_REDIRECTS) {
    return fail("invalid_redirect_uri", "Provide 1–10 redirect_uris.");
  }
  const bad = uris.find((u) => !validRedirectUri(u));
  if (bad) return fail("invalid_redirect_uri", `Redirect URI not allowed: ${bad}`);
  const method = typeof body.token_endpoint_auth_method === "string" ? body.token_endpoint_auth_method : "none";
  if (!["none", "client_secret_basic", "client_secret_post"].includes(method)) {
    return fail("invalid_client_metadata", `Unsupported token_endpoint_auth_method: ${method}`);
  }
  const grants = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return fail("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
  }
  const name = strField(body.client_name, 100) ?? "Unnamed client";
  const isPublic = method === "none";
  const id = randomToken(18);
  const secret = isPublic ? null : randomToken(32);
  const now = nowSec();
  await c.env.DB.prepare(
    `INSERT INTO oidc_clients
       (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups, require_pkce,
        environment, created_at, created_by, client_type, source, client_uri, logo_uri, skip_consent)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, 1, 'production', ?6, NULL, ?7, 'dcr', ?8, ?9, 0)`,
  )
    .bind(
      id,
      name,
      JSON.stringify([...new Set(uris)]),
      secret ? await sha256Hex(secret) : "",
      secret ? secret.slice(0, 6) : "",
      now,
      isPublic ? "public" : "confidential",
      httpsUrlField(body.client_uri),
      httpsUrlField(body.logo_uri),
    )
    .run();
  await audit(c.env.DB, "CLIENT_REGISTERED", {
    clientId: id,
    detail: { name, via: "dcr", redirect_hosts: uris.map(hostOf) },
  });
  return c.json(
    {
      client_id: id,
      client_id_issued_at: now,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: [...new Set(uris)],
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
    { "cache-control": "no-store" },
  );
});
