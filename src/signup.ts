import { Hono } from "hono";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Env } from "./config";
import { audit, getClient } from "./db";
import type { OidcClient } from "./db";
import { createSession, getSession, setSessionCookie } from "./session";
import { newId, nowSec, rpIdFromIssuer, sha256Hex } from "./util";
import { challengeFromResponse, storeChallenge, takeChallenge } from "./webauthn-challenges";
import { clientIp, credentialInsert, credentialName } from "./webauthn";

export const PUBLIC_GROUP = "public";

export async function signupClient(db: D1Database, next: string): Promise<OidcClient | null> {
  if (!next.startsWith("/authorize?")) return null;
  const q = new URLSearchParams(next.slice("/authorize?".length));
  const client = await getClient(db, q.get("client_id") ?? "");
  return client && client.source === "admin" && client.public_signup ? client : null;
}

export function displayName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
  return name;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

export const signup = new Hono<{ Bindings: Env }>();

signup.post("/signup/options", async (c) => {
  const body = await c.req
    .json<{ name?: unknown; next?: unknown }>()
    .catch((): { name?: unknown; next?: unknown } => ({}));
  if (await getSession(c)) return c.json({ error: "already_signed_in" }, 409);
  const name = displayName(body.name);
  if (!name) return c.json({ error: "invalid_name" }, 400);
  const client = await signupClient(c.env.DB, text(body.next));
  if (!client) return c.json({ error: "signup_closed" }, 403);
  const userId = newId();
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME,
    rpID: rpIdFromIssuer(c.env.ISSUER),
    userID: Uint8Array.from(new TextEncoder().encode(userId)),
    userName: name,
    userDisplayName: name,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    supportedAlgorithmIDs: [-7, -257],
  });
  await storeChallenge(c.env.DB, options.challenge, {
    type: "signup",
    userId: null,
    data: { userId, name, clientId: client.id },
  });
  return c.json(options);
});

signup.post("/signup/verify", async (c) => {
  const body = await c.req
    .json<{ response?: RegistrationResponseJSON }>()
    .catch((): { response?: RegistrationResponseJSON } => ({}));
  if (!body.response) return c.json({ error: "bad_request" }, 400);
  const challenge = challengeFromResponse(body.response);
  const stored = challenge ? await takeChallenge(c.env.DB, challenge) : null;
  if (!challenge || !stored || stored.type !== "signup")
    return c.json({ error: "invalid_challenge" }, 400);
  const userId = text(stored.data["userId"]);
  const name = displayName(stored.data["name"]);
  const client = await getClient(c.env.DB, text(stored.data["clientId"]));
  if (!userId || !name || !client || client.source !== "admin" || !client.public_signup)
    return c.json({ error: "signup_closed" }, 403);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: c.env.ISSUER,
      expectedRPID: rpIdFromIssuer(c.env.ISSUER),
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: "verification_failed" }, 400);
  }
  if (!verification.verified || !verification.registrationInfo)
    return c.json({ error: "verification_failed" }, 400);
  const info = verification.registrationInfo;
  const db = c.env.DB;
  const now = nowSec();
  const cred = credentialInsert(db, userId, body.response, info, credentialName(undefined, info));
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (id, created_at, name, email, is_admin, updated_at, public) VALUES (?1, ?2, ?3, ?4, 0, ?2, 1)",
      )
      .bind(userId, now, name, `${userId}@public.invalid`),
    cred.stmt,
    db
      .prepare(
        "INSERT OR IGNORE INTO groups (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)",
      )
      .bind(newId(), PUBLIC_GROUP, "Accounts people created themselves", now),
    db
      .prepare(
        "INSERT INTO group_members (group_id, user_id, created_at) SELECT id, ?1, ?2 FROM groups WHERE name = ?3",
      )
      .bind(userId, now, PUBLIC_GROUP),
  ]);
  const ip = clientIp(c);
  const ipHash = ip ? await sha256Hex(ip) : null;
  await audit(db, "USER_SIGNED_UP", {
    userId,
    clientId: client.id,
    ipHash,
    userAgent: c.req.header("user-agent"),
  });
  const raw = await createSession(db, userId, c.req.header("user-agent") ?? null, ip, cred.id);
  setSessionCookie(c, raw);
  return c.json({ ok: true });
});
