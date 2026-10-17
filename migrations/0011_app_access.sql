-- App groups, per-app access grants with optional roles, and launcher favorites.
-- apps.allowed_groups stays so a rolled-back Worker keeps working; new code reads grants.
CREATE TABLE app_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

ALTER TABLE apps ADD COLUMN app_group_id TEXT REFERENCES app_groups(id) ON DELETE SET NULL;
ALTER TABLE apps ADD COLUMN slug TEXT;

-- One target (app or app group) and one subject (user, group or everyone) per grant.
CREATE TABLE app_grants (
  id TEXT PRIMARY KEY,
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  app_group_id TEXT REFERENCES app_groups(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  everyone INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((app_id IS NULL) != (app_group_id IS NULL)),
  CHECK ((user_id IS NOT NULL) + (group_id IS NOT NULL) + (everyone = 1) = 1)
);
CREATE INDEX idx_app_grants_app ON app_grants(app_id);
CREATE INDEX idx_app_grants_app_group ON app_grants(app_group_id);
CREATE INDEX idx_app_grants_user ON app_grants(user_id);
CREATE INDEX idx_app_grants_group ON app_grants(group_id);

CREATE TABLE app_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, app_id)
);

UPDATE apps SET slug = trim(lower(replace(replace(replace(name, ' ', '-'), '.', '-'), '/', '-')), '-')
WHERE slug IS NULL;

INSERT INTO app_grants (id, app_id, everyone, created_at)
SELECT lower(hex(randomblob(16))), id, 1, created_at FROM apps
WHERE client_id IS NULL AND (allowed_groups IS NULL OR allowed_groups = '[]');

INSERT INTO app_grants (id, app_id, group_id, created_at)
SELECT lower(hex(randomblob(16))), a.id, g.id, a.created_at
FROM apps a, json_each(a.allowed_groups) j
JOIN groups g ON g.name = j.value
WHERE a.client_id IS NULL AND a.allowed_groups IS NOT NULL;
