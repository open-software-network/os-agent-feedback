ALTER TABLE agent_sessions
  ADD COLUMN customer_ref TEXT,
  ADD COLUMN agent_version TEXT,
  ADD COLUMN agent_identity_source TEXT NOT NULL DEFAULT 'unknown'
    CHECK (agent_identity_source IN ('unknown', 'company_observed', 'agent_reported'));

UPDATE agent_sessions
SET agent_identity_source = 'company_observed'
WHERE agent_name NOT IN ('unknown-agent', 'unknown-customer-agent', 'anonymous-customer-agent');

