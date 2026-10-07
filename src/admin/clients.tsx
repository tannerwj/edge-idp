import { Hono } from "hono";
import { audit, listClients } from "../db";
import { nowSec, randomToken, sha256Hex } from "../util";
import type { ACtx, AdminVars } from "./shell";
import { field, p } from "./shell";

export const clientsAdmin = new Hono<AdminVars>();

type ClientRow = Awaited<ReturnType<typeof listClients>>[number];

/** How many users can reach an app: everyone, or members of allowed groups. */
async function accessCounts(db: D1Database) {
  const { results: groupCounts } = await db
    .prepare(
      `SELECT g.name, COUNT(m.user_id) AS n FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.id
       GROUP BY g.id`,
    )
    .all<{ name: string; n: number }>();
  const countByGroup = new Map(groupCounts.map((r) => [r.name, r.n]));
  const { count: totalUsers } =
    (await db
      .prepare("SELECT COUNT(*) AS count FROM users WHERE disabled = 0")
      .first<{ count: number }>()) ?? { count: 0 };
  return (cl: ClientRow) => {
    if (!cl.allowed_groups?.length) return totalUsers;
    return cl.allowed_groups.reduce(
      (sum, g) => sum + (countByGroup.get(g) ?? 0),
      0,
    );
  };
}

function clientRow(cl: ClientRow, canAccess: number) {
  return (
    <tr key={cl.id}>
      <td>{cl.name}</td>
      <td class="muted small mono">{cl.id}</td>
      <td class="muted small">
        {cl.redirect_uris.map((u) => (
          <div key={u} class="mono">
            {new URL(u).host}
          </div>
        ))}
      </td>
      <td class="muted small">
        {cl.allowed_groups?.length ? cl.allowed_groups.join(", ") : "everyone"}{" "}
        ({canAccess} {canAccess === 1 ? "user" : "users"})
      </td>
      <td class="muted small">
        <form method="post" action={`/admin/clients/${cl.id}/pkce`}>
          <button
            class="btn ghost small"
            type="submit"
            title={cl.require_pkce
              ? "PKCE required — click to allow non-PKCE flows"
              : "PKCE optional — click to require it"}
          >
            {cl.require_pkce ? "Required" : "Optional"}
          </button>
        </form>
      </td>
      <td class="actions">
        <form method="post" action={`/admin/clients/${cl.id}/rotate`}>
          <button
            class="btn ghost small"
            type="submit"
            title="New secret (old one stops working immediately)"
          >
            Rotate secret
          </button>
        </form>
        <form method="post" action={`/admin/clients/${cl.id}/delete`}>
          <button class="btn danger ghost small" type="submit">
            Delete
          </button>
        </form>
      </td>
    </tr>
  );
}

clientsAdmin.get("/", async (c) => {
  const clients = await listClients(c.env.DB);
  const canAccess = await accessCounts(c.env.DB);
  return await p(
    c,
    "clients",
    "Apps",
    <>
      <h1>Apps</h1>
      <p class="muted">
        Register an app to let it use this server for sign-in. Redirect URIs
        must match <em>exactly</em> — that is what stops another app from
        stealing login codes.
      </p>
      <form method="post" action="/admin/clients" class="stack">
        <label class="field">
          <span>App name</span>
          <input name="name" required maxLength={120} placeholder="Constellation" />
        </label>
        <label class="field">
          <span>Redirect URIs (one per line)</span>
          <textarea
            name="redirectUris"
            rows={3}
            required
            placeholder="https://app.example.com/cdn-cgi/access/callback"
          />
        </label>
        <label class="field">
          <span>Allowed groups (comma-separated, blank = everyone)</span>
          <input name="allowedGroups" maxLength={200} placeholder="family, finance" />
        </label>
        <label class="check">
          <input type="checkbox" name="requirePkce" value="1" checked />
          <span>
            Require PKCE S256 <span class="muted small">(uncheck for server-side
            clients like Cloudflare Access that can't send a code challenge)</span>
          </span>
        </label>
        <div>
          <button class="btn primary" type="submit">
            Register app
          </button>
        </div>
      </form>
      <table class="table">
        <thead>
          <tr>
            <th>App</th>
            <th>Client ID</th>
            <th>Redirects to</th>
            <th>Who can sign in</th>
            <th>PKCE</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((cl) => clientRow(cl, canAccess(cl)))}
        </tbody>
      </table>
    </>,
  );
});

