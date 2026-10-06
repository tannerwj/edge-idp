import { Hono } from "hono";
import { audit, listClients } from "../db";
import { nowSec, randomToken, sha256Hex } from "../util";
import type { ACtx, AdminVars } from "./shell";
import { field, p } from "./shell";

export const clientsAdmin = new Hono<AdminVars>();

clientsAdmin.get("/", async (c) => {
  const clients = await listClients(c.env.DB);
  return p(
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
            <th>Groups</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((cl) => (
            <tr key={cl.id}>
              <td>{cl.name}</td>
              <td class="muted small mono">{cl.id}</td>
              <td class="muted small">
                {cl.allowed_groups?.length
                  ? cl.allowed_groups.join(", ")
                  : "everyone"}
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
          ))}
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
  return p(
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
    return p(
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
  await c.env.DB.prepare(
    `INSERT INTO oidc_clients
       (id, name, redirect_uris, secret_hash, secret_prefix, allowed_groups, created_at, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      name,
      JSON.stringify(uris),
      await sha256Hex(secret),
      secret.slice(0, 6),
      groups.length ? JSON.stringify(groups) : null,
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
