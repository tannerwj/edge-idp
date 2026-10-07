import type { Context } from "hono";
import type { Env } from "../config";
import type { User } from "../db";
import { getTheme } from "../theme-cache";
import { nowSec, randomToken, sha256Hex } from "../util";
import { AppShell, adminNav } from "../shell";

export type AdminVars = { Bindings: Env; Variables: { admin: User } };
export type ACtx = Context<AdminVars>;

/** Form fields from parseBody(): File uploads are never valid here. */
export function field(
  form: Record<string, string | File | undefined>,
  key: string,
): string {
  const v = form[key];
  return typeof v === "string" ? v : "";
}

export function fmt(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

export const p = async (
  c: ACtx,
  active: string,
  title: string,
  children: unknown,
) => {
  const admin = c.get("admin");
  return c.html(
    AppShell({
      rpName: c.env.RP_NAME,
      title,
      theme: await getTheme(c.env),
      userName: admin.name,
      userEmail: admin.email,
      isAdmin: true,
      active,
      nav: adminNav(),
      children,
    }),
  );
};

/** One-time enrollment link (7-day TTL, single-use, hashed at rest). */
export async function mintEnrollmentLink(
  db: D1Database,
  userId: string,
  issuer: string,
): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare(
      `INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)`,
    )
    .bind(await sha256Hex(token), userId, nowSec(), nowSec() + 7 * 86400)
    .run();
  return `${issuer}/enroll/${token}`;
}
