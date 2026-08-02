-- Thin customer-enrichment MVP. This migration is intentionally additive to
-- the v2 feedback and customer-intelligence foundation introduced in 0033.

ALTER TABLE consent_grants
  ADD COLUMN enrichment_purpose TEXT CHECK (
    enrichment_purpose IS NULL OR enrichment_purpose IN (
      'product_personalization', 'targeted_advertising'
    )
  );

ALTER TABLE consent_events
  ADD COLUMN enrichment_purpose TEXT CHECK (
    enrichment_purpose IS NULL OR enrichment_purpose IN (
      'product_personalization', 'targeted_advertising'
    )
  );

CREATE TABLE enrichment_consent_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  consent_grant_id UUID NOT NULL,
  subject TEXT NOT NULL CHECK (
    subject ~ '^afsub1_[A-Za-z0-9_-]{43}$'
    OR subject ~ '^afint1_[a-f0-9]{32}$'
  ),
  scope TEXT NOT NULL CHECK (scope IN (
    'share_preferences', 'remember_preferences', 'personalize'
  )),
  enrichment_purpose TEXT NOT NULL CHECK (enrichment_purpose IN (
    'product_personalization', 'targeted_advertising'
  )),
  prior_state TEXT CHECK (prior_state IS NULL OR prior_state IN (
    'approved', 'declined', 'revoked'
  )),
  state TEXT NOT NULL CHECK (state IN ('approved', 'declined', 'revoked')),
  basis TEXT NOT NULL CHECK (basis = 'user_consent'),
  revision BIGINT NOT NULL CHECK (revision > 0),
  source TEXT NOT NULL DEFAULT 'enrichment' CHECK (source = 'enrichment'),
  decided_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (environment_id, workspace_id, product_id)
    REFERENCES product_environments(id, workspace_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (consent_grant_id, workspace_id)
    REFERENCES consent_grants(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX enrichment_consent_events_grant_created_idx
  ON enrichment_consent_events (consent_grant_id, created_at DESC, id DESC);

CREATE TABLE enrichment_requests (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  interaction_id UUID NOT NULL,
  api_key_id UUID,
  customer_id UUID,
  surface TEXT NOT NULL CHECK (surface IN ('http_json', 'html', 'mcp')),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'product_personalization', 'targeted_advertising'
  )),
  remember BOOLEAN NOT NULL,
  consent_subject TEXT NOT NULL CHECK (
    consent_subject ~ '^afsub1_[A-Za-z0-9_-]{43}$'
    OR consent_subject ~ '^afint1_[a-f0-9]{32}$'
  ),
  expected_consent_revision BIGINT NOT NULL DEFAULT 0
    CHECK (expected_consent_revision >= 0),
  identity_level TEXT NOT NULL CHECK (identity_level IN (
    'verified', 'pseudonymous', 'ephemeral'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'consent_required', 'answer_ready', 'declined', 'answered',
    'no_relevant_context'
  )),
  operation TEXT NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 160),
  question_key TEXT NOT NULL CHECK (question_key ~ '^[a-z0-9][a-z0-9_.-]{0,79}$'),
  question TEXT NOT NULL CHECK (char_length(question) BETWEEN 8 AND 700),
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  capability_nonce_hash BYTEA NOT NULL CHECK (octet_length(capability_nonce_hash) = 32),
  expires_at TIMESTAMPTZ NOT NULL,
  answered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  UNIQUE (environment_id, interaction_id),
  FOREIGN KEY (environment_id, workspace_id, product_id)
    REFERENCES product_environments(id, workspace_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (interaction_id, workspace_id)
    REFERENCES interactions_v2(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (api_key_id, workspace_id)
    REFERENCES api_keys(id, workspace_id) ON DELETE SET NULL (api_key_id),
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id),
  CHECK (expires_at > created_at),
  CHECK ((state IN ('answered', 'no_relevant_context')) = (answered_at IS NOT NULL))
);

CREATE INDEX enrichment_requests_customer_created_idx
  ON enrichment_requests (customer_id, created_at DESC, id DESC)
  WHERE customer_id IS NOT NULL;