/** Redirect URIs must be https and unique; anything else is rejected. */
function parseUris(input: string): string[] | null {
  const uris = input
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (uris.length === 0) return null;
  for (const u of uris) {
    try {
      if (new URL(u).protocol !== "https:") return null;
    } catch {
      return null;
    }
  }
  return [...new Set(uris)];
}

async function showSecretOnce(
  c: ACtx,
  clientId: string,
  secret: string,
  rotated: boolean,
) {
  return await p(
    c,
    "clients",
    rotated ? "Secret rotated" : "App registered",
    <>
      <h1>{rotated ? "Secret rotated" : "App registered"}</h1>
      <p class="muted">
        Copy these <strong>now</strong> — the secret is stored as a hash and
        can never be shown again
        {rotated ? "; the old secret no longer works" : ""}.
      </p>
      <label class="field">
        <span>Client ID</span>
        <input readonly value={clientId} data-select />
      </label>
      <label class="field">
        <span>Client secret</span>
        <input readonly value={secret} data-select />
      </label>
      <p>
        <a class="btn" href="/admin/clients">
          Back to apps
        </a>
      </p>
    </>,
  );
}

clientsAdmin.post("/clients", async (c) => {
  const form = await c.req.parseBody();
  const name = field(form, "name").trim().slice(0, 120);
  const uris = parseUris(field(form, "redirectUris"));
  const groups = field(form, "allowedGroups")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!name || !uris) {
    return await p(
      c,
      "clients",
      "Apps",
      <p class="status error">
        A name and at least one valid https redirect URI are required.
      </p>,
    );
  }
  const id = randomToken(18);
  const secret = randomToken(32);
  const requirePkce = field(form, "requirePkce") === "1" ? 1 : 0;
  await c.env.DB.prepare(
    `INSERT INTO oidc_clients
       (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups, require_pkce, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      id,
      name,
      JSON.stringify(uris),
      await sha256Hex(secret),
      secret.slice(0, 6),
      groups.length ? JSON.stringify(groups) : null,
      requirePkce,
      nowSec(),
      c.get("admin").id,
    )
    .run();
  await audit(c.env.DB, "CLIENT_CREATED", {
    clientId: id,
    detail: { by: c.get("admin").id, name },
  });
  return showSecretOnce(c, id, secret, false);
});

clientsAdmin.post("/clients/:id/rotate", async (c) => {
  const secret = randomToken(32);
  await c.env.DB.prepare(
    "UPDATE oidc_clients SET secret_hash = ?1, secret_prefix = ?2 WHERE id = ?3",
  )
    .bind(await sha256Hex(secret), secret.slice(0, 6), c.req.param("id"))
    .run();
  await audit(c.env.DB, "CLIENT_SECRET_ROTATED", {
    clientId: c.req.param("id"),
    detail: { by: c.get("admin").id },
  });
  return showSecretOnce(c, c.req.param("id"), secret, true);
});

clientsAdmin.post("/clients/:id/pkce", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE oidc_clients SET require_pkce = 1 - require_pkce WHERE id = ?1",
  )
    .bind(id)
    .run();
  await audit(c.env.DB, "CLIENT_PKCE_TOGGLED", {
    clientId: id,
    detail: { by: c.get("admin").id },
  });
  return c.redirect("/admin/clients", 303);
});

clientsAdmin.post("/clients/:id/delete", async (c) => {
  await c.env.DB.prepare("DELETE FROM oidc_clients WHERE id = ?1")
    .bind(c.req.param("id"))
    .run();
  await audit(c.env.DB, "CLIENT_DELETED", {
    clientId: c.req.param("id"),
    detail: { by: c.get("admin").id },
  });
  return c.redirect("/admin/clients", 303);
});
