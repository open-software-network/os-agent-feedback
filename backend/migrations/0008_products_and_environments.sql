CREATE TABLE products (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, slug)
);

CREATE TABLE product_environments (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  feedback_mode TEXT NOT NULL DEFAULT 'auto' CHECK (feedback_mode IN ('auto', 'ask', 'off')),
  collect_event_summaries BOOLEAN NOT NULL DEFAULT FALSE,
  retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, slug),
  UNIQUE (id, workspace_id)
);

INSERT INTO products (id, workspace_id, name, slug, created_at, updated_at)
SELECT
  md5(w.id::text || ':legacy-product')::uuid,
  w.id,
  COALESCE(NULLIF(regexp_replace(w.name, '\s+workspace$', '', 'i'), ''), 'Existing product'),
  'existing-product',
  w.created_at,
  NOW()
FROM workspaces w;

INSERT INTO product_environments
  (id, workspace_id, product_id, name, slug, feedback_mode, collect_event_summaries,
   retention_days, created_at, updated_at)
SELECT
  md5(w.id::text || ':legacy-production')::uuid,
  w.id,
  md5(w.id::text || ':legacy-product')::uuid,
  'Production',
  'production',
  w.feedback_mode,
  FALSE,
  w.retention_days,
  w.created_at,
  NOW()
FROM workspaces w;

ALTER TABLE api_keys ADD COLUMN environment_id UUID REFERENCES product_environments(id) ON DELETE RESTRICT;
ALTER TABLE sessions_v2 ADD COLUMN environment_id UUID REFERENCES product_environments(id) ON DELETE RESTRICT;
ALTER TABLE interactions_v2 ADD COLUMN environment_id UUID REFERENCES product_environments(id) ON DELETE RESTRICT;

UPDATE api_keys k
SET environment_id = md5(k.workspace_id::text || ':legacy-production')::uuid;

UPDATE sessions_v2 s
SET environment_id = md5(s.workspace_id::text || ':legacy-production')::uuid;

UPDATE interactions_v2 i
SET environment_id = md5(i.workspace_id::text || ':legacy-production')::uuid;

ALTER TABLE api_keys ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE sessions_v2 ALTER COLUMN environment_id SET NOT NULL;
ALTER TABLE interactions_v2 ALTER COLUMN environment_id SET NOT NULL;

ALTER TABLE sessions_v2
  DROP CONSTRAINT IF EXISTS sessions_v2_workspace_id_source_ref_hash_key;
ALTER TABLE sessions_v2
  ADD CONSTRAINT sessions_v2_environment_source_ref_hash_key
  UNIQUE (environment_id, source, ref_hash);

CREATE INDEX products_workspace_created_idx
ON products (workspace_id, created_at);

CREATE UNIQUE INDEX products_workspace_name_unique_idx
ON products (workspace_id, LOWER(name));

CREATE INDEX product_environments_workspace_product_idx
ON product_environments (workspace_id, product_id, created_at);

CREATE UNIQUE INDEX product_environments_product_name_unique_idx
ON product_environments (product_id, LOWER(name));

CREATE INDEX api_keys_environment_created_idx
ON api_keys (environment_id, created_at DESC);

CREATE INDEX interactions_v2_environment_occurred_idx
ON interactions_v2 (environment_id, occurred_at DESC);

CREATE INDEX sessions_v2_environment_last_seen_idx
ON sessions_v2 (environment_id, last_seen_at DESC);
