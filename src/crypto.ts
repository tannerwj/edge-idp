import * as jose from "jose";
import type { Env } from "./config";
import { newId, nowSec } from "./util";

/**
 * Token signing.
 *
 * Threat note: only RS256 is ever used. Cloudflare Access accepts RSA and
 * ECDSA algorithms but NOT EdDSA or HS256 — signing with anything else
 * would silently break the one integration this server exists for. The key is
 * an RSA-2048 JWK in the SIGNING_KEY_JWK secret, generated once at setup
 * (scripts/gen-key.mjs).
 *
 * Rotation: move the current key to SIGNING_KEY_JWK_PREVIOUS, put a new key
 * (with a new `kid`) in SIGNING_KEY_JWK, deploy. Both public keys are
 * published in JWKS, new tokens use the new key, and old tokens verify until
 * they expire (≤1h). Then delete the previous secret.
 *
 * Access tokens are RFC 9068 JWTs (`typ: at+jwt`). Verification demands that
 * header, so an ID token can never be replayed as an access token.
 */

interface LoadedKey {
  /** Private key — signing only. jose v6 refuses to verify with it. */
  key: CryptoKey;
  /** Public key — verification. Derived, never stored separately. */
  verifyKey: CryptoKey;
  kid: string;
  publicJwk: jose.JWK;
}

const cache = new Map<string, LoadedKey>();

async function loadKey(raw: string, fallbackKid: string): Promise<LoadedKey> {
  const hit = cache.get(raw);
  if (hit) return hit;
  let jwk: jose.JWK;
  try {
    jwk = JSON.parse(raw);
  } catch {
    throw new Error("identity: signing key is not valid JSON");
  }
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.d) {
    throw new Error("identity: signing key must be an RSA private JWK");
  }
  // An RSA JWK with an asymmetric alg always imports to a CryptoKey; the
  // instanceof check keeps the type honest instead of asserting it.
  const imported = await jose.importJWK(jwk, "RS256");
  if (!(imported instanceof CryptoKey)) {
    throw new Error("identity: signing key did not import to a CryptoKey");
  }
  const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : fallbackKid;
  // Public half is derived, never stored separately — one source of truth.
  const publicJwk: jose.JWK = { kty: "RSA", n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" };
  const verifyImported = await jose.importJWK(publicJwk, "RS256");
  if (!(verifyImported instanceof CryptoKey)) {
    throw new Error("identity: public JWK did not import to a CryptoKey");
  }
  const loaded = { key: imported, verifyKey: verifyImported, kid, publicJwk };
  cache.set(raw, loaded);
  return loaded;
}

export async function getSigningKey(env: Env): Promise<LoadedKey> {
  return loadKey(env.SIGNING_KEY_JWK, "sig-1");
}

/** Every key that may have signed a still-valid token: current first. */
async function allKeys(env: Env): Promise<LoadedKey[]> {
  const keys = [await getSigningKey(env)];
  if (env.SIGNING_KEY_JWK_PREVIOUS) {
    const prev = await loadKey(env.SIGNING_KEY_JWK_PREVIOUS, "sig-0");
    if (prev.kid !== keys[0]?.kid) keys.push(prev);
  }
  return keys;
}

export async function jwksDocument(env: Env): Promise<{ keys: jose.JWK[] }> {
  return { keys: (await allKeys(env)).map((k) => k.publicJwk) };
}

export interface TokenClaims {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  /** Unix seconds when the user last completed a passkey ceremony. */
  authTime: number;
  nonce?: string;
}

export const ID_TOKEN_TTL = 3600;
export const ACCESS_TOKEN_TTL = 3600;

/**
 * Mint an OIDC ID token. Everything Cloudflare Access consumes (email,
 * groups) must be IN this token because Access never calls userinfo.
 */
export async function mintIdToken(
  env: Env,
  claims: TokenClaims,
  audience: string,
): Promise<string> {
  const { key, kid } = await getSigningKey(env);
  const now = nowSec();
  return await new jose.SignJWT({
    email: claims.email,
    email_verified: true,
    name: claims.name,
    preferred_username: claims.email,
    groups: claims.groups,
    auth_time: claims.authTime,
    // RFC 8176: proof-of-possession of a key + user presence/verification.
    amr: ["pop", "user"],
    ...(claims.nonce ? { nonce: claims.nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(env.ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_TTL)
    .sign(key);
}

/**
 * Mint an RFC 9068 access token. `audience` is the resource it's for: the
 * RFC 8707 `resource` the client asked for (e.g. `${ISSUER}/mcp`), or the
 * client_id when none was given (userinfo-only tokens). /mcp only accepts
 * tokens whose audience is the MCP resource AND whose scope includes `mcp`,
 * so a token handed to some app at sign-in is useless against the admin API.
 */
export async function mintAccessToken(
  env: Env,
  claims: TokenClaims,
  opts: { audience: string; clientId: string; scope: string },
): Promise<string> {
  const { key, kid } = await getSigningKey(env);
  const now = nowSec();
  return await new jose.SignJWT({
    scope: opts.scope,
    client_id: opts.clientId,
    email: claims.email,
    name: claims.name,
    groups: claims.groups,
    auth_time: claims.authTime,
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "at+jwt" })
    .setSubject(claims.sub)
    .setIssuer(env.ISSUER)
    .setAudience(opts.audience)
    .setJti(newId())
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL)
    .sign(key);
}

/**
 * Verify a bearer access token. Fails closed on any error. Pass `audience`
 * when the caller is a specific resource (the MCP endpoint does).
 */
export async function verifyAccessToken(
  env: Env,
  token: string,
  audience?: string,
): Promise<jose.JWTPayload> {
  const keys = await allKeys(env);
  const { kid } = jose.decodeProtectedHeader(token);
  const match = keys.find((k) => k.kid === kid);
  if (!match) throw new Error("unknown kid");
  const { payload } = await jose.jwtVerify(token, match.verifyKey, {
    issuer: env.ISSUER,
    algorithms: ["RS256"],
    typ: "at+jwt",
    ...(audience ? { audience } : {}),
  });
  return payload;
}

/** Verify an ID token we minted (for id_token_hint at logout). */
export async function verifyIdToken(
  env: Env,
  token: string,
): Promise<jose.JWTPayload> {
  const keys = await allKeys(env);
  const { kid } = jose.decodeProtectedHeader(token);
  const match = keys.find((k) => k.kid === kid);
  if (!match) throw new Error("unknown kid");
  const { payload } = await jose.jwtVerify(token, match.verifyKey, {
    issuer: env.ISSUER,
    algorithms: ["RS256"],
    typ: "JWT",
    // Logout hints may be expired; the signature is what matters there.
    clockTolerance: 30 * 24 * 3600,
  });
  return payload;
}
