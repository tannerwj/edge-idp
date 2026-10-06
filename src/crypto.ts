import * as jose from "jose";
import type { Env } from "./config";
import { nowSec } from "./util";

/**
 * Token signing.
 *
 * Threat note: only RS256 is ever used. Cloudflare Access accepts RSA and
 * ECDSA algorithms but NOT EdDSA or HS256 — signing with anything else
 * would silently break the one integration this server exists for. The key is
 * an RSA-2048 JWK in the SIGNING_KEY_JWK secret, generated once at setup
 * (scripts/gen-key.mjs). v1 has no rotation UI; rotation = generate a new key,
 * set the secret, redeploy (documented in DEPLOY.md). Tokens are short-lived
 * (1h), so the rotation blast radius is bounded.
 */

interface CachedKey {
  raw: string;
  /** Private key — signing only. jose v6 refuses to verify with it. */
  key: CryptoKey;
  /** Public key — verification. Derived, never stored separately. */
  verifyKey: CryptoKey;
  kid: string;
  publicJwk: jose.JWK;
}

let cached: CachedKey | null = null;

export async function getSigningKey(env: Env): Promise<CachedKey> {
  if (cached && cached.raw === env.SIGNING_KEY_JWK) return cached;
  let jwk: jose.JWK;
  try {
    jwk = JSON.parse(env.SIGNING_KEY_JWK);
  } catch {
    throw new Error("identity: SIGNING_KEY_JWK is not valid JSON");
  }
  if (jwk.kty !== "RSA" || !jwk.n || !jwk.d) {
    throw new Error("identity: SIGNING_KEY_JWK must be an RSA private JWK");
  }
  // An RSA JWK with an asymmetric alg always imports to a CryptoKey; the
  // instanceof check keeps the type honest instead of asserting it.
  const imported = await jose.importJWK(jwk, "RS256");
  if (!(imported instanceof CryptoKey)) {
    throw new Error("identity: SIGNING_KEY_JWK did not import to a CryptoKey");
  }
  const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : "sig-1";
  // Public half is derived, never stored separately — one source of truth.
  const publicJwk: jose.JWK = {
    kty: "RSA",
    n: jwk.n,
    e: jwk.e,
    kid,
    alg: "RS256",
    use: "sig",
  };
  const verifyImported = await jose.importJWK(publicJwk, "RS256");
  if (!(verifyImported instanceof CryptoKey)) {
    throw new Error("identity: public JWK did not import to a CryptoKey");
  }
  cached = {
    raw: env.SIGNING_KEY_JWK,
    key: imported,
    verifyKey: verifyImported,
    kid,
    publicJwk,
  };
  return cached;
}

export function jwksDocument(publicJwk: jose.JWK): { keys: jose.JWK[] } {
  return { keys: [publicJwk] };
}

export interface TokenClaims {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  /** Seconds since the user last completed a passkey ceremony. */
  authTime: number;
  nonce?: string;
}

/**
 * Mint an OIDC ID token. The claim set is deliberately tiny: everything
 * Cloudflare Access consumes (email, groups, custom claims) must be IN this
 * token because Access never calls userinfo.
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
    ...(claims.nonce ? { nonce: claims.nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(env.ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

/**
 * Mint the access token. It is a short-lived JWT (not opaque) so /userinfo
 * stays stateless — no token store, no extra DB round trip, nothing to
 * revoke. Threat note: this means an access token is bearer-valid until it
 * expires (1h); acceptable because it only discloses the same profile claims
 * already in the ID token.
 */
export async function mintAccessToken(
  env: Env,
  claims: TokenClaims,
  audience: string,
): Promise<string> {
  const { key, kid } = await getSigningKey(env);
  const now = nowSec();
  return await new jose.SignJWT({
    scope: "openid profile email groups",
    email: claims.email,
    name: claims.name,
    groups: claims.groups,
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuer(env.ISSUER)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

/** Verify a bearer access token for /userinfo. Fails closed on any error. */
export async function verifyAccessToken(
  env: Env,
  token: string,
): Promise<jose.JWTPayload> {
  // Verify with the PUBLIC key: jose v6 requires a public CryptoKey for
  // verification and the private one only carries "sign" usage.
  const { verifyKey } = await getSigningKey(env);
  const { payload } = await jose.jwtVerify(token, verifyKey, {
    issuer: env.ISSUER,
    algorithms: ["RS256"],
  });
  return payload;
}
