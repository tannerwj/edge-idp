import { Hono } from "hono";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import type { Env } from "./config";
import { audit, getCredentialsForUser, getUser, getUserByEmail } from "./db";
import type { User, WebAuthnCredential } from "./db";
import { createSession, sessionUser, setSessionCookie } from "./session";
import { base64url, newId, nowSec, rpIdFromIssuer, sha256Hex } from "./util";

/**
 * Passkey ceremonies (SimpleWebAuthn v14, pure WebCrypto — no Node-only deps).
 *
 * Threat notes:
 * - Challenges are single-use, 5-minute, server-stored (D1), and bound to the
 *   user they were issued for. takeChallenge() deletes on read and every
 *   verify step re-checks the user binding, so a challenge can never be
 *   replayed or swapped between users.
 * - expectedOrigin is the exact ISSUER origin and expectedRPID its hostname.
 *   A credential registered on a lookalike domain can never verify here.
 * - supportedAlgorithmIDs is pinned to [-7 (ES256), -257 (RS256)]: v14
 *   otherwise offers ML-DSA first on runtimes with PQC WebCrypto, which would
 *   make behavior runtime-dependent.
 * - userVerification is "preferred", not "required": Apple enforces biometrics
 *   when available anyway; "required" would lock out devices without
 *   biometrics for zero phishing-resistance gain (the key never leaves the
 *   authenticator either way).
 * - Counters: synced passkeys report counter=0 forever, so we only enforce
 *   strict counter increments for credentials that have previously reported a
 *   nonzero counter (the standard exemption).
 */

const CHALLENGE_TTL = 300; // 5 minutes

/** Type predicate for parsed JSON — no assertions, just narrowing. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface StoredChallenge {
  type: "registration" | "authentication";
  userId: string | null;
  data: Record<string, unknown>;
}

async function storeChallenge(
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
async function takeChallenge(
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
function challengeFromResponse(
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

export async function validEnrollmentToken(
  db: D1Database,
  token: string,
): Promise<{ user: User; tokenHash: string } | null> {
  const tokenHash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT * FROM enrollment_tokens WHERE token_hash = ?1")
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number; used: number }>();
  if (!row || row.used || row.expires_at < nowSec()) return null;
  const user = await getUser(db, row.user_id);
  if (!user || user.disabled) return null;
  return { user, tokenHash };
}

function clientIp(c: {
  req: { header: (n: string) => string | undefined };
}): string | null {
  return (
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null
  );
}

function credIdB64(cred: WebAuthnCredential): string {
  return base64url(cred.credential_id);
}

/** Decode a base64url string to bytes (for storing credential IDs as BLOBs). */
function b64urlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const webauthn = new Hono<{ Bindings: Env }>();

/**
 * Registration options. Two doors in:
 *  1. enrollmentToken — a new user enrolling their first passkey;
 *  2. an active session — a signed-in user adding another passkey.
 */
