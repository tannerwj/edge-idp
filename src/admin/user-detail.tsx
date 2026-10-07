import { Hono } from "hono";
import { getCredentialsForUser } from "../db";
import type { AdminVars } from "./shell";
import { p } from "./shell";

export const userDetailAdmin = new Hono<AdminVars>();

type DetailData = {
  user: {
    id: string;
    name: string;
    email: string;
    is_admin: number;
    disabled: number;
    created_at: number;
  };
  creds: Awaited<ReturnType<typeof getCredentialsForUser>>;
  allGroups: { id: string; name: string }[];
  memberIds: Set<string>;
  sessions: { id: string; created_at: number; last_seen_at: number }[];
};

async function loadDetail(
  db: D1Database,
  id: string,
): Promise<DetailData | null> {
  const user = await db
    .prepare("SELECT * FROM users WHERE id = ?1")
    .bind(id)
    .first<DetailData["user"]>();
  if (!user) return null;
  const creds = await getCredentialsForUser(db, id);
  const { results: allGroups } = await db
    .prepare("SELECT id, name FROM groups ORDER BY name ASC")
    .all<{ id: string; name: string }>();
  const { results: memberOf } = await db
    .prepare("SELECT group_id FROM group_members WHERE user_id = ?1")
    .bind(id)
    .all<{ group_id: string }>();
  const { results: sessions } = await db
    .prepare(
      "SELECT id, created_at, last_seen_at FROM sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC LIMIT 10",
    )
    .bind(id)
    .all<{ id: string; created_at: number; last_seen_at: number }>();
  return {
    user,
    creds,
    allGroups,
    memberIds: new Set(memberOf.map((m) => m.group_id)),
    sessions,
  };
}

userDetailAdmin.get("/", async (c) => {
  const id = c.req.param("id") ?? "";
  if (!id) return c.text("User not found", 404);
  const data = await loadDetail(c.env.DB, id);
  if (!data) return c.text("User not found", 404);
  const { user, creds, allGroups, memberIds, sessions } = data;
  return await p(
    c,
    "users",
    user.name,
    <>
      <h1>{user.name}</h1>
      <p class="muted">
        {user.email} ·{" "}
        {user.is_admin ? <span class="pill">admin</span> : "standard"} ·{" "}
        {user.disabled ? "disabled" : "active"}
      </p>
      <h2>Edit profile</h2>
      <form method="post" action={`/admin/users/${id}/profile`} class="stack">
        <label class="field">
          <span>Name</span>
          <input name="name" required maxLength={120} value={user.name} />
        </label>
        <label class="field">
          <span>Email</span>
          <input name="email" type="email" required maxLength={254} value={user.email} />
        </label>
        <div class="row wrap">
          <button class="btn primary" type="submit">
            Save
          </button>
        </div>
      </form>
      <h2>Groups</h2>
      <form method="post" action={`/admin/users/${id}/groups`} class="stack">
        {allGroups.length === 0 ? (
          <p class="muted small">No groups exist yet — create one on the Groups tab.</p>
        ) : (
          <div class="check-grid">
            {allGroups.map((g) => (
              <label key={g.id} class="check">
                <input
                  type="checkbox"
                  name="groups"
                  value={g.id}
                  checked={memberIds.has(g.id)}
                />
                <span>{g.name}</span>
              </label>
            ))}
          </div>
        )}
        <div>
          <button class="btn" type="submit">
            Update groups
          </button>
        </div>
      </form>
      <h2>Role</h2>
      <form method="post" action={`/admin/users/${id}/role`} class="row wrap">
        <input type="hidden" name="isAdmin" value={user.is_admin ? "0" : "1"} />
        <button class="btn" type="submit" disabled={id === c.get("admin").id}>
          {user.is_admin ? "Remove admin" : "Make admin"}
        </button>
        {id === c.get("admin").id ? (
          <span class="muted small">You can't change your own role.</span>
        ) : null}
      </form>
      <h2>Passkeys ({creds.length})</h2>
      {creds.length === 0 ? (
        <p class="muted small">No passkeys enrolled.</p>
      ) : (
        <ul class="key-list">
          {creds.map((k) => (
            <li key={k.id}>
              <span class="key-name">{k.name}</span>
              <span class="muted small">
                added {new Date(k.created_at * 1000).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h2>Recent sessions ({sessions.length})</h2>
      {sessions.length === 0 ? (
        <p class="muted small">No active sessions.</p>
      ) : (
        <ul class="key-list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span class="muted small">
                last seen {new Date(s.last_seen_at * 1000).toLocaleString()}
              </span>
              <form method="post" action={`/admin/users/${id}/sessions/${s.id}/revoke`}>
                <button class="btn danger ghost small" type="submit">
                  Revoke
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <p>
        <a class="btn ghost" href="/admin/">
          Back to users
        </a>
      </p>
    </>,
  );
});
