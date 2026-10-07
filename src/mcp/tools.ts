/** The MCP tool catalog. `execute` is appended by sandbox.ts. */
import { obj } from "./common";
import type { ToolDef } from "./common";
import { PEOPLE_TOOLS } from "./tools-people";
import { APP_TOOLS } from "./tools-apps";

/** metrics_summary: per-tool calls, latency p50/p95, errors, execute composition. */
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
    const perTool = await db
      .prepare(
        `SELECT tool_name, COUNT(*) AS calls, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors,
                AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms
         FROM mcp_calls WHERE started_at >= ?1 AND tool_name != 'execute'
         GROUP BY tool_name ORDER BY calls DESC`,
      )
      .bind(dayAgo)
      .all<{ tool_name: string; calls: number; errors: number; avg_ms: number; max_ms: number }>();
    // p50/p95 need ordered values; fetch durations per tool (bounded).
    const withPercentiles = await Promise.all(
      perTool.results.map(async (r) => {
        const durs = await db
          .prepare(
            `SELECT duration_ms FROM mcp_calls
             WHERE started_at >= ?1 AND tool_name = ?2 ORDER BY duration_ms ASC LIMIT 1000`,
          )
          .bind(dayAgo, r.tool_name)
          .all<{ duration_ms: number }>();
        const vals = durs.results.map((d) => d.duration_ms).sort((a, b) => a - b);
        const pct = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * p))] : 0);
        const topErrors = await db
          .prepare(
            `SELECT error, COUNT(*) AS n FROM mcp_calls
             WHERE started_at >= ?1 AND tool_name = ?2 AND success = 0 AND error IS NOT NULL
             GROUP BY error ORDER BY n DESC LIMIT 3`,
          )
          .bind(dayAgo, r.tool_name)
          .all<{ error: string; n: number }>();
        return {
          tool: r.tool_name,
          calls: r.calls,
          errors: r.errors,
          latency_ms: {
            avg: Math.round(r.avg_ms),
            p50: pct(0.5),
            p95: pct(0.95),
            max: r.max_ms,
          },
          top_errors: topErrors.results,
        };
      }),
    );
    // Execute composition: how many inner calls per execute run.
    const execStats = await db
      .prepare(
        `SELECT COUNT(*) AS runs FROM mcp_calls
         WHERE started_at >= ?1 AND tool_name = 'execute' AND success = 1`,
      )
      .bind(dayAgo)
      .first<{ runs: number }>();
    const innerCalls = await db
      .prepare(
        `SELECT tool_name, COUNT(*) AS n FROM mcp_calls
         WHERE started_at >= ?1 AND tool_name != 'execute'
         GROUP BY tool_name ORDER BY n DESC LIMIT 5`,
      )
      .bind(dayAgo)
      .all<{ tool_name: string; n: number }>();
    return {
      window: "last 24h",
      per_tool: withPercentiles,
      execute_runs: execStats?.runs ?? 0,
      most_chained_tools: innerCalls.results,
    };
  },
};

export const TOOLS: ToolDef[] = [...PEOPLE_TOOLS, ...APP_TOOLS, METRICS_TOOL];
