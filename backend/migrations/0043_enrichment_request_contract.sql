-- Immutable customer-context request contract.
ALTER TABLE enrichment_requests
  ADD COLUMN handler_owner TEXT
    CHECK (handler_owner IN ('company_mcp', 'same_origin_best_effort')),
  ADD COLUMN catalog_hash BYTEA CHECK (octet_length(catalog_hash) = 32),
  ADD COLUMN remember_allowed BOOLEAN,
  ADD COLUMN remembered_max_days INTEGER
    CHECK (remembered_max_days BETWEEN 0 AND 3650),
  ADD COLUMN unremembered_expires_at TIMESTAMPTZ;

-- Existing NULL rows are the explicit pre-contract bridge sentinel. The
-- application normalizes them from the original request/environment fields.
-- Backfill and NOT NULL contract constraints belong in a later contract
-- rollout, after all old writers have been retired.
