import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./config";
import { audit, getClient } from "./db";
import type { OidcClient, User } from "./db";
import { jwksDocument, verifyIdToken } from "./crypto";
import { destroySession, getSession } from "./session";
import type { Session } from "./session";
import { redirectMatches, resolveClient } from "./oauth-clients";
import { clientAccessProblem, discovery, mcpResource, protectedResource, SCOPES } from "./oauth-shared";
import { nowSec, randomToken, sha256Hex } from "./util";
import { ConsentPage, ErrorPage, SignOutPage } from "./pages";
import { uiFor } from "./ui/layout";

/**
 * OIDC provider + OAuth 2.1 authorization server.
 *
 * Threat notes:
 * - Consent: admin-registered first-party clients skip it (the passkey
 *   ceremony is the intent — the original design). Dynamic (DCR) and CIMD
 *   clients are third-party, so they always get a consent screen, and the
 *   decision is remembered per (user, client) until revoked.
 * - PKCE S256 is required for every public client and, by default, every
 *   confidential one. Confidential server-side clients that can't send it
 *   (Cloudflare Access) may opt out per client — they still prove their
 *   secret at /token, and the code is bound to the exact redirect URI.
 * - Codes: single-use (atomic UPDATE … WHERE used = 0), 60s, bound to
 *   (client, redirect_uri, challenge, resource).
 * - Audience: an access token's `aud` is the RFC 8707 resource it was minted
 *   for. The MCP endpoint only accepts aud = `${ISSUER}/mcp` with the `mcp`
 *   scope, so a token some app received at sign-in can't drive the admin API.
 * - Token endpoint, refresh rotation and userinfo live in oauth-token.ts.
 * - Refresh tokens exist only for `mcp` / `offline_access` grants, rotate on
 *   every use, and a replayed (already-rotated) token revokes its family.
 */

const CODE_TTL = 60;

export const oidc = new Hono<{ Bindings: Env }>();

oidc.get("/.well-known/openid-configuration", (c) => c.json(discovery(c.env)));
// RFC 8414. MCP clients try this first; same document, OAuth flavored.
oidc.get("/.well-known/oauth-authorization-server", (c) => c.json(discovery(c.env)));

oidc.get("/jwks", async (c) => c.json(await jwksDocument(c.env)));
oidc.get("/.well-known/jwks.json", async (c) => c.json(await jwksDocument(c.env)));

oidc.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(protectedResource(c.env)));
oidc.get("/.well-known/oauth-protected-resource", (c) => c.json(protectedResource(c.env)));

/* ──────────────────────────── /authorize ──────────────────────────── */

interface AuthzRequest {
  client: OidcClient;
  redirectUri: string;
  state: string | undefined;
  scope: string;
  scopes: string[];
  codeChallenge: string;
  nonce: string | null;
  resource: string | null;
  prompt: string[];
  maxAge: number | null;
}

type Validated =
  | { ok: true; req: AuthzRequest }
  | { ok: false; response: Response };

/** Normalize an RFC 8707 resource: ours only, trailing slash forgiven. */
function normalizeResource(env: Env, raw: string | undefined): string | null | false {
  if (!raw) return null;
  const r = raw.replace(/\/+$/, "");
  if (r === mcpResource(env) || r === env.ISSUER) return r;
  return false;
}

async function errorPage(c: Context<{ Bindings: Env }>, title: string, message: string, status: 400 | 403 = 400) {
  return c.html(
    <ErrorPage ui={await uiFor(c)} title={title} message={message} />,
    status,
  );
}

/** PKCE is mandatory for public clients and (by default) everyone else;
 *  when sent at all it must be a well-formed S256 challenge. */
function pkceOk(q: Record<string, string>, client: OidcClient): boolean {
  const required = client.require_pkce || client.client_type === "public";
  if (!q.code_challenge && !required) return true;
  return q.code_challenge_method === "S256" && /^[A-Za-z0-9_-]{43}$/.test(q.code_challenge ?? "");
}

/** Requested scopes, de-duplicated; the OIDC default when none are given. */
function parseScopes(raw: string | undefined): string[] {
  const scopes = [...new Set((raw ?? "openid profile email").trim().split(/\s+/).filter(Boolean))];
  return scopes.length ? scopes : ["openid"];
}

/**
 * Validate an authorization request (shared by GET /authorize and the
 * consent POST, which re-validates everything — the form is untrusted).
 */
