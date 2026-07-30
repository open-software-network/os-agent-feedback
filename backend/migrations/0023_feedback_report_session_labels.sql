ALTER TABLE feedback_reports
    ADD COLUMN session_label TEXT;

ALTER TABLE feedback_reports
    ADD CONSTRAINT feedback_reports_session_label_length
    CHECK (
        session_label IS NULL
        OR char_length(session_label) BETWEEN 2 AND 80
    );
