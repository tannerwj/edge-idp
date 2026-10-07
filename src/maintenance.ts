/**
 * Hourly cron: retention + garbage collection. Kept out of the request path
 * so no user-facing request pays for a table scan.
 */
import { nowSec } from "./util";

const DAY = 86400;
const AUDIT_MAX_ROWS = 50_000;
const AUDIT_MAX_AGE = 365 * DAY;
const MCP_CALLS_MAX_AGE = 30 * DAY;
const DCR_UNUSED_TTL = 30 * DAY;

export async function runMaintenance(db: D1Database): Promise<Record<string, number>> {
  const now = nowSec();
  const stmts = {
    challenges: db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?1").bind(now),
    codes: db.prepare("DELETE FROM auth_codes WHERE expires_at < ?1").bind(now - 3600),
    sessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
    enrollments: db
      .prepare("DELETE FROM enrollment_tokens WHERE expires_at < ?1 OR used = 1")
      .bind(now - 7 * DAY),
    // Rotated refresh tokens are kept a day for replay detection, then dropped.
    refresh: db
      .prepare(
        "DELETE FROM refresh_tokens WHERE expires_at < ?1 OR (rotated_at IS NOT NULL AND rotated_at < ?2)",
      )
      .bind(now, now - DAY),
    audit_age: db.prepare("DELETE FROM audit_log WHERE created_at < ?1").bind(now - AUDIT_MAX_AGE),
    // Index-friendly cap: everything older than the Nth-newest id.
    audit_cap: db.prepare(
      `DELETE FROM audit_log WHERE id < (SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ${AUDIT_MAX_ROWS})`,
    ),
    mcp_calls: db
      .prepare("DELETE FROM mcp_calls WHERE started_at < ?1")
      .bind(now - MCP_CALLS_MAX_AGE),
    // Dynamically registered clients that never got a consent are litter
    // (Cursor & co. register on every fresh connect).
    dcr_clients: db
      .prepare(
        `DELETE FROM oidc_clients WHERE source = 'dcr' AND created_at < ?1
         AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oidc_clients.id)`,
      )
      .bind(now - DCR_UNUSED_TTL),
  };
  const names = Object.keys(stmts);
  const results = await db.batch(Object.values(stmts));
  return Object.fromEntries(names.map((n, i) => [n, results[i]?.meta.changes ?? 0]));
}
