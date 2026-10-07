/**
 * Signed-in user surface: Account & security (profile, passkeys, devices,
 * connected apps, recent activity). The home launcher lives in home.tsx.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./config";
import { audit, getCredentialsForUser } from "./db";
import { getSession, SESSION_COOKIE } from "./session";
import type { Session } from "./session";
import * as ops from "./ops";
import { nowSec, sha256Hex } from "./util";
import { AppShell, setFlash, uiFor } from "./ui/layout";
import { Avatar, Empty, PageHead, PostButton, Time } from "./ui/components";
import { deviceLabel, Feed } from "./ui/feed";
import type { Viewer } from "./ui/layout";
import { Icon } from "./ui/icons";
import { getCookie } from "hono/cookie";
import { aaguidName } from "./aaguid";
import type { WebAuthnCredential } from "./db";

type Credential = WebAuthnCredential;
interface SessionRow {
  id_hash: string;
  created_at: number;
  last_seen_at: number;
  user_agent: string | null;
}
interface GrantRow {
  client_id: string;
  scope: string;
  created_at: number;
  last_used_at: number | null;
  name: string;
  source: string;
}
import { field } from "./admin/shell";

type C = Context<{ Bindings: Env }>;

function PasskeysSection({ creds }: { creds: Credential[] }) {
  return (
    <section class="card" id="passkeys">
      <div class="card-head">
        <Icon name="fingerprint" />
        <div class="grow">
          <h2>Passkeys</h2>
          <div class="sub">How you sign in. Keep at least two, on different devices.</div>
        </div>
        <div id="account-box">
          <button id="add-key-btn" class="btn primary sm" type="button">
            <Icon name="plus" size="sm" />
            Add passkey
          </button>
        </div>
      </div>
      <p id="account-status" class="status card-status" role="status" aria-live="polite"></p>
      <ul class="list">
        {creds.map((k) => (
          <li key={k.id}>
            <span class="ev-icon-lg">
              <Icon name={k.backup_state ? "cloud" : "key"} />
            </span>
            <div class="grow">
              <div class="title row-sm">
                {k.name}
                {k.backup_state ? <span class="badge">Synced</span> : <span class="badge">This device only</span>}
              </div>
              <div class="meta">
                {aaguidName(k.aaguid) ? <>{aaguidName(k.aaguid)} · </> : null}
                Added <Time ts={k.created_at} /> · {k.last_used_at ? <>Last used <Time ts={k.last_used_at} /></> : "Never used"}
              </div>
            </div>
            <button class="btn ghost sm" type="button" data-open={`rename-${k.id}`}>
              Rename
            </button>
            {creds.length > 1 ? (
              <PostButton
                action={`/account/keys/${k.id}/remove`}
                label="Remove"
                class="btn ghost sm danger"
                confirm={`Remove “${k.name}”? You won't be able to sign in with it anymore.`}
              />
            ) : (
              <span class="muted tiny" title="Add another passkey before removing your last one">
                Last passkey
              </span>
            )}
            <dialog id={`rename-${k.id}`}>
              <form method="post" action={`/account/keys/${k.id}/rename`}>
                <div class="dlg-head">
                  <h2 class="grow">Rename passkey</h2>
                </div>
                <div class="dlg-body">
                  <label class="field">
                    <span class="label">Name</span>
                    <input name="name" value={k.name} maxLength={60} required />
                  </label>
                </div>
                <div class="dlg-foot">
                  <button class="btn" type="button" data-close>
                    Cancel
                  </button>
                  <button class="btn primary" type="submit">
                    Save
                  </button>
                </div>
              </form>
            </dialog>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SessionsSection({ sessions, currentHash, others, rpName }: { sessions: SessionRow[]; currentHash: string; others: number; rpName: string }) {
  return (
    <section class="card" id="sessions">
      <div class="card-head">
        <Icon name="monitor" />
        <div class="grow">
          <h2>Where you're signed in</h2>
          <div class="sub">Browser sessions on {rpName}. Apps keep their own sessions on top of these.</div>
        </div>
        {others > 0 ? (
          <PostButton action="/account/sessions/revoke-others" label="Sign out other sessions" class="btn sm" confirm="Sign out of every other browser?" />
        ) : null}
      </div>
      <ul class="list">
        {sessions.map((x) => {
          const d = deviceLabel(x.user_agent);
          const current = x.id_hash === currentHash;
          return (
            <li key={x.id_hash}>
              <span class="ev-icon-lg">
                <Icon name={d.icon} />
              </span>
              <div class="grow">
                <div class="title row-sm">
                  {d.label}
                  {current ? <span class="badge ok dot">This browser</span> : null}
                </div>
                <div class="meta">
                  Signed in <Time ts={x.created_at} /> · Active <Time ts={x.last_seen_at} />
                </div>
              </div>
              {current ? null : <PostButton action={`/account/sessions/${x.id_hash}/revoke`} label="Sign out" class="btn ghost sm" />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ConnectedSection({ grants }: { grants: GrantRow[] }) {
  return (
    <section class="card" id="connected">
      <div class="card-head">
        <Icon name="plug" />
        <div class="grow">
          <h2>Connected apps</h2>
          <div class="sub">Third-party apps and AI tools you've approved. Disconnecting revokes their access immediately.</div>
        </div>
      </div>
      {grants.length ? (
        <ul class="list">
          {grants.map((g) => (
            <li key={g.client_id}>
              <span class="ev-icon-lg">
                <Icon name={g.scope.includes("mcp") ? "bot" : "plug"} />
              </span>
              <div class="grow">
                <div class="title">{g.name}</div>
                <div class="meta">
                  {g.scope.split(" ").join(", ")} · Approved <Time ts={g.created_at} />
                  {g.last_used_at ? <> · Used <Time ts={g.last_used_at} /></> : null}
                </div>
              </div>
              <PostButton
                action="/account/grants/revoke"
                fields={{ client_id: g.client_id }}
                label="Disconnect"
                class="btn ghost sm danger"
                confirm={`Disconnect ${g.name}? It will need your approval again.`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="plug" title="No connected apps">
          When you approve an app or AI assistant (like Claude) to use your account, it shows up here.
        </Empty>
      )}
    </section>
  );
}

export const account = new Hono<{ Bindings: Env }>();

export function viewerOf(s: Session): Viewer {
  return { id: s.user.id, name: s.user.name, email: s.user.email, isAdmin: !!s.user.is_admin };
}

async function requireSession(c: C): Promise<Session | Response> {
  const s = await getSession(c);
  if (!s) return c.redirect(`/login?next=${encodeURIComponent(new URL(c.req.url).pathname)}`, 302);
  return s;
}

/* ───────────────────────────── account & security ───────────────────────────── */

