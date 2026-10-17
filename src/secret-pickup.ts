import { Hono } from "hono";
import type { Env } from "./config";
import { audit } from "./db";
import { b64urlToBytes } from "./webauthn-challenges";
import { base64url, nowSec, randomToken, sha256Hex } from "./util";

export const PICKUP_TTL = 600;
const CONTEXT = "edge-idp secret pickup v1\0";

async function pickupKey(token: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CONTEXT + token));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function createPickup(
  db: D1Database,
  clientId: string,
  secret: string,
): Promise<string> {
  const token = randomToken(32);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await pickupKey(token),
    new TextEncoder().encode(secret),
  );
  await db
    .prepare(
      "INSERT INTO secret_pickups (token_hash, client_id, ciphertext, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(
      await sha256Hex(token),
      clientId,
      `${base64url(iv)}:${base64url(sealed)}`,
      nowSec(),
      nowSec() + PICKUP_TTL,
    )
    .run();
  return token;
}

async function redeem(
  db: D1Database,
  token: string,
): Promise<{ clientId: string; secret: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await db
    .prepare(
      "DELETE FROM secret_pickups WHERE token_hash = ?1 AND expires_at >= ?2 RETURNING client_id, ciphertext",
    )
    .bind(await sha256Hex(token), nowSec())
    .first<{ client_id: string; ciphertext: string }>();
  if (!row) return null;
  const [iv, sealed] = row.ciphertext.split(":");
  if (!iv || !sealed) return null;
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlToBytes(iv) },
    await pickupKey(token),
    b64urlToBytes(sealed),
  );
  return { clientId: row.client_id, secret: new TextDecoder().decode(plain) };
}

export const pickup = new Hono<{ Bindings: Env }>();

pickup.post("/client-secret/pickup", async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : "";
  const found = await redeem(c.env.DB, token);
  if (!found)
    return c.text("Unknown, used or expired pickup.", 404, { "cache-control": "no-store" });
  await audit(c.env.DB, "CLIENT_SECRET_PICKED_UP", { clientId: found.clientId });
  return c.text(found.secret, 200, { "cache-control": "no-store", pragma: "no-cache" });
});
