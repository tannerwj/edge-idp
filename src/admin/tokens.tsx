import { Hono } from "hono";
import { audit } from "../db";
import { newId, nowSec, randomToken, sha256Hex } from "../util";
import type { AdminVars } from "./shell";
import { field, fmt, p } from "./shell";

export const tokensAdmin = new Hono<AdminVars>();

tokensAdmin.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.created_at, t.last_used_at, u.name AS creator
     FROM api_tokens t JOIN users u ON u.id = t.created_by
     ORDER BY t.created_at DESC`,
  ).all<{
    id: string;
    name: string;
    created_at: number;
    last_used_at: number | null;
    creator: string;
  }>();
  return await p(
    c,
    "tokens",
    "API Tokens",
    <>
      <h1>API Tokens</h1>
      <p class="muted">
        Tokens for MCP and programmatic access. They have full admin power —
        guard them like passwords. Only the hash is stored.
      </p>
      <form method="post" action="/admin/tokens" class="row wrap">
        <label class="field inline">
          <span>Token name</span>
          <input name="name" required maxLength={60} placeholder="Claude MCP" />
        </label>
        <button class="btn primary" type="submit">
          Create token
        </button>
      </form>
      {results.length === 0 ? (
        <p class="muted small">No tokens yet.</p>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th>By</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td class="muted small">{fmt(t.created_at)}</td>
                  <td class="muted small">{t.last_used_at ? fmt(t.last_used_at) : "never"}</td>
                  <td class="muted small">{t.creator}</td>
                  <td class="actions">
                    <form method="post" action={`/admin/tokens/${t.id}/delete`}>
                      <button class="btn danger ghost small" type="submit">
                        Revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Connect via MCP</h2>
      <p class="muted small">
        Point your MCP client at <code>{c.env.ISSUER}/mcp</code> with the token
        as a Bearer header. Streamable HTTP transport.
      </p>
    </>,
  );
});

tokensAdmin.post("/", async (c) => {
  const form = await c.req.parseBody();
  const name = field(form, "name").trim().slice(0, 60);
  if (!name) return c.text("Name is required.", 400);
  const raw = randomToken(32);
  const id = newId();
  await c.env.DB.prepare(
    "INSERT INTO api_tokens (id, token_hash, name, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, await sha256Hex(raw), name, nowSec(), c.get("admin").id)
    .run();
  await audit(c.env.DB, "API_TOKEN_CREATED", {
    userId: c.get("admin").id,
    detail: { name },
  });
  return await p(
    c,
    "tokens",
    "Token created",
    <>
      <h1>Token created</h1>
      <p class="muted">
        Copy this <strong>now</strong> — it can never be shown again.
      </p>
      <label class="field">
        <span>API token</span>
        <input readonly value={raw} data-select />
      </label>
      <p>
        <a class="btn" href="/admin/tokens">
          Back to tokens
        </a>
      </p>
    </>,
  );
});

tokensAdmin.post("/:id/delete", async (c) => {
  await c.env.DB.prepare("DELETE FROM api_tokens WHERE id = ?1")
    .bind(c.req.param("id"))
    .run();
  await audit(c.env.DB, "API_TOKEN_REVOKED", {
    userId: c.get("admin").id,
    detail: { token: c.req.param("id").slice(0, 8) },
  });
  return c.redirect("/admin/tokens", 303);
});
