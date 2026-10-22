import { Hono } from "hono";
import { getUser, listGroups, listUsers } from "../db";
import type { Group, User } from "../db";
import * as ops from "../ops";
import type { AdminVars } from "./shell";
import { act, actor, failBack, field, fields, page } from "./shell";
import { emailOn, revealLink } from "./invites";
import { deliverLink } from "../invites";
import { Avatar, Dialog, Empty, GroupChips, GroupPicker, PageHead, Time } from "../ui/components";
import { Icon } from "../ui/icons";

function InviteDialog({ groups, emailReady }: { groups: Group[]; emailReady: boolean }) {
  return (
    <Dialog
      id="invite"
      sheet
      title="Invite a person"
      lede="They'll get a one-time link (valid 7 days) to create a passkey."
      action="/admin/users"
      submit="Create invite link"
    >
      <label class="field">
        <span class="label">Name</span>
        <input name="name" required maxLength={120} placeholder="Ada Lovelace" autocomplete="off" />
      </label>
      <label class="field">
        <span class="label">Email</span>
        <input
          name="email"
          type="email"
          required
          maxLength={254}
          placeholder="ada@example.com"
          autocomplete="off"
        />
        <span class="hint">Apps see this address. It's not used to sign in — passkeys are.</span>
      </label>
      <div class="field">
        <span class="label">Groups</span>
        <GroupPicker name="groups" all={groups} selected={[]} />
      </div>
      <label class="check">
        <input type="checkbox" name="isAdmin" value="1" />
        <span>
          Make admin
          <span class="sub">Can manage people, apps and settings, and use the admin API.</span>
        </span>
      </label>
      {emailReady ? (
        <label class="check">
          <input type="checkbox" name="sendEmail" value="1" checked />
          <span>
            Email the invite
            <span class="sub">You'll still see the link, in case it doesn't arrive.</span>
          </span>
        </label>
      ) : null}
    </Dialog>
  );
}

export const usersAdmin = new Hono<AdminVars>();

const FILTERS = ["all", "admins", "pending", "disabled"] as const;
type Filter = (typeof FILTERS)[number];

