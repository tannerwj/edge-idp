import type { Env } from "./config";
import { claimsForClient } from "./access";
import type { UserContext } from "./access";
import type { OidcClient } from "./db";
import type { TokenClaims } from "./crypto";

export const SCOPES = ["openid", "profile", "email", "groups", "offline_access", "mcp", "mcp:read"];
export const ADMIN_SCOPES = ["mcp", "mcp:read"];

export function clientAccessProblem(
  ctx: UserContext,
  client: OidcClient,
  scopes: string[],
): string | null {
  const { user } = ctx;
  if (scopes.some((scope) => ADMIN_SCOPES.includes(scope)) && !user.is_admin) {
    return "admin access was removed";
  }
  if (user.public && !(client.source === "admin" && client.public_signup)) {
    return "this app is for members only";
  }
  const linked = client.source === "admin" ? ctx.apps.filter((a) => a.client_id === client.id) : [];
  if (linked.length)
    return linked.some((a) => ctx.access.has(a.id)) ? null : "app access was removed";
  if (client.allowed_groups?.length) {
    if (!client.allowed_groups.some((group) => ctx.groups.includes(group)))
      return "group access was removed";
  } else if (client.source !== "admin" && !user.is_admin) {
    return "client access was removed";
  }
  return null;
}

export function mcpResource(env: Env): string {
  return `${env.ISSUER}/mcp`;
}

export function discovery(env: Env) {
  const iss = env.ISSUER;
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks`,
    registration_endpoint: `${iss}/register`,
    revocation_endpoint: `${iss}/revoke`,
    end_session_endpoint: `${iss}/end-session`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    scopes_supported: SCOPES,
    prompt_values_supported: ["none", "login", "consent"],
    claims_supported: [
      "sub",
      "iss",
      "aud",
      "exp",
      "iat",
      "auth_time",
      "nonce",
      "amr",
      "email",
      "email_verified",
      "name",
      "preferred_username",
      "groups",
      "apps",
      "roles",
    ],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResource(env: Env) {
  return {
    resource: mcpResource(env),
    authorization_servers: [env.ISSUER],
    scopes_supported: ["mcp", "mcp:read"],
    bearer_methods_supported: ["header"],
    resource_name: `${env.RP_NAME} admin`,
    resource_documentation: `${env.ISSUER}/admin/tokens`,
  };
}
export function accessClaimsClient(client: OidcClient, scope: string): string | null {
  return client.source === "admin" && scope.split(" ").includes("groups") ? client.id : null;
}

export function claimsFor(
  ctx: UserContext,
  authTime: number,
  opts: { nonce?: string | null; accessFor?: string | null; method?: string | null } = {},
): TokenClaims | null {
  const { user } = ctx;
  if (user.disabled) return null;
  return {
    sub: user.id,
    email: user.email,
    name: user.name,
    public: user.public === 1,
    groups: ctx.groups,
    authTime,
    method: opts.method ?? null,
    ...(opts.nonce ? { nonce: opts.nonce } : {}),
    ...(opts.accessFor ? claimsForClient(ctx.apps, ctx.access, opts.accessFor) : {}),
  };
}
