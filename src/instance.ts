import type { Env } from "./config";
import { nowSec } from "./util";

/**
 * Per-request instance config, so a one-click install (Deploy to Cloudflare
 * button) runs with nothing to configure:
 *
 * - ISSUER falls back to the request's own origin. On Workers only hostnames
 *   routed to this Worker (its workers.dev name, its routes and custom
 *   domains) ever reach it, so a client can't pick the origin. Set ISSUER once
 *   you add a custom domain so tokens and passkeys stay on one name.
 * - RP_NAME falls back to "Identity".
 * - SIGNING_KEY_JWK falls back to a key generated on first use and kept in
 *   D1 (signing_keys). Threat note: D1 read access then yields a key that can
 *   forge tokens, but D1 write access already means full control (insert an
 *   admin, a session), so the exposure barely moves. Setting the secret
 *   always wins; production instances that have one never touch the table.
 *
 * The resolved values replace the raw ones on c.env for the request, so every
 * consumer keeps reading env.ISSUER / env.SIGNING_KEY_JWK unchanged.
 */

let storedKey: string | null = null;

async function generateSigningJwk(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("identity: RSA key generation returned no key pair");
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (exported instanceof ArrayBuffer) throw new Error("identity: RSA key did not export as a JWK");
  return JSON.stringify({ ...exported, kid: "sig-1", alg: "RS256", use: "sig" });
}

/** The D1-held signing key, generated once. Concurrent first requests converge on one row. */
async function storedSigningKey(db: D1Database): Promise<string> {
  if (storedKey) return storedKey;
  const read = () => db.prepare("SELECT jwk FROM signing_keys WHERE id = 'current'").first<{ jwk: string }>();
  let row = await read();
  if (!row) {
    await db
      .prepare("INSERT OR IGNORE INTO signing_keys (id, jwk, created_at) VALUES ('current', ?1, ?2)")
      .bind(await generateSigningJwk(), nowSec())
      .run();
    row = await read();
  }
  if (!row) throw new Error("identity: could not create the signing key (are migrations applied?)");
  storedKey = row.jwk;
  return storedKey;
}

/** Fill in whatever the deployment left unset. Values may be missing at runtime even though Env types them. */
export async function resolveEnv(env: Env, requestUrl: string): Promise<Env> {
  return {
    ...env,
    ISSUER: env.ISSUER || new URL(requestUrl).origin,
    RP_NAME: env.RP_NAME || "Identity",
    SIGNING_KEY_JWK: env.SIGNING_KEY_JWK || (await storedSigningKey(env.DB)),
  };
}
