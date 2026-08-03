ALTER TABLE code_match_queue
  ADD COLUMN verification_retry_repo TEXT,
  ADD COLUMN verification_retry_count INTEGER NOT NULL DEFAULT 0
    CHECK (verification_retry_count >= 0);

-- Nullable for compatibility with pre-round-3 writers during rollout. Every
-- round-3 settlement writes one of these explicit outcomes.
ALTER TABLE report_code_hints
  ADD COLUMN outcome TEXT
    CHECK (outcome IN ('matched', 'no_match', 'proven_absent', 'terminal_unverifiable'));

-- Pre-0037 retry markers have no trustworthy repository provenance. Discard
-- them so the next claim starts fresh against the current product mapping.
UPDATE code_match_queue SET
  verification_retry_sha = NULL,
  verification_retry_count = 0,
  last_error = NULL,
  available_at = NOW()
WHERE verification_retry_sha IS NOT NULL;

ALTER TABLE code_match_queue
  ADD CONSTRAINT code_match_verification_retry_pair_check
    CHECK (
      (verification_retry_sha IS NULL) = (verification_retry_repo IS NULL)
    );
