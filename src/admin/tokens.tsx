import { Hono } from "hono";
import { audit } from "../db";
import * as ops from "../ops";
import { nowSec } from "../util";
import type { AdminVars } from "./shell";
import { act, actor, field, page } from "./shell";
import { Callout, CopyField, Dialog, Empty, PageHead, PostButton, Time } from "../ui/components";
import { Icon } from "../ui/icons";

export const tokensAdmin = new Hono<AdminVars>();

type ApiTokenRow = {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  scope: string;
  expires_at: number | null;
  prefix: string | null;
  creator: string;
};

function TokenRow({ t, now }: { t: ApiTokenRow; now: number }) {
  const expired = !!t.expires_at && t.expires_at < now;
  return (
    <tr key={t.id}>
      <td>
        <div class="name">{t.name}</div>
        <div class="muted small">
          {t.prefix ? <span class="mono">{t.prefix}…</span> : null} by {t.creator}
        </div>
      </td>
      <td>
        {t.scope === "admin" ? (
          <span class="badge warn">Full admin</span>
        ) : (
          <span class="badge">Read-only</span>
        )}
      </td>
      <td class="muted small nowrap">
        <Time ts={t.last_used_at} empty="Never" />
      </td>
      <td class="small nowrap">
        {expired ? (
          <span class="badge bad">Expired</span>
        ) : t.expires_at ? (
          <Time ts={t.expires_at} />
        ) : (
          <span class="muted">Never</span>
        )}
      </td>
      <td class="actions">
        <PostButton
          action={`/admin/tokens/${t.id}/delete`}
          label="Revoke"
          class="btn ghost sm danger"
          confirm={`Revoke “${t.name}”? Anything using it stops working.`}
        />
      </td>
    </tr>
  );
}

function NewTokenDialog() {
  return (
    <Dialog
      id="new-token"
      title="New API token"
      lede="Shown once. Stored as a hash."
      action="/admin/tokens"
      submit="Create token"
    >
      <label class="field">
        <span class="label">Name</span>
        <input name="name" required maxLength={60} placeholder="Home automation script" />
      </label>
      <div class="field">
        <span class="label">Access</span>
        <label class="check">
          <input type="radio" name="scope" value="read" checked />
          <span>
            Read-only
            <span class="sub">List people, groups, apps, audit log. Can't change anything.</span>
          </span>
        </label>
        <label class="check">
          <input type="radio" name="scope" value="admin" />
          <span>
            Full admin
            <span class="sub">Everything you can do in this UI. Guard it like a password.</span>
          </span>
        </label>
      </div>
      <label class="field">
        <span class="label">Expires</span>
        <select name="expires">
          <option value="30">In 30 days</option>
          <option value="90" selected>
            In 90 days
          </option>
          <option value="365">In a year</option>
          <option value="">Never</option>
        </select>
      </label>
    </Dialog>
  );
}

tokensAdmin.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.created_at, t.last_used_at, t.scope, t.expires_at, t.prefix, u.name AS creator
     FROM api_tokens t JOIN users u ON u.id = t.created_by ORDER BY t.created_at DESC`,
  ).all<ApiTokenRow>();
  const now = nowSec();
  return await page(
    c,
    { active: "tokens", title: "API tokens" },
    <>
      <PageHead
        title="API tokens"
        lede={
          <>
            Bearer tokens for the admin MCP server and scripts. Most AI clients can use OAuth
            instead — see <a href="/admin/connect#mcp">Connect</a>.
          </>
        }
        actions={
          <button class="btn primary" type="button" data-open="new-token">
            <Icon name="plus" size="sm" />
            New token
          </button>
        }
      />
      <div class="card">
        {results.length ? (
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Access</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {results.map((t) => (
                  <TokenRow key={t.id} t={t} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            icon="key"
            title="No API tokens"
            action={
              <button class="btn primary" type="button" data-open="new-token">
                Create a token
              </button>
            }
          >
            Create one for scripts or MCP clients that can't do OAuth.
          </Empty>
        )}
      </div>
      <NewTokenDialog />
    </>,
  );
});

tokensAdmin.post("/", async (c) => {
  const form = await c.req.parseBody();
  const days = parseInt(field(form, "expires"), 10);
  let raw: string;
  try {
    raw = await ops.createApiToken(
      c.env.DB,
      {
        name: field(form, "name"),
        scope: field(form, "scope") === "admin" ? "admin" : "read",
        expiresInDays: Number.isFinite(days) && days > 0 ? days : null,
      },
      actor(c),
    );
  } catch (e) {
    if (e instanceof ops.OpError)
      return act(c, "/admin/tokens", "", async () => {
        throw e;
      });
    throw e;
  }
  const url = `${c.env.ISSUER}/mcp`;
  return await page(
    c,
    {
      active: "tokens",
      title: "Token created",
      crumbs: [{ label: "API tokens", href: "/admin/tokens" }, { label: "New token" }],
      narrow: true,
    },
    <div class="card">
      <div class="card-body stack">
        <div class="hero-icon ok">
          <Icon name="key" />
        </div>
        <div>
          <h1>Copy your token</h1>
          <p class="muted">This is the only time it's shown.</p>
        </div>
        <CopyField value={raw} big label="API token" />
        <Callout icon="terminal">
          <div class="stack-sm">
            <b>Claude Code</b>
            <pre class="code">{`claude mcp add --transport http ${c.env.RP_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-")} ${url} \\\n  --header "Authorization: Bearer ${raw}"`}</pre>
            <b>curl</b>
            <pre class="code">{`curl -s ${url} -H "Authorization: Bearer ${raw}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`}</pre>
          </div>
        </Callout>
        <div class="row">
          <a class="btn primary right" href="/admin/tokens">
            Done
          </a>
        </div>
      </div>
    </div>,
  );
});

tokensAdmin.post("/:id/delete", async (c) => {
  const id = c.req.param("id");
  return act(c, "/admin/tokens", "Token revoked", async () => {
    await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ?1").bind(id).run();
    await audit(c.env.DB, "API_TOKEN_REVOKED", {
      userId: c.get("admin").id,
      detail: { token: id.slice(0, 8) },
    });
  });
});
