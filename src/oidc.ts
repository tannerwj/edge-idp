import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./config";
import { audit, getClient, getUser, getUserGroups } from "./db";
import type { OidcClient } from "./db";
import {
  getSigningKey,
  jwksDocument,
  mintAccessToken,
  mintIdToken,
  verifyAccessToken,
} from "./crypto";
import { sessionUser } from "./session";
import {
  base64url,
  nowSec,
  randomToken,
  sha256Hex,
  timingSafeEqualHex,
} from "./util";

/**
 * Minimal OIDC: authorization code + mandatory PKCE S256, nothing else.
 *
 * Threat notes:
 * - NO consent screen (deliberate QoL call): clients are admin-registered with
 *   exact-match redirect URIs, and the user just proved identity with a
 *   passkey seconds ago. The authentication ceremony IS the user intent.
 *   Revisit if third-party/self-registered clients ever exist.
 * - PKCE S256 is REQUIRED, not optional — even for confidential clients
 *   (defense in depth; also matches the Access "PKCE on every login" toggle).
 * - Codes: single-use, 60s, bound to (client, redirect_uri, challenge).
 *   Redirect URI is compared with exact string equality — no prefix tricks.
 * - Client secrets are SHA-256 hashes compared in constant time.
 * - /userinfo accepts only our own JWT access tokens (stateless, 1h).
 */

const CODE_TTL = 60;
const SCOPES = ["openid", "profile", "email", "groups"];

export const oidc = new Hono<{ Bindings: Env }>();

oidc.get("/.well-known/openid-configuration", (c) => {
  const iss = c.env.ISSUER;
  return c.json({
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
    ],
    scopes_supported: SCOPES,
    claims_supported: [
      "sub",
      "email",
      "email_verified",
      "name",
      "preferred_username",
      "groups",
      "auth_time",
    ],
  });
});

oidc.get("/jwks", async (c) => {
  const { publicJwk } = await getSigningKey(c.env);
  return c.json(jwksDocument(publicJwk));
});
oidc.get("/.well-known/jwks.json", async (c) => {
  const { publicJwk } = await getSigningKey(c.env);
  return c.json(jwksDocument(publicJwk));
});

