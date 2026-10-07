import { Hono } from "hono";
import { listApps, listClients, listGroups, listUsers } from "../db";
import type { User } from "../db";
import * as ops from "../ops";
import type { AdminVars } from "./shell";
import { act, actor, field, page } from "./shell";
import { Avatar, Dialog, Empty, PageHead, PostButton } from "../ui/components";
import { Icon } from "../ui/icons";

export const groupsAdmin = new Hono<AdminVars>();

async function usage(db: D1Database) {
  const [clients, apps] = await Promise.all([listClients(db), listApps(db)]);
  return (name: string) => ({
    clients: clients.filter((c) => c.allowed_groups?.includes(name)),
    apps: apps.filter((a) => !a.client_id && a.allowed_groups?.includes(name)),
  });
}

type Usage = ReturnType<Awaited<ReturnType<typeof usage>>>;

groupsAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const [groups, users, { results: members }, uses] = await Promise.all([
    listGroups(db),
    listUsers(db),
    db
      .prepare("SELECT group_id, user_id FROM group_members")
      .all<{ group_id: string; user_id: string }>(),
    usage(db),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  return await page(
    c,
    { active: "groups", title: "Groups" },
    <>
      <PageHead
        title="Groups"
        lede={
          <>
            Groups decide who can open which app. They're sent to every app in the{" "}
            <code>groups</code> claim, so Cloudflare Access policies (and your own apps) can match
            on them.
          </>
        }
        actions={
          <button class="btn primary" type="button" data-open="new-group">
            <Icon name="plus" size="sm" />
            New group
          </button>
        }
      />
      {groups.length ? (
        <div class="grid-3">
          {groups.map((g) => {
            const ids = members.filter((m) => m.group_id === g.id).map((m) => m.user_id);
            const u = uses(g.name);
            return (
              <a key={g.id} class="card group-card" href={`/admin/groups/${g.id}`}>
                <div class="card-body stack-sm">
                  <div class="row between">
                    <span class="badge accent mono">{g.name}</span>
                    <span class="muted small">
                      {g.members} {g.members === 1 ? "member" : "members"}
                    </span>
                  </div>
                  <p class="text-2 small">
                    {g.description ?? <span class="muted">No description</span>}
                  </p>
                  <div class="row between">
                    <span class="avatar-stack">
                      {ids.slice(0, 6).map((id) => {
                        const user = byId.get(id);
                        return user ? (
                          <Avatar key={id} name={user.name} seed={user.id} size="sm" />
                        ) : null;
                      })}
                    </span>
                    <span class="muted tiny">
                      {u.clients.length + u.apps.length
                        ? `${u.clients.length + u.apps.length} app${u.clients.length + u.apps.length === 1 ? "" : "s"}`
                        : "Not used by apps"}
                    </span>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      ) : (
        <div class="card">
          <Empty
            icon="group"
            title="No groups yet"
            action={
              <button class="btn primary" type="button" data-open="new-group">
                Create a group
              </button>
            }
          >
            Try <code>family</code>, <code>friends</code>, or <code>homelab</code> — then give apps
            to groups instead of people.
          </Empty>
        </div>
      )}
      <Dialog id="new-group" title="New group" action="/admin/groups" submit="Create group">
        <label class="field">
          <span class="label">Name</span>
          <input
            name="name"
            required
            maxLength={60}
            placeholder="family"
            pattern="[a-z0-9_\-]+"
            autocomplete="off"
          />
          <span class="hint">
            Lowercase letters, numbers, dashes. This exact string appears in tokens.
          </span>
        </label>
        <label class="field">
          <span class="label">Description</span>
          <input name="description" maxLength={200} placeholder="Optional" />
        </label>
      </Dialog>
    </>,
  );
});

groupsAdmin.post("/", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/groups", "Group created", () =>
    ops.createGroup(
      c.env.DB,
      { name: field(form, "name"), description: field(form, "description") },
      actor(c),
    ),
  );
});

function MembersCard({ id, inGroup, notIn }: { id: string; inGroup: User[]; notIn: User[] }) {
  return (
    <section class="card span-2">
      <div class="card-head">
        <h2 class="grow">Members</h2>
        {notIn.length ? (
          <form method="post" action={`/admin/groups/${id}/members`} class="row-sm">
            <select name="user_id" required aria-label="Person to add" class="select-sm">
              {notIn.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} — {x.email}
                </option>
              ))}
            </select>
            <button class="btn sm primary" type="submit">
              Add
            </button>
          </form>
        ) : null}
      </div>
      {inGroup.length ? (
        <ul class="list">
          {inGroup.map((m) => (
            <li key={m.id}>
              <Avatar name={m.name} seed={m.id} />
              <div class="grow">
                <a class="title" href={`/admin/users/${m.id}`}>
                  {m.name}
                </a>
                <div class="meta">{m.email}</div>
              </div>
              <PostButton
                action={`/admin/groups/${id}/members/${m.id}/remove`}
                label="Remove"
                class="btn ghost sm"
              />
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="users" title="No members yet" />
      )}
    </section>
  );
}

function GrantsCard({ name, u }: { name: string; u: Usage }) {
  return (
    <section class="card">
      <div class="card-head">
        <h2>Grants access to</h2>
      </div>
      {u.clients.length + u.apps.length ? (
        <ul class="list">
          {u.clients.map((x) => (
            <li key={x.id}>
              <Icon name="plug" />
              <a class="grow title" href={`/admin/clients/${encodeURIComponent(x.id)}`}>
                {x.name}
              </a>
              <span class="badge">Client</span>
            </li>
          ))}
          {u.apps.map((x) => (
            <li key={x.id}>
              <Icon name="grid" />
              <span class="grow title">{x.name}</span>
              <span class="badge">Launcher</span>
            </li>
          ))}
        </ul>
      ) : (
        <div class="card-body muted small">
          Nothing here references <code>{name}</code> yet. It may still be used by Cloudflare Access
          policies.
        </div>
      )}
    </section>
  );
}

groupsAdmin.get("/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  const g = (await listGroups(db)).find((x) => x.id === id);
  if (!g) return c.notFound();
  const [users, { results: members }, uses] = await Promise.all([
    listUsers(db),
    db
      .prepare("SELECT user_id FROM group_members WHERE group_id = ?1")
      .bind(id)
      .all<{ user_id: string }>(),
    usage(db),
  ]);
  const memberIds = new Set(members.map((m) => m.user_id));
  const inGroup = users.filter((u) => memberIds.has(u.id));
  const notIn = users.filter((u) => !memberIds.has(u.id) && !u.disabled);
  const u = uses(g.name);
  return await page(
    c,
    {
      active: "groups",
      title: g.name,
      crumbs: [{ label: "Groups", href: "/admin/groups" }, { label: g.name }],
    },
    <>
      <PageHead
        title={g.name}
        lede={g.description ?? "No description"}
        actions={
          <button class="btn" type="button" data-open="edit-group">
            <Icon name="edit" size="sm" />
            Edit
          </button>
        }
      />
      <div class="grid-3">
        <MembersCard id={id} inGroup={inGroup} notIn={notIn} />
        <div class="stack">
          <GrantsCard name={g.name} u={u} />
          <section class="card danger-zone">
            <div class="card-body stack-sm">
              <p class="muted small">
                Deleting is refused while apps or clients here still use this group.
              </p>
              <PostButton
                action={`/admin/groups/${id}/delete`}
                label="Delete group"
                icon="trash"
                class="btn sm danger"
                confirm={`Delete ${g.name}? Check Cloudflare Access policies that match on it first.`}
              />
            </div>
          </section>
        </div>
      </div>
      <Dialog
        id="edit-group"
        title={`Edit ${g.name}`}
        lede="The name is immutable — it's baked into tokens and policies."
        action={`/admin/groups/${id}`}
      >
        <label class="field">
          <span class="label">Description</span>
          <input name="description" maxLength={200} value={g.description ?? ""} />
        </label>
      </Dialog>
    </>,
  );
});

groupsAdmin.post("/:id", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  return act(c, `/admin/groups/${id}`, "Saved", () =>
    ops.updateGroup(c.env.DB, id, { description: field(form, "description") }, actor(c)),
  );
});

groupsAdmin.post("/:id/members", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  return act(c, `/admin/groups/${id}`, "Member added", () =>
    ops.setGroupMember(c.env.DB, id, field(form, "user_id"), true, actor(c)),
  );
});

groupsAdmin.post("/:id/members/:uid/remove", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/groups/${id}`, "Member removed", () =>
    ops.setGroupMember(c.env.DB, id, c.req.param("uid"), false, actor(c)),
  );
});

groupsAdmin.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  try {
    await ops.deleteGroup(c.env.DB, id, actor(c));
  } catch (e) {
    if (e instanceof ops.OpError)
      return act(c, `/admin/groups/${id}`, "", async () => {
        throw e;
      });
    throw e;
  }
  return act(c, "/admin/groups", "Group deleted", async () => {});
});
