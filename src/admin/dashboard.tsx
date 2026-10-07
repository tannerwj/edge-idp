import { Hono } from "hono";
import { listClients } from "../db";
import type { AdminVars } from "./shell";
import { fmt, p } from "./shell";

export const dashboardAdmin = new Hono<AdminVars>();

dashboardAdmin.get("/", async (c) => {
  const db = c.env.DB;

  const [
    userCount,
    activeSessions,
    clients,
    groupCount,
    recentActivity,
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
  ]);

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

      <h2>Apps</h2>
      {clients.length === 0 ? (
        <div class="card">
          <p class="muted">No apps registered yet.</p>
          <p>
            <a class="btn primary small" href="/admin/clients">Register your first app</a>
          </p>
        </div>
      ) : (
        <div class="widget-grid">
          {clients.map((cl) => (
            <div class="widget" key={cl.id}>
              <h3>
                {cl.name}{" "}
                {cl.environment !== "production" && (
                  <span class="pill muted-pill">{cl.environment}</span>
                )}
              </h3>
              <p class="muted small mono">{cl.id.slice(0, 16)}…</p>
              <p class="muted small">
                {cl.redirect_uris.length} redirect URI{cl.redirect_uris.length === 1 ? "" : "s"} ·{" "}
                {cl.allowed_groups?.length ? cl.allowed_groups.join(", ") : "everyone"}
              </p>
              <p>
                <a class="btn small" href="/admin/clients">Manage</a>
              </p>
            </div>
          ))}
        </div>
      )}

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
    </>,
  );
});