function FilterBar({ filter, n }: { filter: Filter; n: Record<Filter, number> }) {
  return (
    <div class="filters">
      <div class="input-search">
        <Icon name="search" size="sm" />
        <input
          type="search"
          placeholder="Filter by name, email or group…"
          data-filter-table="people"
          aria-label="Filter people"
        />
      </div>
      <div class="segmented right">
        {(["all", "admins", "pending", "disabled"] as const).map((f) => (
          <a
            key={f}
            href={f === "all" ? "/admin/users" : `/admin/users?filter=${f}`}
            class={filter === f ? "active" : ""}
          >
            {f === "all"
              ? "All"
              : f === "admins"
                ? "Admins"
                : f === "pending"
                  ? "No passkey"
                  : "Disabled"}{" "}
            <span class="muted">{n[f]}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function PersonRow({ u, k, groups }: { u: User; k: number; groups: string[] }) {
  return (
    <tr
      data-href={`/admin/users/${u.id}`}
      data-filter-text={`${u.name} ${u.email} ${groups.join(" ")}`.toLowerCase()}
    >
      <td>
        <div class="cell-user">
          <Avatar name={u.name} seed={u.id} />
          <div class="truncate">
            <a class="name" href={`/admin/users/${u.id}`}>
              {u.name}
            </a>{" "}
            {u.is_admin ? <span class="badge accent">Admin</span> : null}
            {u.public ? <span class="badge">Public</span> : null}
            <div class="sub truncate">{u.public ? "Signed up through a public app" : u.email}</div>
          </div>
        </div>
      </td>
      <td>
        <GroupChips groups={groups} empty="—" />
      </td>
      <td>
        {k ? (
          <span class="row-sm">
            <Icon name="fingerprint" size="sm" class="muted" />
            {k}
          </span>
        ) : (
          <span class="badge warn">Not set up</span>
        )}
      </td>
      <td class="muted small nowrap">
        <Time ts={u.last_sign_in_at} empty="Never" />
      </td>
      <td>
        {u.disabled ? (
          <span class="badge bad dot">Disabled</span>
        ) : (
          <span class="badge ok dot">Active</span>
        )}
      </td>
    </tr>
  );
}

usersAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const filter: Filter = FILTERS.find((f) => f === c.req.query("filter")) ?? "all";
  const [users, groups, { results: keys }, { results: members }, ready] = await Promise.all([
    listUsers(db),
    listGroups(db),
    db
      .prepare("SELECT user_id, COUNT(*) AS n FROM webauthn_credentials GROUP BY user_id")
      .all<{ user_id: string; n: number }>(),
    db
      .prepare(
        "SELECT m.user_id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id ORDER BY g.name",
      )
      .all<{ user_id: string; name: string }>(),
    emailOn(c),
  ]);
  const keyCount = new Map(keys.map((k) => [k.user_id, k.n]));
  const memberGroups = new Map<string, string[]>();
  for (const m of members)
    memberGroups.set(m.user_id, [...(memberGroups.get(m.user_id) ?? []), m.name]);
  const groupsOf = (id: string) => memberGroups.get(id) ?? [];
  const shown = users.filter((u) => {
    if (filter === "admins") return !!u.is_admin;
    if (filter === "pending") return !keyCount.get(u.id) && !u.disabled;
    if (filter === "disabled") return !!u.disabled;
    return true;
  });
  const n = {
    all: users.length,
    admins: users.filter((u) => u.is_admin).length,
    pending: users.filter((u) => !keyCount.get(u.id) && !u.disabled).length,
    disabled: users.filter((u) => u.disabled).length,
  };
  return await page(
    c,
    { active: "users", title: "People" },
    <>
      <PageHead
        title="People"
        lede="Everyone who can sign in. Invite someone and they'll set up a passkey from a one-time link."
        actions={
          <div class="row-sm">
            <a class="btn" href="/admin/users/invites">
              <Icon name="mail" size="sm" />
              Pending invites
            </a>
            <button
              class="btn primary"
              type="button"
              data-open="invite"
              {...(c.req.query("invite") ? { "data-autoopen": "" } : {})}
            >
              <Icon name="userPlus" size="sm" />
              Invite person
            </button>
          </div>
        }
      />
      <FilterBar filter={filter} n={n} />
      <div class="card">
        {shown.length ? (
          <div class="table-wrap">
            <table class="table" id="people">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Groups</th>
                  <th>Passkeys</th>
                  <th>Last sign-in</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <PersonRow key={u.id} u={u} k={keyCount.get(u.id) ?? 0} groups={groupsOf(u.id)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="users" title={filter === "all" ? "No one here yet" : "Nobody matches"}>
            {filter === "all"
              ? "Invite your first person — they'll get a link to set up a passkey."
              : "Try another filter."}
          </Empty>
        )}
      </div>

      <InviteDialog groups={groups} emailReady={ready} />
    </>,
  );
});

usersAdmin.post("/", async (c) => {
  const form = await c.req.parseBody({ all: true });
  try {
    const r = await ops.createUser(
      c.env.DB,
      c.env.ISSUER,
      {
        name: field(form, "name"),
        email: field(form, "email"),
        groups: fields(form, "groups"),
        isAdmin: field(form, "isAdmin") === "1",
      },
      actor(c),
    );
    const delivery =
      field(form, "sendEmail") === "1"
        ? await deliverLink(
            c.env,
            { name: field(form, "name"), email: field(form, "email"), public: 0 },
            r.enrollmentLink,
            "invite",
          )
        : null;
    return revealLink(c, r.id, r.enrollmentLink, { fresh: true, delivery });
  } catch (e) {
    return failBack(c, "/admin/users?invite=1", e);
  }
});

usersAdmin.post("/:id/profile", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  return act(c, `/admin/users/${id}`, "Profile saved", () =>
    ops.updateUser(
      c.env.DB,
      id,
      { name: field(form, "name"), email: field(form, "email") },
      actor(c),
    ),
  );
});

usersAdmin.post("/:id/groups", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody({ all: true });
  return act(c, `/admin/users/${id}`, "Groups updated", () =>
    ops.setUserGroupsByName(c.env.DB, id, fields(form, "groups"), actor(c)),
  );
});

usersAdmin.post("/:id/role", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const makeAdmin = field(form, "isAdmin") === "1";
  return act(c, `/admin/users/${id}`, makeAdmin ? "Now an admin" : "Admin removed", () =>
    ops.setAdmin(c.env.DB, id, makeAdmin, actor(c)),
  );
});

usersAdmin.post("/:id/member", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  return act(c, `/admin/users/${id}`, "Now a member", () =>
    ops.makeMember(c.env.DB, id, field(form, "email"), actor(c)),
  );
});

usersAdmin.post("/:id/enrollment", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  let link: string;
  try {
    link = await ops.mintEnrollmentLink(c.env.DB, c.env.ISSUER, id, actor(c));
  } catch (e) {
    return failBack(c, `/admin/users/${id}`, e);
  }
  const user = await getUser(c.env.DB, id);
  const delivery =
    user && field(form, "sendEmail") === "1"
      ? await deliverLink(c.env, user, link, "relink")
      : null;
  return revealLink(c, id, link, { fresh: false, delivery });
});

usersAdmin.post("/:id/sessions/:sid/revoke", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}?tab=devices`, "Session signed out", () =>
    ops.revokeSessions(c.env.DB, id, actor(c), c.req.param("sid")),
  );
});

usersAdmin.post("/:id/sign-out", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}?tab=devices`, "Signed out everywhere", () =>
    ops.revokeSessions(c.env.DB, id, actor(c)),
  );
});

usersAdmin.post("/:id/revoke-keys", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}`, "Passkeys reset — send a new enrollment link", () =>
    ops.revokePasskeys(c.env.DB, id, actor(c)),
  );
});

usersAdmin.post("/:id/keys/:kid/remove", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}?tab=passkeys`, "Passkey removed", () =>
    ops.removePasskey(c.env.DB, id, c.req.param("kid"), actor(c)),
  );
});

usersAdmin.post("/:id/disable", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}`, "User disabled", () =>
    ops.setDisabled(c.env.DB, id, true, actor(c)),
  );
});

usersAdmin.post("/:id/enable", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}`, "User enabled", () =>
    ops.setDisabled(c.env.DB, id, false, actor(c)),
  );
});

usersAdmin.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  try {
    await ops.deleteUser(c.env.DB, id, actor(c));
  } catch (e) {
    return failBack(c, `/admin/users/${id}`, e);
  }
  return act(c, "/admin/users", "User deleted", async () => {});
});
