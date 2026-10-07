import { Hono } from "hono";
import { listClients } from "../db";
import type { AdminVars } from "./shell";
import { p } from "./shell";

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
    db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE disabled = 0")
      .first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM sessions")
      .first<{ n: number }>(),
    listClients(db),
    db.prepare("SELECT COUNT(*) AS n FROM groups").first<{ n: number }>(),
    db
      .prepare(
        `SELECT event, created_at, user_id FROM audit_log
         ORDER BY id DESC LIMIT 8`,
      )
      .all<{ event: string; created_at: number; user_id: string | null }>(),
  ]);

  const userNames = new Map<string, string>();
  const ids = [
    ...new Set(
      recentActivity.results.map((r) => r.user_id).filter(Boolean) as string[],
    ),
  ];
  if (ids.length) {
    const placeholders = ids.map(() => "?1").join(",");
    // D1 doesn't support variable placeholders cleanly; fetch individually.
    await Promise.all(
      ids.map(async (id, i) => {
        const u = await db
          .prepare("SELECT name FROM users WHERE id = ?1")
          .bind(id)
          .first<{ name: string }>();
        if (u) userNames.set(id, u.name);
      }),
    );
  }

  const stats = [
    { label: "Users", value: userCount?.n ?? 0, href: "/admin/" },
    { label: "Active sessions", value: activeSessions?.n ?? 0, href: "/admin/" },
    { label: "Apps", value: clients.length, href: "/admin/clients" },
    { label: "Groups", value: groupCount?.n ?? 0, href: "/admin/groups" },
  ];

  return await p(
    c,
    "dashboard",
    "Dashboard",
    <>
      <h1>Dashboard</h1>
      <div class="stat-grid">
        {stats.map((s) => (
          <a key={s.label} href={s.href} class="stat-card">
            <span class="stat-value">{s.value}</span>
            <span class="muted small">{s.label}</span>
          </a>
        ))}
      </div>
      <h2>Recent activity</h2>
      {recentActivity.results.length === 0 ? (
        <p class="muted small">No activity yet.</p>
      ) : (
        <ul class="key-list">
          {recentActivity.results.map((r, i) => (
            <li key={i}>
              <span class="key-name">{r.event.replace(/_/g, " ")}</span>
              <span class="muted small">
                {r.user_id ? userNames.get(r.user_id) ?? "unknown" : "system"} ·{" "}
                {new Date(r.created_at * 1000).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h2>Apps using Johnson ID</h2>
      {clients.length === 0 ? (
        <p class="muted small">
          No apps registered yet. <a href="/admin/clients">Register one</a>.
        </p>
      ) : (
        <ul class="key-list">
          {clients.map((cl) => (
            <li key={cl.id}>
              <span class="key-name">{cl.name}</span>
              <span class="muted small mono">{cl.id.slice(0, 12)}…</span>
            </li>
          ))}
        </ul>
      )}
    </>,
  );
});
