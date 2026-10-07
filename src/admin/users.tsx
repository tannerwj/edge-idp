import { Hono } from "hono";
import {
  audit,
  getCredentialsForUser,
  getUserByEmail,
  listUsers,
} from "../db";
import { newId, nowSec } from "../util";
import type { AdminVars } from "./shell";
import { field, mintEnrollmentLink, p } from "./shell";

export const usersAdmin = new Hono<AdminVars>();

usersAdmin.get("/", async (c) => {
  const users = await listUsers(c.env.DB);
  const rows = await Promise.all(
    users.map(async (u) => ({
      u,
      keys: (await getCredentialsForUser(c.env.DB, u.id)).length,
    })),
  );
  return await p(
    c,
    "users",
    "Users",
    <>
      <form method="post" action="/admin/users" class="row wrap">
        <label class="field inline">
          <span>Name</span>
          <input name="name" required maxLength={120} placeholder="Ada Lovelace" />
        </label>
        <label class="field inline">
          <span>Email</span>
          <input name="email" type="email" required maxLength={254} />
        </label>
        <button class="btn primary" type="submit">
          Create user
        </button>
      </form>
            <div class="table-wrap">
<table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Passkeys</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ u, keys }) => (
            <tr key={u.id}>
              <td>
                <a href={`/admin/users/${u.id}`}>{u.name}</a>
                {u.is_admin ? <span class="pill">admin</span> : null}
              </td>
              <td class="muted">{u.email}</td>
              <td>{keys}</td>
              <td>{u.disabled ? "disabled" : "active"}</td>
              <td class="actions">
                <form method="post" action={`/admin/users/${u.id}/enrollment`}>
                  <button
                    class="btn ghost small"
                    type="submit"
                    title="New enrollment link (first setup or recovery)"
                  >
                    Enrollment link
                  </button>
                </form>
                <form method="post" action={`/admin/users/${u.id}/revoke-keys`}>
                  <button
                    class="btn ghost small"
                    type="submit"
                    title="Delete all passkeys (account recovery)"
                  >
                    Revoke keys
                  </button>
                </form>
                <form
                  method="post"
                  action={`/admin/users/${u.id}/${u.disabled ? "enable" : "disable"}`}
                >
                  <button class="btn ghost small" type="submit">
                    {u.disabled ? "Enable" : "Disable"}
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </>,
  );
});

usersAdmin.post("/", async (c) => {
  const form = await c.req.parseBody();
  const name = field(form, "name").trim().slice(0, 120);
  const email = field(form, "email").trim().slice(0, 254);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return await p(
      c,
      "users",
      "Users",
      <p class="status error">Name and a valid email are required.</p>,
    );
  }
  if (await getUserByEmail(c.env.DB, email)) {
    return await p(
      c,
      "users",
      "Users",
      <p class="status error">That email already exists.</p>,
    );
  }
  const id = newId();
  const now = nowSec();
  await c.env.DB.prepare(
    "INSERT INTO users (id, created_at, name, email, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, now, name, email, now)
    .run();
  const link = await mintEnrollmentLink(c.env.DB, id, c.env.ISSUER);
  await audit(c.env.DB, "USER_CREATED", {
    userId: id,
    detail: { by: c.get("admin").id },
  });
  return await p(
    c,
    "users",
    "User created",
    <>
      <h1>User created</h1>
      <p class="muted">
        Share this one-time link with {name} (valid 7 days). It lets them set
        up their passkey — after that, the link is dead.
      </p>
      <label class="field">
        <span>Enrollment link</span>
        <input readonly value={link} data-select />
      </label>
      <p>
        <a class="btn" href="/admin/users">
          Back to users
        </a>
      </p>
    </>,
  );
});


usersAdmin.post("/:id/profile", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const name = field(form, "name").trim().slice(0, 120);
  const email = field(form, "email").trim().slice(0, 254);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return c.text("Name and a valid email are required.", 400);
  }
  const clash = await c.env.DB.prepare(
    "SELECT id FROM users WHERE lower(email) = lower(?1) AND id != ?2",
  )
    .bind(email, id)
    .first();
  if (clash) return c.text("That email is already in use.", 400);
  await c.env.DB.prepare(
    "UPDATE users SET name = ?1, email = ?2, updated_at = ?3 WHERE id = ?4",
  )
    .bind(name, email, nowSec(), id)
    .run();
  await audit(c.env.DB, "USER_PROFILE_UPDATED", {
    userId: id,
    detail: { by: c.get("admin").id },
  });
  return c.redirect(`/admin/users/${id}`, 303);
});

