import { feedbackStates } from "../feedback-format";
import type { SharedReport, MaintainerReply } from "../feedback-format";
export interface InboxRow extends SharedReport, MaintainerReply {
  id: number;
  duplicate_of: number | null;
}
export function Inbox({ rows }: { rows: InboxRow[] }) {
  return (
    <main>
      <h1>Maintainer inbox</h1>
      {!rows.length && <p>No reports.</p>}
      {rows.map((r) => (
        <article key={r.id}>
          <h2>
            #{r.id} · {r.summary}
          </h2>
          <p>
            {r.kind} · v{r.server_version} {r.tool_name}
          </p>
          {r.duplicate_of && <p>Follows replies to #{r.duplicate_of}</p>}
          <form method="post" action={"/admin/maintainer/" + r.id}>
            <label>
              Status{" "}
              <select name="status">
                {feedbackStates.map((s) => (
                  <option key={s} selected={r.status === s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reply visible to reporters{" "}
              <textarea name="reply" maxLength={1000}>
                {r.reply}
              </textarea>
            </label>
            <label>
              GitHub issue <input type="url" name="issue" value={r.issue} />
            </label>
            <label>
              Duplicate of report number{" "}
              <input type="number" name="duplicate_of" min="1" value={r.duplicate_of ?? ""} />
            </label>
            <button>Save reply</button>
          </form>
        </article>
      ))}
      {rows.length === 50 && <a href={"?before=" + rows.at(-1)?.id}>Older reports</a>}
    </main>
  );
}
