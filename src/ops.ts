import { audit, getUser, getUserByEmail, listClients } from "./db";
import { newId, nowSec, randomToken, sha256Hex } from "./util";
import { by, OpError } from "./ops-core";
import type { Actor } from "./ops-core";

export { OpError } from "./ops-core";
export * from "./ops-apps";
export * from "./ops-settings";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GROUP_RE = /^[a-z0-9_-]{1,60}$/;
const ENROLL_TTL = 7 * 86400;

export async function mintEnrollmentLink(
  db: D1Database,
  issuer: string,
  userId: string,
  a: Actor,
): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare(
      "INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(await sha256Hex(token), userId, nowSec(), nowSec() + ENROLL_TTL)
    .run();
  await audit(db, "ENROLLMENT_STARTED", { userId, detail: by(a) });
  return `${issuer}/enroll#${token}`;
}

export async function createUser(
  db: D1Database,
  issuer: string,
  input: { name: string; email: string; groups?: string[]; isAdmin?: boolean },
  a: Actor,
): Promise<{ id: string; enrollmentLink: string }> {
  const name = input.name.trim().slice(0, 120);
  const email = input.email.trim().slice(0, 254);
  if (!name) throw new OpError("Name is required.");
  if (!EMAIL_RE.test(email)) throw new OpError("Enter a valid email address.");
  if (await getUserByEmail(db, email)) throw new OpError("A user with that email already exists.");
  const id = newId();
  const now = nowSec();
  await db
    .prepare(
      "INSERT INTO users (id, created_at, name, email, is_admin, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?2)",
    )
    .bind(id, now, name, email, input.isAdmin ? 1 : 0)
    .run();
  if (input.groups?.length) await setUserGroupsByName(db, id, input.groups, a, false);
  await audit(db, "USER_CREATED", { userId: id, detail: by(a) });
  const enrollmentLink = await mintEnrollmentLink(db, issuer, id, a);
  return { id, enrollmentLink };
}

export async function updateUser(
  db: D1Database,
  id: string,
  input: { name?: string; email?: string },
  a: Actor,
): Promise<void> {
  const user = await getUser(db, id);
  if (!user) throw new OpError("User not found.");
  const name = input.name === undefined ? user.name : input.name.trim().slice(0, 120);
  const email = input.email === undefined ? user.email : input.email.trim().slice(0, 254);
  if (!name) throw new OpError("Name is required.");
  if (!EMAIL_RE.test(email)) throw new OpError("Enter a valid email address.");
  if (email.toLowerCase() !== user.email.toLowerCase()) {
    const clash = await db
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?1) AND id != ?2")
      .bind(email, id)
      .first();
    if (clash) throw new OpError("That email is already in use.");
  }
  await db
    .prepare("UPDATE users SET name = ?1, email = ?2, updated_at = ?3 WHERE id = ?4")
    .bind(name, email, nowSec(), id)
    .run();
  await audit(db, "USER_PROFILE_UPDATED", {
    userId: id,
    detail: by(a, { nameChanged: name !== user.name, emailChanged: email !== user.email }),
  });
}

export async function setDisabled(
  db: D1Database,
  id: string,
  disabled: boolean,
  a: Actor,
): Promise<void> {
  if (id === a.adminId && disabled) throw new OpError("You can't disable your own account.");
  if (!(await getUser(db, id))) throw new OpError("User not found.");
  const stmts = [
    db
      .prepare("UPDATE users SET disabled = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(disabled ? 1 : 0, nowSec(), id),
  ];
  if (disabled) {
    stmts.push(db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id));
    stmts.push(db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?1").bind(id));
  }
  await db.batch(stmts);
  await audit(db, disabled ? "USER_DISABLED" : "USER_ENABLED", { userId: id, detail: by(a) });
}

export async function setAdmin(
  db: D1Database,
  id: string,
  isAdmin: boolean,
  a: Actor,
): Promise<void> {
  if (id === a.adminId) throw new OpError("You can't change your own role.");
  if (!(await getUser(db, id))) throw new OpError("User not found.");
  const stmts = [
    db
      .prepare("UPDATE users SET is_admin = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(isAdmin ? 1 : 0, nowSec(), id),
  ];
  if (!isAdmin) {
    stmts.push(db.prepare("DELETE FROM api_tokens WHERE created_by = ?1").bind(id));
    stmts.push(
      db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?1 AND (scope LIKE '%mcp%')").bind(id),
    );
  }
  await db.batch(stmts);
  await audit(db, isAdmin ? "ADMIN_GRANTED" : "ADMIN_REVOKED", { userId: id, detail: by(a) });
}

export async function deleteUser(db: D1Database, id: string, a: Actor): Promise<void> {
  if (id === a.adminId) throw new OpError("You can't delete your own account.");
  const user = await getUser(db, id);
  if (!user) throw new OpError("User not found.");
  await db.prepare("DELETE FROM users WHERE id = ?1").bind(id).run();
  await audit(db, "USER_DELETED", { detail: by(a, { email: user.email }) });
}

export async function revokePasskeys(db: D1Database, id: string, a: Actor): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM webauthn_credentials WHERE user_id = ?1").bind(id),
    db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(id),
    db.prepare("DELETE FROM refresh_tokens WHERE user_id = ?1").bind(id),
  ]);
  await audit(db, "PASSKEYS_REVOKED", { userId: id, detail: by(a) });
}

