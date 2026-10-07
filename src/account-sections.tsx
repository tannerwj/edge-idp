import { Empty, PostButton, Time } from "./ui/components";
import { deviceLabel, Feed } from "./ui/feed";
import type { FeedRow } from "./ui/feed";
import { Icon } from "./ui/icons";
import { aaguidName } from "./aaguid";
import type { User, WebAuthnCredential } from "./db";

type Credential = WebAuthnCredential;
export interface SessionRow {
  id_hash: string;
  created_at: number;
  last_seen_at: number;
  user_agent: string | null;
}
export interface GrantRow {
  client_id: string;
  scope: string;
  created_at: number;
  last_used_at: number | null;
  name: string;
  source: string;
}

export function AccountLede({ user }: { user: User }) {
  return (
    <>
      {user.email}
      {user.is_admin ? (
        <>
          {" "}
          <span class="badge accent">Admin</span>
        </>
      ) : null}
    </>
  );
}

export function ProfileSection({ user }: { user: User }) {
  return (
    <section class="card" id="profile">
      <div class="card-head">
        <Icon name="user" />
        <h2>Profile</h2>
      </div>
      <form method="post" action="/account/profile">
        <div class="card-body grid-2">
          <label class="field">
            <span class="label">Name</span>
            <input name="name" required maxLength={120} value={user.name} autocomplete="name" />
          </label>
          <label class="field">
            <span class="label">Email</span>
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              value={user.email}
              autocomplete="email"
            />
            <span class="hint">
              Apps see this as your email. Your passkeys keep working if you change it.
            </span>
          </label>
        </div>
        <div class="card-foot">
          <button class="btn primary right" type="submit">
            Save profile
          </button>
        </div>
      </form>
    </section>
  );
}

export function PasskeysSection({ creds }: { creds: Credential[] }) {
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
                {k.backup_state ? (
                  <span class="badge">Synced</span>
                ) : (
                  <span class="badge">This device only</span>
                )}
              </div>
              <div class="meta">
                {aaguidName(k.aaguid) ? <>{aaguidName(k.aaguid)} · </> : null}
                Added <Time ts={k.created_at} /> ·{" "}
                {k.last_used_at ? (
                  <>
                    Last used <Time ts={k.last_used_at} />
                  </>
                ) : (
                  "Never used"
                )}
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

export function SessionsSection({
  sessions,
  currentHash,
  others,
  rpName,
}: {
  sessions: SessionRow[];
  currentHash: string;
  others: number;
  rpName: string;
}) {
  return (
    <section class="card" id="sessions">
      <div class="card-head">
        <Icon name="monitor" />
        <div class="grow">
          <h2>Where you're signed in</h2>
          <div class="sub">
            Browser sessions on {rpName}. Apps keep their own sessions on top of these.
          </div>
        </div>
        {others > 0 ? (
          <PostButton
            action="/account/sessions/revoke-others"
            label="Sign out other sessions"
            class="btn sm"
            confirm="Sign out of every other browser?"
          />
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
              {current ? null : (
                <PostButton
                  action={`/account/sessions/${x.id_hash}/revoke`}
                  label="Sign out"
                  class="btn ghost sm"
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function ConnectedSection({ grants }: { grants: GrantRow[] }) {
  return (
    <section class="card" id="connected">
      <div class="card-head">
        <Icon name="plug" />
        <div class="grow">
          <h2>Connected apps</h2>
          <div class="sub">
            Third-party apps and AI tools you've approved. Disconnecting revokes their access
            immediately.
          </div>
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
                  {g.last_used_at ? (
                    <>
                      {" "}
                      · Used <Time ts={g.last_used_at} />
                    </>
                  ) : null}
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
          When you approve an app or AI assistant (like Claude) to use your account, it shows up
          here.
        </Empty>
      )}
    </section>
  );
}

export function ActivitySection({ rows }: { rows: FeedRow[] }) {
  return (
    <section class="card" id="activity">
      <div class="card-head">
        <Icon name="activity" />
        <h2>Recent activity</h2>
      </div>
      {rows.length ? (
        <Feed rows={rows} showWho={false} />
      ) : (
        <Empty icon="activity" title="Nothing yet" />
      )}
    </section>
  );
}
