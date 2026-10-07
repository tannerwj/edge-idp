import { Hono } from "hono";
import { getUser, listGroups, listUsers } from "../db";
import type { Group } from "../db";
import * as ops from "../ops";
import type { AdminVars, ACtx } from "./shell";
import { act, actor, field, fields, page } from "./shell";
import { Avatar, CopyField, Dialog, Empty, GroupChips, GroupPicker, PageHead, Time } from "../ui/components";
import { Icon } from "../ui/icons";

function InviteDialog({ groups }: { groups: Group[] }) {
  return (
    <Dialog id="invite" sheet title="Invite a person" lede="They'll get a one-time link (valid 7 days) to create a passkey." action="/admin/users" submit="Create invite link">
      <label class="field">
        <span class="label">Name</span>
        <input name="name" required maxLength={120} placeholder="Ada Lovelace" autocomplete="off" />
      </label>
      <label class="field">
        <span class="label">Email</span>
        <input name="email" type="email" required maxLength={254} placeholder="ada@example.com" autocomplete="off" />
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
    </Dialog>
  );
}

export const usersAdmin = new Hono<AdminVars>();

const FILTERS = ["all", "admins", "pending", "disabled"] as const;
type Filter = (typeof FILTERS)[number];

usersAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const filter: Filter = FILTERS.find((f) => f === c.req.query("filter")) ?? "all";
  const [users, groups, { results: keys }, { results: members }] = await Promise.all([
    listUsers(db),
    listGroups(db),
    db.prepare("SELECT user_id, COUNT(*) AS n FROM webauthn_credentials GROUP BY user_id").all<{ user_id: string; n: number }>(),
    db.prepare("SELECT m.user_id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id ORDER BY g.name").all<{ user_id: string; name: string }>(),
  ]);
  const keyCount = new Map(keys.map((k) => [k.user_id, k.n]));
  const groupsOf = (id: string) => members.filter((m) => m.user_id === id).map((m) => m.name);
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
          <button class="btn primary" type="button" data-open="invite" {...(c.req.query("invite") ? { "data-autoopen": "" } : {})}>
            <Icon name="userPlus" size="sm" />
            Invite person
          </button>
        }
      />
      <div class="filters">
        <div class="input-search">
          <Icon name="search" size="sm" />
          <input type="search" placeholder="Filter by name, email or group…" data-filter-table="people" aria-label="Filter people" />
        </div>
        <div class="segmented right">
          {(["all", "admins", "pending", "disabled"] as const).map((f) => (
            <a key={f} href={f === "all" ? "/admin/users" : `/admin/users?filter=${f}`} class={filter === f ? "active" : ""}>
              {f === "all" ? "All" : f === "admins" ? "Admins" : f === "pending" ? "No passkey" : "Disabled"} <span class="muted">{n[f]}</span>
            </a>
          ))}
        </div>
      </div>
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
                {shown.map((u) => {
                  const k = keyCount.get(u.id) ?? 0;
                  return (
                    <tr key={u.id} data-href={`/admin/users/${u.id}`} data-filter-text={`${u.name} ${u.email} ${groupsOf(u.id).join(" ")}`.toLowerCase()}>
                      <td>
                        <div class="cell-user">
                          <Avatar name={u.name} seed={u.id} />
                          <div class="truncate">
                            <a class="name" href={`/admin/users/${u.id}`}>
                              {u.name}
                            </a>{" "}
                            {u.is_admin ? <span class="badge accent">Admin</span> : null}
                            <div class="sub truncate">{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <GroupChips groups={groupsOf(u.id)} empty="—" />
                      </td>
                      <td>{k ? <span class="row-sm"><Icon name="fingerprint" size="sm" class="muted" />{k}</span> : <span class="badge warn">Not set up</span>}</td>
                      <td class="muted small nowrap">
                        <Time ts={u.last_sign_in_at} empty="Never" />
                      </td>
                      <td>{u.disabled ? <span class="badge bad dot">Disabled</span> : <span class="badge ok dot">Active</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon="users" title={filter === "all" ? "No one here yet" : "Nobody matches"}>
            {filter === "all" ? "Invite your first person — they'll get a link to set up a passkey." : "Try another filter."}
          </Empty>
        )}
      </div>

      <InviteDialog groups={groups} />
    </>,
  );
});

/** One-time reveal of a fresh enrollment link (never stored in plaintext). */
export async function revealEnrollment(c: ACtx, userId: string, link: string, fresh: boolean) {
  const u = await getUser(c.env.DB, userId);
  const name = u?.name ?? "them";
  const first = name.split(" ")[0];
  const mail = `mailto:${encodeURIComponent(u?.email ?? "")}?subject=${encodeURIComponent(`Your ${c.env.RP_NAME} invite`)}&body=${encodeURIComponent(
    `Hi ${first},\n\nSet up your passkey for ${c.env.RP_NAME} here (valid for 7 days, works once):\n\n${link}\n`,
  )}`;
  return await page(
    c,
    { active: "users", title: fresh ? "Invite ready" : "Enrollment link", crumbs: [{ label: "People", href: "/admin/users" }, { label: name, href: `/admin/users/${userId}` }, { label: "Link" }], narrow: true },
    <div class="card">
      <div class="card-body stack">
        <div class="hero-icon ok">
          <Icon name="check" />
        </div>
        <div>
          <h1>{fresh ? `${first} is invited` : "New enrollment link"}</h1>
          <p class="muted">
            Send this link to {first}. It works once, for 7 days, and is shown only now — we store just a hash.
          </p>
        </div>
        <CopyField value={link} big label="enrollment link" />
        <div class="row wrap">
          <a class="btn" href={mail}>
            <Icon name="mail" size="sm" />
            Email it
          </a>
          <button class="btn" type="button" data-share={link} data-share-title={`${c.env.RP_NAME} invite`}>
            <Icon name="arrowUpRight" size="sm" />
            Share…
          </button>
          <button class="btn" type="button" data-qr={link}>
            <Icon name="qr" size="sm" />
            Show QR
          </button>
          <a class="btn ghost right" href={`/admin/users/${userId}`}>
            Done
          </a>
        </div>
        <div class="qr" data-qr-target hidden></div>
      </div>
    </div>,
  );
}

usersAdmin.post("/", async (c) => {
  const form = await c.req.parseBody({ all: true });
  try {
    const r = await ops.createUser(
      c.env.DB,
      c.env.ISSUER,
      { name: field(form, "name"), email: field(form, "email"), groups: fields(form, "groups"), isAdmin: field(form, "isAdmin") === "1" },
      actor(c),
    );
    return revealEnrollment(c, r.id, r.enrollmentLink, true);
  } catch (e) {
    if (e instanceof ops.OpError) return act(c, "/admin/users?invite=1", "", async () => { throw e; });
    throw e;
  }
});

usersAdmin.post("/:id/profile", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  return act(c, `/admin/users/${id}`, "Profile saved", () =>
    ops.updateUser(c.env.DB, id, { name: field(form, "name"), email: field(form, "email") }, actor(c)),
  );
});