async function validateAuthorize(
  c: Context<{ Bindings: Env }>,
  q: Record<string, string>,
): Promise<Validated> {
  const resolved = await resolveClient(c.env.DB, q.client_id ?? "");
  // Without a valid client + exact redirect match we cannot safely redirect
  // the error anywhere, so these fail as pages, not redirects.
  if (!resolved) {
    return { ok: false, response: await errorPage(c, "Unknown app", "This sign-in link names an app this server doesn't know (unknown client_id).") };
  }
  if ("error" in resolved) {
    return { ok: false, response: await errorPage(c, "App unavailable", resolved.error) };
  }
  const client = resolved.client;
  const redirectUri = q.redirect_uri ?? (client.redirect_uris.length === 1 ? (client.redirect_uris[0] ?? "") : "");
  if (!redirectMatches(client.redirect_uris, redirectUri)) {
    return { ok: false, response: await errorPage(c, "Redirect not allowed", `${client.name} asked to send you somewhere it isn't registered for (redirect_uri mismatch).`) };
  }
  const state = q.state;
  const redirectError = (error: string, description?: string): Validated => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    if (description) u.searchParams.set("error_description", description);
    if (state) u.searchParams.set("state", state);
    u.searchParams.set("iss", c.env.ISSUER);
    return { ok: false, response: c.redirect(u.toString(), 302) };
  };

  if (q.response_type !== "code") return redirectError("unsupported_response_type");
  if (!pkceOk(q, client)) return redirectError("invalid_request", "PKCE S256 code_challenge required");
  const scopes = parseScopes(q.scope);
  const unknown = scopes.filter((sc) => !SCOPES.includes(sc));
  if (unknown.length) return redirectError("invalid_scope", `Unknown scope: ${unknown.join(" ")}`);
  const resource = normalizeResource(c.env, q.resource);
  if (resource === false) return redirectError("invalid_target", "Unknown resource");
  const maxAge = q.max_age !== undefined && /^\d+$/.test(q.max_age) ? parseInt(q.max_age, 10) : null;
  return {
    ok: true,
    req: {
      client,
      redirectUri,
      state,
      scope: scopes.join(" "),
      scopes,
      codeChallenge: q.code_challenge ?? "",
      nonce: q.nonce ?? null,
      resource,
      prompt: (q.prompt ?? "").split(/\s+/).filter(Boolean),
      maxAge,
    },
  };
}

function redirectWith(c: Context<{ Bindings: Env }>, req: AuthzRequest, params: Record<string, string>): Response {
  const u = new URL(req.redirectUri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (req.state) u.searchParams.set("state", req.state);
  u.searchParams.set("iss", c.env.ISSUER);
  return c.redirect(u.toString(), 302);
}

/** Can this user use this client at all? Returns a reason when not. */
async function accessProblem(db: D1Database, user: User, req: AuthzRequest): Promise<string | null> {
  const reason = await clientAccessProblem(db, user, req.client, req.scopes);
  return reason ? `Your account can no longer use ${req.client.name}: ${reason}.` : null;
}

async function hasGrant(db: D1Database, userId: string, req: AuthzRequest): Promise<boolean> {
  const row = await db
    .prepare("SELECT scope FROM oauth_grants WHERE user_id = ?1 AND client_id = ?2")
    .bind(userId, req.client.id)
    .first<{ scope: string }>();
  if (!row) return false;
  const granted = row.scope.split(" ");
  return req.scopes.every((s) => granted.includes(s));
}

async function issueCode(c: Context<{ Bindings: Env }>, req: AuthzRequest, session: Session): Promise<Response> {
  const code = randomToken(32);
  const now = nowSec();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO auth_codes
         (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, nonce, expires_at, resource, auth_time)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      await sha256Hex(code),
      req.client.id,
      session.user.id,
      req.redirectUri,
      req.codeChallenge,
      req.scope,
      req.nonce,
      now + CODE_TTL,
      req.resource,
      session.authTime,
    ),
    c.env.DB.prepare("UPDATE oidc_clients SET last_used_at = ?1 WHERE id = ?2").bind(now, req.client.id),
  ]);
  await audit(c.env.DB, "CODE_ISSUED", { userId: session.user.id, clientId: req.client.id });
  return redirectWith(c, req, { code });
}

/** URL to resume this exact request after sign-in, minus prompt=login. */
function resumeUrl(c: Context): string {
  const u = new URL(c.req.url);
  const prompts = (u.searchParams.get("prompt") ?? "").split(/\s+/).filter((p) => p && p !== "login");
  if (prompts.length) u.searchParams.set("prompt", prompts.join(" "));
  else u.searchParams.delete("prompt");
  return u.pathname + u.search;
}

