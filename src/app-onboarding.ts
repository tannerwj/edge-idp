import { auditStmt, getApp, getUserByEmail } from "./db";
import { by, EMAIL_RE, OpError } from "./ops-core";
import type { Actor } from "./ops-core";
import { newId, nowSec, randomToken, sha256Hex } from "./util";

function validateInviteName(name: string) {
  if (!name.trim() || name.length > 120 || /[\p{Cc}\p{Cf}]/u.test(name))
    throw new OpError("Enter a name of up to 120 characters.");
}
export async function inviteToApp(
  db: D1Database,
  issuer: string,
  input: { appId: string; email: string; name: string; existingOnly?: boolean },
  actor: Actor,
) {
  const { appId, email, name, existingOnly } = input;
  const app = await getApp(db, appId);
  if (!app || !EMAIL_RE.test(email) || email.toLowerCase().endsWith("@public.invalid"))
    throw new OpError("Choose an app and a valid member email.");
  const existing = await getUserByEmail(db, email);
  if (existing?.disabled || existing?.public || (!existing && existingOnly))
    throw new OpError("Choose an active member.");
  if (!existing) validateInviteName(name);
  const userId = existing?.id ?? newId();
  const stmts: D1PreparedStatement[] = [];
  let link = issuer + "/open/" + encodeURIComponent(app.id);
  if (!existing) {
    const token = randomToken(32);
    stmts.push(
      db
        .prepare(
          "INSERT INTO users(id,created_at,updated_at,name,email,is_admin) SELECT ?,unixepoch(),unixepoch(),?,?,0 WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email)=lower(?))",
        )
        .bind(userId, name.trim(), email, email),
      db
        .prepare(
          "INSERT INTO enrollment_tokens(token_hash,user_id,created_at,expires_at) VALUES (?,?,unixepoch(),?)",
        )
        .bind(await sha256Hex(token), userId, nowSec() + 7 * 86400),
      auditStmt(db, "USER_CREATED", { userId, detail: by(actor) }),
    );
    link = issuer + "/enroll?app=" + encodeURIComponent(app.id) + "#" + token;
  }
  stmts.push(
    db
      .prepare(
        "INSERT INTO app_grants(id,app_id,user_id,created_at) SELECT ?,?,?,unixepoch() WHERE NOT EXISTS (SELECT 1 FROM app_grants WHERE app_id=? AND user_id=? AND role IS NULL)",
      )
      .bind(newId(), app.id, userId, app.id, userId),
    db
      .prepare(
        "INSERT OR IGNORE INTO app_invitations(app_id,user_id,invited_at) VALUES (?,?,unixepoch())",
      )
      .bind(app.id, userId),
    auditStmt(db, "APP_INVITED", {
      userId,
      clientId: app.client_id,
      detail: by(actor, { app: app.id }),
    }),
  );
  try {
    await db.batch(stmts);
  } catch (error) {
    if (!existing && (await getUserByEmail(db, email)))
      throw new OpError(
        "This member was created during the invitation. Preview again to use their account.",
      );
    throw error;
  }
  return {
    appName: app.name,
    link,
    user: { id: userId, name: existing?.name ?? name, email, public: 0 },
    created: !existing,
  };
}

export async function connectionEvents(db: D1Database, client: string, since: number) {
  const { results } = await db
    .prepare(
      "SELECT id,event,created_at FROM audit_log WHERE client_id=? AND created_at>=? AND event IN ('CALLBACK_MATCHED','SIGN_IN_PROBLEM','CODE_ISSUED','TOKEN_ISSUED','CLIENT_AUTH_FAILED','CODE_REJECTED') ORDER BY id DESC LIMIT 30",
    )
    .bind(client, since)
    .all<{ id: number; event: string; created_at: number }>();
  return results;
}
