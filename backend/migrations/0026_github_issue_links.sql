CREATE TABLE product_github_repos (
  product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  path_prefix TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE group_github_issues (
  -- Deliberate privacy tradeoff: deleting the owning product/group also deletes
  -- Epode's repo/issue reference. The customer's GitHub issue remains untouched,
  -- while Epode does not retain customer repository metadata after product deletion.
  group_key TEXT PRIMARY KEY REFERENCES report_groups(group_key) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_full_name TEXT NOT NULL,
  issue_number BIGINT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  created_by TEXT NOT NULL,
  last_commented_report_count BIGINT NOT NULL DEFAULT 0,
  state_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX group_github_issues_repo_number_idx
  ON group_github_issues (repo_full_name, issue_number);