usersAdmin.post("/:id/groups", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody({ all: true });
  return act(c, `/admin/users/${id}`, "Groups updated", () => ops.setUserGroupsByName(c.env.DB, id, fields(form, "groups"), actor(c)));
});

usersAdmin.post("/:id/role", async (c) => {
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const makeAdmin = field(form, "isAdmin") === "1";
  return act(c, `/admin/users/${id}`, makeAdmin ? "Now an admin" : "Admin removed", () => ops.setAdmin(c.env.DB, id, makeAdmin, actor(c)));
});

usersAdmin.post("/:id/enrollment", async (c) => {
  const id = c.req.param("id");
  const link = await ops.mintEnrollmentLink(c.env.DB, c.env.ISSUER, id, actor(c));
  return revealEnrollment(c, id, link, false);
});

usersAdmin.post("/:id/sessions/:sid/revoke", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}?tab=devices`, "Session signed out", () => ops.revokeSessions(c.env.DB, id, actor(c), c.req.param("sid")));
});

usersAdmin.post("/:id/sign-out", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}?tab=devices`, "Signed out everywhere", () => ops.revokeSessions(c.env.DB, id, actor(c)));
});

usersAdmin.post("/:id/revoke-keys", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}`, "Passkeys reset — send a new enrollment link", () => ops.revokePasskeys(c.env.DB, id, actor(c)));
});

usersAdmin.post("/:id/keys/:kid/remove", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}?tab=passkeys`, "Passkey removed", async () => {
    await c.env.DB.prepare("DELETE FROM webauthn_credentials WHERE id = ?1 AND user_id = ?2").bind(c.req.param("kid"), id).run();
  });
});

usersAdmin.post("/:id/disable", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}`, "User disabled", () => ops.setDisabled(c.env.DB, id, true, actor(c)));
});

usersAdmin.post("/:id/enable", async (c) => {
  const id = c.req.param("id");
  return act(c, `/admin/users/${id}`, "User enabled", () => ops.setDisabled(c.env.DB, id, false, actor(c)));
});

usersAdmin.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  try {
    await ops.deleteUser(c.env.DB, id, actor(c));
  } catch (e) {
    if (e instanceof ops.OpError) return act(c, `/admin/users/${id}`, "", async () => { throw e; });
    throw e;
  }
  return act(c, "/admin/users", "User deleted", async () => {});
});
