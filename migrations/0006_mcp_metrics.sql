-- MCP tool call metrics for visibility into usage and performance.
CREATE TABLE mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  error TEXT,
  token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL
);
CREATE INDEX idx_mcp_calls_tool ON mcp_calls(tool_name, started_at);
CREATE INDEX idx_mcp_calls_time ON mcp_calls(started_at);
