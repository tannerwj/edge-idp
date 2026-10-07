import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { getUser } from "./db";
import type { Env } from "./config";
import type { User } from "./db";
import { nowSec, randomToken, sha256Hex } from "./util";

export const SESSION_COOKIE = "__Host-idp_session";
const SESSION_TTL = 30 * 24 * 3600;
const STEP_UP_TTL = 5 * 60;

export interface Session {
  user: User;
  idHash: string;
  authTime: number;
  stepUpAt: number | null;
}

export function hasRecentStepUp(session: Session): boolean {
  return session.stepUpAt !== null && nowSec() - session.stepUpAt <= STEP_UP_TTL;
}

export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string | null,
  ip: string | null,
  credentialId: string | null = null,
  stepUp = false,
): Promise<string> {
  const raw = randomToken(32);
  const now = nowSec();
  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip_hash, credential_id, step_up_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
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
    "SELECT user_id, created_at, expires_at, last_seen_at, step_up_at FROM sessions WHERE id_hash = ?1",
  )
    .bind(hash)
    .first<{
      user_id: string;
      created_at: number;
      expires_at: number;
      last_seen_at: number;
      step_up_at: number | null;
    }>();
  const now = nowSec();
  if (!row || row.expires_at < now) {
    if (row) {
      await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1").bind(hash).run();
    }
    return null;
  }
  const user = await getUser(c.env.DB, row.user_id);
  if (!user || user.disabled) return null;
  if (now - row.last_seen_at > 60) {
    const slide = c.env.DB.prepare(
      "UPDATE sessions SET expires_at = ?1, last_seen_at = ?2 WHERE id_hash = ?3",
    )
      .bind(now + SESSION_TTL, now, hash)
      .run()
      .catch(() => {});
    c.executionCtx.waitUntil(slide);
  }
  return { user, idHash: hash, authTime: row.created_at, stepUpAt: row.step_up_at };
}

export async function sessionUser<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<User | null> {
  return (await getSession(c))?.user ?? null;
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