oidc.get("/authorize", async (c) => {
  const v = await validateAuthorize(c, c.req.query());
  if (!v.ok) return v.response;
  const req = v.req;
  const session = await getSession(c);
  const stale =
    session && req.maxAge !== null && nowSec() - session.authTime > req.maxAge;
  if (!session || stale || req.prompt.includes("login")) {
    if (req.prompt.includes("none")) return redirectWith(c, req, { error: "login_required" });
    const params = new URLSearchParams({ next: resumeUrl(c) });
    if (session) params.set("reauth", "1");
    return c.redirect(`/login?${params.toString()}`, 302);
  }
  const problem = await accessProblem(c.env.DB, session.user, req);
  if (problem) {
    if (req.prompt.includes("none")) return redirectWith(c, req, { error: "access_denied" });
    await audit(c.env.DB, "ACCESS_DENIED", { userId: session.user.id, clientId: req.client.id });
    return errorPage(c, "Access denied", problem, 403);
  }
  const needsConsent =
    req.prompt.includes("consent") ||
    (!req.client.skip_consent && !(await hasGrant(c.env.DB, session.user.id, req)));
  if (needsConsent) {
    if (req.prompt.includes("none")) return redirectWith(c, req, { error: "consent_required" });
    return c.html(
      <ConsentPage
        ui={await uiFor(c)}
        client={req.client}
        user={session.user}
        scopes={req.scopes}
        redirectUri={req.redirectUri}
        params={c.req.query()}
      />,
    );
  }
  return issueCode(c, req, session);
});

/** Consent decision. Re-validates the whole request from the form. */
oidc.post("/authorize/decision", async (c) => {
  const form = await c.req.parseBody();
  const q: Record<string, string> = {};
  for (const [k, val] of Object.entries(form)) if (typeof val === "string") q[k] = val;
  const decision = q.decision;
  delete q.decision;
  const v = await validateAuthorize(c, q);
  if (!v.ok) return v.response;
  const req = v.req;
  const session = await getSession(c);
  if (!session) return c.redirect(`/login`, 303);
  if (decision !== "allow") {
    await audit(c.env.DB, "CONSENT_DENIED", { userId: session.user.id, clientId: req.client.id });
    return redirectWith(c, req, { error: "access_denied" });
  }
  const problem = await accessProblem(c.env.DB, session.user, req);
  if (problem) return errorPage(c, "Access denied", problem, 403);
  await c.env.DB.prepare(
    `INSERT INTO oauth_grants (user_id, client_id, scope, created_at, last_used_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(user_id, client_id) DO UPDATE SET scope = ?3, last_used_at = ?4`,
  )
    .bind(session.user.id, req.client.id, req.scope, nowSec())
    .run();
  await audit(c.env.DB, "CONSENT_GRANTED", {
    userId: session.user.id,
    clientId: req.client.id,
    detail: { scope: req.scope },
  });
  return issueCode(c, req, session);
});

/* ──────────────────────── RP-initiated logout ──────────────────────── */

/** Where may we send the user after logout? Same origin as one of the
 *  client's registered redirect URIs — never an arbitrary URL. */
async function postLogoutTarget(c: Context<{ Bindings: Env }>, q: Record<string, string>): Promise<string | null> {
  const target = q.post_logout_redirect_uri;
  if (!target) return null;
  let clientId = q.client_id ?? null;
  if (!clientId && q.id_token_hint) {
    try {
      const p = await verifyIdToken(c.env, q.id_token_hint);
      clientId = typeof p.aud === "string" ? p.aud : (p.aud?.[0] ?? null);
    } catch {
      return null;
    }
  }
  if (!clientId) return null;
  const client = await getClient(c.env.DB, clientId);
  if (!client) return null;
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    return null;
  }
  if (!client.redirect_uris.some((r) => { try { return new URL(r).origin === origin; } catch { return false; } })) return null;
  const u = new URL(target);
  if (q.state) u.searchParams.set("state", q.state);
  return u.toString();
}

oidc.get("/end-session", async (c) => {
  const q = c.req.query();
  const session = await getSession(c);
  const target = await postLogoutTarget(c, q);
  if (!session) return target ? c.redirect(target, 302) : c.redirect("/login", 302);
  return c.html(
    <SignOutPage ui={await uiFor(c)} user={session.user} params={q} />,
  );
});

oidc.post("/end-session", async (c) => {
  const form = await c.req.parseBody();
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(form)) if (typeof v === "string") q[k] = v;
  const session = await getSession(c);
  if (session) await audit(c.env.DB, "SIGN_OUT", { userId: session.user.id, detail: { via: "end_session" } });
  await destroySession(c);
  const target = await postLogoutTarget(c, q);
  return c.redirect(target ?? "/login?signed_out=1", 303);
});
