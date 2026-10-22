import type { Env } from "./config";
import { audit } from "./db";
import { by, OpError } from "./ops-core";
import type { Actor } from "./ops-core";
import { invalidateSettingsCache, SETTING_KEYS } from "./settings-cache";
import { base64url, rpIdFromIssuer } from "./util";
import { b64urlToBytes } from "./webauthn-challenges";

export const BACKUP_FORMAT = "edge-idp-backup";
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

type Cell = string | number | null | { $b64: string };
type Row = Record<string, Cell>;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exported_at: number;
  issuer: string;
  rp_id: string;
  tables: Record<string, Row[]>;
}

interface TableSpec {
  name: string;
  key: string[];
  mode: "upsert" | "keep";
}

const TABLES: TableSpec[] = [
  { name: "users", key: ["id"], mode: "keep" },
  { name: "groups", key: ["id"], mode: "upsert" },
  { name: "app_groups", key: ["id"], mode: "upsert" },
  { name: "oidc_clients", key: ["id"], mode: "upsert" },
  { name: "apps", key: ["id"], mode: "upsert" },
  { name: "app_grants", key: ["id"], mode: "upsert" },
  { name: "group_members", key: ["group_id", "user_id"], mode: "keep" },
  { name: "app_favorites", key: ["user_id", "app_id"], mode: "keep" },
  { name: "webauthn_credentials", key: ["id"], mode: "keep" },
  { name: "webhooks", key: ["id"], mode: "upsert" },
  { name: "instance_settings", key: ["key"], mode: "upsert" },
];

const SETTINGS = new Set<string>(
  Object.values(SETTING_KEYS).filter((k) => k !== SETTING_KEYS.cfApiToken),
);

const settingRow = (table: string, row: Record<string, unknown>): boolean =>
  table !== "instance_settings" || (typeof row.key === "string" && SETTINGS.has(row.key));

function exportCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (v instanceof ArrayBuffer) return { $b64: base64url(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v))
    return { $b64: base64url(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (Array.isArray(v)) return { $b64: base64url(Uint8Array.from(v.map(Number))) };
  return null;
}

export async function exportBackup(env: Env, a: Actor): Promise<Backup> {
  const tables: Record<string, Row[]> = {};
  for (const t of TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t.name}`).all();
    tables[t.name] = results
      .filter((r) => settingRow(t.name, r))
      .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, exportCell(v)])));
  }
  await audit(env.DB, "BACKUP_EXPORTED", { userId: a.adminId, detail: by(a) });
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exported_at: Math.floor(Date.now() / 1000),
    issuer: env.ISSUER,
    rp_id: rpIdFromIssuer(env.ISSUER),
    tables,
  };
}

function isCell(v: unknown): v is Cell {
  if (v === null || typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))
    return true;
  return (
    typeof v === "object" &&
    v !== null &&
    Object.keys(v).length === 1 &&
    "$b64" in v &&
    typeof v.$b64 === "string" &&
    /^[A-Za-z0-9_-]*$/.test(v.$b64)
  );
}

function isRow(v: unknown): v is Row {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.entries(v).every(([k, c]) => /^[a-z_]{1,40}$/.test(k) && isCell(c))
  );
}

export function parseBackup(text: string): Backup {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new OpError("That file isn't JSON.");
  }
  if (typeof v !== "object" || v === null || !("format" in v) || v.format !== BACKUP_FORMAT)
    throw new OpError("That file isn't an edge-idp backup.");
  if (!("version" in v) || v.version !== 1)
    throw new OpError("This backup comes from a newer version; update first.");
  const doc: Record<string, unknown> = { ...v };
  const tables = doc.tables;
  if (typeof tables !== "object" || tables === null) throw new OpError("The backup has no tables.");
  const byName: Record<string, unknown> = { ...tables };
  const out: Record<string, Row[]> = {};
  for (const t of TABLES) {
    const rows = byName[t.name] ?? [];
    if (!Array.isArray(rows) || !rows.every(isRow))
      throw new OpError(`The backup's ${t.name} table is malformed.`);
    out[t.name] = rows;
  }
  const str = (k: string) => {
    const x = doc[k];
    return typeof x === "string" ? x.slice(0, 300) : "";
  };
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exported_at: typeof doc.exported_at === "number" ? doc.exported_at : 0,
    issuer: str("issuer"),
    rp_id: str("rp_id"),
    tables: out,
  };
}

function importCell(c: Cell): string | number | null | Uint8Array {
  return c !== null && typeof c === "object" ? b64urlToBytes(c.$b64) : c;
}

async function columnsOf(db: D1Database, table: string): Promise<Set<string>> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

function rowStatement(db: D1Database, t: TableSpec, cols: Set<string>, row: Row) {
  const names = Object.keys(row).filter((k) => cols.has(k));
  if (!t.key.every((k) => names.includes(k))) return null;
  const update = names.filter((n) => !t.key.includes(n));
  const conflict =
    t.mode === "upsert" && update.length
      ? `ON CONFLICT(${t.key.join(", ")}) DO UPDATE SET ${update.map((n) => `${n} = excluded.${n}`).join(", ")}`
      : "ON CONFLICT DO NOTHING";
  return db
    .prepare(
      `INSERT INTO ${t.name} (${names.join(", ")}) VALUES (${names.map((_, i) => `?${i + 1}`).join(", ")}) ${conflict}`,
    )
    .bind(...names.map((n) => importCell(row[n] ?? null)));
}

async function applyChunk(db: D1Database, stmts: D1PreparedStatement[]) {
  try {
    const results = await db.batch(stmts);
    return { applied: results.reduce((n, r) => n + (r.meta.changes ?? 0), 0), skipped: 0 };
  } catch {
    let applied = 0;
    let skipped = 0;
    for (const s of stmts) {
      try {
        applied += (await s.run()).meta.changes ?? 0;
      } catch {
        skipped++;
      }
    }
    return { applied, skipped };
  }
}

export async function importBackup(
  env: Env,
  backup: Backup,
  a: Actor,
): Promise<{ applied: number; skipped: number; passkeys: boolean }> {
  const passkeys = backup.rp_id === rpIdFromIssuer(env.ISSUER);
  let applied = 0;
  let skipped = 0;
  for (const t of TABLES) {
    if (t.name === "webauthn_credentials" && !passkeys) continue;
    const cols = await columnsOf(env.DB, t.name);
    const rows = (backup.tables[t.name] ?? []).filter((r) => settingRow(t.name, r));
    const stmts = rows.flatMap((r) => rowStatement(env.DB, t, cols, r) ?? []);
    for (let i = 0; i < stmts.length; i += 50) {
      const r = await applyChunk(env.DB, stmts.slice(i, i + 50));
      applied += r.applied;
      skipped += r.skipped;
    }
  }
  invalidateSettingsCache();
  await audit(env.DB, "BACKUP_IMPORTED", {
    userId: a.adminId,
    detail: by(a, { from: backup.issuer, applied, skipped, passkeys }),
  });
  return { applied, skipped, passkeys };
}
