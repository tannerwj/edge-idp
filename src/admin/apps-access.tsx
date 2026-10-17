import { Hono } from "hono";
import type { Group, User } from "../db";
import { DEFAULT_ROLES } from "../access";
import type { AppGroup, Grant } from "../access";
import * as ops from "../ops";
import type { AdminVars } from "./shell";
import { act, actor, field } from "./shell";
import { Dialog, PostButton } from "../ui/components";
import { Icon } from "../ui/icons";

export interface AccessData {
  grants: Grant[];
  groups: Group[];
  users: User[];
  appGroups: AppGroup[];
}

export const appsAccessAdmin = new Hono<AdminVars>();

function subjectLabel(g: Grant, d: AccessData): string {
  if (g.everyone) return "Everyone";
  if (g.user_id) return d.users.find((u) => u.id === g.user_id)?.name ?? "Unknown person";
  return d.groups.find((x) => x.id === g.group_id)?.name ?? "Unknown group";
}

function subjectIcon(g: Grant) {
  if (g.everyone) return "globe" as const;
  return g.user_id ? ("user" as const) : ("users" as const);
}

export function GrantChips(props: { grants: Grant[]; d: AccessData; empty?: string }) {
  if (!props.grants.length) return <span class="muted small">{props.empty ?? "Nobody yet"}</span>;
  return (
    <span class="chips">
      {props.grants.map((g) => (
        <span key={g.id} class="badge">
          {subjectLabel(g, props.d)}
          {g.role ? <span class="muted"> · {g.role}</span> : null}
        </span>
      ))}
    </span>
  );
}

export function RoleSuggestions() {
  return (
    <datalist id="role-suggestions">
      {DEFAULT_ROLES.map((r) => (
        <option key={r} value={r} />
      ))}
    </datalist>
  );
}

function GrantRow(props: { g: Grant; d: AccessData; via?: string }) {
  const g = props.g;
  return (
    <li>
      <Icon name={subjectIcon(g)} />
      <div class="grow">
        <div class="title">{subjectLabel(g, props.d)}</div>
        <div class="meta">
          {g.role ? `Role: ${g.role}` : "Can open it, no role"}
          {props.via ? ` · via ${props.via}` : ""}
        </div>
      </div>
      {props.via ? null : (
        <PostButton
          action={`/admin/apps/grants/${g.id}/delete`}
          label=""
          icon="trash"
          class="btn ghost icon sm"
          title="Remove access"
          confirm={`Remove ${subjectLabel(g, props.d)}'s access?`}
        />
      )}
    </li>
  );
}

function SubjectSelect(props: { d: AccessData }) {
  return (
    <select name="subject" required>
      <option value="everyone">Everyone who can sign in</option>
      <optgroup label="Groups">
        {props.d.groups.map((g) => (
          <option key={g.id} value={`group:${g.id}`}>
            {g.name}
          </option>
        ))}
      </optgroup>
      <optgroup label="People">
        {props.d.users.map((u) => (
          <option key={u.id} value={`user:${u.id}`}>
            {u.name} ({u.email})
          </option>
        ))}
      </optgroup>
    </select>
  );
}

export function AccessDialog(props: {
  id: string;
  title: string;
  action: string;
  own: Grant[];
  inherited?: { from: string; grants: Grant[] };
  d: AccessData;
}) {
  const inherited = props.inherited?.grants ?? [];
  return (
    <Dialog
      id={props.id}
      sheet
      title={props.title}
      lede="Who can open it, and with which role. Apps receive roles as roles: [“slug:role”] and decide what each one allows."
    >
      <div class="stack">
        {props.own.length + inherited.length ? (
          <ul class="list">
            {props.own.map((g) => (
              <GrantRow key={g.id} g={g} d={props.d} />
            ))}
            {inherited.map((g) => (
              <GrantRow key={g.id} g={g} d={props.d} via={props.inherited?.from} />
            ))}
          </ul>
        ) : (
          <p class="muted small">Nobody has access yet.</p>
        )}
        <form method="post" action={props.action} class="stack-sm">
          <div class="grid-2">
            <label class="field">
              <span class="label">Who</span>
              <SubjectSelect d={props.d} />
            </label>
            <label class="field">
              <span class="label">Role (optional)</span>
              <input
                name="role"
                list="role-suggestions"
                maxLength={30}
                placeholder="admin, writer, reader"
              />
            </label>
          </div>
          <span class="hint">
            A role on an app group applies to every app in it under the same name, so stick to
            shared names like admin, writer and reader there.
          </span>
          <div>
            <button class="btn primary sm" type="submit">
              <Icon name="plus" size="sm" />
              Grant access
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

export function AppGroupForm(props: { group?: AppGroup }) {
  return (
    <>
      <label class="field">
        <span class="label">Name</span>
        <input
          name="name"
          required
          maxLength={60}
          value={props.group?.name ?? ""}
          placeholder="Home"
        />
      </label>
      <label class="field">
        <span class="label">Description</span>
        <input
          name="description"
          maxLength={200}
          value={props.group?.description ?? ""}
          placeholder="Optional; shown under the section on the home screen"
        />
      </label>
    </>
  );
}

function subjectOf(raw: string): ops.GrantInput {
  if (raw === "everyone") return { everyone: true };
  const [kind, id] = raw.split(":");
  if (kind === "group" && id) return { groupId: id };
  if (kind === "user" && id) return { userId: id };
  throw new ops.OpError("Pick who gets access.");
}

appsAccessAdmin.post("/groups", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/apps", "App group created", () =>
    ops.createAppGroup(
      c.env.DB,
      { name: field(form, "name"), description: field(form, "description") },
      actor(c),
    ),
  );
});

appsAccessAdmin.post("/groups/:id", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/apps", "App group saved", () =>
    ops.updateAppGroup(
      c.env.DB,
      c.req.param("id"),
      { name: field(form, "name"), description: field(form, "description") },
      actor(c),
    ),
  );
});

appsAccessAdmin.post("/groups/:id/delete", async (c) =>
  act(c, "/admin/apps", "App group deleted", () =>
    ops.deleteAppGroup(c.env.DB, c.req.param("id"), actor(c)),
  ),
);

appsAccessAdmin.post("/groups/:id/grants", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/apps", "Access granted", async () =>
    ops.addGrant(
      c.env.DB,
      {
        ...subjectOf(field(form, "subject")),
        appGroupId: c.req.param("id"),
        role: field(form, "role"),
      },
      actor(c),
    ),
  );
});

appsAccessAdmin.post("/grants/:gid/delete", async (c) =>
  act(c, "/admin/apps", "Access removed", () =>
    ops.removeGrant(c.env.DB, c.req.param("gid"), actor(c)),
  ),
);

appsAccessAdmin.post("/:id/grants", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/apps", "Access granted", async () =>
    ops.addGrant(
      c.env.DB,
      { ...subjectOf(field(form, "subject")), appId: c.req.param("id"), role: field(form, "role") },
      actor(c),
    ),
  );
});
