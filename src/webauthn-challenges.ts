/**
 * WebAuthn challenge store (D1). Challenges are single-use, 5-minute, and
 * bound to the user they were issued for — see the threat notes in
 * webauthn.ts.
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { nowSec } from "./util";

const CHALLENGE_TTL = 300; // 5 minutes

/** Type predicate for parsed JSON — no assertions, just narrowing. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export interface StoredChallenge {
  type: "registration" | "authentication";
  userId: string | null;
  data: Record<string, unknown>;
}

export async function storeChallenge(
  db: D1Database,
  challenge: string,
  c: StoredChallenge,
): Promise<void> {
  // Opportunistic cleanup: expired challenges are dead weight and a (bounded)
  // DoS vector if an attacker spams the /options endpoints.
  await db
    .prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?1")
    .bind(nowSec())
    .run();
  await db
    .prepare(
      `INSERT INTO webauthn_challenges (challenge, type, user_id, data, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(
      challenge,
      c.type,
      c.userId,
      JSON.stringify(c.data),
      nowSec() + CHALLENGE_TTL,
    )
    .run();
}

/** Fetch-and-delete: challenges are single-use by construction. */
export async function takeChallenge(
  db: D1Database,
  challenge: string,
): Promise<StoredChallenge | null> {
  const row = await db
    .prepare("SELECT * FROM webauthn_challenges WHERE challenge = ?1")
    .bind(challenge)
    .first<{
      type: string;
      user_id: string | null;
      data: string;
      expires_at: number;
    }>();
  if (!row) return null;
  await db
    .prepare("DELETE FROM webauthn_challenges WHERE challenge = ?1")
    .bind(challenge)
    .run();
  if (row.expires_at < nowSec()) return null;
  if (row.type !== "registration" && row.type !== "authentication") return null;
  const data: unknown = JSON.parse(row.data);
  return {
    type: row.type,
    userId: row.user_id,
    data: isRecord(data) ? data : {},
  };
}

/** The challenge the browser answered, from inside clientDataJSON. */
export function challengeFromResponse(
  response: RegistrationResponseJSON | AuthenticationResponseJSON,
): string | null {
  try {
    const raw = response.response.clientDataJSON;
    const json: unknown = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(raw)),
    );
    return isRecord(json) && typeof json.challenge === "string"
      ? json.challenge
      : null;
  } catch {
    return null;
  }
}

/** Decode a base64url string to bytes (for storing credential IDs as BLOBs). */
export function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
