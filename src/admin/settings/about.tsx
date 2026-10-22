import { Hono } from "hono";
import { getSetting } from "../../db";
import { cfConfigured } from "../../cf-access";
import { VERSION } from "../../assets.gen";
import { availableUpdate, upstreamLinks, upstreamRepo } from "../../upstream";
import type { Env } from "../../config";
import type { AdminVars } from "../shell";
import { Icon } from "../../ui/icons";
import { SettingsCard, settingsPage } from "./shell";

export const aboutSettings = new Hono<AdminVars>();

const ok = (on: boolean, yes: string, no: string) =>
  on ? <span class="badge ok dot">{yes}</span> : <span class="badge">{no}</span>;

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

function Runtime(props: { env: Env }) {
  return (
    <SettingsCard icon="activity" title="Runtime" sub="What this Worker is running with.">
      <div class="card-body">
        <dl class="kv">
          <dt>Rate limiting</dt>
          <dd>
            {ok(
              !!props.env.AUTH_LIMITER,
              "Workers rate limiter bound",
              "Not bound — use WAF rules",
            )}
          </dd>
          <dt>Code mode (MCP execute)</dt>
          <dd>{ok(!!props.env.LOADER, "Worker Loader bound", "Not bound")}</dd>
          <dt>Email binding</dt>
          <dd>{ok(!!props.env.EMAIL, "Bound", "Not bound")}</dd>
          <dt>Cloudflare API</dt>
          <dd>{ok(cfConfigured(props.env), "Connected", "Not configured")}</dd>
          <dt>Error tracking</dt>
          <dd>{ok(!!props.env.SENTRY_DSN, "Sentry", "Off")}</dd>
        </dl>
      </div>
    </SettingsCard>
  );
}

aboutSettings.get("/about", async (c) => {
  const [update, checkedAt] = await Promise.all([
    availableUpdate(c.env),
    getSetting(c.env.DB, "upstream_checked_at", ""),
  ]);
  return settingsPage(
    c,
    "about",
    <>
      <About
        version={VERSION}
        repo={upstreamRepo(c.env)}
        update={update}
        checkedAt={Number(checkedAt) || null}
      />
      <Runtime env={c.env} />
    </>,
  );
});
