import type { Env } from "./config";
import { audit } from "./db";
import { encryptionSecret, generateSigningJwk, sealKey } from "./instance";
import { by, OpError } from "./ops-core";
import type { Actor } from "./ops-core";
import { getInstanceSettings } from "./settings-cache";
import { nowSec } from "./util";

export const RETIRE_AFTER = 2 * 3600;
const SYSTEM: Actor = { adminId: "system", via: "system" };

function kidOf(jwk: string): string {
  try {
    const v: unknown = JSON.parse(jwk);
    return typeof v === "object" && v !== null && "kid" in v && typeof v.kid === "string"
      ? v.kid
      : "sig-1";
  } catch {
    return "sig-1";
  }
}

export function canUseDatabaseKey(env: Env): boolean {
  try {
    encryptionSecret(env);
    return true;
  } catch {
    return false;
  }
}

export async function storedKeys(
  db: D1Database,
): Promise<{ id: string; created_at: number; retire_at: number | null }[]> {
  const { results } = await db
    .prepare("SELECT id, created_at, retire_at FROM signing_keys ORDER BY created_at DESC")
    .all<{ id: string; created_at: number; retire_at: number | null }>();
  return results;
}

export async function rotateSigningKey(env: Env, a: Actor): Promise<string> {
  if (env.SIGNING_KEY_SOURCE !== "database")
    throw new OpError(
      "This instance signs with the SIGNING_KEY_JWK secret; rotate it with the two-secret steps.",
    );
  const secret = encryptionSecret(env);
  const jwk = await generateSigningJwk();
  const now = nowSec();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM signing_keys WHERE id = 'previous'"),
    env.DB.prepare(
      "UPDATE signing_keys SET id = 'previous', retire_at = ?1 WHERE id = 'current'",
    ).bind(now + RETIRE_AFTER),
    env.DB.prepare(
      "INSERT INTO signing_keys (id, jwk, created_at) VALUES ('current', ?1, ?2)",
    ).bind(await sealKey(jwk, secret), now),
  ]);
  const kid = kidOf(jwk);
  await audit(env.DB, "SIGNING_KEY_ROTATED", {
    userId: a.adminId === "system" ? null : a.adminId,
    detail: by(a, { kid }),
  });
  return kid;
}

export async function moveKeyToDatabase(env: Env, a: Actor): Promise<string> {
  if (env.SIGNING_KEY_SOURCE !== "secret")
    throw new OpError("The signing key is already kept in the database.");
  if (!canUseDatabaseKey(env))
    throw new OpError(
      "Set a SETUP_TOKEN Worker secret first; it encrypts the key in the database.",
    );
  await env.DB.prepare(
    "INSERT OR REPLACE INTO signing_keys (id, jwk, created_at, retire_at) VALUES ('current', ?1, ?2, NULL)",
  )
    .bind(await sealKey(env.SIGNING_KEY_JWK, encryptionSecret(env)), nowSec())
    .run();
  const kid = kidOf(env.SIGNING_KEY_JWK);
  await audit(env.DB, "SIGNING_KEY_MOVED", { userId: a.adminId, detail: by(a, { kid }) });
  return kid;
}

export async function autoRotate(env: Env): Promise<"rotated" | "skipped"> {
  const s = await getInstanceSettings(env.DB);
  if (s.keyRotationDays === "off" || env.SIGNING_KEY_SOURCE !== "database") return "skipped";
  const current = await env.DB.prepare(
    "SELECT created_at FROM signing_keys WHERE id = 'current'",
  ).first<{ created_at: number }>();
  if (!current || nowSec() - current.created_at < Number(s.keyRotationDays) * 86400)
    return "skipped";
  await rotateSigningKey(env, SYSTEM);
  return "rotated";
}
