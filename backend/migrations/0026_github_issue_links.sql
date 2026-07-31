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
  -- The installation that OWNS this issue's repository, pinned at filing time
  -- and used for every later call about this issue (comments, state refresh).
  -- Remapping the product to another repo/installation must not redirect
  -- traffic for an issue that already lives somewhere else.
  installation_id BIGINT NOT NULL,
  repo_full_name TEXT NOT NULL,
  -- NULL only while a filing is in flight; populated once GitHub responds.
  issue_number BIGINT,
  url TEXT,
  state TEXT,
  -- 'pending' claims the group for one filer BEFORE the GitHub call, so the
  -- primary key de-duplicates concurrent requests without holding a database
  -- connection across the network. A filer that dies mid-call leaves a stale
  -- 'pending' row, reclaimable after a short window.
  filing_state TEXT NOT NULL DEFAULT 'filed'
    CHECK (filing_state IN ('pending', 'filed')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT NOT NULL,
  last_commented_report_count BIGINT NOT NULL DEFAULT 0,
  state_refreshed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    filing_state = 'pending'
    OR (issue_number IS NOT NULL AND url IS NOT NULL AND state IS NOT NULL)
  )
);

-- Multiple NULL issue_numbers coexist (in-flight filings); the constraint only
-- binds once an issue number actually exists.
CREATE UNIQUE INDEX group_github_issues_repo_number_idx
  ON group_github_issues (repo_full_name, issue_number);
