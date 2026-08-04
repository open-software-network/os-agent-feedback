-- Bounded, request-derived facts observed by company-side HTTP adapters.
-- These records deliberately exclude credentials, cookies, request bodies,
-- full referrer URLs, and arbitrary headers. They follow interaction retention
-- through the cascading interaction foreign key.

CREATE TABLE customer_request_observations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  environment_id UUID NOT NULL,
  customer_id UUID,
  interaction_id UUID NOT NULL UNIQUE,
  client_ip TEXT CHECK (
    client_ip IS NULL OR char_length(client_ip) BETWEEN 2 AND 45
  ),
  request_method TEXT CHECK (
    request_method IS NULL OR request_method ~ '^[A-Z]{1,16}$'
  ),
  user_agent TEXT CHECK (
    user_agent IS NULL OR char_length(user_agent) BETWEEN 1 AND 512
  ),
  accept_language TEXT CHECK (
    accept_language IS NULL OR char_length(accept_language) BETWEEN 1 AND 256
  ),
  referrer_origin TEXT CHECK (
    referrer_origin IS NULL OR char_length(referrer_origin) BETWEEN 8 AND 300
  ),
  sec_ch_ua TEXT CHECK (
    sec_ch_ua IS NULL OR char_length(sec_ch_ua) BETWEEN 1 AND 512
  ),
  sec_ch_ua_platform TEXT CHECK (
    sec_ch_ua_platform IS NULL OR char_length(sec_ch_ua_platform) BETWEEN 1 AND 80
  ),
  sec_ch_ua_mobile TEXT CHECK (
    sec_ch_ua_mobile IS NULL OR sec_ch_ua_mobile IN ('?0', '?1')
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (product_id, workspace_id)
    REFERENCES products(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id, workspace_id, product_id)
    REFERENCES product_environments(id, workspace_id, product_id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id, workspace_id)
    REFERENCES customers(id, workspace_id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (interaction_id, workspace_id)
    REFERENCES interactions_v2(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX customer_request_observations_customer_observed_idx
  ON customer_request_observations (customer_id, observed_at DESC, id DESC)
  WHERE customer_id IS NOT NULL;

CREATE INDEX customer_request_observations_product_observed_idx
  ON customer_request_observations (product_id, observed_at DESC, id DESC);
