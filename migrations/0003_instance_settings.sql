-- Instance-wide settings (theme, etc.). Single-row-per-key store.
CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO instance_settings (key, value, updated_at)
VALUES ('theme', 'obsidian', strftime('%s', 'now'));
