import { Hono } from "hono";
import type { AdminVars } from "./shell";
import { fmt, p } from "./shell";

export const mcpMetricsAdmin = new Hono<AdminVars>();

mcpMetricsAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;

  const [perTool, recent, totals] = await Promise.all([
    db
      .prepare(
        `SELECT tool_name,
                COUNT(*) AS calls,
                SUM(success) AS ok,
                AVG(duration_ms) AS avg_ms,
                MAX(duration_ms) AS max_ms
         FROM mcp_calls WHERE started_at >= ?1
         GROUP BY tool_name ORDER BY calls DESC`,
      )
      .bind(dayAgo)
      .all<{
        tool_name: string;
        calls: number;
        ok: number;
        avg_ms: number;
        max_ms: number;
      }>(),
    db
      .prepare(
        `SELECT m.tool_name, m.started_at, m.duration_ms, m.success, m.error, t.name AS token_name
         FROM mcp_calls m LEFT JOIN api_tokens t ON t.id = m.token_id
         ORDER BY m.id DESC LIMIT 20`,
      )
      .bind()
      .all<{
        tool_name: string;
        started_at: number;
        duration_ms: number;
        success: number;
        error: string | null;
        token_name: string | null;
      }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors,
                AVG(duration_ms) AS avg_ms
         FROM mcp_calls WHERE started_at >= ?1`,
      )
      .bind(dayAgo)
      .first<{ total: number; errors: number; avg_ms: number }>(),
  ]);

  const errorRate =
    totals && totals.total > 0
      ? ((totals.errors / totals.total) * 100).toFixed(1)
      : "0";

  return await p(
    c,
    "mcp",
    "MCP Metrics",
    <>
      <h1>MCP Metrics</h1>
      <p class="muted small">Last 24 hours.</p>
      <div class="stat-grid">
        <div class="stat-card">
          <span class="stat-value">{totals?.total ?? 0}</span>
          <span class="muted small">Tool calls</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{errorRate}%</span>
          <span class="muted small">Error rate</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{Math.round(totals?.avg_ms ?? 0)}ms</span>
          <span class="muted small">Avg latency</span>
        </div>
      </div>
      <h2>By tool</h2>
      {perTool.results.length === 0 ? (
        <p class="muted small">No MCP calls in the last 24 hours.</p>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Calls</th>
                <th>Errors</th>
                <th>Avg ms</th>
                <th>Max ms</th>
              </tr>
            </thead>
            <tbody>
              {perTool.results.map((r) => (
                <tr key={r.tool_name}>
                  <td class="mono small">{r.tool_name}</td>
                  <td>{r.calls}</td>
                  <td class={r.calls - r.ok > 0 ? "status error" : ""}>
                    {r.calls - r.ok}
                  </td>
                  <td class="muted small">{Math.round(r.avg_ms)}ms</td>
                  <td class="muted small">{r.max_ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Recent calls</h2>
      {recent.results.length === 0 ? (
        <p class="muted small">No calls yet.</p>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Tool</th>
                <th>Token</th>
                <th>Latency</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.results.map((r, i) => (
                <tr key={i}>
                  <td class="muted small">{fmt(r.started_at)}</td>
                  <td class="mono small">{r.tool_name}</td>
                  <td class="muted small">{r.token_name ?? "—"}</td>
                  <td class="muted small">{r.duration_ms}ms</td>
                  <td class={r.success ? "muted small" : "status error"}>
                    {r.success ? "ok" : r.error ?? "error"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>,
  );
});
