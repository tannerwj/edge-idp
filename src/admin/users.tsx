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
  return p(
    c,
    "users",
    "Users",
    <>
      <h1>Users</h1>
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
                {u.name}
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
    </>,
  );
});

usersAdmin.post("/users", async (c) => {
  const form = await c.req.parseBody();
  const name = field(form, "name").trim().slice(0, 120);
  const email = field(form, "email").trim().slice(0, 254);
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return p(
      c,
      "users",
      "Users",
      <p class="status error">Name and a valid email are required.</p>,
    );
  }
  if (await getUserByEmail(c.env.DB, email)) {
    return p(
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
  return p(
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
        <a class="btn" href="/admin/">
          Back to users
        </a>
      </p>
    </>,
  );
});

usersAdmin.post("/users/:id/enrollment", async (c) => {
  const id = c.req.param("id");
  const link = await mintEnrollmentLink(c.env.DB, id, c.env.ISSUER);
  await audit(c.env.DB, "ENROLLMENT_STARTED", {
    userId: id,
    detail: { by: c.get("admin").id },
  });
  return p(
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
        <a class="btn" href="/admin/">
          Back to users
        </a>
      </p>
    </>,
  );
});

usersAdmin.post("/users/:id/revoke-keys", async (c) => {
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
  return c.redirect("/admin/", 303);
});

usersAdmin.post("/users/:id/disable", async (c) => {
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
  return c.redirect("/admin/", 303);
});

usersAdmin.post("/users/:id/enable", async (c) => {
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
  return c.redirect("/admin/", 303);
});
