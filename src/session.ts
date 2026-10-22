import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { rowToUser } from "./db";
import type { Env } from "./config";
import type { User } from "./db";
import type { StepUpWindow } from "./settings-cache";
import { nowSec, randomToken, sha256Hex } from "./util";

export const SESSION_COOKIE = "__Host-idp_session";
const SESSION_TTL = 30 * 24 * 3600;
const STEP_UP_TTL = 5 * 60;

export type SignInMethod = "passkey" | "email";

export interface Session {
  user: User;
  idHash: string;
  authTime: number;
  stepUpAt: number | null;
  method: SignInMethod;
}

export function hasRecentStepUp(session: Session, ttl = STEP_UP_TTL): boolean {
  return session.stepUpAt !== null && nowSec() - session.stepUpAt <= ttl;
}

export function adminStepUpOk(session: Session, window: StepUpWindow): boolean {
  return window === "off" || hasRecentStepUp(session, Number(window) * 60);
}

export interface NewSession {
  userAgent: string | null;
  ip: string | null;
  credentialId?: string | null;
  stepUp?: boolean;
  method?: SignInMethod;
}

export async function createSession(
  db: D1Database,
  userId: string,
  opts: NewSession,
): Promise<string> {
  const { userAgent, ip, credentialId = null, stepUp = false, method = "passkey" } = opts;
  const raw = randomToken(32);
  const now = nowSec();
  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip_hash, credential_id, step_up_at, method)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(
        await sha256Hex(raw),
        userId,
        now,
        now + SESSION_TTL,
        now,
        userAgent?.slice(0, 300) ?? null,
        ip ? await sha256Hex(ip) : null,
        credentialId,
        stepUp ? now : null,
        method,
      ),
    db.prepare("UPDATE users SET last_sign_in_at = ?1 WHERE id = ?2").bind(now, userId),
  ]);
  return raw;
}

export async function getSession<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<Session | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  const row = await c.env.DB.prepare(
    `SELECT u.*, s.created_at AS session_created_at, s.expires_at AS session_expires_at,
            s.last_seen_at AS session_last_seen_at, s.step_up_at AS session_step_up_at,
            s.method AS session_method
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?1`,
  )
    .bind(hash)
    .first();
  const now = nowSec();
  if (!row) return null;
  const expiresAt = Number(row.session_expires_at);
  if (expiresAt < now) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1").bind(hash).run();
    return null;
  }
  const user = rowToUser(row);
  if (user.disabled) return null;
  if (now - Number(row.session_last_seen_at) > 60) {
    const slide = c.env.DB.prepare(
      "UPDATE sessions SET expires_at = ?1, last_seen_at = ?2 WHERE id_hash = ?3",
    )
      .bind(now + SESSION_TTL, now, hash)
      .run()
      .catch(() => {});
    c.executionCtx.waitUntil(slide);
  }
  const stepUpAt = row.session_step_up_at;
  return {
    user,
    idHash: hash,
    authTime: Number(row.session_created_at),
    stepUpAt: typeof stepUpAt === "number" ? stepUpAt : null,
    method: row.session_method === "email" ? "email" : "passkey",
  };
}

export function setSessionCookie(c: Context, raw: string): void {
  setCookie(c, SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL,
  });
}

export async function destroySession<E extends { Bindings: Env }>(c: Context<E>): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1")
      .bind(await sha256Hex(raw))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });
}
