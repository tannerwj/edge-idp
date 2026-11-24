import { Hono } from "hono";
import { feedbackStates, validIssue } from "../feedback-format";
import { Inbox } from "./view";
import { getCookie, setCookie } from "hono/cookie";
import type { InboxRow } from "./view";
import { readBodyLimited } from "../http-body";

export const maintainerAdmin = new Hono<{ Bindings: { DB: D1Database; AUTHORITY?: Fetcher } }>();
const cookie = "__Host-maintainer";
maintainerAdmin.post("/session", async (c) => {
  if (!c.env.AUTHORITY || !c.req.header("origin")) return c.text("Sign-in unavailable", 403);
  let token;
  try {
    const body = await readBodyLimited(c.req.raw, 256);
    token = new URLSearchParams(new TextDecoder().decode(body)).get("code");
  } catch {
    return c.text("Invalid launch", 400);
  }
  if (!token || !/^[\w-]{43}$/.test(token)) return c.text("Invalid launch", 403);
  const response = await c.env.AUTHORITY.fetch("https://authority.invalid/exchange", {
    method: "POST",
    body: JSON.stringify({
      token,
      origin: new URL(c.req.url).origin,
      sender: c.req.header("origin"),
    }),
  });
  if (!response.ok)
    return c.text("Open the maintainer inbox again from your signed-in installation.", 403);
  setCookie(c, cookie, await response.text(), {
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 1800,
  });
  return c.redirect("/admin", 303);
});
maintainerAdmin.use("*", async (c, next) => {
  const token = getCookie(c, cookie);
  const origin = new URL(c.req.url).origin;
  const write = c.req.method === "POST";
  if (write && c.req.header("origin") !== origin) return c.text("Invalid origin", 403);
  if (!token || !c.env.AUTHORITY)
    return c.text(
      "In your maintainer installation, choose Feedback, then Open maintainer inbox.",
      403,
    );
  const response = await c.env.AUTHORITY.fetch(
    "https://authority.invalid/" + (write ? "write" : "read"),
    { method: "POST", body: JSON.stringify({ token, origin }) },
  );
  if (!response.ok)
    return c.text("Reopen the inbox from your installation and confirm your passkey.", 403);
  return next();
});
maintainerAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const before = Number(c.req.query("before")) || 0;
  const rows = await db
    .prepare(
      "SELECT id,kind,summary,tool_name,server_version,status,reply,issue,duplicate_of FROM reports WHERE (?1=0 OR id<?1) ORDER BY id DESC LIMIT 50",
    )
    .bind(before)
    .all<InboxRow>();
  return c.html(
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Maintainer inbox · Edge IDP</title>
        <style>
          {
            "body{font:1rem/1.5 system-ui,sans-serif;background:#f5f6f8;color:#18212d;margin:0}main{max-width:46rem;margin:auto;padding:1.5rem}article{background:white;border:1px solid #ccd3dc;border-radius:.6rem;padding:1rem;margin-bottom:1rem}form,label{display:grid;gap:.4rem}form{gap:1rem}button,input,select,textarea{font:inherit;padding:.4rem}textarea{min-height:4rem}button{justify-self:start}"
          }
        </style>
      </head>
      <body>
        <Inbox rows={rows.results} />
      </body>
    </html>,
  );
});
maintainerAdmin.post("/:id", async (c) => {
  const db = c.env.DB;

  const f = await c.req.parseBody(),
    id = Number(c.req.param("id")),
    target = Number(f.duplicate_of) || null;
  if (
    !feedbackStates.some((s) => s === f.status) ||
    typeof f.reply !== "string" ||
    f.reply.length > 1000 ||
    !validIssue(f.issue)
  )
    return c.text("Invalid reply or issue URL", 400);
  if (!target && (f.status === "done" || f.status === "declined") && !f.reply.trim())
    return c.text("Add a resolution note", 400);
  const updated = await db
    .prepare(
      `UPDATE reports SET status=?1,reply=?2,issue=?3,duplicate_of=?4 WHERE id=?5 AND (?4 IS NULL OR (?4<>?5 AND EXISTS(SELECT 1 FROM reports WHERE id=?4 AND duplicate_of IS NULL) AND NOT EXISTS(SELECT 1 FROM reports WHERE duplicate_of=?5)))`,
    )
    .bind(f.status, f.reply.trim(), f.issue, target, id)
    .run();
  return updated.meta.changes
    ? c.redirect("/admin", 303)
    : c.text("Unknown report or invalid duplicate group", 400);
});