account.get("/account", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const db = c.env.DB;
  const currentHash = await sha256Hex(getCookie(c, SESSION_COOKIE) ?? "");
  const [creds, sessions, grants, activity] = await Promise.all([
    getCredentialsForUser(db, s.user.id),
    db
      .prepare("SELECT id_hash, created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ?1 AND expires_at > ?2 ORDER BY last_seen_at DESC")
      .bind(s.user.id, nowSec())
      .all<{ id_hash: string; created_at: number; last_seen_at: number; user_agent: string | null }>(),
    db
      .prepare(
        `SELECT g.client_id, g.scope, g.created_at, g.last_used_at, c.name, c.source FROM oauth_grants g
         JOIN oidc_clients c ON c.id = g.client_id WHERE g.user_id = ?1 ORDER BY g.last_used_at DESC`,
      )
      .bind(s.user.id)
      .all<{ client_id: string; scope: string; created_at: number; last_used_at: number | null; name: string; source: string }>(),
    db
      .prepare(
        `SELECT a.event, a.created_at, c.name AS client_name FROM audit_log a
         LEFT JOIN oidc_clients c ON c.id = a.client_id
         WHERE a.user_id = ?1 AND a.event NOT IN ('CODE_ISSUED','TOKEN_ISSUED') ORDER BY a.id DESC LIMIT 15`,
      )
      .bind(s.user.id)
      .all<{ event: string; created_at: number; client_name: string | null }>(),
  ]);
  const others = sessions.results.filter((x) => x.id_hash !== currentHash).length;
  return c.html(
    <AppShell ui={await uiFor(c)} viewer={viewerOf(s)} active="account" title="Account & security" page="account" flash={c.req.query("ok")} narrow>
      <PageHead
        leading={<Avatar name={s.user.name} seed={s.user.id} size="lg" />}
        title={s.user.name}
        lede={
          <>
            {s.user.email}
            {s.user.is_admin ? (
              <>
                {" "}
                <span class="badge accent">Admin</span>
              </>
            ) : null}
          </>
        }
      />
      <div class="stack-lg">
        <section class="card" id="profile">
          <div class="card-head">
            <Icon name="user" />
            <h2>Profile</h2>
          </div>
          <form method="post" action="/account/profile">
            <div class="card-body grid-2">
              <label class="field">
                <span class="label">Name</span>
                <input name="name" required maxLength={120} value={s.user.name} autocomplete="name" />
              </label>
              <label class="field">
                <span class="label">Email</span>
                <input name="email" type="email" required maxLength={254} value={s.user.email} autocomplete="email" />
                <span class="hint">Apps see this as your email. Your passkeys keep working if you change it.</span>
              </label>
            </div>
            <div class="card-foot">
              <button class="btn primary right" type="submit">
                Save profile
              </button>
            </div>
          </form>
        </section>

        <PasskeysSection creds={creds} />

        <SessionsSection sessions={sessions.results} currentHash={currentHash} others={others} rpName={c.env.RP_NAME} />

        <ConnectedSection grants={grants.results} />

        <section class="card" id="activity">
          <div class="card-head">
            <Icon name="activity" />
            <h2>Recent activity</h2>
          </div>
          {activity.results.length ? <Feed rows={activity.results} showWho={false} /> : <Empty icon="activity" title="Nothing yet" />}
        </section>
      </div>
    </AppShell>,
  );
});