export async function revokeSessions(
  db: D1Database,
  userId: string,
  a: Actor,
  sessionHash?: string,
): Promise<void> {
  if (sessionHash) {
    await db
      .prepare("DELETE FROM sessions WHERE id_hash = ?1 AND user_id = ?2")
      .bind(sessionHash, userId)
      .run();
  } else {
    await db.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId).run();
  }
  await audit(db, "SESSION_REVOKED", { userId, detail: by(a, { all: !sessionHash }) });
}

export async function setUserGroupsByName(
  db: D1Database,
  userId: string,
  names: string[],
  a: Actor,
  log = true,
): Promise<void> {
  const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  const { results } = await db
    .prepare("SELECT id, name FROM groups")
    .all<{ id: string; name: string }>();
  const byName = new Map(results.map((g) => [g.name, g.id]));
  const missing = wanted.filter((n) => !byName.has(n));
  if (missing.length) throw new OpError(`Unknown group: ${missing.join(", ")}`);
  const now = nowSec();
  await db.batch([
    db.prepare("DELETE FROM group_members WHERE user_id = ?1").bind(userId),
    ...wanted.map((n) =>
      db
        .prepare("INSERT INTO group_members (group_id, user_id, created_at) VALUES (?1, ?2, ?3)")
        .bind(byName.get(n), userId, now),
    ),
  ]);
  if (log) await audit(db, "USER_GROUPS_UPDATED", { userId, detail: by(a, { groups: wanted }) });
}

export async function createGroup(
  db: D1Database,
  input: { name: string; description?: string },
  a: Actor,
): Promise<string> {
  const name = input.name.trim().toLowerCase();
  if (!GROUP_RE.test(name))
    throw new OpError("Group names use lowercase letters, numbers, dashes and underscores.");
  const exists = await db.prepare("SELECT 1 AS x FROM groups WHERE name = ?1").bind(name).first();
  if (exists) throw new OpError("A group with that name already exists.");
  const id = newId();
  await db
    .prepare("INSERT INTO groups (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, name, input.description?.trim().slice(0, 200) || null, nowSec())
    .run();
  await audit(db, "GROUP_CREATED", { detail: by(a, { name }) });
  return id;
}

export async function updateGroup(
  db: D1Database,
  id: string,
  input: { description?: string },
  a: Actor,
): Promise<void> {
  await db
    .prepare("UPDATE groups SET description = ?1 WHERE id = ?2")
    .bind(input.description?.trim().slice(0, 200) || null, id)
    .run();
  await audit(db, "GROUP_UPDATED", { detail: by(a, { group: id }) });
}

export async function deleteGroup(db: D1Database, id: string, a: Actor): Promise<void> {
  const g = await db
    .prepare("SELECT name FROM groups WHERE id = ?1")
    .bind(id)
    .first<{ name: string }>();
  if (!g) throw new OpError("Group not found.");
  const clients = (await listClients(db)).filter((c) => c.allowed_groups?.includes(g.name));
  const { results: apps } = await db
    .prepare("SELECT name, allowed_groups FROM apps")
    .all<{ name: string; allowed_groups: string | null }>();
  const appRefs = apps.filter((x) => {
    const list: unknown = x.allowed_groups ? JSON.parse(x.allowed_groups) : [];
    return Array.isArray(list) && list.includes(g.name);
  });
  const refs = [...clients.map((c) => c.name), ...appRefs.map((x) => x.name)];
  if (refs.length)
    throw new OpError(`“${g.name}” is still used by: ${refs.join(", ")}. Remove it there first.`);
  await db.batch([
    db.prepare("DELETE FROM group_members WHERE group_id = ?1").bind(id),
    db.prepare("DELETE FROM groups WHERE id = ?1").bind(id),
  ]);
  await audit(db, "GROUP_DELETED", { detail: by(a, { name: g.name }) });
}

export async function setGroupMember(
  db: D1Database,
  groupId: string,
  userId: string,
  member: boolean,
  a: Actor,
): Promise<void> {
  if (member) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO group_members (group_id, user_id, created_at) VALUES (?1, ?2, ?3)",
      )
      .bind(groupId, userId, nowSec())
      .run();
  } else {
    await db
      .prepare("DELETE FROM group_members WHERE group_id = ?1 AND user_id = ?2")
      .bind(groupId, userId)
      .run();
  }
  await audit(db, member ? "GROUP_MEMBER_ADDED" : "GROUP_MEMBER_REMOVED", {
    userId,
    detail: by(a, { group: groupId }),
  });
}
