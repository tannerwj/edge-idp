import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { nowSec } from "./util";

const CHALLENGE_TTL = 300;

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
  await db
    .prepare(
      `INSERT INTO webauthn_challenges (challenge, type, user_id, data, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(challenge, c.type, c.userId, JSON.stringify(c.data), nowSec() + CHALLENGE_TTL)
    .run();
}

export async function takeChallenge(
  db: D1Database,
  challenge: string,
): Promise<StoredChallenge | null> {
  const row = await db
    .prepare(`DELETE FROM webauthn_challenges WHERE challenge = ?1 AND expires_at >= ?2
              RETURNING type, user_id, data, expires_at`)
    .bind(challenge, nowSec())
    .first<{
      type: string;
      user_id: string | null;
      data: string;
      expires_at: number;
    }>();
  if (!row) return null;
  if (row.type !== "registration" && row.type !== "authentication") return null;
  const data: unknown = JSON.parse(row.data);
  return {
    type: row.type,
    userId: row.user_id,
    data: isRecord(data) ? data : {},
  };
}

export function challengeFromResponse(
  response: RegistrationResponseJSON | AuthenticationResponseJSON,
): string | null {
  try {
    const raw = response.response.clientDataJSON;
    const json: unknown = JSON.parse(new TextDecoder().decode(b64urlToBytes(raw)));
    return isRecord(json) && typeof json.challenge === "string" ? json.challenge : null;
  } catch {
    return null;
  }
}

export function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
