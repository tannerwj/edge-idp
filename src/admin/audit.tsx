import { Hono } from "hono";
import type { AdminVars } from "./shell";
import { page } from "./shell";
import { Avatar, Empty, PageHead, Time } from "../ui/components";
import { eventMeta } from "../ui/feed";
import { Icon } from "../ui/icons";

const PER_PAGE = 50;

interface AuditRow {
  id: number;
  created_at: number;
  event: string;
  detail: string | null;
  user_agent: string | null;
  uid: string | null;
  name: string | null;
  email: string | null;
  client_name: string | null;
}

function AuditTable({ rows, total, pageNo, pages, qs }: { rows: AuditRow[]; total: number; pageNo: number; pages: number; qs: (p: number) => string }) {
  return (
    <div class="card">
      {rows.length ? (
        <>
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Who</th>
                  <th>App</th>
                  <th>When</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = eventMeta(r.event);
                  return (
                    <tr key={r.id}>
                      <td>
                        <span class="row-sm nowrap">
                          <span class={`ev-icon sm ${m.tone}`}>
                            <Icon name={m.icon} size="sm" />
                          </span>
                          {m.label}
                        </span>
                      </td>
                      <td>
                        {r.uid ? (
                          <a class="row-sm nowrap" href={`/admin/users/${r.uid}`}>
                            <Avatar name={r.name ?? "?"} seed={r.uid} size="sm" />
                            {r.name}
                          </a>
                        ) : (
                          <span class="muted">—</span>
                        )}
                      </td>
                      <td class="small">{r.client_name ?? <span class="muted">—</span>}</td>
                      <td class="muted small nowrap">
                        <Time ts={r.created_at} />
                      </td>
                      <td class="small">
                        {r.detail ? (
                          <details class="disclose">
                            <summary>View</summary>
                            <pre class="json">{JSON.stringify(JSON.parse(r.detail), null, 2)}</pre>
                          </details>
                        ) : (
                          <span class="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div class="pager">
            <span>
              {total.toLocaleString()} event{total === 1 ? "" : "s"} · page {pageNo} of {pages}
            </span>
            {pageNo > 1 ? (
              <a class="btn sm" href={qs(pageNo - 1)}>
                <Icon name="chevronLeft" size="sm" />
                Newer
              </a>
            ) : null}
            {pageNo < pages ? (
              <a class="btn sm" href={qs(pageNo + 1)}>
                Older
                <Icon name="chevronRight" size="sm" />
              </a>
            ) : null}
          </div>
        </>
      ) : (
        <Empty icon="list" title="No matching events" />
      )}
    </div>
  );
}

export const auditAdmin = new Hono<AdminVars>();

const catLink = (cat: string) => (cat ? `/admin/audit?category=${cat}` : "/admin/audit");

/** Event categories for the quick filter. */
const CATEGORIES: Record<string, string[]> = {
  signins: ["SIGN_IN", "SIGN_OUT", "ACCESS_DENIED"],
  security: ["ACCESS_DENIED", "REFRESH_REUSE_DETECTED", "PASSKEY_COUNTER_REGRESSION", "PASSKEYS_REVOKED", "CODE_REJECTED", "ADMIN_GRANTED", "API_TOKEN_CREATED", "SETUP_REJECTED"],
  passkeys: ["PASSKEY_REGISTERED", "PASSKEY_REMOVED", "PASSKEY_RENAMED", "PASSKEYS_REVOKED", "ENROLLMENT_STARTED"],
  admin: [
    "SETUP_COMPLETED", "USER_CREATED", "USER_DELETED", "USER_DISABLED", "USER_ENABLED", "USER_PROFILE_UPDATED", "USER_GROUPS_UPDATED",
    "ADMIN_GRANTED", "ADMIN_REVOKED", "GROUP_CREATED", "GROUP_DELETED", "GROUP_MEMBER_ADDED", "GROUP_MEMBER_REMOVED",
    "CLIENT_CREATED", "CLIENT_UPDATED", "CLIENT_DELETED", "CLIENT_SECRET_ROTATED", "APP_CREATED", "APP_UPDATED", "APP_DELETED",
    "SETTINGS_CHANGED", "API_TOKEN_CREATED", "API_TOKEN_REVOKED",
  ],
  oauth: ["CONSENT_GRANTED", "CONSENT_DENIED", "CONSENT_REVOKED", "CLIENT_REGISTERED", "CLIENT_DISCOVERED", "TOKEN_ISSUED", "REFRESH_REUSE_DETECTED"],
};

auditAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const pageNo = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
  const event = (c.req.query("event") ?? "").trim().toUpperCase();
  const category = c.req.query("category") ?? "";
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const where: string[] = [];
  const binds: unknown[] = [];
  if (event) {
    binds.push(event);
    where.push(`a.event = ?${binds.length}`);
  } else if (CATEGORIES[category]) {
    const list = CATEGORIES[category];
    where.push(`a.event IN (${list.map((e) => { binds.push(e); return `?${binds.length}`; }).join(",")})`);
  } else {
    where.push("a.event NOT IN ('CODE_ISSUED','TOKEN_ISSUED')");
  }
  if (q) {
    binds.push(`%${q}%`);
    where.push(`(lower(u.email) LIKE ?${binds.length} OR lower(u.name) LIKE ?${binds.length} OR lower(c.name) LIKE ?${binds.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const from = `FROM audit_log a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN oidc_clients c ON c.id = a.client_id ${whereSql}`;
  const [countRow, rows, eventTypes] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...binds).first<{ n: number }>(),
    db
      .prepare(
        `SELECT a.id, a.created_at, a.event, a.detail, a.user_agent, u.id AS uid, u.name, u.email, c.name AS client_name ${from}
         ORDER BY a.id DESC LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`,
      )
      .bind(...binds, PER_PAGE, (pageNo - 1) * PER_PAGE)
      .all<{ id: number; created_at: number; event: string; detail: string | null; user_agent: string | null; uid: string | null; name: string | null; email: string | null; client_name: string | null }>(),
    db.prepare("SELECT DISTINCT event FROM audit_log ORDER BY event").all<{ event: string }>(),
  ]);
  const total = countRow?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (event) u.set("event", event);
    if (category) u.set("category", category);
    if (q) u.set("q", q);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return s ? `/admin/audit?${s}` : "/admin/audit";
  };
  return await page(
    c,
    { active: "audit", title: "Audit log" },
    <>
      <PageHead
        title="Audit log"
        lede="Every sign-in, change and security signal. Kept for a year (newest 50,000 events)."
        actions={
          <a class="btn" href="/admin/audit.csv">
            <Icon name="download" size="sm" />
            Export CSV
          </a>
        }
      />
      <div class="filters">
        <div class="segmented">
          {[
            ["", "All"],
            ["signins", "Sign-ins"],
            ["security", "Security"],
            ["passkeys", "Passkeys"],
            ["admin", "Admin"],
            ["oauth", "OAuth"],
          ].map(([k, label]) => (
            <a key={k} href={catLink(k ?? "")} class={category === k && !event ? "active" : ""}>
              {label}
            </a>
          ))}
        </div>
        <form method="get" action="/admin/audit" class="row-sm right wrap">
          {category ? <input type="hidden" name="category" value={category} /> : null}
          <div class="input-search">
            <Icon name="search" size="sm" />
            <input type="search" name="q" value={q} placeholder="Person or app…" aria-label="Search" />
          </div>
          <select name="event" aria-label="Event" data-autosubmit>
            <option value="">Any event</option>
            {eventTypes.results.map((e) => (
              <option key={e.event} value={e.event} selected={e.event === event}>
                {eventMeta(e.event).label}
              </option>
            ))}
          </select>
        </form>
      </div>
      <AuditTable rows={rows.results} total={total} pageNo={pageNo} pages={pages} qs={qs} />
    </>,
  );
});

/** CSV cell: neutralize spreadsheet formula injection, then quote. */
const esc = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  // Neutralize spreadsheet formula injection, then CSV-quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** CSV export (newest 10k events), served at /admin/audit.csv. */
export async function auditCsv(db: D1Database): Promise<string> {
  const { results } = await db
    .prepare(
      `SELECT a.created_at, a.event, u.email, c.name AS client, a.detail FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN oidc_clients c ON c.id = a.client_id
       ORDER BY a.id DESC LIMIT 10000`,
    )
    .all<{ created_at: number; event: string; email: string | null; client: string | null; detail: string | null }>();
  return [
    "time,event,user,client,detail",
    ...results.map((r) => [new Date(r.created_at * 1000).toISOString(), r.event, r.email, r.client, r.detail].map(esc).join(",")),
  ].join("\n");
}
