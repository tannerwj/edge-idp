import type { App, User, Group, OidcClient } from "../db";
import { Hono } from "hono";
import { listApps, listGroups, listUsers, listClients } from "../db";
import { listGrants, resolveAccess, claimsForClient } from "../access";
import { clientAccessProblem } from "../oauth-shared";
import type { Grant, UserContext } from "../access";
import { field, fields, page } from "./shell";
import type { AdminVars } from "./shell";
export const previews = new Hono<AdminVars>();
previews.post("/preview/*", async (c) => {
  const db = c.env.DB,
    form = await c.req.parseBody({ all: true });
  const path = new URL(c.req.url).pathname.replace("/admin/preview/", "").split("/");

  const [apps, users, groups, grants, membership, clients] = await Promise.all([
    listApps(db),
    listUsers(db),
    listGroups(db),
    listGrants(db),
    db
      .prepare("SELECT user_id,group_id FROM group_members")
      .all<{ user_id: string; group_id: string }>(),
    listClients(db),
  ]);
  const plan = previewPlan(path, form, groups, grants, membership.results);
  if (!plan) return c.notFound();
  const lines = previewRows(
    { apps, users, groups, grants, membership: membership.results, clients },
    plan,
  );
  return page(
    c,
    { active: "apps", title: "Preview access changes" },
    <form
      class="card card-body stack"
      method="post"
      action={"/admin/" + path.map(encodeURIComponent).join("/")}
    >
      <h1>Preview access changes</h1>
      <p>
        Launcher access, sign-in eligibility and roles for linked clients. External app policies
        apply separately.
      </p>
      {lines.length ? <ul>{lines}</ul> : <p>No launcher access or role changes.</p>}
      {Object.entries(form).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map(
          (value) =>
            typeof value === "string" && (
              <input key={k + value} type="hidden" name={k} value={value} />
            ),
        ),
      )}
      <button>Apply change</button>
    </form>,
  );
});

type Membership = { user_id: string; group_id: string };
function previewPlan(
  path: string[],
  form: Record<string, string | File | (string | File)[]>,
  groups: Group[],
  grants: Grant[],
  membership: Membership[],
) {
  const [kind, id = "", op = "", extra] = path;
  const groupGrant = kind === "apps" && id === "groups";
  let change: Grant | undefined;
  let nextGrants = grants;
  let targetUser = "";
  let membershipAfter: string[] = [];
  if (kind === "apps" && id === "grants" && extra === "delete") {
    change = grants.find((g) => g.id === op);
    if (!change) return null;
    nextGrants = grants.filter((g) => g !== change);
  } else if (kind === "apps" && (groupGrant ? extra : op) === "grants") {
    change = proposedGrant(form, groupGrant ? null : id, groupGrant ? op : null);
    nextGrants = [...grants, change];
  } else if (kind === "users" && op === "groups") {
    targetUser = id;
    membershipAfter = groups
      .filter((g) => fields(form, "groups").includes(g.name))
      .map((g) => g.id);
  } else if (kind === "groups" && op === "members") {
    targetUser = extra || field(form, "user_id");
    membershipAfter = membership
      .filter((m) => m.user_id === targetUser && m.group_id !== id)
      .map((m) => m.group_id);
    if (!extra) membershipAfter.push(id);
  } else return null;
  return { change, nextGrants, targetUser, membershipAfter };
}
function previewRows(
  data: {
    apps: App[];
    users: User[];
    groups: Group[];
    grants: Grant[];
    membership: Membership[];
    clients: OidcClient[];
  },
  plan: NonNullable<ReturnType<typeof previewPlan>>,
) {
  const { apps, users, groups, grants, membership } = data;
  const { change, nextGrants, targetUser, membershipAfter } = plan;
  const lines = [];
  for (const user of users.filter((u) => !u.disabled && (!targetUser || u.id === targetUser))) {
    const subject = {
      userId: user.id,
      isPublic: !!user.public,
      groupIds: membership.filter((m) => m.user_id === user.id).map((m) => m.group_id),
    };
    const afterSubject = targetUser ? { ...subject, groupIds: membershipAfter } : subject;
    const before = resolveAccess(apps, grants, subject),
      after = resolveAccess(apps, nextGrants, afterSubject);
    const ctx = {
      user,
      apps,
      groups: groups.filter((g) => subject.groupIds.includes(g.id)).map((g) => g.name),
      grants,
      subject,
      access: before,
    };
    const nextCtx = {
      ...ctx,
      groups: groups.filter((g) => afterSubject.groupIds.includes(g.id)).map((g) => g.name),
      grants: nextGrants,
      subject: afterSubject,
      access: after,
    };
    lines.push(...clientChanges(data.clients, ctx, nextCtx));
    for (const app of apps) {
      const prev = before.get(app.id),
        next = after.get(app.id);
      const affected = change && resolveAccess([app], [change], subject).has(app.id);
      const membershipAffected =
        targetUser &&
        grants.some(
          (g) =>
            g.group_id &&
            subject.groupIds.includes(g.group_id) !== afterSubject.groupIds.includes(g.group_id) &&
            (g.app_id === app.id || (g.app_group_id && g.app_group_id === app.app_group_id)),
        );
      if (!membershipAffected && JSON.stringify(prev) === JSON.stringify(next) && !affected)
        continue;
      const via = nextGrants
        .filter((g) => resolveAccess([app], [g], afterSubject).has(app.id))
        .map((g) =>
          g.everyone
            ? "All members"
            : g.group_id
              ? groups.find((group) => group.id === g.group_id)?.name
              : "direct grant",
        );
      lines.push(
        <li>
          {user.name} · {app.name} ·{" "}
          {prev ? (next ? "Keeps access" : "Loses access") : "Gains access"}
          {prev?.length ? " · previous roles: " + prev.join(", ") : ""}
          {next?.length ? " · resulting roles: " + next.join(", ") : ""}
          {via.length ? " · via " + [...new Set(via)].join(", ") : ""}
        </li>,
      );
    }
  }
  return lines;
}

function proposedGrant(
  form: Record<string, string | File | (string | File)[]>,
  appId: string | null,
  groupId: string | null,
): Grant {
  const subject = field(form, "subject"),
    role = field(form, "role").trim().toLowerCase();
  return {
    id: "preview",
    created_at: 0,
    app_id: appId,
    app_group_id: groupId,
    user_id: subject.startsWith("user:") ? subject.slice(5) : null,
    group_id: subject.startsWith("group:") ? subject.slice(6) : null,
    everyone: Number(subject === "everyone"),
    role: role || null,
  };
}

function signInResult(client: OidcClient, ctx: UserContext) {
  const denied = clientAccessProblem(ctx, client, ["openid"]);
  if (denied) return "Denied (" + denied + ")";
  const roles = claimsForClient(ctx.apps, ctx.access, client.id).roles;
  return roles?.length ? "Eligible with roles " + roles.join(", ") : "Eligible";
}
function clientChanges(clients: OidcClient[], before: UserContext, after: UserContext) {
  return clients.flatMap((client) => {
    const previous = signInResult(client, before),
      next = signInResult(client, after);
    return previous === next
      ? []
      : [
          <li key={client.id}>
            {before.user.name} · {client.name} sign-in · {previous} → {next}
          </li>,
        ];
  });
}
