-- A retiring signing key stays published (row id 'previous') until retire_at.
ALTER TABLE signing_keys ADD COLUMN retire_at INTEGER;
