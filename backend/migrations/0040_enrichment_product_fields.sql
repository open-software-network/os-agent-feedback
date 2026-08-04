-- Product-scoped customer-context fields and per-request field snapshots.
--
-- A product may define its own closed field catalog (key, label, type,
-- allowed values, purpose and operation bindings). Once a product has at
-- least one enabled definition, that catalog replaces the built-in global
-- catalog for the product's enrichment requests. Each request stores an
-- immutable snapshot of the fields it may collect, so later definition edits
-- never change what an in-flight or historical request allowed.
--
-- Additive only: products without definitions keep the legacy global catalog
-- and legacy requests keep the process-global answer schema.

CREATE TABLE enrichment_field_definitions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  field_key TEXT NOT NULL CHECK (
    field_key ~ '^[a-z][a-z0-9_]{0,30}\.[a-z][a-z0-9_]{0,46}$'
  ),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 3 AND 120),
  signal_type TEXT NOT NULL CHECK (
    signal_type IN ('intent', 'preference', 'constraint')
  ),
  allowed_values TEXT[] NOT NULL CHECK (
    cardinality(allowed_values) BETWEEN 1 AND 32
  ),
  targeted_advertising_safe BOOLEAN NOT NULL DEFAULT FALSE,
  operations TEXT[] CHECK (
    operations IS NULL OR cardinality(operations) BETWEEN 1 AND 32
  ),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  UNIQUE (product_id, workspace_id, field_key),
  FOREIGN KEY (product_id, workspace_id)
    REFERENCES products(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX enrichment_field_definitions_product_idx
  ON enrichment_field_definitions (product_id, workspace_id, enabled, field_key);

CREATE TABLE enrichment_request_fields (
  request_id UUID NOT NULL,
  workspace_id UUID NOT NULL,
  catalog_version TEXT NOT NULL CHECK (catalog_version IN ('v1', 'product:v1')),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, workspace_id),
  FOREIGN KEY (request_id, workspace_id)
    REFERENCES enrichment_requests(id, workspace_id) ON DELETE CASCADE
);
