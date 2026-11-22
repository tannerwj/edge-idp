import { newId } from "./util";
import { Hono } from "hono";
import type { Env } from "./config";
import { appsForUser, listAppGroups, loadUserContext } from "./access";
import type { AppGroup } from "./access";
import { setFavorite } from "./ops";
import type { App } from "./db";
import { getSession } from "./session";
import { AppShell, uiFor } from "./ui/layout";
import { Callout, Empty, hueOf, PageHead, Time } from "./ui/components";
import { Feed } from "./ui/feed";
import type { FeedRow } from "./ui/feed";
import { Icon } from "./ui/icons";
import { viewerOf } from "./account";

export const home = new Hono<{ Bindings: Env }>();

home.get("/open/:id", async (c) => {
  const s = await getSession(c);
  if (!s) return c.redirect("/login?next=" + encodeURIComponent(new URL(c.req.url).pathname));
  const app = (await appsForUser(c.env.DB, s.user.id)).find((a) => a.id === c.req.param("id"));
  if (!app || !/^https?:\/\//i.test(app.url)) return c.notFound();
  return c.redirect(app.url);
});

home.post("/apps/:id/request", async (c) => {
  const s = await getSession(c);
  if (!s || s.user.public) return c.notFound();
  const ctx = await loadUserContext(c.env.DB, s.user.id),
    app = ctx?.apps.find((a) => a.id === c.req.param("id") && a.requestable);
  if (!ctx || !app || ctx.access.has(app.id)) return c.notFound();
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO access_requests(id,app_id,user_id,requested_at) SELECT ?,id,?,unixepoch() FROM apps WHERE id=? AND requestable=1",
  )
    .bind(newId(), s.user.id, app.id)
    .run();
  return c.redirect("/", 303);
});
async function favoritesOf(db: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT app_id FROM app_favorites WHERE user_id = ?1")
    .bind(userId)
    .all<{ app_id: string }>();
  return new Set(results.map((r) => r.app_id));
}

