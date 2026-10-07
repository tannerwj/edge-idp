import { Hono } from "hono";
import { listClients } from "../db";
import type { AdminVars } from "./shell";
import { fmt, p } from "./shell";

export const dashboardAdmin = new Hono<AdminVars>();

dashboardAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const now = Math.floor(Date.now() / 1000);
  const dayAgo = now - 86400;
  const weekAgo = now - 7 * 86400;

  const [
    userCount,
    activeSessions,
    clients,
    groupCount,
    recentActivity,
    signinsWeek,
    mcpCalls,
  ] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 0").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>(),
    listClients(db),
    db.prepare("SELECT COUNT(*) AS n FROM groups").first<{ n: number }>(),
    db
      .prepare(
        `SELECT a.event, a.created_at, u.email FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.id DESC LIMIT 10`,
      )
      .all<{ event: string; created_at: number; email: string | null }>(),
    // Sign-ins per day for the last 7 days (for sparkline)
    db
      .prepare(
        `SELECT CAST(created_at / 86400 AS INTEGER) AS day, COUNT(*) AS n
         FROM audit_log WHERE event = 'SIGN_IN' AND created_at >= ?1
         GROUP BY day ORDER BY day ASC`,
      )
      .bind(weekAgo)
      .all<{ day: number; n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM mcp_calls WHERE started_at >= ?1")
      .bind(dayAgo)
      .first<{ n: number }>(),
  ]);

  // Build 7-day sparkline data
  const todayDay = Math.floor(now / 86400);
  const sparkData = Array.from({ length: 7 }, (_, i) => {
    const day = todayDay - 6 + i;
    const found = signinsWeek.results.find((r) => r.day === day);
    return found?.n ?? 0;
  });
  const maxSpark = Math.max(...sparkData, 1);

  const prodApps = clients.filter((cl) => cl.environment === "production").length;
  const nonProdApps = clients.length - prodApps;

  return await p(
    c,
    "dashboard",
    "Dashboard",
    <>
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-value">{userCount?.n ?? 0}</span>
          <span class="stat-label">Active users</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{activeSessions?.n ?? 0}</span>
          <span class="stat-label">Active sessions</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{clients.length}</span>
          <span class="stat-label">
            Apps ({prodApps} prod{nonProdApps ? `, ${nonProdApps} non-prod` : ""})
          </span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{groupCount?.n ?? 0}</span>
          <span class="stat-label">Groups</span>
        </div>
      </div>

      <div class="widget-grid">
        <div class="widget">
          <h3>Sign-ins · last 7 days</h3>
          <div class="sparkline">
            {sparkData.map((v, i) => (
              <div
                key={i}
                class="spark-bar"
                style={`height: ${Math.max(4, (v / maxSpark) * 100)}%`}
                title={`${v} sign-ins`}
              ></div>
            ))}
          </div>
          <p class="muted small">
            {sparkData.reduce((a, b) => a + b, 0)} total sign-ins this week
          </p>
        </div>

        <div class="widget">
          <h3>Quick actions</h3>
          <div class="quick-actions">
            <a class="btn small primary" href="/admin/users">Add user</a>
            <a class="btn small" href="/admin/clients">Register app</a>
            <a class="btn small" href="/admin/groups">Create group</a>
            <a class="btn small" href="/admin/tokens">New API token</a>
          </div>
          {(mcpCalls?.n ?? 0) > 0 && (
            <p class="muted small">{mcpCalls?.n} MCP calls in the last 24h</p>
          )}
        </div>
      </div>

      <div class="widget-grid">
        <div class="widget">
          <h3>Recent activity</h3>
          {recentActivity.results.length === 0 ? (
            <p class="muted small">No activity yet.</p>
          ) : (
            <div class="widget-list">
              {recentActivity.results.map((r, i) => (
                <div class="widget-item" key={i}>
                  <span class="mono small">{r.event}</span>
                  <span class="muted small">
                    {r.email ?? "system"} · {fmt(r.created_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p>
            <a class="muted small" href="/admin/audit">View full audit log →</a>
          </p>
        </div>

        <div class="widget">
          <h3>Apps</h3>
          {clients.length === 0 ? (
            <p class="muted small">
              No apps yet. <a href="/admin/clients">Register one</a>.
            </p>
          ) : (
            <div class="widget-list">
              {clients.slice(0, 5).map((cl) => (
                <div class="widget-item" key={cl.id}>
                  <span>
                    {cl.name}{" "}
                    {cl.environment !== "production" && (
                      <span class="pill muted-pill">{cl.environment}</span>
                    )}
                  </span>
                  <a class="muted small" href="/admin/clients">Manage →</a>
                </div>
              ))}
            </div>
          )}
          {clients.length > 5 && (
            <p>
              <a class="muted small" href="/admin/clients">
                View all {clients.length} apps →
              </a>
            </p>
          )}
        </div>
      </div>
    </>,
  );
});
