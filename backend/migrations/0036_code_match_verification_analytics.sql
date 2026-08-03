ALTER TABLE code_match_queue
  ADD COLUMN verification_retry_sha TEXT
    CHECK (verification_retry_sha IS NULL OR verification_retry_sha ~ '^[a-f0-9]{40}$');

-- Append one row for each successfully settled queue attempt. Counts are
-- measured before ranking/deduplication, after pinned-content verification,
-- so every candidate belongs to exactly one outcome bucket.
CREATE TABLE code_match_verification_analytics (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  computed_at_sha TEXT NOT NULL CHECK (computed_at_sha ~ '^[a-f0-9]{40}$'),
  candidates_seen BIGINT NOT NULL CHECK (candidates_seen >= 0),
  dropped_as_absent BIGINT NOT NULL CHECK (dropped_as_absent >= 0),
  kept_verified BIGINT NOT NULL CHECK (kept_verified >= 0),
  kept_unverified BIGINT NOT NULL CHECK (kept_unverified >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (candidates_seen = dropped_as_absent + kept_verified + kept_unverified)
);

CREATE INDEX code_match_verification_analytics_report_created_idx
  ON code_match_verification_analytics (report_id, created_at DESC, id DESC);
