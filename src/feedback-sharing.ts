import type { Env } from "./config";
import { DEFAULT_UPSTREAM, upstreamRepo } from "./upstream";
import { outboundUrlProblem } from "./outbound";
import { feedbackText } from "./feedback";
import { validShared, validReply } from "./feedback-format";
import type { SharedReport, MaintainerReply } from "./feedback-format";
import { OpError } from "./ops-core";
import { randomToken } from "./util";
import { readBodyLimited } from "./http-body";

export function feedbackDestination(env: Env) {
  const repo = upstreamRepo(env);
  if (!repo) return null;
  const raw =
    env.FEEDBACK_INBOX_URL ??
    (repo === DEFAULT_UPSTREAM ? "https://edge-idp-feedback.twj.workers.dev" : null);
  if (!raw || raw === "off" || outboundUrlProblem(raw, env.ISSUER)) return null;
  const url = new URL(raw);
  return url.origin === raw ? url.origin : null;
}
export async function queueShare(env: Env, id: number, form: Record<string, unknown>) {
  const destination = feedbackDestination(env);
  if (!destination || destination !== form.destination)
    throw new OpError("The maintainer inbox has changed. Review the destination again.");
  const report = await env.DB.prepare("SELECT kind,server_version FROM feedback WHERE id=?")
    .bind(id)
    .first<Pick<SharedReport, "kind" | "server_version">>();
  if (!report) throw new OpError("Report not found.");
  const payload = {
    ...report,
    summary: feedbackText(form.summary, 200, true),
    tool_name: feedbackText(form.tool_name, 100),
  };
  if (!validShared(payload))
    throw new OpError(
      "Use a tool name with only letters, numbers, periods, underscores and hyphens.",
    );
  const bytes = JSON.stringify(payload);
  const [, read] = await env.DB.batch<{ payload: string; destination: string }>([
    env.DB.prepare(
      "INSERT INTO feedback_shares(feedback_id,destination,receipt,payload) VALUES(?,?,?,?) ON CONFLICT(feedback_id) DO NOTHING",
    ).bind(id, destination, randomToken(), bytes),
    env.DB.prepare("SELECT payload,destination FROM feedback_shares WHERE feedback_id=?").bind(id),
  ]);
  const row = read?.results[0];
  if (row?.payload !== bytes || row.destination !== destination)
    throw new OpError("A different preview has already been approved for this report.");
}
interface Share {
  feedback_id: number;
  destination: string;
  receipt: string;
  payload: string;
  remote_status: string | null;
  attempt: number;
}
class ReceiverError extends Error {}
async function fetchReply(job: Share): Promise<MaintainerReply> {
  const url = job.destination + "/v1/report",
    headers = { authorization: "Bearer " + job.receipt, "content-type": "application/json" };
  const init = { headers, redirect: "manual" as const };
  if (!job.remote_status) {
    const sent = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(5000),
      method: "PUT",
      body: job.payload,
    });
    await sent.body?.cancel();
    if (!sent.ok)
      throw new ReceiverError("Receiver returned HTTP " + sent.status + " during delivery.");
  }
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    await res.body?.cancel();
    throw new ReceiverError("Receiver returned HTTP " + res.status + " during the status check.");
  }
  const reply = JSON.parse(new TextDecoder().decode(await readBodyLimited(res, 8192)));
  if (!reply || !validReply(reply)) throw new ReceiverError("Receiver returned an invalid status.");
  return reply;
}
export async function syncFeedback(env: Env, id: number) {
  const destination = feedbackDestination(env);
  if (!destination) return;
  const db = env.DB;
  const job = await db
    .prepare(
      "UPDATE feedback_shares SET next_check=unixepoch()+120,attempt=attempt+1 WHERE feedback_id=? AND destination=? AND next_check<=unixepoch() RETURNING *",
    )
    .bind(id, destination)
    .first<Share>();
  if (!job) return;
  let reply: MaintainerReply;
  try {
    reply = await fetchReply(job);
  } catch (error) {
    const reason =
      error instanceof ReceiverError
        ? error.message
        : "Could not read the maintainer inbox response.";
    await db
      .prepare(
        "UPDATE feedback_shares SET last_error=?,next_check=unixepoch()+3600 WHERE feedback_id=? AND attempt=?",
      )
      .bind(reason + " Retry scheduled.", id, job.attempt)
      .run();
    return;
  }
  const interval = ["done", "declined"].includes(reply.status) ? 86400 : 3600;
  await db
    .prepare(
      "UPDATE feedback_shares SET remote_status=?,reply=?,issue=?,last_error=NULL,next_check=unixepoch()+? WHERE feedback_id=? AND attempt=?",
    )
    .bind(reply.status, reply.reply, reply.issue, interval, id, job.attempt)
    .run();
}
export async function pollFeedback(env: Env) {
  const dst = feedbackDestination(env);
  if (!dst) return;
  const due = await env.DB.prepare(
    "SELECT feedback_id FROM feedback_shares WHERE destination=? AND next_check<=unixepoch() ORDER BY next_check,feedback_id LIMIT 12",
  )
    .bind(dst)
    .all<{ feedback_id: number }>();
  await Promise.all(due.results.map((r) => syncFeedback(env, r.feedback_id)));
}
