-- Problem reports and improvement ideas that agents file through the MCP feedback_submit tool.
CREATE TABLE mcp_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  admin_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  tool_name TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  server_version TEXT NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT
);
CREATE INDEX idx_mcp_feedback_time ON mcp_feedback(created_at);