account.post("/account/profile", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const form = await c.req.parseBody();
  try {
    await ops.updateUser(c.env.DB, s.user.id, { name: field(form, "name"), email: field(form, "email") }, { adminId: s.user.id, via: "ui" });
  } catch (e) {
    if (e instanceof ops.OpError) {
      setFlash(c, e.message, "bad");
      return c.redirect("/account#profile", 303);
    }
    throw e;
  }
  return c.redirect("/account?ok=saved", 303);
});

account.post("/account/keys/:id/remove", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const creds = await getCredentialsForUser(c.env.DB, s.user.id);
  const target = creds.find((k) => k.id === c.req.param("id"));
  // Fail safe: never let a user strand themselves with zero passkeys.
  if (!target || creds.length <= 1) return c.redirect("/account#passkeys", 303);
  await c.env.DB.prepare("DELETE FROM webauthn_credentials WHERE id = ?1 AND user_id = ?2").bind(target.id, s.user.id).run();
  await audit(c.env.DB, "PASSKEY_REMOVED", { userId: s.user.id, detail: { credential: target.id, name: target.name } });
  return c.redirect("/account?ok=key_removed#passkeys", 303);
});

account.post("/account/keys/:id/rename", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const form = await c.req.parseBody();
  const name = field(form, "name").trim().slice(0, 60);
  if (name) {
    await c.env.DB.prepare("UPDATE webauthn_credentials SET name = ?1 WHERE id = ?2 AND user_id = ?3").bind(name, c.req.param("id"), s.user.id).run();
    await audit(c.env.DB, "PASSKEY_RENAMED", { userId: s.user.id, detail: { credential: c.req.param("id") } });
  }
  return c.redirect("/account?ok=key_renamed#passkeys", 303);
});

account.post("/account/sessions/:hash/revoke", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1 AND user_id = ?2").bind(c.req.param("hash"), s.user.id).run();
  await audit(c.env.DB, "SESSION_REVOKED", { userId: s.user.id, detail: { by: s.user.id, via: "self" } });
  return c.redirect("/account?ok=signed_out#sessions", 303);
});

account.post("/account/sessions/revoke-others", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1 AND id_hash != ?2").bind(s.user.id, s.idHash).run();
  await audit(c.env.DB, "SESSION_REVOKED", { userId: s.user.id, detail: { by: s.user.id, via: "self", others: true } });
  return c.redirect("/account?ok=signed_out_others#sessions", 303);
});

account.post("/account/grants/revoke", async (c) => {
  const s = await requireSession(c);
  if (s instanceof Response) return s;
  const form = await c.req.parseBody();
  const clientId = field(form, "client_id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_grants WHERE user_id = ?1 AND client_id = ?2").bind(s.user.id, clientId),
    c.env.DB.prepare("DELETE FROM refresh_tokens WHERE user_id = ?1 AND client_id = ?2").bind(s.user.id, clientId),
  ]);
  await audit(c.env.DB, "CONSENT_REVOKED", { userId: s.user.id, clientId });
  return c.redirect("/account?ok=revoked#connected", 303);
});