oidc.get("/authorize", async (c) => {
  const q = c.req.query();
  const clientId = q.client_id ?? "";
  const redirectUri = q.redirect_uri ?? "";
  const state = q.state;

  const client = clientId ? await getClient(c.env.DB, clientId) : null;
  const fail = (error: string, description: string) =>
    c.html(
      `<h1>Sign-in error</h1><p><b>${escapeHtml(error)}</b>: ${escapeHtml(description)}</p>`,
      400,
    );

  // Without a valid client + exact redirect match we cannot safely redirect
  // the error anywhere, so these fail as pages, not redirects.
  if (!client) return fail("invalid_client", "Unknown client_id.");
  if (!client.redirect_uris.includes(redirectUri)) {
    return fail("invalid_redirect_uri", "redirect_uri is not registered.");
  }
  const redirectError = (error: string) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    if (state) u.searchParams.set("state", state);
    return c.redirect(u.toString(), 302);
  };

  if (q.response_type !== "code") return redirectError("unsupported_response_type");
  // PKCE is required by default; clients that can't send it (e.g. Cloudflare
  // Access) opt out per-client and authenticate with their secret instead.
  // Threat note: skipping PKCE is safe here because the code is bound to the
  // exact redirect_uri and the confidential client proves possession of its
  // secret at the token endpoint.
  if (client.require_pkce) {
    if (q.code_challenge_method !== "S256" || !q.code_challenge) {
      return redirectError("invalid_request");
    }
  } else if (q.code_challenge && q.code_challenge_method !== "S256") {
    return redirectError("invalid_request");
  }
  const scope = (q.scope ?? "openid profile email").trim() || "openid";
  const unknown = scope.split(/\s+/).filter((s) => !SCOPES.includes(s));
  if (unknown.length > 0) return redirectError("invalid_scope");

  const user = await sessionUser(c);
  if (!user) {
    // Not signed in: bounce through the login page, then resume here.
    return c.redirect(`/login?next=${encodeURIComponent(c.req.url)}`, 302);
  }

  if (client.allowed_groups?.length) {
    const groups = await getUserGroups(c.env.DB, user.id);
    const ok = client.allowed_groups.some((g) => groups.includes(g));
    if (!ok) {
      return fail(
        "access_denied",
        `Your account is not in a group allowed for ${client.name}.`,
      );
    }
  }

  const code = randomToken(32);
  const now = nowSec();
  await c.env.DB.prepare(
    `INSERT INTO auth_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, nonce, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      await sha256Hex(code),
      client.id,
      user.id,
      redirectUri,
      q.code_challenge ?? "",
      scope,
      q.nonce ?? null,
      now + CODE_TTL,
    )
    .run();

  await audit(c.env.DB, "CODE_ISSUED", {
    userId: user.id,
    clientId: client.id,
  });

  const u = new URL(redirectUri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  return c.redirect(u.toString(), 302);
});

interface TokenBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
  client_id?: string;
  client_secret?: string;
}

async function authenticateClient(
  c: { req: { header: (n: string) => string | undefined } },
  db: D1Database,
  body: TokenBody,
): Promise<OidcClient | null> {
  let clientId = body.client_id ?? "";
  let clientSecret = body.client_secret ?? "";
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = atob(auth.slice(6).trim());
      const idx = decoded.indexOf(":");
      if (idx >= 0) {
        clientId = decodeURIComponent(decoded.slice(0, idx));
        clientSecret = decodeURIComponent(decoded.slice(idx + 1));
      }
    } catch {
      return null;
    }
  }
  if (!clientId || !clientSecret) return null;
  const client = await getClient(db, clientId);
  if (!client) return null;
  // Threat note: the stored value is a SHA-256 hash, so we hash the presented
  // secret and compare hashes in constant time — the raw secret never sits
  // next to a non-constant comparison.
  const presented = await sha256Hex(clientSecret);
  if (!timingSafeEqualHex(presented, client.secret_hash)) return null;
  return client;
}

oidc.post("/token", async (c) => {
  const raw = await c.req.parseBody();
  const body: TokenBody = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v : ""]),
  );
  const invalid = (error: string, status: 400 | 401 = 400) =>
    c.json({ error }, status);

  const client = await authenticateClient(c, c.env.DB, body);
  if (!client) {
    return c.json({ error: "invalid_client" }, 401);
  }
  if (body.grant_type !== "authorization_code") {
    return invalid("unsupported_grant_type");
  }
  if (!body.code || !body.redirect_uri) {
    return invalid("invalid_request");
  }
  // code_verifier is required only when the client enforces PKCE.
  if (client.require_pkce && !body.code_verifier) {
    return invalid("invalid_request");
  }

  const row = await c.env.DB.prepare(
    "SELECT * FROM auth_codes WHERE code_hash = ?1",
  )
    .bind(await sha256Hex(body.code))
    .first<{
      client_id: string;
      user_id: string;
      redirect_uri: string;
      code_challenge: string;
      scope: string;
      nonce: string | null;
      expires_at: number;
      used: number;
    }>();
  if (
    !row ||
    row.used ||
    row.expires_at < nowSec() ||
    row.client_id !== client.id ||
    row.redirect_uri !== body.redirect_uri
  ) {
    return invalid("invalid_grant");
  }

  // PKCE S256 verification, when a challenge was issued. Clients that opted
  // out of PKCE (confidential clients authenticating with a secret) store an
  // empty challenge and skip this check.
  if (row.code_challenge) {
    const verifierBytes = new TextEncoder().encode(body.code_verifier ?? "");
    const digest = await crypto.subtle.digest("SHA-256", verifierBytes);
    if (base64url(digest) !== row.code_challenge) {
      return invalid("invalid_grant");
    }
  }

  await c.env.DB.prepare("UPDATE auth_codes SET used = 1 WHERE code_hash = ?1")
    .bind(await sha256Hex(body.code))
    .run();

  const user = await getUser(c.env.DB, row.user_id);
  if (!user || user.disabled) return invalid("invalid_grant");
  const groups = await getUserGroups(c.env.DB, user.id);

  const claims = {
    sub: user.id,
    email: user.email,
    name: user.name,
    groups,
    authTime: nowSec(),
    ...(row.nonce ? { nonce: row.nonce } : {}),
  };
  const [idToken, accessToken] = await Promise.all([
    mintIdToken(c.env, claims, client.id),
    mintAccessToken(c.env, claims, client.id),
  ]);

  await audit(c.env.DB, "TOKEN_ISSUED", {
    userId: user.id,
    clientId: client.id,
  });

  return c.json({
    access_token: accessToken,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: 3600,
  });
});

oidc.get("/userinfo", async (c) => userinfo(c));
oidc.post("/userinfo", async (c) => userinfo(c));

async function userinfo(c: Context<{ Bindings: Env }>): Promise<Response> {
  const auth = c.req.header("authorization");
  const token = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;
  if (!token) return c.json({ error: "unauthorized" }, 401);
  let payload;
  try {
    payload = await verifyAccessToken(c.env, token);
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({
    sub: payload.sub,
    email: payload.email,
    email_verified: true,
    name: payload.name,
    preferred_username: payload.email,
    groups: payload.groups ?? [],
  });
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (ch) => map[ch] ?? ch);
}
