import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import { getUser } from "./db";
import type { Env } from "./config";
import type { User } from "./db";
import { nowSec, randomToken, sha256Hex } from "./util";

/**
 * IdP browser sessions.
 *
 * Threat note: the cookie carries a random 256-bit token; the DB stores only
 * its SHA-256 hash, so a database read never yields a live session. Cookies
 * are HttpOnly + Secure + SameSite=Lax + __Host-style path-scoped. Sessions
 * slide (30d) on use and die with the user row (ON DELETE CASCADE).
 * SameSite=Lax is safe here because /authorize is always reached via top-level
 * GET navigation, never a cross-site POST.
 */

export const SESSION_COOKIE = "idp_session";
const SESSION_TTL = 30 * 24 * 3600;

export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string | null,
  ip: string | null,
): Promise<string> {
  const raw = randomToken(32);
  const now = nowSec();
  await db
    .prepare(
      `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      await sha256Hex(raw),
      userId,
      now,
      now + SESSION_TTL,
      now,
      userAgent?.slice(0, 300) ?? null,
      ip ? await sha256Hex(ip) : null,
    )
    .run();
  return raw;
}

/** Validate the session cookie; returns the user or null. Slides expiry. */
export async function sessionUser<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<User | null> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  const row = await c.env.DB.prepare(
    "SELECT user_id, expires_at FROM sessions WHERE id_hash = ?1",
  )
    .bind(hash)
    .first<{ user_id: string; expires_at: number }>();
  if (!row || row.expires_at < nowSec()) {
    if (row) {
      await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1")
        .bind(hash)
        .run();
    }
    return null;
  }
  const user = await getUser(c.env.DB, row.user_id);
  if (!user || user.disabled) return null;
  // Slide the session in the background — don't block the response on it.
  const slide = c.env.DB.prepare(
    "UPDATE sessions SET expires_at = ?1, last_seen_at = ?2 WHERE id_hash = ?3",
  )
    .bind(nowSec() + SESSION_TTL, nowSec(), hash)
    .run()
    .catch(() => {});
  c.executionCtx.waitUntil(slide);
  return user;
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

export async function destroySession<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<void> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (raw) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1")
      .bind(await sha256Hex(raw))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
