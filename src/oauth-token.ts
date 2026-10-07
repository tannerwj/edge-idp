import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./config";
import { audit, getClient, getUser } from "./db";
import type { OidcClient } from "./db";
import { ACCESS_TOKEN_TTL, mintAccessToken, mintIdToken, verifyAccessToken } from "./crypto";
import type { TokenClaims } from "./crypto";
import { claimsFor, clientAccessProblem, mcpResource } from "./oauth-shared";
import { base64url, newId, nowSec, randomToken, sha256Hex, timingSafeEqualHex } from "./util";

const REFRESH_TTL = 30 * 86400;

export const tokens = new Hono<{ Bindings: Env }>();

type TokenBody = Record<string, string | undefined>;

async function authenticateClient(
  c: Context<{ Bindings: Env }>,
  body: TokenBody,
): Promise<OidcClient | null> {
  let clientId = body.client_id ?? "";
  let clientSecret = body.client_secret ?? "";
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const idx = decoded.indexOf(":");
      if (idx < 0) return null;
      clientId = decodeURIComponent(decoded.slice(0, idx));
      clientSecret = decodeURIComponent(decoded.slice(idx + 1));
    } catch {
      return null;
    }
  }
  if (!clientId) return null;
  const client = await getClient(c.env.DB, clientId);
  if (!client) return null;
  if (client.client_type === "public") {
    return clientSecret ? null : client;
  }
  if (!clientSecret) return null;
  const presented = await sha256Hex(clientSecret);
  return timingSafeEqualHex(presented, client.secret_hash) ? client : null;
}

function wantsRefresh(scope: string): boolean {
  const s = scope.split(" ");
  return s.includes("offline_access") || s.includes("mcp") || s.includes("mcp:read");
}

interface RefreshGrant {
  family: { id: string; expiresAt: number };
  clientId: string;
  userId: string;
  scope: string;
  resource: string | null;
  authTime: number;
}

