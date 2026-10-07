import { Hono } from "hono";
import { nowSec } from "../util";
import type { AdminVars } from "./shell";
import { page } from "./shell";
import { Empty, PageHead, Time } from "../ui/components";
import { Icon } from "../ui/icons";

interface ToolRow {
  tool_name: string;
  calls: number;
  ok: number;
  avg_ms: number;
  max_ms: number;
}

function ByTool({ rows, maxCalls }: { rows: ToolRow[]; maxCalls: number }) {
  return (
    <section class="card">
      <div class="card-head">
        <h2>By tool</h2>
      </div>
      {rows.length ? (
        <ul class="list">
          {rows.map((r) => (
            <li key={r.tool_name} class="stack-sm top-client">
              <div class="row between">
                <span class="mono small">{r.tool_name}</span>
                <span class="muted small">
                  {r.calls} · {Math.round(r.avg_ms)}ms
                  {r.calls - r.ok ? ` · ${r.calls - r.ok} err` : ""}
                </span>
              </div>
              <div class="meter">
                <span data-w={String(Math.round((r.calls / maxCalls) * 10))}></span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="bot" title="No calls yet" />
      )}
    </section>
  );
}

export const metricsAdmin = new Hono<AdminVars>();

metricsAdmin.get("/", async (c) => {
  const db = c.env.DB;
  const dayAgo = nowSec() - 86400;
  const [perTool, recent, totals] = await Promise.all([
    db
      .prepare(
        `SELECT tool_name, COUNT(*) AS calls, SUM(success) AS ok, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms
         FROM mcp_calls WHERE started_at >= ?1 GROUP BY tool_name ORDER BY calls DESC`,
      )
      .bind(dayAgo)
      .all<{ tool_name: string; calls: number; ok: number; avg_ms: number; max_ms: number }>(),
    db
      .prepare(
        `SELECT m.tool_name, m.started_at, m.duration_ms, m.success, m.error, t.name AS token_name
         FROM mcp_calls m LEFT JOIN api_tokens t ON t.id = m.token_id ORDER BY m.id DESC LIMIT 25`,
      )
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
        `SELECT COUNT(*) AS total, SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors, AVG(duration_ms) AS avg_ms
         FROM mcp_calls WHERE started_at >= ?1`,
      )
      .bind(dayAgo)
      .first<{ total: number; errors: number | null; avg_ms: number | null }>(),
  ]);
  const total = totals?.total ?? 0;
  const errRate = total ? (((totals?.errors ?? 0) / total) * 100).toFixed(1) : "0";
  const maxCalls = Math.max(1, ...perTool.results.map((r) => r.calls));
  return await page(
    c,
    { active: "metrics", title: "MCP activity" },
    <>
      <PageHead
        title="MCP activity"
        lede="What AI assistants did through the admin API in the last 24 hours."
      />
      <div class="stack-lg">
        <div class="grid-3">
          <div class="card stat">
            <span class="k">
              <Icon name="bot" size="sm" />
              Tool calls
            </span>
            <span class="v">{total}</span>
          </div>
          <div class="card stat">
            <span class="k">
              <Icon name="alert" size="sm" />
              Error rate
            </span>
            <span class="v">{errRate}%</span>
          </div>
          <div class="card stat">
            <span class="k">
              <Icon name="clock" size="sm" />
              Avg latency
            </span>
            <span class="v">{Math.round(totals?.avg_ms ?? 0)} ms</span>
          </div>
        </div>
        <div class="grid-3">
          <ByTool rows={perTool.results} maxCalls={maxCalls} />
          <section class="card span-2">
            <div class="card-head">
              <h2>Recent calls</h2>
            </div>
            {recent.results.length ? (
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Caller</th>
                      <th>Time</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.results.map((r) => (
                      <tr key={`${r.tool_name}-${r.started_at}-${r.duration_ms}`}>
                        <td class="mono small">{r.tool_name}</td>
                        <td class="small">{r.token_name ?? <span class="muted">OAuth</span>}</td>
                        <td class="muted small nowrap">
                          <Time ts={r.started_at} /> · {r.duration_ms}ms
                        </td>
                        <td>
                          {r.success ? (
                            <span class="badge ok dot">OK</span>
                          ) : (
                            <span class="badge bad dot" title={r.error ?? ""}>
                              {(r.error ?? "Error").slice(0, 40)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="bot" title="Nothing yet">
                Connect an assistant from <a href="/admin/connect">Connect</a>.
              </Empty>
            )}
          </section>
        </div>
      </div>
    </>,
  );
});
