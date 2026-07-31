CREATE TABLE report_groups (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  grouper_name TEXT NOT NULL,
  grouper_version INTEGER NOT NULL,
  explanation TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX report_groups_key_idx ON report_groups (group_key);
CREATE INDEX report_groups_product_idx ON report_groups (product_id, updated_at DESC);

ALTER TABLE feedback_reports
  ADD COLUMN group_id UUID REFERENCES report_groups(id) ON DELETE SET NULL;

CREATE INDEX feedback_reports_group_idx ON feedback_reports (group_id, created_at DESC);
