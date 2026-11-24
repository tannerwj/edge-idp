import { Hono } from "hono";
import { feedbackStates, validIssue } from "../feedback-format";
import { Inbox } from "../maintainer/view";
import type { InboxRow } from "../maintainer/view";
import { page } from "./shell";
import type { AdminVars } from "./shell";
export const maintainerAdmin = new Hono<AdminVars>();
maintainerAdmin.get("/", async (c) => {
  const db = c.env.MAINTAINER_DB;
  if (!db) return c.notFound();
  const before = Number(c.req.query("before")) || 0;
  const rows = await db
    .prepare(
      "SELECT id,kind,summary,tool_name,server_version,status,reply,issue,duplicate_of FROM reports WHERE (?1=0 OR id<?1) ORDER BY id DESC LIMIT 50",
    )
    .bind(before)
    .all<InboxRow>();
  return page(c, { active: "metrics", title: "Maintainer inbox" }, <Inbox rows={rows.results} />);
});
maintainerAdmin.post("/:id", async (c) => {
  const db = c.env.MAINTAINER_DB;
  if (!db) return c.notFound();

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
    ? c.redirect("/admin/maintainer", 303)
    : c.text("Unknown report or invalid duplicate group", 400);
});
