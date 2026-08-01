-- Customer intelligence is additive to the existing interaction, session,
-- feedback, and consent contract. Existing v1 tables remain authoritative
-- while the application dual-writes the richer model.

-- Composite keys let every new foreign key carry the owning tenant alongside
-- the referenced identifier. UUIDs are globally unique already; these
-- constraints make cross-workspace wiring structurally impossible.
ALTER TABLE product_environments
  ADD CONSTRAINT product_environments_id_workspace_product_key
  UNIQUE (id, workspace_id, product_id);

ALTER TABLE interactions_v2
  ADD CONSTRAINT interactions_v2_id_workspace_id_key UNIQUE (id, workspace_id);

ALTER TABLE sessions_v2
  ADD CONSTRAINT sessions_v2_id_workspace_id_key UNIQUE (id, workspace_id);

ALTER TABLE feedback_reports
  ADD CONSTRAINT feedback_reports_id_workspace_id_key UNIQUE (id, workspace_id);

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_id_workspace_id_key UNIQUE (id, workspace_id);

CREATE TABLE customers (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('account', 'user', 'workspace', 'generic', 'anonymous')),
  identity_level TEXT NOT NULL
    CHECK (identity_level IN ('verified', 'pseudonymous', 'ephemeral')),
  identity_confidence DOUBLE PRECISION
    CHECK (identity_confidence IS NULL OR identity_confidence BETWEEN 0 AND 1),
  parent_customer_id UUID,
  merged_into_customer_id UUID,
  display_name TEXT CHECK (
    display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 160
  ),
  properties JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(properties) = 'object'),
  segments TEXT[] NOT NULL DEFAULT '{}'::TEXT[]
    CHECK (cardinality(segments) <= 50),
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (parent_customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (parent_customer_id),
  FOREIGN KEY (merged_into_customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE RESTRICT,
  CHECK (parent_customer_id IS NULL OR parent_customer_id <> id),
  CHECK (merged_into_customer_id IS NULL OR merged_into_customer_id <> id),
  CHECK (first_seen_at <= last_seen_at)
);

CREATE INDEX customers_workspace_last_seen_idx
  ON customers (workspace_id, last_seen_at DESC, id DESC)
  WHERE merged_into_customer_id IS NULL;

CREATE INDEX customers_workspace_identity_idx
  ON customers (workspace_id, identity_level, last_seen_at DESC)
  WHERE merged_into_customer_id IS NULL;

CREATE TABLE customer_identifiers (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'account_ref', 'user_ref', 'workspace_ref', 'customer_ref',
    'anonymous_ref', 'installation_ref'
  )),
  ref_hash BYTEA NOT NULL CHECK (octet_length(ref_hash) = 32),
  display_hint TEXT NOT NULL CHECK (char_length(display_hint) BETWEEN 1 AND 80),
  identity_level TEXT NOT NULL
    CHECK (identity_level IN ('verified', 'pseudonymous', 'ephemeral')),
  provenance TEXT NOT NULL CHECK (provenance IN (
    'company_authenticated', 'company_provided', 'first_party_anonymous',
    'companion_approved'
  )),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, product_id, kind, ref_hash),
  FOREIGN KEY (product_id, workspace_id)
    REFERENCES products(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE CASCADE,
  CHECK ((identity_level = 'verified') = (verified_at IS NOT NULL))
);

CREATE INDEX customer_identifiers_customer_idx
  ON customer_identifiers (workspace_id, customer_id, created_at);

