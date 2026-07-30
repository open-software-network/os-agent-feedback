CREATE TABLE feedback_report_workflow (
  report_id UUID PRIMARY KEY REFERENCES feedback_reports(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'investigating', 'planned', 'resolved', 'wont_act')),
  assignee_os_user_id TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  internal_note TEXT,
  updated_by_os_user_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feedback_report_workflow (report_id, workspace_id)
SELECT id, workspace_id FROM feedback_reports
ON CONFLICT (report_id) DO NOTHING;

CREATE INDEX feedback_report_workflow_workspace_status_idx
  ON feedback_report_workflow (workspace_id, status, updated_at DESC);
