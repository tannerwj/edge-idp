import type { Group, OidcClient } from "../db";
import * as ops from "../ops";
import { Callout, CopyField, GroupPicker, PageHead, PostButton, Time } from "../ui/components";
import { Icon } from "../ui/icons";

export function host(u: string): string {
  try {
    const x = new URL(u);
    return x.protocol.startsWith("http") ? x.host : `${x.protocol}//${x.host}`;
  } catch {
    return u;
  }
}

export function TypeBadges(props: { c: OidcClient }) {
  const { c } = props;
  return (
    <span class="row-sm wrap">
      <span class="badge">{c.client_type === "public" ? "Public" : "Confidential"}</span>
      {c.source === "dcr" ? <span class="badge warn">Self-registered</span> : null}
      {c.source === "cimd" ? <span class="badge ok">Metadata URL</span> : null}
      {c.environment !== "production" ? <span class="badge">{c.environment}</span> : null}
      {c.redirect_uris.some((u) => u.includes("cloudflareaccess.com")) ? (
        <span class="badge accent">Cloudflare Access</span>
      ) : null}
    </span>
  );
}

export const detailHref = (id: string) => `/admin/clients/${encodeURIComponent(id)}`;

function ClientSidebar({
  client,
  grants,
  refresh,
  signIns,
  iss,
}: {
  client: OidcClient;
  grants: number;
  refresh: number;
  signIns: number;
  iss: string;
}) {
  return (
    <div class="stack">
      <section class="card">
        <div class="card-head">
          <h2>Usage</h2>
        </div>
        <div class="card-body">
          <dl class="kv kv-tight">
            <dt>Sign-ins (30d)</dt>
            <dd>{signIns}</dd>
            <dt>Last used</dt>
            <dd>
              <Time ts={client.last_used_at} empty="Never" />
            </dd>
            <dt>Consents</dt>
            <dd>{grants}</dd>
            <dt>Live sessions</dt>
            <dd>
              {refresh} refresh token{refresh === 1 ? "" : "s"}
            </dd>
            <dt>Created</dt>
            <dd>
              <Time ts={client.created_at} />
            </dd>
          </dl>
        </div>
      </section>
      <section class="card">
        <div class="card-head">
          <h2>Endpoints</h2>
        </div>
        <div class="card-body stack-sm">
          <span class="label">Discovery</span>
          <CopyField value={`${iss}/.well-known/openid-configuration`} label="discovery URL" />
          <details class="disclose">
            <summary>
              <Icon name="chevronRight" size="sm" />
              All endpoints
            </summary>
            <div class="stack-sm">
              <span class="label">Authorize</span>
              <CopyField value={`${iss}/authorize`} />
              <span class="label">Token</span>
              <CopyField value={`${iss}/token`} />
              <span class="label">JWKS</span>
              <CopyField value={`${iss}/jwks`} />
              <span class="label">Userinfo</span>
              <CopyField value={`${iss}/userinfo`} />
              <span class="label">Sign-out</span>
              <CopyField value={`${iss}/end-session`} />
            </div>
          </details>
        </div>
      </section>
      <section class="card danger-zone">
        <div class="card-body stack-sm">
          <p class="muted small">
            Deleting revokes every consent and refresh token issued to this client.
          </p>
          <PostButton
            action={`${detailHref(client.id)}/delete`}
            label="Delete client"
            icon="trash"
            class="btn sm danger"
            confirm={`Delete ${client.name}? Anything using it stops signing in.`}
          />
        </div>
      </section>
    </div>
  );
}

