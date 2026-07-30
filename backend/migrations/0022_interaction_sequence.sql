ALTER TABLE interactions_v2
  ADD COLUMN client_sequence BIGINT
  CHECK (client_sequence IS NULL OR client_sequence BETWEEN 1 AND 9007199254740991);

CREATE INDEX interactions_v2_session_timeline_idx
  ON interactions_v2 (session_id, occurred_at, client_sequence, id);
