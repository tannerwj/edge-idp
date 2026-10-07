import { Hono } from "hono";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { Env } from "./config";
import { audit, getCredentialsForUser, getUser, getUserByEmail } from "./db";
import type { User, WebAuthnCredential } from "./db";
import {
  createSession,
  destroySession,
  getSession,
  hasRecentStepUp,
  setSessionCookie,
} from "./session";
import { base64url, newId, nowSec, rpIdFromIssuer, sha256Hex } from "./util";
import { aaguidName } from "./aaguid";
import {
  b64urlToBytes,
  challengeFromResponse,
  storeChallenge,
  takeChallenge,
} from "./webauthn-challenges";
import type { StoredChallenge } from "./webauthn-challenges";

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
 * - User verification is required: possession or a touch alone must not
 *   authenticate to this root-of-trust service.
 * - Counters: synced passkeys report counter=0 forever, so we only enforce
 *   strict counter increments for credentials that have previously reported a
 *   nonzero counter (the standard exemption).
 */

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

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string | null {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for") ?? null;
}

function credIdB64(cred: WebAuthnCredential): string {
  return base64url(cred.credential_id);
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
    const session = await getSession(c);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    // Session age alone is insufficient: require an explicit passkey recheck.
    if (!hasRecentStepUp(session)) {
      return c.json({ error: "reauth_required" }, 401);
    }
    user = session.user;
  }

  const rpID = rpIdFromIssuer(c.env.ISSUER);
  const existing = await getCredentialsForUser(c.env.DB, user.id);
  const options = await generateRegistrationOptions({
    rpName: c.env.RP_NAME,
    rpID,
    userID: Uint8Array.from(new TextEncoder().encode(user.id)),
    userName: user.email,
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials: existing.map((cred) => ({
      id: credIdB64(cred),
      transports: cred.transports,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
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
): Promise<string> {
  const deviceType = info.credentialDeviceType ?? "singleDevice";
  const id = newId();
  await db
    .prepare(
      `INSERT INTO webauthn_credentials
         (id, user_id, credential_id, public_key, counter, transports, name,
          backup_eligible, backup_state, aaguid, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      id,
      userId,
      b64urlToBytes(info.credential.id),
      info.credential.publicKey,
      0,
      response.response.transports ? JSON.stringify(response.response.transports) : null,
      name,
      deviceType === "multiDevice" ? 1 : 0,
      info.credentialBackedUp ? 1 : 0,
      info.aaguid ?? null,
      nowSec(),
    )
    .run();
  return id;
}

/**
 * Burn an enrollment token atomically BEFORE storing the credential, so two
 * racing ceremonies on one link can't both enroll. False if already used.
 */
async function burnEnrollmentToken(db: D1Database, token: string): Promise<boolean> {
  const burned = await db
    .prepare("UPDATE enrollment_tokens SET used = 1 WHERE token_hash = ?1 AND used = 0")
    .bind(await sha256Hex(token))
    .run();
  return burned.meta.changes > 0;
}

/** User-chosen label, else the provider's name (AAGUID), else a generic one. */
function credentialName(requested: string | undefined, info: RegistrationInfo): string {
  const deviceType = info.credentialDeviceType ?? "singleDevice";
  return (
    requested?.trim().slice(0, 60) ||
    aaguidName(info.aaguid) ||
    (deviceType === "multiDevice" ? "Synced passkey" : "Security key")
  );
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
  if (!body.enrollmentToken) {
    const session = await getSession(c);
    if (!session || session.user.id !== stored.userId || !hasRecentStepUp(session)) {
      return c.json({ error: "reauth_required" }, 401);
    }
  }

  const rpID = rpIdFromIssuer(c.env.ISSUER);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: c.env.ISSUER,
      expectedRPID: rpID,
      requireUserVerification: true,
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

  if (body.enrollmentToken && !(await burnEnrollmentToken(c.env.DB, body.enrollmentToken))) {
    return c.json({ error: "invalid_enrollment_token" }, 400);
  }

  const name = credentialName(body.name, info);
  const credId = await persistCredential(c.env.DB, user.id, body.response, info, name);

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
    credId,
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
    // Threat note: this DOES reveal whether an email has passkeys (the allow
    // list is empty for unknown emails). Accepted: the email path exists only
    // for non-discoverable security keys, and there is no password to stuff.
    // The default sign-in button uses discoverable credentials and sends no
    // email at all.
  }
  const rpID = rpIdFromIssuer(c.env.ISSUER);
  const creds = user ? await getCredentialsForUser(c.env.DB, user.id) : [];
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: creds.map((cred) => ({
      id: credIdB64(cred),
      transports: cred.transports,
    })),
    userVerification: "required",
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
    stepUp?: boolean;
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
      requireUserVerification: true,
    });
  } catch {
    return c.json({ error: "auth_failed" }, 401);
  }
  if (!verification.verified || !verification.authenticationInfo) {
    return c.json({ error: "auth_failed" }, 401);
  }
  if (body.stepUp) {
    const prior = await getSession(c);
    if (!prior || prior.user.id !== user.id) return c.json({ error: "auth_failed" }, 401);
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
  await destroySession(c);
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
    cred.id,
    body.stepUp === true,
  );
  setSessionCookie(c, raw);
  return c.json({ ok: true, name: user.name });
});
