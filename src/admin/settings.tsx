import { Hono } from "hono";
import { audit, getSetting, setSetting } from "../db";
import { jwksDocument } from "../crypto";
import { cfConfigured } from "../cf-access";
import { ACCENTS, invalidateSettingsCache } from "../settings-cache";
import { rpIdFromIssuer } from "../util";
import type { AdminVars } from "./shell";
import { act, field, page } from "./shell";
import { PageHead } from "../ui/components";
import { Icon } from "../ui/icons";
import { VERSION } from "../assets.gen";
import { availableUpdate, upstreamLinks, upstreamRepo } from "../upstream";

export const settingsAdmin = new Hono<AdminVars>();

/** On/off status badge. */
const ok = (on: boolean, yes: string, no: string) =>
  on ? <span class="badge ok dot">{yes}</span> : <span class="badge">{no}</span>;

/** Version, update status and the way to send feedback upstream. */
function About(props: {
  version: string;
  repo: string | null;
  update: string | null;
  checkedAt: number | null;
}) {
  const links = props.repo ? upstreamLinks(props.repo) : null;
  return (
    <section class="card" id="about">
      <div class="card-head">
        <Icon name="info" />
        <div class="grow">
          <h2>About & feedback</h2>
          <div class="sub">
            {links ? (
              <>
                Built from <a href={links.source}>{props.repo}</a>. Found a bug or want something?
                Tell upstream; no fork needed.
              </>
            ) : (
              "Update checks and feedback links are off (UPSTREAM_REPO=off)."
            )}
          </div>
        </div>
      </div>
      <div class="card-body stack">
        <dl class="kv">
          <dt>Version</dt>
          <dd class="row-sm wrap">
            <span class="badge mono">v{props.version}</span>
            {props.update && links ? (
              <a class="badge accent dot" href={links.updating}>
                v{props.update} available
              </a>
            ) : links ? (
              <span class="badge ok dot">{props.checkedAt ? "Up to date" : "Not checked yet"}</span>
            ) : null}
          </dd>
        </dl>
        {links ? (
          <div class="row-sm wrap">
            <a class="btn" href={links.bug} target="_blank" rel="noopener">
              <Icon name="alert" />
              <span>Report a bug</span>
            </a>
            <a class="btn" href={links.feature} target="_blank" rel="noopener">
              <Icon name="sparkles" />
              <span>Suggest a feature</span>
            </a>
            <a
              class="btn ghost"
              href={props.update ? links.updating : links.changes}
              target="_blank"
              rel="noopener"
            >
              <Icon name="arrowUpRight" />
              <span>{props.update ? "How to update" : "What's new"}</span>
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}

settingsAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const [accent, dcr, cimd, jwks, update, checkedAt] = await Promise.all([
    getSetting(db, "accent", "indigo"),
    getSetting(db, "dcr_enabled", "1"),
    getSetting(db, "cimd_enabled", "1"),
    jwksDocument(c.env),
    availableUpdate(c.env),
    getSetting(db, "upstream_checked_at", ""),
  ]);
  const repo = upstreamRepo(c.env);
  return await page(
    c,
    { active: "settings", title: "Settings", narrow: true },
    <>
      <PageHead
        title="Settings"
        lede="Instance-wide settings. Identity values come from cloudflare.config.ts and secrets."
      />
      <div class="stack-lg">
        <form class="card" method="post" action="/admin/settings">
          <div class="card-head">
            <Icon name="sparkles" />
            <div class="grow">
              <h2>Appearance</h2>
              <div class="sub">
                Accent color for everyone. Light/dark follows each person's device (or the toggle in
                the sidebar).
              </div>
            </div>
          </div>
          <div class="card-body">
            <div class="swatches">
              {ACCENTS.map((a) => (
                <label key={a} class="swatch" data-accent={a} title={a}>
                  <input type="radio" name="accent" value={a} checked={accent === a} />
                  <span></span>
                </label>
              ))}
            </div>
          </div>
          <div class="card-head card-head-mid">
            <Icon name="bot" />
            <div class="grow">
              <h2>OAuth client onboarding</h2>
              <div class="sub">
                How AI tools and other third-party clients may introduce themselves. Users still
                approve each one.
              </div>
            </div>
          </div>
          <div class="card-body stack">
            <label class="switch">
              <input type="checkbox" name="cimd" value="1" checked={cimd === "1"} />
              <span class="track"></span>
              <span>
                Client ID metadata documents
                <span class="sub">
                  Clients identified by an https URL they control (claude.ai, Claude Code, VS Code).
                  Recommended.
                </span>
              </span>
            </label>
            <label class="switch">
              <input type="checkbox" name="dcr" value="1" checked={dcr === "1"} />
              <span class="track"></span>
              <span>
                Dynamic client registration
                <span class="sub">
                  Anyone can register a client (Cursor needs this). Unused ones are cleaned up after
                  30 days.
                </span>
              </span>
            </label>
          </div>
          <div class="card-foot">
            <button class="btn primary right" type="submit">
              Save settings
            </button>
          </div>
        </form>

        <About
          version={VERSION}
          repo={repo}
          update={update}
          checkedAt={Number(checkedAt) || null}
        />

        <section class="card">
          <div class="card-head">
            <Icon name="fingerprint" />
            <h2>Identity</h2>
          </div>
          <div class="card-body">
            <dl class="kv">
              <dt>Issuer</dt>
              <dd class="mono small">{c.env.ISSUER}</dd>
              <dt>Passkey domain (RP ID)</dt>
              <dd class="mono small">{rpIdFromIssuer(c.env.ISSUER)}</dd>
              <dt>Signing keys</dt>
              <dd class="row-sm wrap">
                {jwks.keys.map((k, i) => (
                  <span key={k.kid ?? String(i)} class={i === 0 ? "badge ok mono" : "badge mono"}>
                    {k.kid} {i === 0 ? "· active" : "· verify only"}
                  </span>
                ))}
              </dd>
              <dt>Rate limiting</dt>
              <dd>
                {ok(
                  !!c.env.AUTH_LIMITER,
                  "Workers rate limiter bound",
                  "Not bound — use WAF rules",
                )}
              </dd>
              <dt>Cloudflare API</dt>
              <dd>{ok(cfConfigured(c.env), "Connected (read-only)", "Not configured")}</dd>
              <dt>Error tracking</dt>
              <dd>{ok(!!c.env.SENTRY_DSN, "Sentry", "Off")}</dd>
            </dl>
          </div>
        </section>
      </div>
    </>,
  );
});

settingsAdmin.post("/", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/settings", "Settings saved", async () => {
    const accent = field(form, "accent");
    if ((ACCENTS as readonly string[]).includes(accent))
      await setSetting(c.env.DB, "accent", accent);
    await setSetting(c.env.DB, "cimd_enabled", field(form, "cimd") === "1" ? "1" : "0");
    await setSetting(c.env.DB, "dcr_enabled", field(form, "dcr") === "1" ? "1" : "0");
    invalidateSettingsCache();
    await audit(c.env.DB, "SETTINGS_CHANGED", { userId: c.get("admin").id, detail: { accent } });
  });
});