function ClientSettingsForm({ client, groups }: { client: OidcClient; groups: Group[] }) {
  return (
    <form class="card" method="post" action={detailHref(client.id)}>
      <div class="card-head">
        <Icon name="settings" />
        <h2>Settings</h2>
      </div>
      <div class="card-body stack">
        <label class="field">
          <span class="label">Name</span>
          <input name="name" required maxLength={120} value={client.name} />
        </label>
        <label class="field">
          <span class="label">Redirect URIs</span>
          <textarea name="redirectUris" rows={3} required>
            {client.redirect_uris.join("\n")}
          </textarea>
        </label>
        <div class="field">
          <span class="label">Allowed groups</span>
          <GroupPicker name="groups" all={groups} selected={client.allowed_groups} />
          <span class="hint">
            {client.source === "admin"
              ? "None selected = everyone."
              : "None selected = admins only (third-party client)."}{" "}
            Checked at every sign-in.
          </span>
        </div>
        <div class="grid-2">
          <label class="field">
            <span class="label">Environment</span>
            <select name="environment">
              {ops.ENVIRONMENTS.map((e) => (
                <option key={e} value={e} selected={client.environment === e}>
                  {e.charAt(0).toUpperCase() + e.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label class="check">
          <input
            type="checkbox"
            name="requirePkce"
            value="1"
            checked={client.require_pkce}
            disabled={client.client_type === "public"}
          />
          <span>
            Require PKCE
            <span class="sub">Always on for public clients. Cloudflare Access needs it off.</span>
          </span>
        </label>
        <label class="check">
          <input type="checkbox" name="skipConsent" value="1" checked={client.skip_consent} />
          <span>
            Trusted first-party app (skip the consent screen)
            <span class="sub">
              The passkey ceremony is the consent. Leave off for anything you didn't build or vet.
            </span>
          </span>
        </label>
      </div>
      <div class="card-foot">
        <button class="btn primary right" type="submit">
          Save changes
        </button>
      </div>
    </form>
  );
}

export function ClientDetail(props: {
  client: OidcClient;
  groups: Group[];
  grants: number;
  refresh: number;
  signIns: number;
  iss: string;
}) {
  const { client, groups, grants, refresh, signIns, iss } = props;
  const isAccess = client.redirect_uris.some((u) => u.includes("cloudflareaccess.com"));
  return (
    <>
      <PageHead title={client.name} lede={<TypeBadges c={client} />} />
      <div class="grid-3">
        <div class="stack span-2">
          <section class="card">
            <div class="card-head">
              <Icon name="key" />
              <h2 class="grow">Credentials</h2>
              {client.client_type === "confidential" && client.source === "admin" ? (
                <PostButton
                  action={`${detailHref(client.id)}/rotate`}
                  label="Rotate secret"
                  icon="refresh"
                  class="btn sm"
                  confirm="Issue a new secret? The current one stops working immediately."
                />
              ) : null}
            </div>
            <div class="card-body stack">
              <div class="field">
                <span class="label">Client ID</span>
                <CopyField value={client.id} label="client ID" />
              </div>
              {client.client_type === "confidential" ? (
                <div class="field">
                  <span class="label">Client secret</span>
                  <div class="secret">
                    <span class="val muted">
                      {client.secret_prefix}••••••••••••••••••••••••••••••
                    </span>
                  </div>
                  <span class="hint">Hashed at rest. Rotate to get a new one.</span>
                </div>
              ) : (
                <p class="muted small">Public client — authenticates with PKCE, no secret.</p>
              )}
            </div>
          </section>

          {isAccess ? (
            <Callout tone="accent" icon="cloud">
              <b>Cloudflare Access settings.</b> In Zero Trust → Settings → Authentication → your
              OpenID Connect provider: App ID = this client ID, Auth URL{" "}
              <code>{iss}/authorize</code>, Token URL <code>{iss}/token</code>, Certificate URL{" "}
              <code>{iss}/jwks</code>, PKCE off, scopes <code>openid email profile groups</code>,
              and add <code>groups</code> under OIDC Claims so policies can use it.
            </Callout>
          ) : null}

          <ClientSettingsForm client={client} groups={groups} />
        </div>

        <ClientSidebar
          client={client}
          grants={grants}
          refresh={refresh}
          signIns={signIns}
          iss={iss}
        />
      </div>
    </>
  );
}