async function mintRefresh(db: D1Database, g: RefreshGrant): Promise<string> {
  const raw = randomToken(32);
  await db
    .prepare(
      `INSERT INTO refresh_tokens (token_hash, family_id, client_id, user_id, scope, resource, auth_time, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      await sha256Hex(raw),
      g.family.id,
      g.clientId,
      g.userId,
      g.scope,
      g.resource,
      g.authTime,
      nowSec(),
      g.family.expiresAt,
    )
    .run();
  return raw;
}

async function tokenResponse(
  c: Context<{ Bindings: Env }>,
  client: OidcClient,
  claims: TokenClaims,
  grant: { scope: string; resource: string | null; refresh: string | null },
): Promise<Response> {
  const scopes = grant.scope.split(" ");
  const audience =
    grant.resource ??
    (scopes.includes("mcp") || scopes.includes("mcp:read") ? mcpResource(c.env) : client.id);
  const accessToken = await mintAccessToken(c.env, claims, {
    audience,
    clientId: client.id,
    scope: grant.scope,
  });
  const idToken = scopes.includes("openid") ? await mintIdToken(c.env, claims, client.id) : null;
  return c.json(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      scope: grant.scope,
      ...(idToken ? { id_token: idToken } : {}),
      ...(grant.refresh ? { refresh_token: grant.refresh } : {}),
    },
    200,
    { "cache-control": "no-store", pragma: "no-cache" },
  );
}

const tokenError = (c: Context, error: string, description?: string, status: 400 | 401 = 400) =>
  c.json({ error, ...(description ? { error_description: description } : {}) }, status, {
    "cache-control": "no-store",
  });

async function codeGrant(
  c: Context<{ Bindings: Env }>,
  client: OidcClient,
  body: TokenBody,
): Promise<Response> {
  if (!body.code) return tokenError(c, "invalid_request", "code is required");
  const codeHash = await sha256Hex(body.code);
  const candidate = await c.env.DB.prepare(
    `SELECT client_id, user_id, redirect_uri, code_challenge, scope, nonce, expires_at, resource, auth_time
     FROM auth_codes WHERE code_hash = ?1 AND used = 0`,
  )
    .bind(codeHash)
    .first<{
      client_id: string;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      scope: string;
      nonce: string | null;
      expires_at: number;
      resource: string | null;
      auth_time: number | null;
    }>();
  if (!candidate) {
    await audit(c.env.DB, "CODE_REJECTED", {
      clientId: client.id,
      detail: { reason: "unknown_or_reused" },
    });
    return tokenError(c, "invalid_grant", "code is invalid, expired, or already used");
  }
  if (
    candidate.expires_at < nowSec() ||
    candidate.client_id !== client.id ||
    (body.redirect_uri !== undefined && body.redirect_uri !== candidate.redirect_uri)
  ) {
    return tokenError(c, "invalid_grant");
  }
  if (candidate.code_challenge) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body.code_verifier ?? ""),
    );
    if (base64url(digest) !== candidate.code_challenge)
      return tokenError(c, "invalid_grant", "PKCE verification failed");
  } else if (client.require_pkce || client.client_type === "public") {
    return tokenError(c, "invalid_grant");
  }
  const user = await getUser(c.env.DB, candidate.user_id);
  if (
    !user ||
    user.disabled ||
    (await clientAccessProblem(c.env.DB, user, client, candidate.scope.split(" ")))
  ) {
    return tokenError(c, "invalid_grant", "user or client access was removed");
  }
  const row = await c.env.DB.prepare(
    `UPDATE auth_codes SET used = 1
     WHERE code_hash = ?1 AND client_id = ?2 AND redirect_uri = ?3 AND code_challenge = ?4
       AND used = 0 AND expires_at >= ?5
     RETURNING user_id, scope, nonce, resource, auth_time`,
  )
    .bind(codeHash, client.id, candidate.redirect_uri, candidate.code_challenge, nowSec())
    .first<{
      user_id: string;
      scope: string;
      nonce: string | null;
      resource: string | null;
      auth_time: number | null;
    }>();
  if (!row) return tokenError(c, "invalid_grant", "code is invalid, expired, or already used");
  const authTime = row.auth_time ?? nowSec();
  const claims = await claimsFor(c.env.DB, row.user_id, authTime, row.nonce);
  if (!claims) return tokenError(c, "invalid_grant", "user is disabled");
  const refresh = wantsRefresh(row.scope)
    ? await mintRefresh(c.env.DB, {
        family: { id: newId(), expiresAt: nowSec() + REFRESH_TTL },
        clientId: client.id,
        userId: row.user_id,
        scope: row.scope,
        resource: row.resource,
        authTime,
      })
    : null;
  await audit(c.env.DB, "TOKEN_ISSUED", {
    userId: row.user_id,
    clientId: client.id,
    detail: { scope: row.scope },
  });
  return tokenResponse(c, client, claims, { scope: row.scope, resource: row.resource, refresh });
}

async function refreshGrant(
  c: Context<{ Bindings: Env }>,
  client: OidcClient,
  body: TokenBody,
): Promise<Response> {
  if (!body.refresh_token) return tokenError(c, "invalid_request", "refresh_token is required");
  const hash = await sha256Hex(body.refresh_token);
  const now = nowSec();
  const candidate = await c.env.DB.prepare(
    `SELECT family_id, client_id, user_id, scope, resource, auth_time, expires_at, rotated_at
     FROM refresh_tokens WHERE token_hash = ?1`,
  )
    .bind(hash)
    .first<{
      family_id: string;
      client_id: string;
      user_id: string;
      scope: string;
      resource: string | null;
      auth_time: number;
      expires_at: number;
      rotated_at: number | null;
    }>();
  if (!candidate || candidate.client_id !== client.id) return tokenError(c, "invalid_grant");
  const replay = async () => {
    await c.env.DB.prepare("DELETE FROM refresh_tokens WHERE family_id = ?1 AND client_id = ?2")
      .bind(candidate.family_id, client.id)
      .run();
    await audit(c.env.DB, "REFRESH_REUSE_DETECTED", {
      userId: candidate.user_id,
      clientId: client.id,
    });
    return tokenError(c, "invalid_grant", "refresh token is invalid or already used");
  };
  if (candidate.rotated_at !== null) return replay();
  if (candidate.expires_at < now) return tokenError(c, "invalid_grant");
  if (client.source !== "admin") {
    const grant = await c.env.DB.prepare(
      "SELECT 1 AS ok FROM oauth_grants WHERE user_id = ?1 AND client_id = ?2",
    )
      .bind(candidate.user_id, client.id)
      .first();
    if (!grant) return tokenError(c, "invalid_grant", "access was revoked");
  }
  let scope = candidate.scope;
  if (body.scope) {
    const asked = body.scope.split(/\s+/).filter(Boolean);
    if (!asked.every((s) => candidate.scope.split(" ").includes(s)))
      return tokenError(c, "invalid_scope");
    scope = asked.join(" ");
  }
  const user = await getUser(c.env.DB, candidate.user_id);
  if (
    !user ||
    user.disabled ||
    (await clientAccessProblem(c.env.DB, user, client, candidate.scope.split(" ")))
  ) {
    await c.env.DB.prepare("DELETE FROM refresh_tokens WHERE family_id = ?1 AND client_id = ?2")
      .bind(candidate.family_id, client.id)
      .run();
    return tokenError(c, "invalid_grant", "user or client access was removed");
  }
  const row = await c.env.DB.prepare(
    `UPDATE refresh_tokens SET rotated_at = ?2
     WHERE token_hash = ?1 AND client_id = ?3 AND rotated_at IS NULL AND expires_at >= ?2
     RETURNING family_id, user_id, scope, resource, auth_time, expires_at`,
  )
    .bind(hash, now, client.id)
    .first<{
      family_id: string;
      user_id: string;
      scope: string;
      resource: string | null;
      auth_time: number;
      expires_at: number;
    }>();
  if (!row) return replay();
  const claims = await claimsFor(c.env.DB, row.user_id, row.auth_time);
  if (!claims) return tokenError(c, "invalid_grant", "user is disabled");
  const refresh = await mintRefresh(c.env.DB, {
    family: { id: row.family_id, expiresAt: row.expires_at },
    clientId: client.id,
    userId: row.user_id,
    scope: row.scope,
    resource: row.resource,
    authTime: row.auth_time,
  });
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "UPDATE oauth_grants SET last_used_at = ?1 WHERE user_id = ?2 AND client_id = ?3",
    )
      .bind(now, row.user_id, client.id)
      .run()
      .catch(() => {}),
  );
  return tokenResponse(c, client, claims, { scope, resource: row.resource, refresh });
}

async function parseForm(c: Context): Promise<TokenBody> {
  const raw = await c.req.parseBody();
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v : undefined]),
  );
}

tokens.post("/token", async (c) => {
  const body = await parseForm(c);
  const client = await authenticateClient(c, body);
  if (!client) return tokenError(c, "invalid_client", undefined, 401);
  if (body.grant_type === "authorization_code") return codeGrant(c, client, body);
  if (body.grant_type === "refresh_token") return refreshGrant(c, client, body);
  return tokenError(c, "unsupported_grant_type");
});

tokens.post("/revoke", async (c) => {
  const body = await parseForm(c);
  const client = await authenticateClient(c, body);
  if (!client) return tokenError(c, "invalid_client", undefined, 401);
  if (body.token) {
    const row = await c.env.DB.prepare(
      "SELECT family_id, client_id FROM refresh_tokens WHERE token_hash = ?1",
    )
      .bind(await sha256Hex(body.token))
      .first<{ family_id: string; client_id: string }>();
    if (row && row.client_id === client.id) {
      await c.env.DB.prepare("DELETE FROM refresh_tokens WHERE family_id = ?1")
        .bind(row.family_id)
        .run();
    }
  }
  return c.body(null, 200);
});

tokens.get("/userinfo", async (c) => userinfo(c));
tokens.post("/userinfo", async (c) => userinfo(c));

async function userinfo(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = c.req.header("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null;
  const unauthorized = () =>
    c.json({ error: "invalid_token" }, 401, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
  if (!token) return unauthorized();
  let payload;
  try {
    payload = await verifyAccessToken(c.env, token);
  } catch {
    return unauthorized();
  }
  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ") : [];
  if (
    typeof payload.sub !== "string" ||
    !scopes.includes("openid") ||
    payload.aud !== payload.client_id
  )
    return unauthorized();
  const claims = await claimsFor(c.env.DB, payload.sub, 0);
  if (!claims) return unauthorized();
  return c.json({
    sub: claims.sub,
    ...(scopes.includes("email") ? { email: claims.email, email_verified: true } : {}),
    ...(scopes.includes("profile") ? { name: claims.name, preferred_username: claims.email } : {}),
    ...(scopes.includes("groups") ? { groups: claims.groups } : {}),
  });
}
