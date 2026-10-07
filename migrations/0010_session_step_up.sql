-- A fresh, action-specific passkey assertion is needed before credential changes.
ALTER TABLE sessions ADD COLUMN step_up_at INTEGER;
