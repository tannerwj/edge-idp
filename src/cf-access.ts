/**
 * Optional, read-only Cloudflare Access integration.
 *
 * With CF_ACCOUNT_ID (var) and CF_API_TOKEN (secret; "Access: Apps and
 * Policies Read" + "Access: Organizations, Identity Providers, and Groups
 * Read") set, the admin UI can list Access applications, show which of them
 * sign in through this IdP and which groups their policies require, and
 * import them into the launcher. Nothing here writes to Cloudflare: Access
 * stays the enforcement point and source of truth for its own policies.
 */
import type { Env } from "./config";

const API = "https://api.cloudflare.com/client/v4";

export function cfConfigured(env: Env): boolean {
  return !!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const records = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter(isRecord) : [];

/** GET a Cloudflare API path; returns the envelope's result (unvalidated). */
async function cfGet(env: Env, path: string): Promise<{ result: unknown; totalPages: number }> {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}${path}`, {
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "user-agent": "edge-idp" },
    signal: AbortSignal.timeout(10_000),
  });
  const body: unknown = await res.json();
  const envelope = isRecord(body) ? body : {};
  if (!res.ok || envelope.success !== true) {
    const msg = records(envelope.errors)
      .map((e) => optStr(e.message) ?? "")
      .filter(Boolean)
      .join("; ");
    throw new Error(msg || `Cloudflare API ${res.status}`);
  }
  const info = isRecord(envelope.result_info) ? envelope.result_info : {};
  return {
    result: envelope.result,
    totalPages: typeof info.total_pages === "number" ? info.total_pages : 1,
  };
}

type Rule = Record<string, Record<string, unknown> | undefined>;

interface CfPolicy {
  id: string;
  name: string;
  decision: string;
  include?: Rule[];
  require?: Rule[];
}

interface CfApp {
  id: string;
  name: string;
  domain?: string;
  type: string;
  logo_url?: string;
  allowed_idps?: string[];
  policies?: CfPolicy[];
}

function toRules(v: unknown): Rule[] {
  return records(v).map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, x]) => [k, isRecord(x) ? x : undefined])),
  );
}

function toApp(r: Record<string, unknown>): CfApp | null {
  const id = optStr(r.id);
  const name = optStr(r.name);
  const type = optStr(r.type);
  if (!id || !name || !type) return null;
  return {
    id,
    name,
    type,
    domain: optStr(r.domain),
    logo_url: optStr(r.logo_url),
    allowed_idps: Array.isArray(r.allowed_idps)
      ? r.allowed_idps.filter((x): x is string => typeof x === "string")
      : undefined,
    policies: records(r.policies).map((p) => ({
      id: optStr(p.id) ?? "",
      name: optStr(p.name) ?? "",
      decision: optStr(p.decision) ?? "",
      include: toRules(p.include),
      require: toRules(p.require),
    })),
  };
}

export interface AccessAppView {
  id: string;
  name: string;
  domain: string | null;
  type: string;
  logoUrl: string | null;
  /** Can users sign in to it with this IdP? */
  usesUs: boolean;
  /** Group names required by `oidc groups` rules targeting this IdP. */
  groups: string[];
  /** Human summary of each allow policy. */
  policies: string[];
}

/** A rule field as display text (rule values are strings in practice). */
function text(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function describeRule(r: Rule, ourIdp: string | null): string {
  const [kind, v] = Object.entries(r)[0] ?? ["?", undefined];
  if (kind === "everyone") return "everyone";
  if (kind === "email") return text(v?.email, "an email");
  if (kind === "email_domain") return `@${text(v?.domain, "")}`;
  if (kind === "oidc") {
    const mine = v?.identity_provider_id === ourIdp ? "" : " (other IdP)";
    return `${text(v?.claim_name, "?")}=${text(v?.claim_value, "?")}${mine}`;
  }
  if (kind === "group") return "Access group";
  if (kind === "login_method") return v?.id === ourIdp ? "signed in with us" : "login method";
  return kind.replace(/_/g, " ");
}

/** Our Access IdP: the OIDC provider whose auth URL is our /authorize. */
async function findOurIdp(env: Env): Promise<{ id: string; name: string } | null> {
  const { result } = await cfGet(env, "/access/identity_providers");
  const mine = records(result).find((i) => {
    const config = isRecord(i.config) ? i.config : {};
    return i.type === "oidc" && config.auth_url === `${env.ISSUER}/authorize`;
  });
  const id = optStr(mine?.id);
  return mine && id ? { id, name: optStr(mine.name) ?? "This IdP" } : null;
}

export async function listAccessApps(
  env: Env,
): Promise<{ idp: { id: string; name: string } | null; apps: AccessAppView[] }> {
  const idp = await findOurIdp(env);
  const apps: CfApp[] = [];
  for (let page = 1; page <= 10; page++) {
    const { result, totalPages } = await cfGet(env, `/access/apps?per_page=100&page=${page}`);
    apps.push(...records(result).flatMap((r) => toApp(r) ?? []));
    if (totalPages <= page) break;
  }
  const ourId = idp?.id ?? null;
  return {
    idp: idp ? { id: idp.id, name: idp.name } : null,
    apps: apps
      .filter((a) => a.type === "self_hosted" || a.type === "saas" || a.type === "bookmark")
      .map((a) => {
        const groups = new Set<string>();
        const policies: string[] = [];
        for (const p of a.policies ?? []) {
          for (const r of [...(p.include ?? []), ...(p.require ?? [])]) {
            const o = r.oidc;
            if (
              o &&
              o.identity_provider_id === ourId &&
              o.claim_name === "groups" &&
              typeof o.claim_value === "string"
            ) {
              groups.add(o.claim_value);
            }
          }
          if (p.decision === "allow") {
            policies.push(
              `${p.name}: ${(p.include ?? []).map((r) => describeRule(r, ourId)).join(" or ") || "—"}`,
            );
          }
        }
        return {
          id: a.id,
          name: a.name,
          domain: a.domain ?? null,
          type: a.type,
          logoUrl: a.logo_url ?? null,
          usesUs: !!ourId && (!a.allowed_idps?.length || a.allowed_idps.includes(ourId)),
          groups: [...groups],
          policies,
        };
      }),
  };
}