usersAdmin.post("/:id/groups", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const raw = form.groups;
  const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(
    (v): v is string => typeof v === "string",
  );
  // Replace membership wholesale: delete all, insert selected.
  await c.env.DB.prepare("DELETE FROM group_members WHERE user_id = ?1")
    .bind(id)
    .run();
  for (const gid of ids) {
    await c.env.DB.prepare(
      "INSERT INTO group_members (group_id, user_id, created_at) VALUES (?1, ?2, ?3)",
    )
      .bind(gid, id, nowSec())
      .run();
  }
  await audit(c.env.DB, "USER_GROUPS_UPDATED", {
    userId: id,
    detail: { by: c.get("admin").id, groups: ids.length },
  });
  return c.redirect(`/admin/users/${id}`, 303);
});

usersAdmin.post("/:id/role", async (c) => {
  const id = c.req.param("id");
  if (id === c.get("admin").id) return c.text("Cannot change your own role", 400);
  const form = await c.req.parseBody();
  const isAdmin = field(form, "isAdmin") === "1" ? 1 : 0;
  await c.env.DB.prepare(
    "UPDATE users SET is_admin = ?1, updated_at = ?2 WHERE id = ?3",
  )
    .bind(isAdmin, nowSec(), id)
    .run();
  await audit(c.env.DB, isAdmin ? "ADMIN_GRANTED" : "ADMIN_REVOKED", {
    userId: id,
    detail: { by: c.get("admin").id },
  });
  return c.redirect(`/admin/users/${id}`, 303);
});

usersAdmin.post("/:id/enrollment", async (c) => {
  const id = c.req.param("id");
  const link = await mintEnrollmentLink(c.env.DB, id, c.env.ISSUER);
  await audit(c.env.DB, "ENROLLMENT_STARTED", {
    userId: id,
    detail: { by: c.get("admin").id },
  });
  return await p(
    c,
    "users",
    "Enrollment link",
    <>
      <h1>Enrollment link</h1>
      <p class="muted">
        One-time link, valid 7 days. Previously issued unused links still work
        until used.
      </p>
      <label class="field">
        <span>Enrollment link</span>
        <input readonly value={link} data-select />
      </label>
      <p>
        <a class="btn" href="/admin/users">
          Back to users
        </a>
      </p>
    </>,
  );
});

usersAdmin.post("/:id/sessions/:sid/revoke", async (c) => {
  const id = c.req.param("id");
  const sid = c.req.param("sid");
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?1 AND user_id = ?2")
    .bind(sid, id)
    .run();
  await audit(c.env.DB, "SESSION_REVOKED", {
    userId: id,
    detail: { by: c.get("admin").id, session: sid.slice(0, 8) },
  });
  return c.redirect(`/admin/users/${id}`, 303);
});

usersAdmin.post("/:id/revoke-keys", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM webauthn_credentials WHERE user_id = ?1")
    .bind(id)
    .run();
  // Sessions die too: without a passkey the user cannot re-auth anyway, and
  // a recovery flow must start from a clean slate.
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1")
    .bind(id)
    .run();
  await audit(c.env.DB, "PASSKEYS_REVOKED", {
    userId: id,
    detail: { by: c.get("admin").id },
  });
  return c.redirect("/admin/users", 303);
});

usersAdmin.post("/:id/disable", async (c) => {
  const id = c.req.param("id");
  if (id === c.get("admin").id) return c.text("Cannot disable yourself", 400);
  await c.env.DB.prepare(
    "UPDATE users SET disabled = 1, updated_at = ?1 WHERE id = ?2",
  )
    .bind(nowSec(), id)
    .run();
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1")
    .bind(id)
    .run();
  await audit(c.env.DB, "USER_DISABLED", {
    userId: id,
    detail: { by: c.get("admin").id },
  });
  return c.redirect("/admin/users", 303);
});

usersAdmin.post("/:id/enable", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE users SET disabled = 0, updated_at = ?1 WHERE id = ?2",
  )
    .bind(nowSec(), id)
    .run();
  await audit(c.env.DB, "USER_ENABLED", {
    userId: id,
    detail: { by: c.get("admin").id },
  });
  return c.redirect("/admin/users", 303);
});