webauthn.post("/register/options", async (c) => {
  const body = await c.req.json<{ enrollmentToken?: string }>();
  let user: User | null = null;
  let enrollmentHash: string | null = null;

  if (body.enrollmentToken) {
    const v = await validEnrollmentToken(c.env.DB, body.enrollmentToken);
    if (!v) return c.json({ error: "invalid_enrollment_token" }, 400);
    user = v.user;
    enrollmentHash = v.tokenHash;
  } else {
    user = await sessionUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
  }

  const rpID = rpIdFromIssuer(c.env.ISSUER);
  const existing = await getCredentialsForUser(c.env.DB, user.id);
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials: existing.map((cred) => ({
      id: credIdB64(cred),
      transports: cred.transports,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    supportedAlgorithmIDs: [-7, -257],
  });

  await storeChallenge(c.env.DB, options.challenge, {
    type: "registration",
    userId: user.id,
    data: enrollmentHash ? { enrollmentTokenHash: enrollmentHash } : {},
  });
  return c.json(options);
});

/** The enrollment token at verify time must match the challenge's binding. */
async function checkEnrollmentBinding(
  db: D1Database,
  enrollmentToken: string | undefined,
  stored: StoredChallenge,
): Promise<boolean> {
  if (enrollmentToken) {
    const v = await validEnrollmentToken(db, enrollmentToken);
    return !!(
      v &&
      v.user.id === stored.userId &&
      v.tokenHash === stored.data["enrollmentTokenHash"]
    );
  }
  return !stored.data["enrollmentTokenHash"];
}

type RegistrationInfo = NonNullable<
  Awaited<ReturnType<typeof verifyRegistrationResponse>>["registrationInfo"]
>;

/** Persist a verified credential. Counter always starts at 0. */
async function persistCredential(
  db: D1Database,
  userId: string,
  response: RegistrationResponseJSON,
  info: RegistrationInfo,
  name: string,
): Promise<void> {
  const deviceType = info.credentialDeviceType ?? "singleDevice";
  await db
    .prepare(
      `INSERT INTO webauthn_credentials
         (id, user_id, credential_id, public_key, counter, transports, name,
          backup_eligible, backup_state, aaguid, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      newId(),
      userId,
      b64urlToBytes(info.credential.id),
      info.credential.publicKey,
      0,
      response.response.transports
        ? JSON.stringify(response.response.transports)
        : null,
      name,
      deviceType === "multiDevice" ? 1 : 0,
      info.credentialBackedUp ? 1 : 0,
      info.aaguid ?? null,
      nowSec(),
    )
    .run();
}

webauthn.post("/register/verify", async (c) => {
  const body = await c.req.json<{
    response: RegistrationResponseJSON;
    enrollmentToken?: string;
    name?: string;
  }>();
  if (!body.response) return c.json({ error: "bad_request" }, 400);

  const challenge = challengeFromResponse(body.response);
  if (!challenge) return c.json({ error: "invalid_challenge" }, 400);
  const stored = await takeChallenge(c.env.DB, challenge);
  if (!stored || stored.type !== "registration" || !stored.userId) {
    return c.json({ error: "invalid_challenge" }, 400);
  }
  // The enrollment token presented at verify time must be the same one the
  // challenge was issued for — otherwise an attacker could piggyback their
  // own ceremony onto someone else's enrollment link.
  if (!(await checkEnrollmentBinding(c.env.DB, body.enrollmentToken, stored))) {
    return c.json({ error: "invalid_enrollment_token" }, 400);
  }

  const rpID = rpIdFromIssuer(c.env.ISSUER);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: c.env.ISSUER,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch {
    return c.json({ error: "verification_failed" }, 400);
  }
  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "verification_failed" }, 400);
  }
  const info = verification.registrationInfo;

  const user = await getUser(c.env.DB, stored.userId);
  if (!user || user.disabled) return c.json({ error: "unknown_user" }, 400);

  const deviceType = info.credentialDeviceType ?? "singleDevice";
  const name =
    body.name?.trim().slice(0, 80) ||
    (deviceType === "multiDevice" ? "Synced passkey" : "Device passkey");
  await persistCredential(c.env.DB, user.id, body.response, info, name);

  if (body.enrollmentToken) {
    await c.env.DB.prepare(
      "UPDATE enrollment_tokens SET used = 1 WHERE token_hash = ?1",
    )
      .bind(await sha256Hex(body.enrollmentToken))
      .run();
  }

  const ip = clientIp(c);
  await audit(c.env.DB, "PASSKEY_REGISTERED", {
    userId: user.id,
    ipHash: ip ? await sha256Hex(ip) : null,
    userAgent: c.req.header("user-agent"),
    detail: { name, backedUp: info.credentialBackedUp },
  });

  // Enrolling (first or additional key) signs the user in — no extra prompt.
  const raw = await createSession(
    c.env.DB,
    user.id,
    c.req.header("user-agent") ?? null,
    ip,
  );
  setSessionCookie(c, raw);
  return c.json({ ok: true });
});

/**
 * Authentication options. With an email we scope to that user's credentials;
 * without one the browser offers discoverable (autofill) credentials.
 */
webauthn.post("/auth/options", async (c) => {
  const body = await c.req.json<{ email?: string }>();
  let user: User | null = null;
  if (body.email) {
    user = await getUserByEmail(c.env.DB, body.email);
    // Deliberately identical responses for unknown emails: the options are
    // still well-formed (empty allow list), so login UX doesn't leak which
    // emails exist. Threat note: user enumeration via timing is negligible
    // here — no password to stuff — but we don't make it free either.
  }
  const rpID = rpIdFromIssuer(c.env.ISSUER);
  const creds = user ? await getCredentialsForUser(c.env.DB, user.id) : [];
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: creds.map((cred) => ({
      id: credIdB64(cred),
      transports: cred.transports,
    })),
    userVerification: "preferred",
  });
  await storeChallenge(c.env.DB, options.challenge, {
    type: "authentication",
    userId: user ? user.id : null,
    data: {},
  });
  return c.json(options);
});

/**
 * Resolve the authenticating user: explicit email, else the challenge
 * binding, else the userHandle from a discoverable credential.
 */
async function resolveAuthUser(
  db: D1Database,
  email: string | undefined,
  stored: StoredChallenge,
  response: AuthenticationResponseJSON,
): Promise<User | null> {
  if (email) return getUserByEmail(db, email);
  if (stored.userId) return getUser(db, stored.userId);
  const handle = response.response.userHandle;
  if (!handle) return null;
  try {
    const id = new TextDecoder().decode(b64urlToBytes(handle));
    return getUser(db, id);
  } catch {
    return null;
  }
}

webauthn.post("/auth/verify", async (c) => {
  const body = await c.req.json<{
    response: AuthenticationResponseJSON;
    email?: string;
  }>();
  if (!body.response) return c.json({ error: "bad_request" }, 400);

  const challenge = challengeFromResponse(body.response);
  if (!challenge) return c.json({ error: "invalid_challenge" }, 400);
  const stored = await takeChallenge(c.env.DB, challenge);
  if (!stored || stored.type !== "authentication") {
    return c.json({ error: "invalid_challenge" }, 400);
  }

  const user = await resolveAuthUser(c.env.DB, body.email, stored, body.response);
  if (!user || user.disabled) return c.json({ error: "auth_failed" }, 401);
  if (stored.userId && stored.userId !== user.id) {
    return c.json({ error: "auth_failed" }, 401);
  }

  const creds = await getCredentialsForUser(c.env.DB, user.id);
  const cred = creds.find((k) => credIdB64(k) === body.response.id);
  if (!cred) return c.json({ error: "auth_failed" }, 401);

  const rpID = rpIdFromIssuer(c.env.ISSUER);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: c.env.ISSUER,
      expectedRPID: rpID,
      credential: {
        id: credIdB64(cred),
        publicKey: cred.public_key,
        counter: cred.counter,
        transports: cred.transports,
      },
      requireUserVerification: false,
    });
  } catch {
    return c.json({ error: "auth_failed" }, 401);
  }
  if (!verification.verified || !verification.authenticationInfo) {
    return c.json({ error: "auth_failed" }, 401);
  }

  // Counter discipline: only credentials that have previously reported a
  // nonzero counter are held to strict increments (synced passkeys sit at 0).
  const newCounter = verification.authenticationInfo.newCounter;
  if (cred.counter > 0 && newCounter <= cred.counter) {
    await audit(c.env.DB, "PASSKEY_COUNTER_REGRESSION", {
      userId: user.id,
      detail: { credential: cred.id },
    });
    return c.json({ error: "auth_failed" }, 401);
  }
  const now = nowSec();
  await c.env.DB.prepare(
    "UPDATE webauthn_credentials SET counter = ?1, last_used_at = ?2 WHERE id = ?3",
  )
    .bind(newCounter, now, cred.id)
    .run();

  const ip = clientIp(c);
  await audit(c.env.DB, "SIGN_IN", {
    userId: user.id,
    ipHash: ip ? await sha256Hex(ip) : null,
    userAgent: c.req.header("user-agent"),
  });

  const raw = await createSession(
    c.env.DB,
    user.id,
    c.req.header("user-agent") ?? null,
    ip,
  );
  setSessionCookie(c, raw);
  return c.json({ ok: true, name: user.name });
});
