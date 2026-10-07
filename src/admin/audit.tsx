import { Hono } from "hono";
import type { AdminVars } from "./shell";
import { fmt, p } from "./shell";

const PER_PAGE = 25;

export const auditAdmin = new Hono<AdminVars>();

auditAdmin.get("/", async (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const eventFilter = (c.req.query("event") ?? "").trim();
  const userFilter = (c.req.query("user") ?? "").trim().toLowerCase();
  const offset = (page - 1) * PER_PAGE;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (eventFilter) {
    where.push("a.event = ?" + (binds.length + 1));
    binds.push(eventFilter);
  }
  if (userFilter) {
    where.push("lower(u.email) LIKE ?" + (binds.length + 1));
    binds.push(`%${userFilter}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [countRow, { results }, { results: eventTypes }] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>()
      .then((r) => r ?? { n: 0 }),
    c.env.DB.prepare(
      `SELECT a.*, u.email AS email FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
       ${whereSql}
       ORDER BY a.id DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
    )
      .bind(...binds, PER_PAGE, offset)
      .all<{
        id: number;
        created_at: number;
        event: string;
        email: string | null;
        client_id: string | null;
        detail: string | null;
      }>(),
    c.env.DB.prepare("SELECT DISTINCT event FROM audit_log ORDER BY event ASC")
      .all<{ event: string }>(),
  ]);

  const total = countRow.n;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const query = new URLSearchParams();
  if (eventFilter) query.set("event", eventFilter);
  if (userFilter) query.set("user", userFilter);
  const qs = query.toString() ? `&${query.toString()}` : "";

  return await p(
    c,
    "audit",
    "Audit log",
    <>
      <h1>Audit log</h1>
      <p class="muted small">
        {total} events{eventFilter || userFilter ? " (filtered)" : ""} · Page {page} of {totalPages}
      </p>
      <form method="get" action="/admin/audit" class="filters">
        <label class="field inline">
          <span>Event</span>
          <select name="event">
            <option value="">All events</option>
            {eventTypes.map((e) => (
              <option key={e.event} value={e.event} selected={e.event === eventFilter ? true : undefined}>
                {e.event}
              </option>
            ))}
          </select>
        </label>
        <label class="field inline">
          <span>User email</span>
          <input name="user" value={userFilter} placeholder="search…" maxLength={100} />
        </label>
        <button class="btn small" type="submit">Filter</button>
        {(eventFilter || userFilter) && (
          <a class="btn small ghost" href="/admin/audit">Clear</a>
        )}
      </form>
      <div class="table-wrap">
        <table class="table compact">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>User</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td class="muted small nowrap">{fmt(r.created_at)}</td>
                <td class="mono small">{r.event}</td>
                <td class="muted small">{r.email ?? "—"}</td>
                <td class="muted small">{r.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {results.length === 0 && <p class="muted">No events match.</p>}
      <nav class="pagination">
        {page > 1 && (
          <a class="btn small" href={`/admin/audit?page=${page - 1}${qs}`}>
            ← Newer
          </a>
        )}
        <span class="muted small">
          Page {page} of {totalPages}
        </span>
        {page < totalPages && (
          <a class="btn small" href={`/admin/audit?page=${page + 1}${qs}`}>
            Older →
          </a>
        )}
      </nav>
    </>,
  );
});
