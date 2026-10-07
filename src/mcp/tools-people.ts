/** MCP tools: users and groups. */
import { getUserGroups, listGroups, listUsers } from "../db";
import * as ops from "../ops";
import { USER_REF, groupByRef, obj, str, strList, userByRef } from "./common";
import type { ToolDef } from "./common";

export const PEOPLE_TOOLS: ToolDef[] = [
  /* ── users ── */
  {
    name: "users_list",
    write: false,
    description: "List all users: id, name, email, admin/disabled flags, groups, passkey count, last sign-in.",
    inputSchema: obj(),
    handler: async ({ db }) => {
      const [users, { results: keys }, { results: members }] = await Promise.all([
        listUsers(db),
        db.prepare("SELECT user_id, COUNT(*) AS n FROM webauthn_credentials GROUP BY user_id").all<{ user_id: string; n: number }>(),
        db
          .prepare("SELECT m.user_id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id")
          .all<{ user_id: string; name: string }>(),
      ]);
      const keyCount = new Map(keys.map((k) => [k.user_id, k.n]));
      const groupsByUser = new Map<string, string[]>();
      for (const member of members) {
        const groups = groupsByUser.get(member.user_id) ?? [];
        groups.push(member.name);
        groupsByUser.set(member.user_id, groups);
      }
      return users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        is_admin: !!u.is_admin,
        disabled: !!u.disabled,
        groups: groupsByUser.get(u.id) ?? [],
        passkeys: keyCount.get(u.id) ?? 0,
        last_sign_in_at: u.last_sign_in_at,
      }));
    },
  },
  {
    name: "users_get",
    write: false,
    description: "One user in detail: profile, groups, passkeys, active sessions, connected OAuth apps.",
    inputSchema: obj(USER_REF),
    handler: async ({ db }, args) => {
      const u = await userByRef(db, args);
      const [groups, keys, sessions, grants] = await Promise.all([
        getUserGroups(db, u.id),
        db.prepare("SELECT id, name, created_at, last_used_at, backup_state FROM webauthn_credentials WHERE user_id = ?1").bind(u.id).all(),
        db.prepare("SELECT created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC").bind(u.id).all(),
        db
          .prepare("SELECT g.client_id, c.name, g.scope, g.last_used_at FROM oauth_grants g JOIN oidc_clients c ON c.id = g.client_id WHERE g.user_id = ?1")
          .bind(u.id)
          .all(),
      ]);
      return { ...u, is_admin: !!u.is_admin, disabled: !!u.disabled, groups, passkeys: keys.results, sessions: sessions.results, connected_apps: grants.results };
    },
  },
  {
    name: "users_create",
    write: true,
    description: "Create a user and return their one-time enrollment link (valid 7 days). Optionally put them in groups or make them an admin.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Display name" },
        email: { type: "string", description: "Email address (unique)" },
        groups: { type: "array", items: { type: "string" }, description: "Group names" },
        is_admin: { type: "boolean" },
      },
      ["name", "email"],
    ),
    handler: async ({ db, env, actor }, args) => {
      const r = await ops.createUser(
        db,
        env.ISSUER,
        { name: str(args.name), email: str(args.email), groups: strList(args.groups), isAdmin: args.is_admin === true },
        actor,
      );
      return { id: r.id, enrollment_link: r.enrollmentLink };
    },
  },
  {
    name: "users_update",
    write: true,
    description: "Change a user's name and/or email.",
    inputSchema: obj({ ...USER_REF, name: { type: "string" }, new_email: { type: "string" } }),
    handler: async ({ db, actor }, args) => {
      const u = await userByRef(db, args);
      await ops.updateUser(
        db,
        u.id,
        { ...(args.name !== undefined ? { name: str(args.name) } : {}), ...(args.new_email !== undefined ? { email: str(args.new_email) } : {}) },
        actor,
      );
      return { ok: true };
    },
  },
  {
    name: "users_set_groups",
    write: true,
    description: "Replace a user's group memberships with exactly this list of group names.",
    inputSchema: obj({ ...USER_REF, groups: { type: "array", items: { type: "string" } } }, ["groups"]),
    handler: async ({ db, actor }, args) => {
      const u = await userByRef(db, args);
      await ops.setUserGroupsByName(db, u.id, strList(args.groups), actor);
      return { ok: true, groups: await getUserGroups(db, u.id) };
    },
  },
  {
    name: "users_set_disabled",
    write: true,
    description: "Disable (signs them out everywhere) or re-enable a user.",
    inputSchema: obj({ ...USER_REF, disabled: { type: "boolean" } }, ["disabled"]),
    handler: async ({ db, actor }, args) => {
      const u = await userByRef(db, args);
      await ops.setDisabled(db, u.id, args.disabled === true, actor);
      return { ok: true };
    },
  },
  {
    name: "users_set_admin",
    write: true,
    description: "Grant or remove admin. Removing admin also deletes their API tokens and MCP refresh tokens.",
    inputSchema: obj({ ...USER_REF, is_admin: { type: "boolean" } }, ["is_admin"]),
    handler: async ({ db, actor }, args) => {
      const u = await userByRef(db, args);
      await ops.setAdmin(db, u.id, args.is_admin === true, actor);
      return { ok: true };
    },
  },
  {
    name: "users_enrollment_link",
    write: true,
    description: "Mint a new one-time passkey enrollment link for a user (first setup or recovery).",
    inputSchema: obj(USER_REF),
    handler: async ({ db, env, actor }, args) => {
      const u = await userByRef(db, args);
      return { enrollment_link: await ops.mintEnrollmentLink(db, env.ISSUER, u.id, actor) };
    },
  },
  {
    name: "users_reset_passkeys",
    write: true,
    description: "Account recovery: delete ALL of a user's passkeys and sessions. Follow with users_enrollment_link.",
    inputSchema: obj(USER_REF),
    handler: async ({ db, actor }, args) => {
      const u = await userByRef(db, args);
      await ops.revokePasskeys(db, u.id, actor);
      return { ok: true };
    },
  },
  {
    name: "users_sign_out",
    write: true,
    description: "Sign a user out of every browser session.",
    inputSchema: obj(USER_REF),
    handler: async ({ db, actor }, args) => {
      const u = await userByRef(db, args);
      await ops.revokeSessions(db, u.id, actor);
      return { ok: true };
    },
  },
  {
    name: "users_delete",
    write: true,
    description: "Permanently delete a user (passkeys, sessions, memberships cascade). Prefer users_set_disabled.",
    inputSchema: obj(USER_REF),
    handler: async ({ db, actor }, args) => {
      const u = await userByRef(db, args);
      await ops.deleteUser(db, u.id, actor);
      return { ok: true };
    },
  },
  /* ── groups ── */
  {
    name: "groups_list",
    write: false,
    description: "List groups with descriptions and member counts.",
    inputSchema: obj(),
    handler: async ({ db }) => listGroups(db),
  },
  {
    name: "groups_create",
    write: true,
    description: "Create a group. Names: lowercase letters, numbers, dash, underscore. Group names appear in the `groups` claim.",
    inputSchema: obj({ name: { type: "string" }, description: { type: "string" } }, ["name"]),
    handler: async ({ db, actor }, args) => ({
      id: await ops.createGroup(db, { name: str(args.name), description: str(args.description) }, actor),
    }),
  },
  {
    name: "groups_delete",
    write: true,
    description: "Delete a group (refused while any app or client still references it).",
    inputSchema: obj({ group: { type: "string", description: "Group id or name" } }, ["group"]),
    handler: async ({ db, actor }, args) => {
      const g = await groupByRef(db, str(args.group));
      await ops.deleteGroup(db, g.id, actor);
      return { ok: true };
    },
  },
  {
    name: "groups_set_member",
    write: true,
    description: "Add (member: true) or remove (member: false) a user from a group.",
    inputSchema: obj(
      { group: { type: "string", description: "Group id or name" }, ...USER_REF, member: { type: "boolean" } },
      ["group", "member"],
    ),
    handler: async ({ db, actor }, args) => {
      const g = await groupByRef(db, str(args.group));
      const u = await userByRef(db, args);
      await ops.setGroupMember(db, g.id, u.id, args.member !== false, actor);
      return { ok: true };
    },
  },
];
