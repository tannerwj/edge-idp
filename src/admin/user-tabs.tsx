/** Tab panels for the admin user-detail page. */
import type { getCredentialsForUser, Group, User } from "../db";
import { Empty, GroupPicker, PostButton, Time } from "../ui/components";
import { deviceLabel, Feed } from "../ui/feed";
import type { FeedRow } from "../ui/feed";
import { Icon } from "../ui/icons";
import { aaguidName } from "../aaguid";

export interface TabData {
  id: string;
  self: boolean;
  user: User;
  creds: Awaited<ReturnType<typeof getCredentialsForUser>>;
  groups: string[];
  allGroups: Group[];
  sessions: {
    id_hash: string;
    created_at: number;
    last_seen_at: number;
    user_agent: string | null;
  }[];
  grants: {
    client_id: string;
    scope: string;
    created_at: number;
    last_used_at: number | null;
    name: string;
  }[];
  activity: FeedRow[];
}

export function OverviewTab({ id, self, user, creds, groups, allGroups }: TabData) {
  return (
    <div class="grid-3">
      <div class="stack span-2">
        <form class="card" method="post" action={`/admin/users/${id}/profile`}>
          <div class="card-head">
            <h2>Profile</h2>
          </div>
          <div class="card-body grid-2">
            <label class="field">
              <span class="label">Name</span>
              <input name="name" required maxLength={120} value={user.name} />
            </label>
            <label class="field">
              <span class="label">Email</span>
              <input name="email" type="email" required maxLength={254} value={user.email} />
            </label>
          </div>
          <div class="card-foot">
            <button class="btn primary right" type="submit">
              Save
            </button>
          </div>
        </form>
        <form class="card" method="post" action={`/admin/users/${id}/groups`}>
          <div class="card-head">
            <div class="grow">
              <h2>Groups</h2>
              <div class="sub">
                Sent to apps in the <code>groups</code> claim, and used for app access.
              </div>
            </div>
          </div>
          <div class="card-body">
            <GroupPicker name="groups" all={allGroups} selected={groups} />
          </div>
          <div class="card-foot">
            <a class="small" href="/admin/groups">
              Manage groups
            </a>
            <button class="btn primary right" type="submit">
              Save groups
            </button>
          </div>
        </form>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head">
            <h2>Details</h2>
          </div>
          <div class="card-body">
            <dl class="kv kv-tight">
              <dt>Joined</dt>
              <dd>
                <Time ts={user.created_at} />
              </dd>
              <dt>Last sign-in</dt>
              <dd>
                <Time ts={user.last_sign_in_at} empty="Never" />
              </dd>
              <dt>Passkeys</dt>
              <dd>{creds.length}</dd>
              <dt>User ID</dt>
              <dd class="mono tiny truncate" title={user.id}>
                {user.id}
              </dd>
            </dl>
          </div>
        </div>
        <div class="card">
          <div class="card-head">
            <h2>Role</h2>
          </div>
          <div class="card-body stack-sm">
            <p class="muted small">
              {user.is_admin
                ? "Admins manage people, apps and settings, and can use the admin API (MCP)."
                : "Standard member: signs in to the apps their groups allow."}
            </p>
            {self ? (
              <p class="muted small">You can't change your own role.</p>
            ) : (
              <PostButton
                action={`/admin/users/${id}/role`}
                fields={{ isAdmin: user.is_admin ? "0" : "1" }}
                label={user.is_admin ? "Remove admin" : "Make admin"}
                icon="shield"
                class="btn sm"
                confirm={
                  user.is_admin
                    ? `Remove admin from ${user.name}? Their API tokens are deleted too.`
                    : `Make ${user.name} an admin?`
                }
              />
            )}
          </div>
        </div>
        {self ? null : (
          <div class="card danger-zone">
            <div class="card-head">
              <h2>Danger zone</h2>
            </div>
            <div class="card-body stack-sm">
              <PostButton
                action={`/admin/users/${id}/revoke-keys`}
                label="Reset passkeys (recovery)"
                icon="refresh"
                class="btn sm danger"
                confirm={`Delete all of ${user.name}'s passkeys and sign them out? Then send them a new enrollment link.`}
              />
              <PostButton
                action={`/admin/users/${id}/delete`}
                label="Delete person"
                icon="trash"
                class="btn sm danger"
                confirm={`Permanently delete ${user.name}? Disabling is reversible; this isn't.`}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function PasskeysTab({ id, user, creds }: TabData) {
  return (
    <div class="card">
      {creds.length ? (
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
                    <span class="badge">Device-bound</span>
                  )}
                </div>
                <div class="meta">
                  {aaguidName(k.aaguid) ? <>{aaguidName(k.aaguid)} · </> : null}Added{" "}
                  <Time ts={k.created_at} /> ·{" "}
                  {k.last_used_at ? (
                    <>
                      Used <Time ts={k.last_used_at} />
                    </>
                  ) : (
                    "Never used"
                  )}
                </div>
              </div>
              <PostButton
                action={`/admin/users/${id}/keys/${k.id}/remove`}
                label="Remove"
                class="btn ghost sm danger"
                confirm={`Remove “${k.name}” from ${user.name}?`}
              />
            </li>
          ))}
        </ul>
      ) : (
        <Empty
          icon="fingerprint"
          title="No passkeys"
          action={
            <PostButton
              action={`/admin/users/${id}/enrollment`}
              label="Get invite link"
              icon="link"
              class="btn primary"
            />
          }
        >
          {user.name} can't sign in until they set one up.
        </Empty>
      )}
    </div>
  );
}

export function SessionsTab({ id, user, sessions }: TabData) {
  return (
    <div class="card">
      {sessions.length ? (
        <>
          <div class="card-head">
            <h2 class="grow">Active sessions</h2>
            <PostButton
              action={`/admin/users/${id}/sign-out`}
              label="Sign out everywhere"
              class="btn sm"
              confirm={`Sign ${user.name} out of every browser?`}
            />
          </div>
          <ul class="list">
            {sessions.map((s) => {
              const d = deviceLabel(s.user_agent);
              return (
                <li key={s.id_hash}>
                  <span class="ev-icon-lg">
                    <Icon name={d.icon} />
                  </span>
                  <div class="grow">
                    <div class="title">{d.label}</div>
                    <div class="meta">
                      Signed in <Time ts={s.created_at} /> · Active <Time ts={s.last_seen_at} />
                    </div>
                  </div>
                  <PostButton
                    action={`/admin/users/${id}/sessions/${s.id_hash}/revoke`}
                    label="Sign out"
                    class="btn ghost sm"
                  />
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <Empty icon="monitor" title="Not signed in anywhere" />
      )}
    </div>
  );
}

export function ConnectedAppsTab({ user, grants }: TabData) {
  return (
    <div class="card">
      {grants.length ? (
        <ul class="list">
          {grants.map((g) => (
            <li key={g.client_id}>
              <span class="ev-icon-lg">
                <Icon name={g.scope.includes("mcp") ? "bot" : "plug"} />
              </span>
              <div class="grow">
                <a class="title" href={`/admin/clients/${encodeURIComponent(g.client_id)}`}>
                  {g.name}
                </a>
                <div class="meta">
                  {g.scope} · Approved <Time ts={g.created_at} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="plug" title="No connected apps">
          Third-party apps and AI tools {user.name} approves show up here.
        </Empty>
      )}
    </div>
  );
}

export function ActivityTab({ activity }: TabData) {
  return (
    <div class="card">
      {activity.length ? (
        <Feed rows={activity} showWho={false} />
      ) : (
        <Empty icon="activity" title="No activity" />
      )}
    </div>
  );
}
