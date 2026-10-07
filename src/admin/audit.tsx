import { Hono } from "hono";
import type { AdminVars } from "./shell";
import { fmt, p } from "./shell";

const PER_PAGE = 50;

export const auditAdmin = new Hono<AdminVars>();

auditAdmin.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const offset = (page - 1) * PER_PAGE;
  const [{ n: total }, { results }] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>().then((r) => r ?? { n: 0 }),
    c.env.DB.prepare(
      `SELECT a.*, u.email AS email FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.id DESC LIMIT ?1 OFFSET ?2`,
    )
      .bind(PER_PAGE, offset)
      .all<{
        id: number;
        created_at: number;
        event: string;
        email: string | null;
        client_id: string | null;
        detail: string | null;
      }>(),
  ]);
  const totalPages = Math.max(1, Math.ceil((total ?? 0) / PER_PAGE));
  return await p(
    c,
    "audit",
    "Audit log",
    <>
      <h1>Audit log</h1>
      <p class="muted small">
        Newest first. IPs are stored as hashes. Page {page} of {totalPages} (
        {total ?? 0} events).
      </p>
      <div class="table-wrap">
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
      </div>
      <nav class="pagination">
        {page > 1 ? (
          <a class="btn small" href={`/admin/audit?page=${page - 1}`}>
            ← Newer
          </a>
        ) : null}
        {page < totalPages ? (
          <a class="btn small" href={`/admin/audit?page=${page + 1}`}>
            Older →
          </a>
        ) : null}
      </nav>
    </>,
  );
});
