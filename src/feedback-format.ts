export const feedbackKinds = ["bug", "confusing", "missing", "slow", "idea", "question"] as const;
export const feedbackStates = ["new", "acknowledged", "planned", "done", "declined"] as const;
export interface SharedReport {
  kind: string;
  summary: string;
  tool_name: string;
  server_version: string;
}
export interface MaintainerReply {
  status: string;
  reply: string;
  issue: string;
}
export function validIssue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === "" || /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(value))
  );
}
export function validReply(raw: Partial<MaintainerReply>): raw is MaintainerReply {
  return (
    feedbackStates.some((s) => s === raw.status) &&
    typeof raw.reply === "string" &&
    raw.reply.length <= 1000 &&
    validIssue(raw.issue)
  );
}
export function validShared(raw: Partial<SharedReport>): raw is SharedReport {
  return (
    feedbackKinds.some((k) => k === raw.kind) &&
    typeof raw.summary === "string" &&
    raw.summary.trim().length > 0 &&
    raw.summary.length <= 200 &&
    typeof raw.tool_name === "string" &&
    /^[\w.-]{0,100}$/.test(raw.tool_name) &&
    typeof raw.server_version === "string" &&
    /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(raw.server_version)
  );
}
