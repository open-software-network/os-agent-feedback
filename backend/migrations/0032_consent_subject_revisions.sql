-- Ask-once decisions use a monotonic subject revision instead of database
-- arrival time. Existing standing decisions become revision 1; revision 0 is
-- reserved in signed capabilities to mean that the subject row was absent.
ALTER TABLE feedback_consent_subjects
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1
    CHECK (revision > 0);

-- Remember which subject revision a per-interaction decision actually
-- created. This keeps successful retries useful while distinguishing them
-- from stale CAS attempts, which must never reveal a report action.
ALTER TABLE feedback_consent_interactions
  ADD COLUMN applied_subject_revision BIGINT
    CHECK (applied_subject_revision IS NULL OR applied_subject_revision > 0);

-- A successful pre-migration decision used the interaction timestamp as the
-- subject timestamp. Preserve retry behavior for the still-current winner;
-- stale and superseded interactions intentionally remain unmarked.
UPDATE feedback_consent_interactions AS interaction
SET applied_subject_revision = subject.revision
FROM feedback_consent_subjects AS subject
WHERE interaction.environment_id = subject.environment_id
  AND interaction.subject = subject.subject
  AND interaction.decision = subject.decision
  AND interaction.decided_at = subject.decided_at;
