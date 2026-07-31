-- Record the prior decision when a durable Ask-once consent decision changes,
-- so the dashboard can flag declined -> approved flips made through a
-- manageConsent handle without blocking them.
ALTER TABLE feedback_consent_subjects
  ADD COLUMN flipped_from TEXT
    CHECK (flipped_from IS NULL OR flipped_from IN ('approved', 'declined'));
