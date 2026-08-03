ALTER TABLE report_code_hints
  DROP CONSTRAINT report_code_hints_outcome_check;

ALTER TABLE report_code_hints
  ADD CONSTRAINT report_code_hints_outcome_check
    CHECK (outcome IN (
      'matched',
      'no_match',
      'proven_absent',
      'terminal_unverifiable',
      'unverified_dropped'
    ));

-- Historical rows may contain hints which were explicitly unverified or
-- predate the verified key. Neither can remain attached to computed_at_sha.
WITH cleaned AS (
  SELECT report_id, hints AS original_hints,
    COALESCE((
      SELECT jsonb_agg(hint.value)
      FROM jsonb_array_elements(hints) hint(value)
      WHERE hint.value->>'verified' = 'true'
    ), '[]'::JSONB) AS verified_hints
  FROM report_code_hints
)
UPDATE report_code_hints stored SET
  hints = cleaned.verified_hints,
  outcome = CASE
    WHEN jsonb_array_length(cleaned.original_hints) > 0
      AND jsonb_array_length(cleaned.verified_hints) = 0
      THEN 'unverified_dropped'
    ELSE stored.outcome
  END
FROM cleaned
WHERE stored.report_id = cleaned.report_id;

ALTER TABLE report_code_hints
  ADD CONSTRAINT report_code_hints_verified_at_sha_check
    CHECK (jsonb_path_query_array(hints, '$[*] ? (@.verified == true)') = hints);

ALTER TABLE code_match_queue
  ADD COLUMN verification_retry_reason TEXT,
  ADD COLUMN verification_retry_content_sha TEXT,
  ADD COLUMN verification_retry_content_repo TEXT,
  ADD COLUMN verification_retry_file TEXT,
  ADD COLUMN verification_retry_required_content INTEGER,
  -- Transient noisy search candidates, deleted on settlement/retention and
  -- cleared on terminal dead letter. They prevent content retries from
  -- repeating the installation's scarce search calls.
  ADD COLUMN verification_retry_candidates JSONB;

ALTER TABLE code_match_queue
  ADD CONSTRAINT code_match_content_retry_state_check
    CHECK (
      (verification_retry_reason IS NULL
        AND verification_retry_content_sha IS NULL
        AND verification_retry_content_repo IS NULL
        AND verification_retry_file IS NULL
        AND verification_retry_required_content IS NULL
        AND verification_retry_candidates IS NULL)
      OR
      (verification_retry_reason = 'content_budget'
        AND verification_retry_sha IS NULL
        AND verification_retry_repo IS NULL
        AND verification_retry_content_sha ~ '^[a-f0-9]{40}$'
        AND LENGTH(BTRIM(verification_retry_content_repo)) > 0
        AND verification_retry_file IS NULL
        AND verification_retry_required_content > 0
        AND (verification_retry_candidates IS NULL
          OR jsonb_typeof(verification_retry_candidates) = 'object'))
      OR
      (verification_retry_reason = 'content_fetch'
        AND verification_retry_sha IS NULL
        AND verification_retry_repo IS NULL
        AND verification_retry_content_sha ~ '^[a-f0-9]{40}$'
        AND LENGTH(BTRIM(verification_retry_content_repo)) > 0
        AND LENGTH(BTRIM(verification_retry_file)) > 0
        AND verification_retry_required_content > 0
        AND jsonb_typeof(verification_retry_candidates) = 'object')
      );

DROP INDEX code_match_queue_claimable_idx;

CREATE INDEX code_match_queue_claimable_idx
  ON code_match_queue (enqueued_at, available_at, report_id)
  WHERE claimed_at IS NULL AND dead_lettered_at IS NULL;
