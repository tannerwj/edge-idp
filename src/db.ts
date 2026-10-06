import { emailKey, nowSec } from "./util";

export interface User {
  id: string;
  created_at: number;
  name: string;
  email: string;
  is_admin: number;
  disabled: number;
  updated_at: number;
}

export interface WebAuthnCredential {
  id: string;
  user_id: string;
  credential_id: ArrayBuffer;
  public_key: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[] | undefined;
  name: string;
  backup_eligible: number;
  backup_state: number;
  aaguid: string | null;
  created_at: number;
  last_used_at: number | null;
}

export interface OidcClient {
  id: string;
  name: string;
  redirect_uris: string[];
  secret_hash: string;
  secret_prefix: string;
  allowed_groups: string[] | null;
  created_at: number;
  created_by: string | null;
}

interface Row {
  [k: string]: unknown;
}

/**
 * D1 returns untyped rows; these validators fail fast on schema drift
 * instead of letting `undefined` masquerade as a string downstream.
 */
function str(v: unknown): string {
  if (typeof v !== "string") throw new Error("db: expected string column");
  return v;
}

function num(v: unknown): number {
  if (typeof v !== "number") throw new Error("db: expected number column");
  return v;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return str(v);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return num(v);
}

/** JSON-encoded string[] columns (redirect URIs, transports, groups). */
function strArray(v: unknown): string[] {
  const parsed: unknown = typeof v === "string" ? JSON.parse(v) : v;
  if (!Array.isArray(parsed)) throw new Error("db: expected string[] column");
  const out: string[] = [];
  for (const x of parsed) {
    if (typeof x !== "string") throw new Error("db: expected string[] column");
    out.push(x);
  }
  return out;
}

function rowToUser(r: Row): User {
  return {
    id: str(r.id),
    created_at: num(r.created_at),
    name: str(r.name),
    email: str(r.email),
    is_admin: num(r.is_admin),
    disabled: num(r.disabled),
    updated_at: num(r.updated_at),
  };
}

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  const r = await db
    .prepare("SELECT * FROM users WHERE id = ?1")
    .bind(id)
    .first<Row>();
  return r ? rowToUser(r) : null;
}

export async function getUserByEmail(
  db: D1Database,
  email: string,
): Promise<User | null> {
  // SQLite LIKE is case-insensitive for ASCII; emails are stored as-given but
  // looked up by lowercased key so admin typos in case can't create duplicates.
  const r = await db
    .prepare("SELECT * FROM users WHERE lower(email) = ?1")
    .bind(emailKey(email))
    .first<Row>();
  return r ? rowToUser(r) : null;
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db
    .prepare("SELECT * FROM users ORDER BY created_at ASC")
    .all<Row>();
  return results.map(rowToUser);
}

/** Group names for the ID token `groups` claim. Sorted for stable tokens. */
export async function getUserGroups(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT g.name AS name FROM groups g
       JOIN group_members m ON m.group_id = g.id
       WHERE m.user_id = ?1 ORDER BY g.name ASC`,
    )
    .bind(userId)
    .all<{ name: string }>();
  return results.map((r) => r.name);
}

export async function getCredentialsForUser(
  db: D1Database,
  userId: string,
): Promise<WebAuthnCredential[]> {
  const { results } = await db
    .prepare("SELECT * FROM webauthn_credentials WHERE user_id = ?1")
    .bind(userId)
    .all<Row>();
  return results.map((r) => ({
    id: str(r.id),
    user_id: str(r.user_id),
    credential_id:
      r.credential_id instanceof ArrayBuffer
        ? r.credential_id.slice(0)
        : new ArrayBuffer(0),
    public_key: new Uint8Array(
      r.public_key instanceof ArrayBuffer ? r.public_key : new ArrayBuffer(0),
    ),
    counter: num(r.counter),
    transports:
      typeof r.transports === "string" ? strArray(r.transports) : undefined,
    name: str(r.name),
    backup_eligible: num(r.backup_eligible),
    backup_state: num(r.backup_state),
    aaguid: strOrNull(r.aaguid),
    created_at: num(r.created_at),
    last_used_at: numOrNull(r.last_used_at),
  }));
}

function rowToClient(r: Row): OidcClient {
  return {
    id: str(r.id),
    name: str(r.name),
    redirect_uris: strArray(str(r.redirect_uris)),
    secret_hash: str(r.secret_hash),
    secret_prefix: str(r.secret_prefix),
    allowed_groups:
      typeof r.allowed_groups === "string"
        ? strArray(r.allowed_groups)
        : null,
    created_at: num(r.created_at),
    created_by: strOrNull(r.created_by),
  };
}

export async function getClient(
  db: D1Database,
  id: string,
): Promise<OidcClient | null> {
  const r = await db
    .prepare("SELECT * FROM oidc_clients WHERE id = ?1")
    .bind(id)
    .first<Row>();
  return r ? rowToClient(r) : null;
}

export async function listClients(db: D1Database): Promise<OidcClient[]> {
  const { results } = await db
    .prepare("SELECT * FROM oidc_clients ORDER BY created_at ASC")
    .all<Row>();
  return results.map(rowToClient);
}

export async function audit(
  db: D1Database,
  event: string,
  opts: {
    userId?: string | null;
    clientId?: string | null;
    ipHash?: string | null;
    userAgent?: string | null;
    detail?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (created_at, event, user_id, client_id, ip_hash, user_agent, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      nowSec(),
      event,
      opts.userId ?? null,
      opts.clientId ?? null,
      opts.ipHash ?? null,
      (opts.userAgent ?? null)?.slice(0, 300) ?? null,
      opts.detail ? JSON.stringify(opts.detail) : null,
    )
    .run();
  // Keep the table bounded: audit logs are evidence, not a growth vector.
  await db
    .prepare(
      "DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 20000)",
    )
    .run();
}

