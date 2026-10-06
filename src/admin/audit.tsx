import { Hono } from "hono";
import type { AdminVars } from "./shell";
import { fmt, p } from "./shell";

export const auditAdmin = new Hono<AdminVars>();

auditAdmin.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT a.*, u.email AS email FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.id DESC LIMIT 200`,
  ).all<{
    id: number;
    created_at: number;
    event: string;
    email: string | null;
    client_id: string | null;
    detail: string | null;
  }>();
  return p(
    c,
    "audit",
    "Audit log",
    <>
      <h1>Audit log</h1>
      <p class="muted small">
        Newest first, last 200 events. IPs are stored as hashes.
      </p>
      <table class="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Event</th>
            <th>User</th>
            <th>App</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.id}>
              <td class="muted small">{fmt(r.created_at)}</td>
              <td class="mono small">{r.event}</td>
              <td class="muted small">{r.email ?? "—"}</td>
              <td class="muted small mono">{r.client_id ?? "—"}</td>
              <td class="muted small">{r.detail ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>,
  );
});
