import type { Context } from "hono";

export interface InboxBindings {
  DB: D1Database;
  AUTHORITY?: Fetcher;
  CONSOLE_AUD?: string;
  AGENT_AUD?: string;
}

export function hasAudience(c: Context, expected: string | undefined) {
  const ctx: Pick<ExecutionContext, "access" | "waitUntil"> = c.executionCtx;
  return !!expected && ctx.access?.aud === expected;
}