function host(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

function isEmoji(s: string): boolean {
  return /\p{Extended_Pictographic}/u.test(s);
}

export function AppTile(props: { app: App; favorite: boolean }) {
  const a = props.app;
  const glyph = a.icon || a.name.slice(0, 1).toUpperCase();
  return (
    <div
      class="tile-wrap"
      data-filter-text={`${a.name} ${a.description ?? ""} ${host(a.url)}`.toLowerCase()}
    >
      <a
        class="tile"
        href={a.url}
        data-hue={a.color ? String(Math.round(parseInt(a.color, 10) / 30) % 12) : hueOf(a.name)}
        target="_blank"
        rel="noopener"
      >
        <span class={a.icon && isEmoji(a.icon) ? "glyph emoji" : "glyph"}>{glyph}</span>
        <span class="go">
          <Icon name="arrowUpRight" size="sm" />
        </span>
        <div>
          <div class="name">{a.name}</div>
          {a.description ? <div class="desc">{a.description}</div> : null}
        </div>
        <div class="host">
          <Icon name="globe" size="sm" />
          {host(a.url)}
        </div>
      </a>
      <form method="post" action={`/apps/${a.id}/favorite`} class="fav-form">
        <input type="hidden" name="on" value={props.favorite ? "0" : "1"} />
        <button
          class={props.favorite ? "fav on" : "fav"}
          type="submit"
          title={props.favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label={props.favorite ? `Unfavorite ${a.name}` : `Favorite ${a.name}`}
        >
          <Icon name="star" size="sm" />
        </button>
      </form>
    </div>
  );
}

function GroupsLede({ groups }: { groups: string[] }) {
  return (
    <>
      You're in{" "}
      {groups.map((g, i) => (
        <>
          {i ? ", " : ""}
          <b>{g}</b>
        </>
      ))}
      .
    </>
  );
}

function BackupPasskeyCallout({ count }: { count: number }) {
  return (
    <Callout tone="accent" icon="shieldCheck">
      <div class="row wrap between">
        <div>
          <b>{count ? "Add a backup passkey." : "Set up a passkey."}</b>{" "}
          <span class="text-2">
            You have {count === 0 ? "no passkeys" : "one passkey"}. Keep a spare somewhere you can
            reach if you lose this device.
          </span>
        </div>
        <a class="btn sm" href="/account#passkeys">
          Add passkey
        </a>
      </div>
    </Callout>
  );
}

interface Launcher {
  apps: App[];
  appGroups: AppGroup[];
  favorites: Set<string>;
}

function TileGrid(props: { apps: App[]; favorites: Set<string>; add?: boolean }) {
  return (
    <div class="launcher">
      {props.apps.map((a) => (
        <AppTile key={a.id} app={a} favorite={props.favorites.has(a.id)} />
      ))}
      {props.add ? (
        <a class="tile add" href="/admin/apps?new=1">
          <Icon name="plus" size="lg" />
          <span>Add an app</span>
        </a>
      ) : null}
    </div>
  );
}

function LauncherSection(props: {
  title: string;
  sub?: string | null;
  apps: App[];
  favorites: Set<string>;
  add?: boolean;
}) {
  return (
    <section class="launcher-section" data-filter-section>
      <div class="section-title">
        <h3>{props.title}</h3>
        {props.sub ? <span class="sub">{props.sub}</span> : null}
      </div>
      <TileGrid apps={props.apps} favorites={props.favorites} add={props.add} />
    </section>
  );
}

function sections(l: Launcher) {
  const known = new Set(l.appGroups.map((g) => g.id));
  const grouped = l.appGroups
    .map((g) => ({ g, apps: l.apps.filter((a) => a.app_group_id === g.id) }))
    .filter((x) => x.apps.length);
  const rest = l.apps.filter((a) => !a.app_group_id || !known.has(a.app_group_id));
  const favs = l.apps.filter((a) => l.favorites.has(a.id));
  return { grouped, rest, favs };
}

function AppsSection({ l, isAdmin }: { l: Launcher; isAdmin: boolean }) {
  const { grouped, rest, favs } = sections(l);
  return (
    <section>
      <div class="section-title launcher-head">
        <h2>Your apps</h2>
        <span class="sub">{l.apps.length ? `${l.apps.length} available` : ""}</span>
        {l.apps.length > 6 ? (
          <input
            class="launcher-search"
            type="search"
            placeholder="Find an app"
            aria-label="Find an app"
            data-filter-table="launcher"
          />
        ) : null}
      </div>
      {l.apps.length ? (
        <div id="launcher" class="stack">
          {favs.length ? (
            <LauncherSection title="Favorites" apps={favs} favorites={l.favorites} />
          ) : null}
          {grouped.map(({ g, apps }) => (
            <LauncherSection
              key={g.id}
              title={g.name}
              sub={g.description}
              apps={apps}
              favorites={l.favorites}
            />
          ))}
          {rest.length || (isAdmin && !grouped.length) ? (
            <LauncherSection
              title={grouped.length ? "More apps" : "All apps"}
              apps={rest}
              favorites={l.favorites}
              add={isAdmin && !grouped.length}
            />
          ) : null}
        </div>
      ) : (
        <div class="card">
          <Empty
            icon="grid"
            title="No apps yet"
            action={
              isAdmin ? (
                <a class="btn primary" href="/admin/apps?new=1">
                  <Icon name="plus" size="sm" />
                  Add your first app
                </a>
              ) : null
            }
          >
            {isAdmin
              ? "Apps you add appear here for everyone allowed to use them — a home screen for your stuff."
              : "When your admin shares apps with you, they'll show up here."}
          </Empty>
        </div>
      )}
    </section>
  );
}

function RecentActivityCard({ rows }: { rows: FeedRow[] }) {
  return (
    <div class="card">
      <div class="card-head">
        <h2>Recent activity</h2>
        <a class="right small" href="/account#activity">
          View all
        </a>
      </div>
      {rows.length ? (
        <Feed rows={rows} showWho={false} />
      ) : (
        <Empty icon="activity" title="Nothing yet" />
      )}
    </div>
  );
}

interface PasskeySummary {
  count: number;
  synced: number;
}

function SecurityCard({ passkeys, authTime }: { passkeys: PasskeySummary; authTime: number }) {
  return (
    <div class="card">
      <div class="card-head">
        <h2>Security</h2>
        <a class="right small" href="/account">
          Manage
        </a>
      </div>
      <ul class="list">
        <li>
          <Icon name="fingerprint" />
          <div class="grow">
            <div class="title">Passkeys</div>
            <div class="meta">
              {passkeys.count} registered
              {passkeys.synced ? " · synced across devices" : ""}
            </div>
          </div>
          {passkeys.count >= 2 ? (
            <a class="badge" href="/account#passkeys">
              Test a spare
            </a>
          ) : (
            <span class="badge warn dot">Add a backup</span>
          )}
        </li>
        <li>
          <Icon name="clock" />
          <div class="grow">
            <div class="title">This session</div>
            <div class="meta">
              Signed in <Time ts={authTime} />
            </div>
          </div>
        </li>
      </ul>
    </div>
  );
}

home.get("/", async (c) => {
  const s = await getSession(c);
  if (!s) return c.redirect("/login", 302);
  const db = c.env.DB;
  const [ctx, appGroups, favorites, passkeys, recent] = await Promise.all([
    loadUserContext(db, s.user.id),
    listAppGroups(db),
    favoritesOf(db, s.user.id),
    db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(MAX(backup_state), 0) AS synced FROM webauthn_credentials WHERE user_id = ?1",
      )
      .bind(s.user.id)
      .first<PasskeySummary>(),
    db
      .prepare(
        `SELECT a.event, a.created_at, c.name AS client_name FROM audit_log a
         LEFT JOIN oidc_clients c ON c.id = a.client_id
         WHERE a.user_id = ?1 AND a.event IN ('SIGN_IN','PASSKEY_REGISTERED','PASSKEY_REMOVED','CONSENT_GRANTED','CODE_ISSUED','ACCESS_DENIED')
         ORDER BY a.id DESC LIMIT 6`,
      )
      .bind(s.user.id)
      .all<{ event: string; created_at: number; client_name: string | null }>(),
  ]);
  const summary = passkeys ?? { count: 0, synced: 0 };
  const groups = ctx?.groups ?? [];
  const apps = ctx ? ctx.apps.filter((a) => ctx.access.has(a.id)) : [];
  const requestable = s.user.public
    ? []
    : (ctx?.apps.filter((a) => a.requestable && !ctx.access.has(a.id)) ?? []);
  const pending = requestable.length
    ? (
        await c.env.DB.prepare(
          "SELECT app_id FROM access_requests WHERE user_id=? AND decision IS NULL",
        )
          .bind(s.user.id)
          .all<{ app_id: string }>()
      ).results.map((r) => r.app_id)
    : [];
  const first = s.user.name.split(" ")[0];
  return c.html(
    <AppShell
      ui={await uiFor(c)}
      viewer={viewerOf(s)}
      active="home"
      title="Home"
      flash={c.req.query("ok")}
    >
      <PageHead
        title={`Welcome back, ${first}`}
        lede={groups.length ? <GroupsLede groups={groups} /> : "Here's everything you can open."}
      />
      <div class="stack-lg">
        {summary.count < 2 ? <BackupPasskeyCallout count={summary.count} /> : null}
        <AppsSection l={{ apps, appGroups, favorites }} isAdmin={!!s.user.is_admin} />
        {requestable.length > 0 && (
          <section class="card card-body">
            <h2>Request access</h2>
            {requestable.map((a) => (
              <form key={a.id} method="post" action={`/apps/${a.id}/request`}>
                <span>{a.name} </span>
                <button disabled={pending.includes(a.id)}>
                  {pending.includes(a.id) ? "Requested" : "Request access"}
                </button>
              </form>
            ))}
          </section>
        )}
        <section class="grid-2">
          <RecentActivityCard rows={recent.results} />
          <SecurityCard passkeys={summary} authTime={s.authTime} />
        </section>
      </div>
    </AppShell>,
  );
});

home.post("/apps/:id/favorite", async (c) => {
  const s = await getSession(c);
  if (!s) return c.redirect("/login", 302);
  const db = c.env.DB;
  const id = c.req.param("id");
  const visible = await appsForUser(db, s.user.id);
  if (!visible.some((a) => a.id === id)) return c.notFound();
  const form = await c.req.parseBody();
  await setFavorite(db, s.user.id, id, form.on === "1");
  return c.redirect("/", 303);
});
