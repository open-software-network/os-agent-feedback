UPDATE interactions_v2
SET classification = 'confirmed', confirmation_method = 'mcp', updated_at = NOW()
WHERE surface = 'mcp';

UPDATE interactions_v2
SET classification = 'unclassified', confirmation_method = NULL, updated_at = NOW()
WHERE surface IN ('http_json', 'http_html', 'http_headers');

UPDATE interactions_v2 i
SET classification = 'confirmed', confirmation_method = 'feedback_report', updated_at = NOW()
WHERE surface IN ('http_json', 'http_html', 'http_headers') AND EXISTS (
  SELECT 1 FROM feedback_reports r WHERE r.interaction_id = i.id
);

UPDATE interactions_v2 i
SET classification = 'confirmed', confirmation_method = 'feedback_report', updated_at = NOW()
WHERE surface = 'unknown' AND EXISTS (
  SELECT 1 FROM feedback_reports r WHERE r.interaction_id = i.id
);

DELETE FROM interactions_v2
WHERE surface = 'unknown' AND NOT EXISTS (
  SELECT 1 FROM feedback_reports r WHERE r.interaction_id = interactions_v2.id
);

ALTER TABLE interactions_v2
  ADD CONSTRAINT interactions_v2_evidence_consistency_check
  CHECK (
    (surface = 'mcp' AND classification = 'confirmed' AND confirmation_method = 'mcp')
    OR
    (surface IN ('http_json', 'http_html', 'http_headers') AND (
      (classification = 'unclassified' AND confirmation_method IS NULL)
      OR (classification = 'confirmed' AND confirmation_method = 'feedback_report')
    ))
    OR
    (surface = 'unknown' AND classification = 'confirmed' AND confirmation_method = 'feedback_report')
  ) NOT VALID;

ALTER TABLE interactions_v2
  VALIDATE CONSTRAINT interactions_v2_evidence_consistency_check;

CREATE INDEX IF NOT EXISTS feedback_reports_interaction_created_idx
  ON feedback_reports (interaction_id, created_at DESC);
