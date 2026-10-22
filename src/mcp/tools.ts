import { obj } from "./common";
import type { ToolDef } from "./common";
import { PEOPLE_TOOLS } from "./tools-people";
import { APP_TOOLS } from "./tools-apps";
import { ACCESS_TOOLS } from "./tools-access";

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function summarize(
  calls: { tool_name: string; duration_ms: number; success: number }[],
  errors: { tool_name: string; error: string; n: number }[],
) {
  const byTool = new Map<string, { durations: number[]; errors: number }>();
  for (const c of calls) {
    const t = byTool.get(c.tool_name) ?? { durations: [], errors: 0 };
    t.durations.push(c.duration_ms);
    if (c.success === 0) t.errors++;
    byTool.set(c.tool_name, t);
  }
  return [...byTool]
    .map(([tool, t]) => ({
      tool,
      calls: t.durations.length,
      errors: t.errors,
      latency_ms: {
        avg: Math.round(t.durations.reduce((a, b) => a + b, 0) / t.durations.length),
        p50: percentile(t.durations, 0.5),
        p95: percentile(t.durations, 0.95),
        max: t.durations[t.durations.length - 1] ?? 0,
      },
      top_errors: errors
        .filter((e) => e.tool_name === tool)
        .slice(0, 3)
        .map((e) => ({ error: e.error, n: e.n })),
    }))
    .sort((a, b) => b.calls - a.calls);
}

const METRICS_TOOL: ToolDef = {
  name: "metrics_summary",
  description:
    "MCP usage analytics for the last 24h: per-tool call counts, latency " +
    "(avg/p50/p95/max), error counts with top error messages, and execute " +
    "composition (avg inner tool calls per run, most-chained tools). " +
    "Use this to find slow tools, error-prone tools, and discoverability gaps.",
  inputSchema: obj(),
  write: false,
  handler: async ({ db }) => {
    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    const [calls, errors, execStats] = await Promise.all([
      db
        .prepare(
          `SELECT tool_name, duration_ms, success FROM mcp_calls
           WHERE started_at >= ?1 AND tool_name != 'execute' ORDER BY tool_name, duration_ms`,
        )
        .bind(dayAgo)
        .all<{ tool_name: string; duration_ms: number; success: number }>(),
      db
        .prepare(
          `SELECT tool_name, error, COUNT(*) AS n FROM mcp_calls
           WHERE started_at >= ?1 AND tool_name != 'execute' AND success = 0 AND error IS NOT NULL
           GROUP BY tool_name, error ORDER BY n DESC`,
        )
        .bind(dayAgo)
        .all<{ tool_name: string; error: string; n: number }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS runs FROM mcp_calls
           WHERE started_at >= ?1 AND tool_name = 'execute' AND success = 1`,
        )
        .bind(dayAgo)
        .first<{ runs: number }>(),
    ]);
    const perTool = summarize(calls.results, errors.results);
    return {
      window: "last 24h",
      per_tool: perTool,
      execute_runs: execStats?.runs ?? 0,
      most_chained_tools: perTool.slice(0, 5).map((t) => ({ tool_name: t.tool, n: t.calls })),
    };
  },
};

export const TOOLS: ToolDef[] = [...PEOPLE_TOOLS, ...APP_TOOLS, ...ACCESS_TOOLS, METRICS_TOOL];
