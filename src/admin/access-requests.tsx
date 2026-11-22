import { Hono } from "hono";
import type { AdminVars } from "./shell";
import { actor, field, page } from "./shell";
import { auditStmt } from "../db";

export const requestsAdmin = new Hono<AdminVars>();
requestsAdmin.post("/apps/:id/requestable", async (c) => {
  const id = c.req.param("id"),
    form = await c.req.parseBody(),
    on = field(form, "enabled") === "1";
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE apps SET requestable=? WHERE id=?").bind(Number(on), id),
    auditStmt(c.env.DB, "APP_REQUESTABILITY_CHANGED", {
      detail: { app: id, enabled: on, by: actor(c).adminId },
    }),
  ]);
  return c.redirect("/admin/apps/" + id + "/onboarding", 303);
});
requestsAdmin.get("/requests", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT r.id,a.name app,u.name person FROM access_requests r JOIN apps a ON a.id=r.app_id JOIN users u ON u.id=r.user_id WHERE r.decision IS NULL ORDER BY r.requested_at",
  ).all<{ id: string; app: string; person: string }>();
  return page(
    c,
    { active: "apps", title: "Access requests" },
    <section class="card card-body">
      <h1>Access requests</h1>
      <p>
        Expiry ends launcher access and new token issuance through this grant. Existing tokens and
        app sessions may continue.
      </p>
      {!results.length && <p>No pending requests.</p>}
      {results.map((r) => (
        <form key={r.id} class="stack-sm" action={"/admin/requests/" + r.id} method="post">
          <h2>
            {r.person} · {r.app}
          </h2>
          <label>
            Last day of access (UTC, optional) <input type="date" name="until" />
          </label>
          <button name="decision" value="approve">
            Approve
          </button>
          <button name="decision" value="deny">
            Deny
          </button>
        </form>
      ))}
    </section>,
  );
});
requestsAdmin.post("/requests/:id", async (c) => {
  const form = await c.req.parseBody(),
    decision = field(form, "decision"),
    until = field(form, "until");
  if (decision !== "approve" && decision !== "deny") return c.text("Invalid decision", 400);
  const end = until ? Date.parse(until + "T00:00:00Z") / 1000 + 86400 : null;
  if (
    decision === "approve" &&
    until &&
    (!/^\d{4}-\d\d-\d\d$/.test(until) || !Number.isFinite(end) || (end ?? 0) <= Date.now() / 1000)
  )
    return c.text("Choose today or a future date.", 400);
  const db = c.env.DB,
    id = c.req.param("id"),
    stmts = [];
  if (decision === "approve") {
    const target = end
      ? "temporary_app_grants(id,app_id,user_id,created_at,expires_at)"
      : "app_grants(id,app_id,user_id,created_at)";
    const columns = end ? "?,r.app_id,r.user_id,unixepoch(),?" : "?,r.app_id,r.user_id,unixepoch()";
    const grantId = (end ? "temporary:" : "approved:") + id;
    stmts.push(
      db
        .prepare(
          `INSERT INTO ${target} SELECT ${columns} FROM access_requests r JOIN apps a ON a.id=r.app_id JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.decision IS NULL AND a.requestable=1 AND u.public=0 AND u.disabled=0`,
        )
        .bind(...(end ? [grantId, end, id] : [grantId, id])),
    );
  }
  stmts.push(
    db
      .prepare(
        "UPDATE access_requests SET decision=?,decided_at=unixepoch() WHERE id=? AND decision IS NULL AND (?='denied' OR changes()=1)",
      )
      .bind(
        decision === "approve" ? "approved" : "denied",
        id,
        decision === "approve" ? "approved" : "denied",
      ),
    db
      .prepare(
        "INSERT INTO audit_log(created_at,event,user_id,detail) SELECT unixepoch(),'ACCESS_REQUEST_DECIDED',user_id,json_object('app',app_id,'decision',decision,'by',?) FROM access_requests WHERE id=? AND changes()=1",
      )
      .bind(actor(c).adminId, id),
  );
  await db.batch(stmts);
  return c.redirect("/admin/requests", 303);
});
