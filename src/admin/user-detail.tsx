import { Hono } from "hono";
import { getCredentialsForUser, getUser, getUserGroups, listGroups } from "../db";
import { nowSec } from "../util";
import type { AdminVars } from "./shell";
import { page } from "./shell";
import { Avatar, PageHead, PostButton } from "../ui/components";
import { ActivityTab, ConnectedAppsTab, OverviewTab, PasskeysTab, SessionsTab } from "./user-tabs";
import type { TabData } from "./user-tabs";

export const userDetailAdmin = new Hono<AdminVars>();

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "passkeys", label: "Passkeys" },
  { id: "devices", label: "Sessions" },
  { id: "apps", label: "Connected apps" },
  { id: "activity", label: "Activity" },
] as const;

userDetailAdmin.get("/", async (c) => {
  const id = c.req.param("id") ?? "";
  const db = c.env.DB;
  const user = await getUser(db, id);
  if (!user) return c.notFound();
  const tab = TABS.find((t) => t.id === c.req.query("tab"))?.id ?? "overview";
  const self = id === c.get("admin").id;
  const [creds, groups, allGroups, sessions, grants, activity] = await Promise.all([
    getCredentialsForUser(db, id),
    getUserGroups(db, id),
    listGroups(db),
    db
      .prepare(
        "SELECT id_hash, created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ?1 AND expires_at > ?2 ORDER BY last_seen_at DESC",
      )
      .bind(id, nowSec())
      .all<{
        id_hash: string;
        created_at: number;
        last_seen_at: number;
        user_agent: string | null;
      }>(),
    db
      .prepare(
        `SELECT g.client_id, g.scope, g.created_at, g.last_used_at, c.name FROM oauth_grants g
         JOIN oidc_clients c ON c.id = g.client_id WHERE g.user_id = ?1`,
      )
      .bind(id)
      .all<{
        client_id: string;
        scope: string;
        created_at: number;
        last_used_at: number | null;
        name: string;
      }>(),
    db
      .prepare(
        `SELECT a.event, a.created_at, c.name AS client_name FROM audit_log a
         LEFT JOIN oidc_clients c ON c.id = a.client_id WHERE a.user_id = ?1 ORDER BY a.id DESC LIMIT 40`,
      )
      .bind(id)
      .all<{ event: string; created_at: number; client_name: string | null }>(),
  ]);
  const data: TabData = {
    id,
    self,
    user,
    creds,
    groups,
    allGroups,
    sessions: sessions.results,
    grants: grants.results,
    activity: activity.results,
  };
  const counts: Record<string, number> = {
    passkeys: creds.length,
    devices: sessions.results.length,
    apps: grants.results.length,
  };

  return await page(
    c,
    {
      active: "users",
      title: user.name,
      crumbs: [{ label: "People", href: "/admin/users" }, { label: user.name }],
    },
    <>
      <PageHead
        leading={<Avatar name={user.name} seed={user.id} size="lg" />}
        title={user.name}
        lede={
          <span class="row-sm wrap">
            {user.email}
            {user.is_admin ? <span class="badge accent">Admin</span> : null}
            {user.disabled ? (
              <span class="badge bad dot">Disabled</span>
            ) : (
              <span class="badge ok dot">Active</span>
            )}
            {!creds.length && !user.disabled ? (
              <span class="badge warn">No passkey yet</span>
            ) : null}
          </span>
        }
        actions={
          <>
            <PostButton
              action={`/admin/users/${id}/enrollment`}
              label={creds.length ? "New enrollment link" : "Get invite link"}
              icon="link"
              class="btn"
            />
            {self ? null : user.disabled ? (
              <PostButton
                action={`/admin/users/${id}/enable`}
                label="Enable"
                icon="check"
                class="btn"
              />
            ) : (
              <PostButton
                action={`/admin/users/${id}/disable`}
                label="Disable"
                icon="ban"
                class="btn danger"
                confirm={`Disable ${user.name}? They'll be signed out everywhere immediately.`}
              />
            )}
          </>
        }
      />
      <nav class="tabs">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={t.id === "overview" ? `/admin/users/${id}` : `/admin/users/${id}?tab=${t.id}`}
            class={tab === t.id ? "active" : ""}
          >
            {t.label}
            {counts[t.id] !== undefined ? <span class="count">{counts[t.id]}</span> : null}
          </a>
        ))}
      </nav>

      {tab === "overview" ? <OverviewTab {...data} /> : null}

      {tab === "passkeys" ? <PasskeysTab {...data} /> : null}

      {tab === "devices" ? <SessionsTab {...data} /> : null}

      {tab === "apps" ? <ConnectedAppsTab {...data} /> : null}

      {tab === "activity" ? <ActivityTab {...data} /> : null}
    </>,
  );
});
