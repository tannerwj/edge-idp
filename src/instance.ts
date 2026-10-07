import type { Env } from "./config";
import { base64url, nowSec } from "./util";

/**
 * Per-request instance config, so a one-click install (Deploy to Cloudflare
 * button) runs with nothing to configure:
 *
 * - Before setup, ISSUER falls back to the request's own origin. Setup pins
 *   that origin in D1; later requests use it across routes and aliases.
 *   Set an explicit ISSUER before enrollment if using a custom domain.
 * - RP_NAME falls back to "Identity".
 * - With no SIGNING_KEY_JWK secret, a key is generated and encrypted in D1
 *   using the high-entropy SETUP_TOKEN Worker secret. Reading D1 alone must
 *   not disclose signing authority. The reference instance's secret wins.
 *
 * The resolved values replace the raw ones on c.env for the request, so every
 * consumer keeps reading env.ISSUER / env.SIGNING_KEY_JWK unchanged.
 */

const KEY_PREFIX = "enc:v1:";
const KEY_CONTEXT = "edge-idp signing key v1\0";

function encryptionSecret(env: Env): string {
  const secret = env.SETUP_TOKEN ?? "";
  // A 32-byte base64url token from scripts/gen-setup-token.mjs is 43 chars.
  // Length is only a floor; operators must generate this randomly.
  if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) {
    throw new Error(
      "identity: SETUP_TOKEN must be a generated 32-byte-or-longer base64url secret for D1 key encryption",
    );
  }
  return secret;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(KEY_CONTEXT + secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function sealKey(jwk: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(jwk),
  );
  return `${KEY_PREFIX}${base64url(iv)}:${base64url(encrypted)}`;
}

async function openKey(stored: string, secret: string): Promise<string> {
  if (!stored.startsWith(KEY_PREFIX))
    throw new Error("identity: signing key row is not encrypted; see DEPLOY.md migration steps");
  const [iv, encrypted] = stored.slice(KEY_PREFIX.length).split(":");
  if (!iv || !encrypted) throw new Error("identity: encrypted signing key is malformed");
  try {
    const raw = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv) },
      await encryptionKey(secret),
      fromBase64url(encrypted),
    );
    return new TextDecoder().decode(raw);
  } catch {
    throw new Error(
      "identity: could not decrypt signing key; restore the original SETUP_TOKEN or signing key",
    );
  }
}

async function generateSigningJwk(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("identity: RSA key generation returned no key pair");
  const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (exported instanceof ArrayBuffer) throw new Error("identity: RSA key did not export as a JWK");
  return JSON.stringify({
    ...exported,
    kid: `sig-${crypto.randomUUID()}`,
    alg: "RS256",
    use: "sig",
  });
}

/** Concurrent first requests converge on one encrypted D1 row. Read each time
 * so key replacement is visible across isolates instead of cached forever. */
async function storedSigningKey(db: D1Database, secret: string): Promise<string> {
  const read = () =>
    db.prepare("SELECT jwk FROM signing_keys WHERE id = 'current'").first<{ jwk: string }>();
  let row = await read();
  if (!row) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO signing_keys (id, jwk, created_at) VALUES ('current', ?1, ?2)",
      )
      .bind(await sealKey(await generateSigningJwk(), secret), nowSec())
      .run();
    row = await read();
  }
  if (!row) throw new Error("identity: could not create the signing key (are migrations applied?)");
  return openKey(row.jwk, secret);
}

/** Fill in whatever the deployment left unset. Values may be missing at runtime even though Env types them. */
export async function resolveEnv(env: Env, requestUrl: string): Promise<Env> {
  const pinned = env.ISSUER
    ? null
    : await env.DB.prepare("SELECT value FROM instance_settings WHERE key = 'issuer'").first<{
        value: string;
      }>();
  if (!env.ISSUER && !pinned) {
    const existing = await env.DB.prepare("SELECT 1 AS present FROM users LIMIT 1").first();
    if (existing)
      throw new Error(
        "identity: existing installation needs an explicit ISSUER before upgrade; see DEPLOY.md",
      );
  }
  const issuer = env.ISSUER || pinned?.value || new URL(requestUrl).origin;
  return {
    ...env,
    ISSUER: issuer,
    RP_NAME: env.RP_NAME || "Identity",
    SIGNING_KEY_JWK: env.SIGNING_KEY_JWK || (await storedSigningKey(env.DB, encryptionSecret(env))),
  };
}
