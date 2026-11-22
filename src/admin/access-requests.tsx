import type { Env } from "../config";
import { lastDay } from "../request-dates";
import { emailStatus, sendMail } from "../email";
import { getInstanceSettings } from "../settings-cache";
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
  const mailReady = emailStatus(c.env, await getInstanceSettings(c.env.DB)) === "ready";
  const { results } = await c.env.DB.prepare(
    "SELECT r.id,r.previous_end,a.name app,u.name person FROM access_requests r JOIN apps a ON a.id=r.app_id JOIN users u ON u.id=r.user_id WHERE r.decision IS NULL ORDER BY r.requested_at",
  ).all<{ id: string; app: string; person: string; previous_end: number | null }>();
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
          {r.previous_end && <p>Extension of access through {lastDay(r.previous_end)} (UTC)</p>}
          <label>
            Decision note (visible to member)
            <textarea name="note" maxLength={500} />
          </label>
          {mailReady && (
            <label>
              <input type="checkbox" name="notify" value="1" />
              Email the decision
            </label>
          )}
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
function validLastDay(value: string, end: number) {
  return (
    /^\d{4}-\d\d-\d\d$/.test(value) &&
    Number.isFinite(end) &&
    end > Date.now() / 1000 &&
    lastDay(end) === value
  );
}
function approvalGrant(db: D1Database, id: string, end: number | null) {
  const target = end
    ? "temporary_app_grants(id,app_id,user_id,created_at,expires_at)"
    : "app_grants(id,app_id,user_id,created_at)";
  const columns = end ? "?,r.app_id,r.user_id,unixepoch(),?" : "?,r.app_id,r.user_id,unixepoch()";
  const grantId = (end ? "temporary:" : "approved:") + id;
  return db
    .prepare(
      `INSERT INTO ${target} SELECT ${columns} FROM access_requests r JOIN apps a ON a.id=r.app_id JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.decision IS NULL AND a.requestable=1 AND u.public=0 AND u.disabled=0`,
    )
    .bind(...(end ? [grantId, end, id] : [grantId, id]));
}
requestsAdmin.post("/requests/:id", async (c) => {
  const form = await c.req.parseBody(),
    decision = field(form, "decision"),
    until = field(form, "until");
  if (decision !== "approve" && decision !== "deny") return c.text("Invalid decision", 400);
  const note = field(form, "note").trim();
  if (note.length > 500) return c.text("Limit the note to 500 characters.", 400);
  const end = until ? Date.parse(until + "T00:00:00Z") / 1000 + 86400 : null;
  if (decision === "approve" && end !== null && !validLastDay(until, end))
    return c.text("Choose today or a future date.", 400);
  const db = c.env.DB,
    id = c.req.param("id"),
    stmts = [];
  if (decision === "approve") {
    const prior = await db
      .prepare("SELECT previous_end FROM access_requests WHERE id=? AND decision IS NULL")
      .bind(id)
      .first<number>("previous_end");
    if (end && prior && end <= prior)
      return c.text("Choose a later last day for the extension.", 400);
    stmts.push(approvalGrant(db, id, end));
  }
  stmts.push(
    db
      .prepare(
        "UPDATE access_requests SET decision=?,decision_note=?,approved_until=?,decided_at=unixepoch() WHERE id=? AND decision IS NULL AND (?='denied' OR changes()=1)",
      )
      .bind(
        decision === "approve" ? "approved" : "denied",
        note || null,
        decision === "approve" ? end : null,
        id,
        decision === "approve" ? "approved" : "denied",
      ),
    db
      .prepare(
        "INSERT INTO audit_log(created_at,event,user_id,detail) SELECT unixepoch(),'ACCESS_REQUEST_DECIDED',user_id,json_object('app',app_id,'decision',decision,'by',?) FROM access_requests WHERE id=? AND changes()=1",
      )
      .bind(actor(c).adminId, id),
  );
  const result = await db.batch(stmts);
  if (result.at(-2)?.meta.changes && field(form, "notify") === "1") {
    if (!(await notifyMember(c.env, id, decision)))
      return c.text("Decision saved. The notification email could not be delivered.", 502);
  }
  return c.redirect("/admin/requests", 303);
});

async function notifyMember(env: Env, id: string, decision: string) {
  const db = env.DB;
  const member = await db
    .prepare(
      "SELECT u.email FROM access_requests r JOIN users u ON u.id=r.user_id WHERE r.id=? AND u.public=0",
    )
    .bind(id)
    .first<string>("email");
  if (member) {
    const mail = await sendMail(env, await getInstanceSettings(db), member, {
      subject: "Your access request",
      heading: "Your access request was " + (decision === "approve" ? "approved" : "denied"),
      paragraphs: ["View the decision in My requests."],
      button: { label: "My requests", url: env.ISSUER + "/requests" },
    });
    return mail.ok;
  }
  return false;
}
