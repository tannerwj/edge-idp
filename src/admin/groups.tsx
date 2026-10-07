import { Hono } from "hono";
import { getUserByEmail } from "../db";
import { newId, nowSec } from "../util";
import type { AdminVars } from "./shell";
import { field, p } from "./shell";

export const groupsAdmin = new Hono<AdminVars>();

groupsAdmin.get("/", async (c) => {
  const { results: groups } = await c.env.DB.prepare(
    "SELECT * FROM groups ORDER BY name ASC",
  ).all<{ id: string; name: string; description: string | null }>();
  const withMembers = await Promise.all(
    groups.map(async (g) => {
      const { results: members } = await c.env.DB.prepare(
        `SELECT u.id, u.name, u.email FROM users u
         JOIN group_members m ON m.user_id = u.id
         WHERE m.group_id = ?1 ORDER BY u.name ASC`,
      )
        .bind(g.id)
        .all<{ id: string; name: string; email: string }>();
      return { g, members };
    }),
  );
  return await p(
    c,
    "groups",
    "Groups",
    <>
      <h1>Groups</h1>
      <p class="muted">
        Groups become the <code>groups</code> claim in ID tokens — Cloudflare
        Access matches its policies against them.
      </p>
      <form method="post" action="/admin/groups" class="row wrap">
        <label class="field inline">
          <span>Name</span>
          <input name="name" required maxLength={60} placeholder="family" />
        </label>
        <label class="field inline">
          <span>Description</span>
          <input name="description" maxLength={200} />
        </label>
        <button class="btn primary" type="submit">
          Create group
        </button>
      </form>
      {withMembers.map(({ g, members }) => (
        <section key={g.id} class="group-block">
          <h2>
            {g.name}
            {g.description ? (
              <span class="muted small"> — {g.description}</span>
            ) : null}
          </h2>
          {members.length === 0 ? (
            <p class="muted small">No members yet.</p>
          ) : (
            <ul class="key-list">
              {members.map((m) => (
                <li key={m.id}>
                  <span class="key-name">{m.name}</span>
                  <span class="muted small">{m.email}</span>
                  <form
                    method="post"
                    action={`/admin/groups/${g.id}/members/remove`}
                  >
                    <input type="hidden" name="userId" value={m.id} />
                    <button class="btn danger ghost small" type="submit">
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <form
            method="post"
            action={`/admin/groups/${g.id}/members`}
            class="row wrap"
          >
            <label class="field inline">
              <span>Add by email</span>
              <input name="email" type="email" required />
            </label>
            <button class="btn small" type="submit">
              Add
            </button>
          </form>
        </section>
      ))}
    </>,
  );
});

groupsAdmin.post("/groups", async (c) => {
  const form = await c.req.parseBody();
  const name = field(form, "name").trim().toLowerCase().slice(0, 60);
  if (!/^[a-z0-9_-]{1,60}$/.test(name)) {
    return await p(
      c,
      "groups",
      "Groups",
      <p class="status error">
        Group names: lowercase letters, numbers, dash, underscore.
      </p>,
    );
  }
  await c.env.DB.prepare(
    "INSERT INTO groups (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(
      newId(),
      name,
      field(form, "description").slice(0, 200) || null,
      nowSec(),
    )
    .run();
  return c.redirect("/admin/groups", 303);
});

groupsAdmin.post("/groups/:id/members", async (c) => {
  const form = await c.req.parseBody();
  const user = await getUserByEmail(c.env.DB, field(form, "email"));
  if (user) {
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO group_members (group_id, user_id, created_at) VALUES (?1, ?2, ?3)",
    )
      .bind(c.req.param("id"), user.id, nowSec())
      .run();
  }
  return c.redirect("/admin/groups", 303);
});

groupsAdmin.post("/groups/:id/members/remove", async (c) => {
  const form = await c.req.parseBody();
  await c.env.DB.prepare(
    "DELETE FROM group_members WHERE group_id = ?1 AND user_id = ?2",
  )
    .bind(c.req.param("id"), field(form, "userId"))
    .run();
  return c.redirect("/admin/groups", 303);
});
