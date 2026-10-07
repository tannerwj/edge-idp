import { emailKey, nowSec } from "./util";

export interface User {
  id: string;
  created_at: number;
  name: string;
  email: string;
  is_admin: number;
  disabled: number;
  updated_at: number;
  last_sign_in_at: number | null;
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

export type ClientType = "confidential" | "public";
export type ClientSource = "admin" | "dcr" | "cimd";

export interface OidcClient {
  id: string;
  name: string;
  redirect_uris: string[];
  secret_hash: string;
  secret_prefix: string;
  allowed_groups: string[] | null;
  require_pkce: boolean;
  environment: string;
  created_at: number;
  created_by: string | null;
  client_type: ClientType;
  source: ClientSource;
  client_uri: string | null;
  logo_uri: string | null;
  description: string | null;
  last_used_at: number | null;
  skip_consent: boolean;
  metadata_expires_at: number | null;
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
    last_sign_in_at: numOrNull(r.last_sign_in_at),
  };
}

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  const r = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(id).first<Row>();
  return r ? rowToUser(r) : null;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  // SQLite LIKE is case-insensitive for ASCII; emails are stored as-given but
  // looked up by lowercased key so admin typos in case can't create duplicates.
  const r = await db
    .prepare("SELECT * FROM users WHERE lower(email) = ?1")
    .bind(emailKey(email))
    .first<Row>();
  return r ? rowToUser(r) : null;
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db.prepare("SELECT * FROM users ORDER BY created_at ASC").all<Row>();
  return results.map(rowToUser);
}

/** Group names for the ID token `groups` claim. Sorted for stable tokens. */
export async function getUserGroups(db: D1Database, userId: string): Promise<string[]> {
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

/**
 * D1 BLOB columns don't come back as a single type: local miniflare returns
 * ArrayBuffer while production D1 returns a plain Array of byte values.
 * Normalize either (or a view) to a fresh Uint8Array; anything else is a
 * schema violation, not an empty credential.
 */
function blobBytes(v: unknown, column: string): Uint8Array<ArrayBuffer> {
  if (v instanceof Uint8Array) return v.slice();
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (Array.isArray(v)) {
    const bytes: number[] = [];
    for (const b of v) {
      if (typeof b !== "number") throw new Error(`db: bad BLOB byte in ${column}`);
      bytes.push(b);
    }
    return Uint8Array.from(bytes);
  }
  if (ArrayBuffer.isView(v)) {
    const view: Uint8Array = v instanceof Uint8Array ? v : new Uint8Array(v.buffer);
    return view.slice();
  }
  throw new Error(`db: expected BLOB column ${column}`);
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
    credential_id: blobBytes(r.credential_id, "credential_id").buffer,
    public_key: blobBytes(r.public_key, "public_key"),
    counter: num(r.counter),
    transports: typeof r.transports === "string" ? strArray(r.transports) : undefined,
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
    allowed_groups: typeof r.allowed_groups === "string" ? strArray(r.allowed_groups) : null,
    // Column added in 0002; default true for rows predating it.
    require_pkce: r.require_pkce === undefined ? true : num(r.require_pkce) === 1,
    // Column added in 0005; default production for rows predating it.
    environment: typeof r.environment === "string" ? r.environment : "production",
    created_at: num(r.created_at),
    created_by: strOrNull(r.created_by),
    client_type: r.client_type === "public" ? "public" : "confidential",
    source: r.source === "dcr" || r.source === "cimd" ? r.source : "admin",
    client_uri: strOrNull(r.client_uri),
    logo_uri: strOrNull(r.logo_uri),
    description: strOrNull(r.description),
    last_used_at: numOrNull(r.last_used_at),
    skip_consent: r.skip_consent === undefined ? true : num(r.skip_consent) === 1,
    metadata_expires_at: numOrNull(r.metadata_expires_at),
  };
}

export async function getClient(db: D1Database, id: string): Promise<OidcClient | null> {
  const r = await db.prepare("SELECT * FROM oidc_clients WHERE id = ?1").bind(id).first<Row>();
  return r ? rowToClient(r) : null;
}

export async function listClients(db: D1Database): Promise<OidcClient[]> {
  const { results } = await db
    .prepare("SELECT * FROM oidc_clients ORDER BY created_at ASC")
    .all<Row>();
  return results.map(rowToClient);
}

export { rowToClient };

/** Count helper: `SELECT COUNT(*) AS n …` → number. */
export async function count(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const r = await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface Group {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  members: number;
}

export async function listGroups(db: D1Database): Promise<Group[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.name, g.description, g.created_at, COUNT(m.user_id) AS members
       FROM groups g LEFT JOIN group_members m ON m.group_id = g.id
       GROUP BY g.id ORDER BY g.name ASC`,
    )
    .all<Group>();
  return results;
}

export interface App {
  id: string;
  name: string;
  url: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  allowed_groups: string[] | null;
  client_id: string | null;
  cf_app_id: string | null;
  sort_order: number;
  created_at: number;
}

function rowToApp(r: Row): App {
  return {
    id: str(r.id),
    name: str(r.name),
    url: str(r.url),
    description: strOrNull(r.description),
    icon: strOrNull(r.icon),
    color: strOrNull(r.color),
    allowed_groups: typeof r.allowed_groups === "string" ? strArray(r.allowed_groups) : null,
    client_id: strOrNull(r.client_id),
    cf_app_id: strOrNull(r.cf_app_id),
    sort_order: num(r.sort_order),
    created_at: num(r.created_at),
  };
}

export async function listApps(db: D1Database): Promise<App[]> {
  const { results } = await db
    .prepare("SELECT * FROM apps ORDER BY sort_order ASC, name COLLATE NOCASE ASC")
    .all<Row>();
  return results.map(rowToApp);
}

export async function getApp(db: D1Database, id: string): Promise<App | null> {
  const r = await db.prepare("SELECT * FROM apps WHERE id = ?1").bind(id).first<Row>();
  return r ? rowToApp(r) : null;
}

/**
 * Apps a user may see in their launcher. Client-linked apps follow the
 * client's allowed_groups (that's what /authorize enforces); the rest follow
 * the app's own list. NULL/empty = everyone.
 */
export async function appsForUser(db: D1Database, userGroups: string[]): Promise<App[]> {
  const [apps, clients] = await Promise.all([listApps(db), listClients(db)]);
  const byId = new Map(clients.map((c) => [c.id, c]));
  return apps.filter((a) => {
    const groups = a.client_id ? (byId.get(a.client_id)?.allowed_groups ?? null) : a.allowed_groups;
    return !groups?.length || groups.some((g) => userGroups.includes(g));
  });
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
  // Retention is enforced by the hourly cron (maintenance.ts), not here: a
  // NOT IN (… LIMIT 20000) on every write reads the whole table each time.
}

/** Instance settings: get a setting, falling back to the default. */
export async function getSetting(db: D1Database, key: string, fallback: string): Promise<string> {
  const row = await db
    .prepare("SELECT value FROM instance_settings WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? fallback;
}

/** Instance settings: set a setting. */
export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO instance_settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
    )
    .bind(key, value, nowSec())
    .run();
}
