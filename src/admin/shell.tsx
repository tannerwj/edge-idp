import type { Context } from "hono";
import type { Env } from "../config";
import type { User } from "../db";
import { nowSec, randomToken, sha256Hex } from "../util";

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

const TABS: [string, string][] = [
  ["users", "Users"],
  ["groups", "Groups"],
  ["clients", "Apps"],
  ["audit", "Audit log"],
];

export function page(
  rpName: string,
  active: string,
  adminName: string,
  title: string,
  children: unknown,
) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <title>
          {title} · Admin · {rpName}
        </title>
        <link rel="stylesheet" href="/styles.css" />
        <script src="/webauthn.js" defer></script>
      </head>
      <body>
        <main class="shell wide">
          <div class="card">
            <div class="brand">
              <span class="brand-mark" aria-hidden="true">
                ◆
              </span>
              <span class="brand-name">{rpName} · Admin</span>
              <span class="muted small right">{adminName}</span>
            </div>
            <nav class="tabs">
              {TABS.map(([id, label]) => (
                <a
                  key={id}
                  href={id === "users" ? "/admin/" : `/admin/${id}`}
                  class={active === id ? "tab active" : "tab"}
                >
                  {label}
                </a>
              ))}
              <a class="tab" href="/">
                Sign-in page
              </a>
            </nav>
            {children}
          </div>
        </main>
      </body>
    </html>
  );
}

export const p = (c: ACtx, active: string, title: string, children: unknown) =>
  c.html(page(c.env.RP_NAME, active, c.get("admin").name, title, children));

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
