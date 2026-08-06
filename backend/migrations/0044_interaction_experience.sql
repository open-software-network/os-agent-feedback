-- Aggregate-safe experience-graph hop evidence and the agent→human handoff
-- marker. `experience` carries dimension keys and decision-quality numbers
-- only (see protocol/v1/telemetry-batch.schema.json); `customer_link_source`
-- persists the product_link_click proof that previously existed only as a
-- transient session-claim signal.
ALTER TABLE interactions_v2
  ADD COLUMN experience JSONB
    CHECK (experience IS NULL OR jsonb_typeof(experience) = 'object'),
  ADD COLUMN customer_link_source TEXT
    CHECK (customer_link_source IS NULL OR customer_link_source = 'product_link_click');

CREATE INDEX interactions_v2_environment_experience_idx
  ON interactions_v2 (environment_id, occurred_at DESC)
  WHERE experience IS NOT NULL;

CREATE INDEX interactions_v2_environment_link_source_idx
  ON interactions_v2 (environment_id, occurred_at DESC)
  WHERE customer_link_source IS NOT NULL;
