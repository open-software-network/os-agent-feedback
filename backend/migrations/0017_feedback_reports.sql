UPDATE interactions_v2
SET classification = 'unclassified', confirmation_method = NULL, updated_at = NOW()
WHERE confirmation_method = 'outcome_submission';

ALTER TABLE interactions_v2
  DROP CONSTRAINT interactions_v2_confirmation_method_check;

ALTER TABLE interactions_v2
  ADD CONSTRAINT interactions_v2_confirmation_method_check
  CHECK (confirmation_method IS NULL OR confirmation_method IN ('mcp', 'feedback_report'));

DROP TABLE outcomes_v2;

CREATE TABLE feedback_reports (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  interaction_id UUID NOT NULL UNIQUE REFERENCES interactions_v2(id) ON DELETE CASCADE,
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 8 AND 700),
  impact TEXT CHECK (impact IS NULL OR impact IN (
    'helped', 'helped_with_friction', 'neutral', 'hindered', 'blocked', 'unknown'
  )),
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(findings) = 'array'),
  workaround JSONB CHECK (workaround IS NULL OR jsonb_typeof(workaround) = 'object'),
  source TEXT NOT NULL DEFAULT 'customer_agent' CHECK (source = 'customer_agent'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX feedback_reports_workspace_created_idx
ON feedback_reports (workspace_id, created_at DESC);

CREATE INDEX feedback_reports_findings_idx
ON feedback_reports USING GIN (findings);
