import { feedbackKinds, feedbackStates } from "./feedback-format";
import { feedbackDestination } from "./feedback-sharing";
import { Hono } from "hono";
import type { Env } from "./config";
import { getSession } from "./session";
import { Callout, Empty, PageHead, Time } from "./ui/components";
import { AppShell, uiFor } from "./ui/layout";
import { viewerOf } from "./account";
import { newId } from "./util";
import { OpError } from "./ops-core";
import { listFeedback, submitFeedback, triageFeedback } from "./feedback";
import type { FeedbackRow } from "./feedback";
import { act, field, page } from "./admin/shell";
import type { AdminVars } from "./admin/shell";

const kindLabels = {
  bug: "Something is broken",
  confusing: "Something is confusing",
  missing: "Something is missing",
  slow: "Something is slow",
  idea: "An idea",
  question: "A question",
};

function Report({ row }: { row: FeedbackRow }) {
  return (
    <article class="stack-sm" id={"report-" + row.id}>
      <div class="row">
        <span class="badge">{row.status}</span>
        <span class="muted">
          #{row.id} · {row.kind} · <Time ts={row.created_at} />
        </span>
      </div>
      <h3>{row.summary}</h3>
      <small class="muted">
        {row.reporter} · v{row.server_version}
        {row.tool_name && " · " + row.tool_name}
      </small>
      {row.details && <p>{row.details}</p>}
      {row.note && (
        <p>
          <strong>Your admin replied</strong> · {row.note}
        </p>
      )}
      {!row.shared && <small class="muted">Only on this installation</small>}
      {!!row.shared && (
        <p>
          <strong>Project feedback</strong> · {row.remote_status ?? "Waiting for delivery"}
          {row.reply && " · " + row.reply}{" "}
          {row.issue && (
            <a href={row.issue} rel="noreferrer">
              View GitHub issue
            </a>
          )}
        </p>
      )}
      {row.last_error && <p>{row.last_error}</p>}
    </article>
  );
}
function Older({ rows, status }: { rows: FeedbackRow[]; status: string }) {
  return rows.length === 50 ? (
    <a href={`?status=${encodeURIComponent(status)}&before=${rows.at(-1)?.id}`}>Older reports</a>
  ) : null;
}
export const memberFeedback = new Hono<{ Bindings: Env }>();
memberFeedback.get("/feedback", async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect("/login?next=/feedback");
  const rows = await listFeedback(
    c.env.DB,
    { user: session.user.id, credential: "member" },
    Number(c.req.query("before")) || 0,
  );
  return c.html(
    <AppShell
      ui={await uiFor(c)}
      viewer={viewerOf(session)}
      active="feedback"
      title="My feedback"
      narrow
    >
      <PageHead
        title="Feedback"
        lede="Send a problem, question, or idea to the admins who run this installation."
        actions={
          session.user.is_admin && (
            <a class="btn" href="/admin/feedback">
              Review local feedback
            </a>
          )
        }
      />
      {c.req.query("sent") && rows.some((row) => String(row.id) === c.req.query("sent")) && (
        <Callout tone="ok">Sent to your local admin. You can follow replies below.</Callout>
      )}
      <div class="stack-lg">
        <form class="card card-body stack" action="/feedback" method="post">
          <h2>Write to your local admin</h2>
          <input type="hidden" name="idempotency_key" value={newId()} />
          <label class="field">
            What is this about?{" "}
            <select name="kind">
              {feedbackKinds.map((k) => (
                <option key={k} value={k}>
                  {kindLabels[k]}
                </option>
              ))}
            </select>
          </label>
          <label class="field">
            Short summary <input required name="summary" maxLength={200} />
          </label>
          <label class="field">
            Details (optional) <textarea name="details" maxLength={4000} />
          </label>
          <p>
            Your report goes to your local admins. Leave out passwords, sign-in links, and personal
            details.
            {feedbackDestination(c.env) &&
              " If the project team can help, your admin can forward an edited summary."}
          </p>
          <div>
            <button class="btn primary">Send to local admin</button>
          </div>
        </form>
        <section class="stack">
          <h2>Your reports and replies</h2>
          {!rows.length && (
            <Empty icon="send" title="No feedback here yet">
              Feedback you send and replies from your admin appear here.
            </Empty>
          )}
          {rows.map((row) => (
            <div class="card card-body" key={row.id}>
              <Report row={row} />
            </div>
          ))}
        </section>
        <Older rows={rows} status="all" />
      </div>
    </AppShell>,
  );
});
memberFeedback.post("/feedback", async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect("/login?next=/feedback");
  try {
    const report = await submitFeedback(
      c.env.DB,
      { user: session.user.id, credential: "member" },
      await c.req.parseBody(),
    );
    return c.redirect("/feedback?sent=" + report.id, 303);
  } catch (e) {
    if (e instanceof OpError) return c.text(e.message, 400);
    throw e;
  }
});
export const feedbackAdmin = new Hono<AdminVars>();
feedbackAdmin.get("/", async (c) => {
  const status = c.req.query("status") ?? "open";
  if (!["open", "all", ...feedbackStates].includes(status)) return c.text("Invalid filter", 400);
  const rows = await listFeedback(c.env.DB, null, Number(c.req.query("before")) || 0, status);
  return page(
    c,
    { active: "feedback-inbox", title: "Local feedback inbox", narrow: true },
    <div class="stack">
      <PageHead
        title="Local feedback inbox"
        lede="Reply to people on this installation and track what needs attention."
      />
      {feedbackDestination(c.env) ? (
        <Callout>
          Need help from the Edge IDP project? Choose <strong>Preview what to forward</strong> on a
          report. You decide what the project team receives.
        </Callout>
      ) : (
        <Callout>
          Forwarding to the project is turned off for this installation. You can still reply
          locally.
        </Callout>
      )}
      <form class="row">
        <label class="field">
          Status{" "}
          <select name="status">
            {["open", "all", ...feedbackStates].map((k) => (
              <option key={k} selected={k === status}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <button class="btn">Filter</button>
      </form>
      {!rows.length && <p>No matching reports.</p>}
      {rows.map((row) => (
        <section class="card card-body stack" key={row.id}>
          <Report row={row} />
          {!row.shared && feedbackDestination(c.env) && (
            <div>
              <a class="btn" href={"/admin/feedback/" + row.id + "/share"}>
                Preview what to forward
              </a>
            </div>
          )}
          <form action={"/admin/feedback/" + row.id} method="post" class="stack">
            <label class="field">
              Status{" "}
              <select name="status">
                {feedbackStates.map((k) => (
                  <option key={k} selected={row.status === k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              Reply to the reporter{" "}
              <textarea name="note" maxLength={1000}>
                {row.note}
              </textarea>
            </label>
            <div>
              <button class="btn primary">Save local update</button>
            </div>
          </form>
        </section>
      ))}
      <Older rows={rows} status={status} />
    </div>,
  );
});
feedbackAdmin.post("/:id", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/feedback", "Feedback updated", () =>
    triageFeedback(c.env.DB, Number(c.req.param("id")), field(form, "status"), field(form, "note")),
  );
});
