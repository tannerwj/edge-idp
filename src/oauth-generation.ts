export async function grantGeneration(db: D1Database, user: string, client: string) {
  return (
    (await db
      .prepare("SELECT generation FROM oauth_disconnects WHERE user_id=? AND client_id=?")
      .bind(user, client)
      .first<number>("generation")) ?? 0
  );
}

export async function activeAssistantGrant(
  db: D1Database,
  user: string,
  client: string,
  generation: unknown,
) {
  if (typeof generation !== "number") return false;
  return !!(await db
    .prepare(`SELECT 1 FROM users u JOIN oidc_clients c ON c.id=?2
 LEFT JOIN oauth_disconnects d ON d.user_id=u.id AND d.client_id=c.id
 WHERE u.id=?1 AND u.is_admin=1 AND u.disabled=0 AND coalesce(d.generation,0)=?3
 AND (c.skip_consent=1 OR EXISTS (SELECT 1 FROM oauth_grants g WHERE g.user_id=u.id AND g.client_id=c.id))`)
    .bind(user, client, generation)
    .first());
}
