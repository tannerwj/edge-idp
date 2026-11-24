import { feedbackKinds, feedbackStates } from "./feedback-format";
import { feedbackDestination } from "./feedback-sharing";
import { Hono } from "hono";
import type { Env } from "./config";
import { getSession } from "./session";
import { Time } from "./ui/components";
import { AppShell, uiFor } from "./ui/layout";
import { viewerOf } from "./account";
import { newId } from "./util";
import { OpError } from "./ops-core";
import { listFeedback, submitFeedback, triageFeedback } from "./feedback";
import type { FeedbackRow } from "./feedback";
import { act, field, page } from "./admin/shell";
import type { AdminVars } from "./admin/shell";

function Report({ row }: { row: FeedbackRow }) {
  return (
    <article class="card card-body">
      <h2>
        #{row.id} · {row.summary}
      </h2>
      <p>
        {row.reporter} · <Time ts={row.created_at} /> · {row.status} · {row.kind} · v
        {row.server_version}
        {row.tool_name && " · " + row.tool_name}
      </p>
      {row.details && <p>{row.details}</p>}
      {row.note && <p>Operator reply · {row.note}</p>}
      {!!row.shared && (
        <p>
          Maintainer inbox · {row.remote_status ?? "Pending delivery"}{" "}
          {row.reply && " · " + row.reply}{" "}
          {row.issue && (
            <a href={row.issue} rel="noreferrer">
              GitHub issue
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
    <AppShell ui={await uiFor(c)} viewer={viewerOf(session)} active="account" title="My feedback">
      <h1>My feedback</h1>
      <form class="card card-body stack" action="/feedback" method="post">
        <h2>Send feedback to this installation</h2>
        <input type="hidden" name="idempotency_key" value={newId()} />
        <label>
          Kind{" "}
          <select name="kind">
            {feedbackKinds.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <label>
          Summary <input required name="summary" maxLength={200} />
        </label>
        <label>
          Details <textarea name="details" maxLength={4000} />
        </label>
        <p>
          Describe the expected result or include a support reference. Leave out personal data,
          credentials and sign-in links. An operator can review and share an edited summary with the
          project maintainers.
        </p>
        <button>Submit feedback</button>
      </form>
      {rows.map((row) => (
        <Report key={row.id} row={row} />
      ))}
      <Older rows={rows} status="all" />
    </AppShell>,
  );
});
memberFeedback.post("/feedback", async (c) => {
  const session = await getSession(c);
  if (!session) return c.redirect("/login?next=/feedback");
  try {
    await submitFeedback(
      c.env.DB,
      { user: session.user.id, credential: "member" },
      await c.req.parseBody(),
    );
  } catch (e) {
    if (e instanceof OpError) return c.text(e.message, 400);
    throw e;
  }
  return c.redirect("/feedback", 303);
});
export const feedbackAdmin = new Hono<AdminVars>();
feedbackAdmin.get("/", async (c) => {
  const status = c.req.query("status") ?? "open";
  if (!["open", "all", ...feedbackStates].includes(status)) return c.text("Invalid filter", 400);
  const rows = await listFeedback(c.env.DB, null, Number(c.req.query("before")) || 0, status);
  return page(
    c,
    { active: "metrics", title: "Feedback inbox" },
    <>
      <h1>Feedback inbox</h1>
      {c.env.MAINTAINER_DB && <a href="/admin/maintainer">Maintainer inbox across installations</a>}
      <form>
        <label>
          Status{" "}
          <select name="status">
            {["open", "all", ...feedbackStates].map((k) => (
              <option key={k} selected={k === status}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <button>Filter</button>
      </form>
      {!rows.length && <p>No matching reports.</p>}
      {rows.map((row) => (
        <section key={row.id}>
          <Report row={row} />
          {!row.shared && feedbackDestination(c.env) && (
            <a href={"/admin/feedback/" + row.id + "/share"}>Review for maintainer inbox</a>
          )}
          <form action={"/admin/feedback/" + row.id} method="post" class="card card-body">
            <label>
              Status{" "}
              <select name="status">
                {feedbackStates.map((k) => (
                  <option key={k} selected={row.status === k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Operator reply{" "}
              <textarea name="note" maxLength={1000}>
                {row.note}
              </textarea>
            </label>
            <button>Update report</button>
          </form>
        </section>
      ))}
      <Older rows={rows} status={status} />
    </>,
  );
});
feedbackAdmin.post("/:id", async (c) => {
  const form = await c.req.parseBody();
  return act(c, "/admin/feedback", "Feedback updated", () =>
    triageFeedback(c.env.DB, Number(c.req.param("id")), field(form, "status"), field(form, "note")),
  );
});
