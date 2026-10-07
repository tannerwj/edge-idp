import { Hono } from "hono";
import { VERSION } from "../assets.gen";
import { availableUpdate } from "../upstream";
import { count } from "../db";
import { nowSec } from "../util";
import type { AdminVars } from "./shell";
import { page } from "./shell";
import { Callout, Empty, PageHead } from "../ui/components";
import { Feed } from "../ui/feed";
import type { FeedRow } from "../ui/feed";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";

function ActivityGrid({ recent, topClients, maxTop }: { recent: FeedRow[]; topClients: { id: string; name: string; n: number }[]; maxTop: number }) {
  return (
    <div class="grid-3">
      <section class="card span-2">
        <div class="card-head">
          <h2>Recent activity</h2>
          <a class="right small" href="/admin/audit">
            Audit log
          </a>
        </div>
        {recent.length ? <Feed rows={recent} /> : <Empty icon="activity" title="No activity yet" />}
      </section>
      <section class="card">
        <div class="card-head">
          <h2>Most used · 14 days</h2>
        </div>
        {topClients.length ? (
          <ul class="list">
            {topClients.map((r) => (
              <li key={r.id} class="stack-sm top-client">
                <div class="row between">
                  <a href={`/admin/clients/${encodeURIComponent(r.id)}`} class="title truncate">
                    {r.name}
                  </a>
                  <span class="muted small">{r.n}</span>
                </div>
                <div class="meter">
                  <span data-w={String(Math.round((r.n / maxTop) * 10))}></span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="plug" title="No sign-ins yet">
            App sign-ins will rank here.
          </Empty>
        )}
      </section>
    </div>
  );
}

export const dashboardAdmin = new Hono<AdminVars>();

const DAY = 86400;

/** 0–19 bar buckets for the sparkline CSS (data-v), scaled to the max. */
function bars(values: number[]): { day: number; v: string; zero: boolean; n: number }[] {
  const max = Math.max(1, ...values);
  return values.map((n, day) => ({ day, v: String(Math.round((n / max) * 19)), zero: n === 0, n }));
}

function Stat(props: { label: string; value: string | number; icon: IconName; sub?: unknown; spark?: number[]; href?: string }) {
  const body = (
    <div class="stat">
      <span class="k">
        <Icon name={props.icon} size="sm" />
        {props.label}
      </span>
      <span class="v">{props.value}</span>
      {props.spark ? (
        <div class="spark" aria-hidden="true">
          {bars(props.spark).map((b) => (
            <span key={b.day} data-v={b.v} class={b.zero ? "zero" : ""} title={String(b.n)}></span>
          ))}
        </div>
      ) : null}
      {props.sub ? <span class="d">{props.sub}</span> : null}
    </div>
  );
  return props.href ? (
    <a class="card stat-link" href={props.href}>
      {body}
    </a>
  ) : (
    <div class="card">{body}</div>
  );
}

type Attention = { tone: "warn" | "bad" | "accent"; icon: IconName; text: unknown; href: string };

/** "Needs attention" cards on the overview, most actionable first. */
function attentionItems(x: { update: string | null; admins: number; pending: string[]; expiringTokens: number; denied: number }): Attention[] {
  const out: Attention[] = [];
  if (x.update) {
    out.push({ tone: "accent", icon: "sparkles", text: <><b>edge-idp v{x.update} is available.</b> You're on v{VERSION}.</>, href: "/admin/settings#about" });
  }
  if (x.admins < 2) {
    out.push({ tone: "warn", icon: "shield", text: <><b>Only one admin.</b> Promote a second person so a lost device never locks you out of admin.</>, href: "/admin/users" });
  }
  if (x.pending.length) {
    out.push({ tone: "accent", icon: "userPlus", text: <><b>{x.pending.length === 5 ? "5+" : x.pending.length} {x.pending.length === 1 ? "person hasn't" : "people haven't"}</b> set up a passkey yet: {x.pending.join(", ")}.</>, href: "/admin/users?filter=pending" });
  }
  if (x.expiringTokens) {
    out.push({ tone: "warn", icon: "key", text: <><b>{x.expiringTokens} API token{x.expiringTokens === 1 ? "" : "s"}</b> expire within a week.</>, href: "/admin/tokens" });
  }
  if (x.denied) {
    out.push({ tone: "bad", icon: "alert", text: <><b>{x.denied} security event{x.denied === 1 ? "" : "s"}</b> in the last 7 days (denied access, token replay, or cloned-key signals).</>, href: "/admin/audit?category=security" });
  }
  return out;
}

dashboardAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const now = nowSec();
  const since = now - 14 * DAY;
  const dayStart = Math.floor(now / DAY) * DAY;

  const [
    users,
    admins,
    noKeys,
    sessions,
    apps,
    clients,
    dynClients,
    signInsByDay,
    topClients,
    recent,
    expiringTokens,
    denied,
  ] = await Promise.all([
    count(db, "SELECT COUNT(*) AS n FROM users WHERE disabled = 0"),
    count(db, "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0"),
    db
      .prepare(
        `SELECT u.id, u.name, u.email FROM users u
         WHERE u.disabled = 0 AND NOT EXISTS (SELECT 1 FROM webauthn_credentials k WHERE k.user_id = u.id)
         ORDER BY u.created_at DESC LIMIT 5`,
      )
      .all<{ id: string; name: string; email: string }>(),
    count(db, "SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?1", now),
    count(db, "SELECT COUNT(*) AS n FROM apps"),
    count(db, "SELECT COUNT(*) AS n FROM oidc_clients"),
    count(db, "SELECT COUNT(*) AS n FROM oidc_clients WHERE source != 'admin'"),
    db
      .prepare(
        `SELECT CAST((created_at - ?2) / ${DAY} AS INTEGER) AS d, COUNT(*) AS n FROM audit_log
         WHERE event = 'SIGN_IN' AND created_at >= ?1 GROUP BY d`,
      )
      .bind(dayStart - 13 * DAY, dayStart - 13 * DAY)
      .all<{ d: number; n: number }>(),
    db
      .prepare(
        `SELECT c.id, c.name, COUNT(*) AS n FROM audit_log a JOIN oidc_clients c ON c.id = a.client_id
         WHERE a.event = 'CODE_ISSUED' AND a.created_at >= ?1 GROUP BY c.id ORDER BY n DESC LIMIT 5`,
      )
      .bind(since)
      .all<{ id: string; name: string; n: number }>(),
    db
      .prepare(
        `SELECT a.event, a.created_at, u.name, u.email, c.name AS client_name FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id LEFT JOIN oidc_clients c ON c.id = a.client_id
         WHERE a.event NOT IN ('CODE_ISSUED', 'TOKEN_ISSUED')
         ORDER BY a.id DESC LIMIT 10`,
      )
      .all<{ event: string; created_at: number; name: string | null; email: string | null; client_name: string | null }>(),
    count(db, "SELECT COUNT(*) AS n FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at BETWEEN ?1 AND ?2", now, now + 7 * DAY),
    count(db, "SELECT COUNT(*) AS n FROM audit_log WHERE event IN ('ACCESS_DENIED','REFRESH_REUSE_DETECTED','PASSKEY_COUNTER_REGRESSION') AND created_at >= ?1", now - 7 * DAY),
  ]);

  const days = Array.from({ length: 14 }, (_, i) => signInsByDay.results.find((r) => r.d === i)?.n ?? 0);
  const total14 = days.reduce((a, b) => a + b, 0);
  const maxTop = Math.max(1, ...topClients.results.map((r) => r.n));

  const attention = attentionItems({ update: await availableUpdate(c.env), admins, pending: noKeys.results.map((u) => u.name), expiringTokens, denied });

  return await page(
    c,
    { active: "overview", title: "Overview" },
    <>
      <PageHead
        title="Overview"
        lede={`Everything happening on ${c.env.RP_NAME}.`}
        actions={
          <>
            <a class="btn" href="/admin/users?invite=1">
              <Icon name="userPlus" size="sm" />
              Invite someone
            </a>
            <a class="btn primary" href="/admin/apps?new=1">
              <Icon name="plus" size="sm" />
              Add app
            </a>
          </>
        }
      />
      <div class="stack-lg">
        <div class="grid-4">
          <Stat label="People" icon="users" value={users} sub={`${admins} admin${admins === 1 ? "" : "s"}`} href="/admin/users" />
          <Stat label="Sign-ins · 14 days" icon="logIn" value={total14} spark={days} href="/admin/audit?event=SIGN_IN" />
          <Stat label="Apps" icon="grid" value={apps} sub={`${clients} OAuth client${clients === 1 ? "" : "s"}${dynClients ? ` · ${dynClients} connected` : ""}`} href="/admin/apps" />
          <Stat label="Active sessions" icon="monitor" value={sessions} sub="Browser sessions on this IdP" />
        </div>

        {attention.length ? (
          <section class="stack-sm">
            {attention.map((a) => (
              <a key={a.href} class="attention" href={a.href}>
                <Callout tone={a.tone} icon={a.icon}>
                  <div class="row between">
                    <span>{a.text}</span>
                    <Icon name="chevronRight" size="sm" />
                  </div>
                </Callout>
              </a>
            ))}
          </section>
        ) : null}

        <ActivityGrid recent={recent.results} topClients={topClients.results} maxTop={maxTop} />
      </div>
    </>,
  );
});
