import type { Env } from "./config";
import { getInstanceSettings } from "./settings-cache";
import { base64url, nowSec } from "./util";

const KEY_PREFIX = "enc:v1:";
const KEY_CONTEXT = "edge-idp signing key v1\0";

export function encryptionSecret(env: Env): string {
  const secret = env.SETUP_TOKEN ?? "";
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

export async function sealKey(jwk: string, secret: string): Promise<string> {
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

export async function generateSigningJwk(): Promise<string> {
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

async function storedSigningKey(
  db: D1Database,
  secret: string,
  existing: string | null,
): Promise<string> {
  if (existing) return openKey(existing, secret);
  await db
    .prepare("INSERT OR IGNORE INTO signing_keys (id, jwk, created_at) VALUES ('current', ?1, ?2)")
    .bind(await sealKey(await generateSigningJwk(), secret), nowSec())
    .run();
  const row = await db
    .prepare("SELECT jwk FROM signing_keys WHERE id = 'current'")
    .first<{ jwk: string }>();
  if (!row) throw new Error("identity: could not create the signing key (are migrations applied?)");
  return openKey(row.jwk, secret);
}

interface InstanceRows {
  pinned: string | null;
  storedKey: string | null;
  previousKey: string | null;
}

async function instanceRows(env: Env): Promise<InstanceRows> {
  const wanted: { name: keyof InstanceRows; stmt: D1PreparedStatement }[] = [];
  if (!env.ISSUER)
    wanted.push({
      name: "pinned",
      stmt: env.DB.prepare("SELECT value FROM instance_settings WHERE key = 'issuer'"),
    });
  if (!env.SIGNING_KEY_JWK) {
    wanted.push({
      name: "storedKey",
      stmt: env.DB.prepare("SELECT jwk AS value FROM signing_keys WHERE id = 'current'"),
    });
    wanted.push({
      name: "previousKey",
      stmt: env.DB.prepare(
        "SELECT jwk AS value FROM signing_keys WHERE id = 'previous' AND retire_at > ?1",
      ).bind(nowSec()),
    });
  }
  const out: InstanceRows = { pinned: null, storedKey: null, previousKey: null };
  if (!wanted.length) return out;
  const results = await env.DB.batch<{ value: string }>(wanted.map((w) => w.stmt));
  wanted.forEach((w, i) => {
    out[w.name] = results[i]?.results[0]?.value ?? null;
  });
  return out;
}

async function keysFor(env: Env, rows: InstanceRows) {
  if (env.SIGNING_KEY_JWK)
    return {
      SIGNING_KEY_JWK: env.SIGNING_KEY_JWK,
      SIGNING_KEY_JWK_PREVIOUS: env.SIGNING_KEY_JWK_PREVIOUS,
      SIGNING_KEY_SOURCE: "secret" as const,
    };
  const secret = encryptionSecret(env);
  return {
    SIGNING_KEY_JWK: await storedSigningKey(env.DB, secret, rows.storedKey),
    SIGNING_KEY_JWK_PREVIOUS:
      env.SIGNING_KEY_JWK_PREVIOUS ||
      (rows.previousKey ? await openKey(rows.previousKey, secret) : undefined),
    SIGNING_KEY_SOURCE: "database" as const,
  };
}

export async function resolveEnv(env: Env, requestUrl: string): Promise<Env> {
  const [settings, rows] = await Promise.all([getInstanceSettings(env.DB), instanceRows(env)]);
  const { pinned } = rows;
  if (!env.ISSUER && !pinned) {
    const existing = await env.DB.prepare("SELECT 1 AS present FROM users LIMIT 1").first();
    if (existing)
      throw new Error(
        "identity: existing installation needs an explicit ISSUER before upgrade; see DEPLOY.md",
      );
  }
  const issuer = env.ISSUER || pinned || new URL(requestUrl).origin;
  return {
    ...env,
    EMAIL: env.EMAIL,
    ISSUER: issuer,
    RP_NAME: settings.name || env.RP_NAME || "Identity",
    CF_API_TOKEN: env.CF_API_TOKEN || settings.cfApiToken || undefined,
    CF_ACCOUNT_ID: env.CF_ACCOUNT_ID || settings.cfAccountId || undefined,
    ...(await keysFor(env, rows)),
  };
}
