/**
 * The way back to the upstream project.
 *
 * Deploy-to-Cloudflare installs are independent clones, not GitHub forks, so
 * nothing links them to this repo. Admins get links to file issues upstream,
 * and the hourly cron checks once a day whether upstream master carries a
 * newer package.json version. That's one GET to raw.githubusercontent.com per
 * day, exposing the configured repo name and request metadata to GitHub.
 * UPSTREAM_REPO="off" disables both;
 * a fork that becomes its own project sets its own "owner/repo".
 */
import type { Env } from "./config";
import { getSetting, setSetting } from "./db";
import { VERSION } from "./assets.gen";
import { readBodyLimited } from "./http-body";
import { nowSec } from "./util";

const DEFAULT_UPSTREAM = "tannerwj/edge-idp";
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const CHECK_EVERY = 86400;

/** owner/repo, or null when the instance opted out. */
export function upstreamRepo(env: Env): string | null {
  const v = env.UPSTREAM_REPO?.trim();
  if (v === "off") return null;
  return v && REPO_RE.test(v) ? v : DEFAULT_UPSTREAM;
}

export function upstreamLinks(repo: string) {
  const base = `https://github.com/${repo}`;
  return {
    source: base,
    bug: `${base}/issues/new?${new URLSearchParams({ template: "bug.yml", version: VERSION }).toString()}`,
    feature: `${base}/issues/new?${new URLSearchParams({ template: "feature.yml" }).toString()}`,
    updating: `${base}/blob/master/DEPLOY.md#staying-up-to-date`,
    changes: `${base}/commits/master`,
  };
}

const parse = (v: string): number[] | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/** True when `candidate` is a strictly newer MAJOR.MINOR.PATCH than `current`. Suffixes are ignored. */
export function newerVersion(candidate: string, current: string): boolean {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

function versionOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("version" in body)) return null;
  return typeof body.version === "string" && parse(body.version) ? body.version : null;
}

/** Cron: at most once a day, record upstream master's version. */
export async function checkForUpdate(env: Env): Promise<"skipped" | "checked" | "failed"> {
  const repo = upstreamRepo(env);
  if (!repo) return "skipped";
  const last = Number(await getSetting(env.DB, "upstream_checked_at", "0"));
  if (nowSec() - last < CHECK_EVERY) return "skipped";
  // Stamp first so an outage costs one attempt a day, not one an hour.
  await setSetting(env.DB, "upstream_checked_at", String(nowSec()));
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/master/package.json`, {
      headers: { "user-agent": "edge-idp-update-check" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    const v = r.ok
      ? versionOf(JSON.parse(new TextDecoder().decode(await readBodyLimited(r, 16 * 1024))))
      : null;
    if (!v) return "failed";
    await setSetting(env.DB, "upstream_version", v);
    return "checked";
  } catch {
    return "failed";
  }
}

/** The newer upstream version, if the last check found one. */
export async function availableUpdate(env: Env): Promise<string | null> {
  if (!upstreamRepo(env)) return null;
  const v = await getSetting(env.DB, "upstream_version", "");
  return newerVersion(v, VERSION) ? v : null;
}
