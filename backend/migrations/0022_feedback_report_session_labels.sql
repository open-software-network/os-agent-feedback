ALTER TABLE feedback_reports
  ADD COLUMN session_label TEXT
  CHECK (session_label IS NULL OR char_length(session_label) BETWEEN 2 AND 80);
