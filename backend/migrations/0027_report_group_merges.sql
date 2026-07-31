ALTER TABLE report_groups
  ADD COLUMN merged_into_group_key TEXT
    REFERENCES report_groups(group_key) ON DELETE SET NULL,
  ADD COLUMN merged_at TIMESTAMPTZ,
  ADD COLUMN merged_by TEXT;

CREATE INDEX report_groups_merged_into_idx
  ON report_groups (merged_into_group_key)
  WHERE merged_into_group_key IS NOT NULL;
