import * as jose from "jose";
import type { Env } from "./config";
import { newId, nowSec } from "./util";

interface LoadedKey {
  key: CryptoKey;
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
  const imported = await jose.importJWK(jwk, "RS256");
  if (!(imported instanceof CryptoKey)) {
    throw new Error("identity: signing key did not import to a CryptoKey");
  }
  const kid = typeof jwk.kid === "string" && jwk.kid ? jwk.kid : fallbackKid;
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
  authTime: number;
  nonce?: string;
}

export const ID_TOKEN_TTL = 3600;
export const ACCESS_TOKEN_TTL = 3600;

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

export async function mintAccessToken(
  env: Env,
  claims: TokenClaims,
  opts: { audience: string; clientId: string; scope: string },
): Promise<string> {
  const { key, kid } = await getSigningKey(env);
  const now = nowSec();
  const scopes = opts.scope.split(" ");
  return await new jose.SignJWT({
    scope: opts.scope,
    client_id: opts.clientId,
    ...(scopes.includes("email") ? { email: claims.email } : {}),
    ...(scopes.includes("profile") ? { name: claims.name } : {}),
    ...(scopes.includes("groups") ? { groups: claims.groups } : {}),
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

export async function verifyIdToken(env: Env, token: string): Promise<jose.JWTPayload> {
  const keys = await allKeys(env);
  const { kid } = jose.decodeProtectedHeader(token);
  const match = keys.find((k) => k.kid === kid);
  if (!match) throw new Error("unknown kid");
  const { payload } = await jose.jwtVerify(token, match.verifyKey, {
    issuer: env.ISSUER,
    algorithms: ["RS256"],
    typ: "JWT",
    clockTolerance: 30 * 24 * 3600,
  });
  return payload;
}
