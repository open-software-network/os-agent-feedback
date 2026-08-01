-- Stable keyset order for high-volume dashboard pages. The existing two-column
-- indexes remain useful to older queries; these include the UUID tie-breaker
-- used by the feedback and session cursors.
CREATE INDEX interactions_v2_environment_occurred_id_idx
  ON interactions_v2 (environment_id, occurred_at DESC, id DESC);

CREATE INDEX sessions_v2_environment_last_seen_id_idx
  ON sessions_v2 (environment_id, last_seen_at DESC, id DESC);

CREATE INDEX feedback_reports_created_id_idx
  ON feedback_reports (created_at DESC, id DESC);