CREATE TABLE customer_resolution_events (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  from_customer_id UUID NOT NULL,
  to_customer_id UUID NOT NULL,
  method TEXT NOT NULL CHECK (method IN (
    'company_deterministic', 'company_confirmed_suggestion'
  )),
  provenance TEXT NOT NULL CHECK (provenance IN (
    'company_authenticated', 'company_provided', 'companion_approved'
  )),
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  api_key_id UUID,
  actor_os_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (product_id, workspace_id)
    REFERENCES products(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (from_customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (to_customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (api_key_id, workspace_id)
    REFERENCES api_keys(id, workspace_id) ON DELETE SET NULL (api_key_id),
  CHECK (from_customer_id <> to_customer_id),
  CHECK ((api_key_id IS NULL) <> (actor_os_user_id IS NULL))
);

CREATE INDEX customer_resolution_events_product_created_idx
  ON customer_resolution_events (product_id, created_at DESC, id DESC);

ALTER TABLE interactions_v2
  ADD COLUMN customer_id UUID;

ALTER TABLE interactions_v2
  ADD CONSTRAINT interactions_v2_customer_workspace_fk
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id);

CREATE INDEX interactions_v2_customer_occurred_idx
  ON interactions_v2 (customer_id, occurred_at DESC, id DESC)
  WHERE customer_id IS NOT NULL;

CREATE TABLE consent_grants (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  customer_id UUID,
  subject TEXT NOT NULL CHECK (
    subject ~ '^afsub1_[A-Za-z0-9_-]{43}$'
    OR subject ~ '^afint1_[a-f0-9]{32}$'
  ),
  scope TEXT NOT NULL CHECK (scope IN (
    'share_outcome', 'share_preferences', 'remember_preferences',
    'personalize'
  )),
  state TEXT NOT NULL CHECK (state IN ('approved', 'declined', 'revoked')),
  basis TEXT NOT NULL CHECK (basis IN ('user_consent', 'provider_feedback_policy')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  decided_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (environment_id, subject, scope),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (environment_id, workspace_id, product_id)
    REFERENCES product_environments(id, workspace_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > decided_at)
);

CREATE INDEX consent_grants_customer_scope_idx
  ON consent_grants (customer_id, scope, updated_at DESC)
  WHERE customer_id IS NOT NULL;

CREATE TABLE consent_events (
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
    'share_outcome', 'share_preferences', 'remember_preferences',
    'personalize'
  )),
  prior_state TEXT CHECK (prior_state IS NULL OR prior_state IN (
    'approved', 'declined', 'revoked'
  )),
  state TEXT NOT NULL CHECK (state IN ('approved', 'declined', 'revoked')),
  basis TEXT NOT NULL CHECK (basis IN ('user_consent', 'provider_feedback_policy')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  source TEXT NOT NULL CHECK (source IN (
    'feedback_consent', 'companion', 'dashboard', 'migration'
  )),
  decided_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (environment_id, workspace_id, product_id)
    REFERENCES product_environments(id, workspace_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (consent_grant_id, workspace_id)
    REFERENCES consent_grants(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX consent_events_grant_created_idx
  ON consent_events (consent_grant_id, created_at DESC, id DESC);

CREATE TABLE customer_signals (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  customer_id UUID,
  session_id UUID,
  interaction_id UUID NOT NULL,
  feedback_report_id UUID,
  feature_key TEXT CHECK (
    feature_key IS NULL OR feature_key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'
  ),
  source_item_key TEXT NOT NULL CHECK (char_length(source_item_key) BETWEEN 1 AND 80),
  signal_type TEXT NOT NULL CHECK (signal_type IN (
    'outcome', 'intent', 'friction', 'preference', 'constraint',
    'feature_need', 'alternative_considered', 'workaround', 'satisfaction',
    'likelihood_to_reuse'
  )),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 3 AND 700),
  detail TEXT CHECK (detail IS NULL OR char_length(detail) BETWEEN 3 AND 700),
  attributes JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(attributes) = 'object'),
  provenance TEXT NOT NULL CHECK (provenance IN (
    'agent_reports_user_statement', 'agent_reports_current_task',
    'agent_inference', 'product_activity', 'company_assertion'
  )),
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  collection_basis TEXT NOT NULL CHECK (collection_basis IN (
    'required_product_data', 'provider_feedback_policy', 'user_consent'
  )),
  consent_grant_id UUID,
  consent_scope TEXT CHECK (consent_scope IS NULL OR consent_scope IN (
    'share_outcome', 'share_preferences', 'remember_preferences',
    'personalize'
  )),
  collected_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, feedback_report_id, source_item_key),
  FOREIGN KEY (product_id, workspace_id)
    REFERENCES products(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (interaction_id, workspace_id)
    REFERENCES interactions_v2(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, workspace_id)
    REFERENCES sessions_v2(id, workspace_id) ON DELETE SET NULL (session_id),
  FOREIGN KEY (feedback_report_id, workspace_id)
    REFERENCES feedback_reports(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (consent_grant_id, workspace_id)
    REFERENCES consent_grants(id, workspace_id) ON DELETE SET NULL (consent_grant_id),
  CHECK ((consent_grant_id IS NULL) = (consent_scope IS NULL)),
  CHECK (expires_at IS NULL OR expires_at > collected_at)
);

CREATE INDEX customer_signals_product_collected_idx
  ON customer_signals (product_id, collected_at DESC, id DESC);

CREATE INDEX customer_signals_customer_collected_idx
  ON customer_signals (customer_id, collected_at DESC, id DESC)
  WHERE customer_id IS NOT NULL;

CREATE INDEX customer_signals_type_collected_idx
  ON customer_signals (product_id, signal_type, collected_at DESC);
