import { limitArg, sinceArg } from "./util";
import { VERSION } from "./assets.gen";
import { OpError } from "./ops-core";

import { feedbackKinds, feedbackStates } from "./feedback-format";
export type FeedbackOwner = { user: string; credential: string };
export interface FeedbackRow {
  id: number;
  kind: string;
  summary: string;
  details: string;
  tool_name: string;
  server_version: string;
  status: string;
  note: string;
  created_at: number;
  reporter: string;
  shared: number;
  remote_status: string | null;
  reply: string | null;
  issue: string | null;
  last_error: string | null;
}
export function feedbackText(value: unknown, max: number, required = false) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim()))
    throw new OpError("Enter valid feedback text within the displayed limits.");
  return value.trim();
}
export function choice(value: unknown, options: readonly string[]) {
  if (typeof value !== "string" || !options.includes(value))
    throw new OpError("Choose one of the listed options.");
  return value;
}
export async function submitFeedback(
  db: D1Database,
  owner: FeedbackOwner,
  args: Record<string, unknown>,
) {
  const kind = choice(args.kind, feedbackKinds),
    summary = feedbackText(args.summary, 200, true),
    details = feedbackText(args.details, 4000),
    tool = feedbackText(args.tool_name, 100),
    key = feedbackText(args.idempotency_key, 128, true);
  const [, read] = await db.batch<FeedbackRow>([
    db
      .prepare(`INSERT INTO feedback(user_id,credential,retry_key,kind,summary,details,tool_name,server_version)
 SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE (SELECT count(*) FROM feedback WHERE user_id=?1 AND credential=?2 AND created_at>unixepoch()-3600)<20
 ON CONFLICT(user_id,credential,retry_key) DO NOTHING`)
      .bind(owner.user, owner.credential, key, kind, summary, details, tool, VERSION),
    db
      .prepare(
        "SELECT id,kind,summary,details,tool_name,status FROM feedback WHERE user_id=? AND credential=? AND retry_key=?",
      )
      .bind(owner.user, owner.credential, key),
  ]);
  const row = read?.results[0];
  if (!row) throw new OpError("Feedback limit reached. Try again in an hour.");
  if (
    row.kind !== kind ||
    row.summary !== summary ||
    row.details !== details ||
    row.tool_name !== tool
  )
    throw new OpError("This retry key belongs to a different report.");
  return { id: row.id, status: row.status };
}
export async function listFeedback(
  db: D1Database,
  owner: FeedbackOwner | null,
  before = 0,
  status = "all",
  opts: Record<string, unknown> = {},
) {
  const filters = ["(?1=0 OR id<?1)"];
  const values: (number | string)[] = [before];
  if (owner) {
    filters.push("user_id=?2 AND credential=?3");
    values.push(owner.user, owner.credential);
  }
  if (status === "open") filters.push("status NOT IN ('done','declined')");
  else if (status !== "all") {
    filters.push("status=?");
    values.push(choice(status, feedbackStates));
  }
  for (const column of ["kind", "tool_name"] as const) {
    if (opts[column] === undefined) continue;
    filters.push(column + "=?");
    values.push(feedbackText(opts[column], 100, true));
  }
  if (typeof opts.since_hours === "number") {
    filters.push("created_at>=?");
    values.push(sinceArg(opts.since_hours, 0));
  }
  values.push(limitArg(opts.limit, 50, 200));
  return (
    await db
      .prepare(
        `SELECT id,kind,summary,details,tool_name,server_version,status,note,created_at,CASE WHEN credential='member' THEN 'Member' ELSE 'Assistant' END reporter,(s.feedback_id IS NOT NULL) shared,s.remote_status,s.reply,s.issue,s.last_error FROM feedback LEFT JOIN feedback_shares s ON s.feedback_id=feedback.id WHERE ${filters.join(" AND ")} ORDER BY id DESC LIMIT ?`,
      )
      .bind(...values)
      .all<FeedbackRow>()
  ).results;
}
export async function triageFeedback(db: D1Database, id: number, state: unknown, text: unknown) {
  const status = choice(state, feedbackStates),
    note = feedbackText(text, 1000, status === "done" || status === "declined");
  const result = await db
    .prepare(
      "UPDATE feedback SET status=?,note=?,updated_at=unixepoch() WHERE id=? RETURNING id,status",
    )
    .bind(status, note, id)
    .first();
  if (!result) throw new OpError("Report not found.");
  return result;
}