CREATE TABLE enrichment_answers (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  request_id UUID NOT NULL,
  interaction_id UUID NOT NULL,
  customer_id UUID,
  status TEXT NOT NULL CHECK (status IN (
    'answered', 'declined', 'no_relevant_context'
  )),
  payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  UNIQUE (request_id),
  FOREIGN KEY (product_id, workspace_id)
    REFERENCES products(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (request_id, workspace_id)
    REFERENCES enrichment_requests(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (interaction_id, workspace_id)
    REFERENCES interactions_v2(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id)
);

-- Keep enrichment proof separate from the older interaction evidence enum.
-- Dashboard/API reads project this proof as `confirmed/enrichment_answer`
-- without rewriting a live constraint during an additive rollout.
CREATE TABLE enrichment_interaction_confirmations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  interaction_id UUID NOT NULL UNIQUE,
  enrichment_answer_id UUID NOT NULL UNIQUE,
  method TEXT NOT NULL DEFAULT 'enrichment_answer'
    CHECK (method = 'enrichment_answer'),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (interaction_id, workspace_id)
    REFERENCES interactions_v2(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (enrichment_answer_id, workspace_id)
    REFERENCES enrichment_answers(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX enrichment_interaction_confirmations_workspace_confirmed_idx
  ON enrichment_interaction_confirmations (workspace_id, confirmed_at DESC, interaction_id);

-- Enrichment-specific hot-path fields live in a new side table. This keeps the
-- expansion migration from scanning, validating, or indexing customer_signals.
CREATE TABLE enrichment_signal_items (
  signal_id UUID PRIMARY KEY REFERENCES customer_signals(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  enrichment_answer_id UUID NOT NULL REFERENCES enrichment_answers(id) ON DELETE CASCADE,
  customer_id UUID,
  interaction_id UUID NOT NULL,
  item_index SMALLINT NOT NULL CHECK (item_index BETWEEN 1 AND 8),
  signal_key TEXT NOT NULL CHECK (signal_key ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
  signal_value TEXT NOT NULL CHECK (char_length(signal_value) BETWEEN 1 AND 80),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'product_personalization', 'targeted_advertising'
  )),
  provenance TEXT NOT NULL CHECK (provenance IN (
    'agent_reports_user_statement', 'agent_reports_current_task',
    'agent_inference', 'product_activity'
  )),
  remembered BOOLEAN NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (enrichment_answer_id, item_index),
  FOREIGN KEY (environment_id, workspace_id, product_id)
    REFERENCES product_environments(id, workspace_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (interaction_id, workspace_id)
    REFERENCES interactions_v2(id, workspace_id) ON DELETE CASCADE,
  CHECK (expires_at > collected_at)
);

CREATE INDEX enrichment_signal_items_environment_customer_key_idx
  ON enrichment_signal_items (
    environment_id, customer_id, signal_key, collected_at DESC, signal_id
  );

CREATE INDEX enrichment_signal_items_interaction_key_idx
  ON enrichment_signal_items (interaction_id, signal_key, collected_at DESC, signal_id);

CREATE INDEX enrichment_signal_items_answer_idx
  ON enrichment_signal_items (enrichment_answer_id, item_index);

CREATE TABLE customer_context_retrievals (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  customer_id UUID,
  interaction_id UUID,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'product_personalization', 'targeted_advertising'
  )),
  identity_level TEXT NOT NULL CHECK (identity_level IN (
    'verified', 'pseudonymous', 'ephemeral'
  )),
  context_version TEXT NOT NULL CHECK (char_length(context_version) BETWEEN 16 AND 120),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (environment_id, workspace_id, product_id)
    REFERENCES product_environments(id, workspace_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (interaction_id, workspace_id)
    REFERENCES interactions_v2(id, workspace_id) ON DELETE CASCADE,
  CHECK (customer_id IS NOT NULL OR interaction_id IS NOT NULL)
);

CREATE TABLE customer_context_retrieval_signals (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  retrieval_id UUID NOT NULL,
  signal_id UUID NOT NULL,
  PRIMARY KEY (retrieval_id, signal_id),
  FOREIGN KEY (retrieval_id, workspace_id)
    REFERENCES customer_context_retrievals(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (signal_id)
    REFERENCES customer_signals(id) ON DELETE CASCADE
);

CREATE TABLE personalization_decisions (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  retrieval_id UUID NOT NULL,
  interaction_id UUID,
  customer_id UUID,
  external_decision_id TEXT NOT NULL CHECK (
    char_length(external_decision_id) BETWEEN 1 AND 100
    AND external_decision_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$'
  ),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'product_personalization', 'targeted_advertising'
  )),
  variant TEXT CHECK (
    variant IS NULL OR (
      char_length(variant) BETWEEN 1 AND 100
      AND variant ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$'
    )
  ),
  payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, product_id, external_decision_id),
  FOREIGN KEY (environment_id, workspace_id, product_id)
    REFERENCES product_environments(id, workspace_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (retrieval_id, workspace_id)
    REFERENCES customer_context_retrievals(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (interaction_id, workspace_id)
    REFERENCES interactions_v2(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id)
);

CREATE TABLE personalization_decision_signals (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  decision_id UUID NOT NULL,
  signal_id UUID NOT NULL,
  PRIMARY KEY (decision_id, signal_id),
  FOREIGN KEY (decision_id, workspace_id)
    REFERENCES personalization_decisions(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (signal_id)
    REFERENCES customer_signals(id) ON DELETE CASCADE
);

CREATE TABLE personalization_outcomes (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  external_outcome_id TEXT NOT NULL CHECK (
    char_length(external_outcome_id) BETWEEN 1 AND 100
    AND external_outcome_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'conversion', 'completion', 'engagement', 'dismissal', 'abandonment'
  )),
  payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, product_id, external_outcome_id),
  FOREIGN KEY (product_id, workspace_id)
    REFERENCES products(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (decision_id, workspace_id)
    REFERENCES personalization_decisions(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX personalization_outcomes_decision_occurred_idx
  ON personalization_outcomes (decision_id, occurred_at DESC, id DESC);
