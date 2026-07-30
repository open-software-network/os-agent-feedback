CREATE TABLE feedback_consent_subjects (
  environment_id UUID NOT NULL REFERENCES product_environments(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'declined')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment_id, subject),
  CHECK (subject ~ '^afsub1_[A-Za-z0-9_-]{43}$')
);

CREATE TABLE feedback_consent_interactions (
  interaction_id UUID PRIMARY KEY,
  environment_id UUID NOT NULL REFERENCES product_environments(id) ON DELETE CASCADE,
  subject TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'declined')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (subject IS NULL OR subject ~ '^afsub1_[A-Za-z0-9_-]{43}$')
);

CREATE INDEX feedback_consent_interactions_environment_idx
  ON feedback_consent_interactions (environment_id, decided_at DESC);
