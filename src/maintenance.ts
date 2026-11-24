import { nowSec } from "./util";

const DAY = 86400;
const AUDIT_MAX_ROWS = 50_000;
const AUDIT_MAX_AGE = 365 * DAY;
const MCP_CALLS_MAX_AGE = 30 * DAY;
const DCR_UNUSED_TTL = 30 * DAY;

export async function runMaintenance(db: D1Database): Promise<Record<string, number>> {
  const now = nowSec();
  const stmts = {
    logout_receipts: db
      .prepare("DELETE FROM logout_deliveries WHERE created_at<?")
      .bind(now - 30 * DAY),
    closed_feedback: db.prepare(`WITH eligible AS (
      SELECT f.id,f.updated_at FROM feedback f LEFT JOIN feedback_shares s ON s.feedback_id=f.id
      WHERE f.status IN ('done','declined') AND (s.feedback_id IS NULL OR s.remote_status IN ('done','declined'))
    ) DELETE FROM feedback WHERE id IN (SELECT id FROM eligible WHERE updated_at<unixepoch()-15552000)
    OR id IN (SELECT id FROM eligible ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 1000)`),
    temporary_grants: db.prepare("DELETE FROM temporary_app_grants WHERE expires_at<=?").bind(now),
    challenges: db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?1").bind(now),
    codes: db.prepare("DELETE FROM auth_codes WHERE expires_at < ?1").bind(now - 3600),
    sessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(now),
    enrollments: db
      .prepare("DELETE FROM enrollment_tokens WHERE expires_at < ?1 OR used = 1")
      .bind(now - 7 * DAY),
    refresh: db
      .prepare(
        "DELETE FROM refresh_tokens WHERE expires_at < ?1 OR (rotated_at IS NOT NULL AND rotated_at < ?2)",
      )
      .bind(now, now - DAY),
    audit_age: db.prepare("DELETE FROM audit_log WHERE created_at < ?1").bind(now - AUDIT_MAX_AGE),
    audit_cap: db.prepare(
      `DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log) - ${AUDIT_MAX_ROWS}`,
    ),
    secret_pickups: db.prepare("DELETE FROM secret_pickups WHERE expires_at < ?1").bind(now),
    email_changes: db.prepare("DELETE FROM email_changes WHERE expires_at < ?1").bind(now),
    magic_links: db.prepare("DELETE FROM magic_links WHERE expires_at < ?1").bind(now),
    retired_keys: db
      .prepare("DELETE FROM signing_keys WHERE id = 'previous' AND retire_at < ?1")
      .bind(now),
    mcp_calls: db
      .prepare("DELETE FROM mcp_calls WHERE started_at < ?1")
      .bind(now - MCP_CALLS_MAX_AGE),
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
