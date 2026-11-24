import { Hono } from "hono";
import type { AdminVars } from "./shell";
import { page, act } from "./shell";
import { feedbackDestination, queueShare, syncFeedback } from "../feedback-sharing";
import type { SharedReport } from "../feedback-format";

export const shareFeedback = new Hono<AdminVars>();
shareFeedback.get("/:id/share", async (c) => {
  const destination = feedbackDestination(c.env),
    id = Number(c.req.param("id"));
  if (!destination) return c.notFound();
  const report = await c.env.DB.prepare(
    "SELECT summary,tool_name,kind,server_version FROM feedback WHERE id=?",
  )
    .bind(id)
    .first<SharedReport>();
  if (!report) return c.notFound();
  return page(
    c,
    { title: "Share feedback", active: "feedback-inbox" },
    <section class="card card-body stack">
      <h1>Forward to the Edge IDP project</h1>
      <p>
        Only the four fields below will go to <strong>{destination}</strong>. Review the summary and
        remove names, addresses, credentials and sign-in links. The original details and local
        conversation stay here. The reporter can follow project replies on their Feedback page.
      </p>
      <p>Report type · {report.kind}</p>
      <p>Server version · {report.server_version}</p>
      <form method="post" class="stack" action={"/admin/feedback/" + id + "/share"}>
        <input type="hidden" name="destination" value={destination} />
        <label class="field">
          Summary{" "}
          <textarea name="summary" required maxLength={200}>
            {report.summary}
          </textarea>
        </label>
        <label class="field">
          Tool name (optional){" "}
          <input
            name="tool_name"
            maxLength={100}
            value={/^[\w.-]+$/.test(report.tool_name) ? report.tool_name : ""}
          />
        </label>
        <div class="row">
          <button class="btn primary">Forward summary to project</button>
          <a href="/admin/feedback">Cancel</a>
        </div>
      </form>
    </section>,
  );
});
shareFeedback.post("/:id/share", async (c) => {
  const form = await c.req.parseBody(),
    id = Number(c.req.param("id"));
  return act(
    c,
    "/admin/feedback",
    "Forwarding approved. Delivery and replies appear on the report.",
    async () => {
      await queueShare(c.env, id, form);
      await syncFeedback(c.env, id);
    },
  );
});
