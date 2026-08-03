CREATE TABLE report_code_hints (
  report_id UUID PRIMARY KEY REFERENCES feedback_reports(id) ON DELETE CASCADE,
  computed_at_sha TEXT NOT NULL CHECK (computed_at_sha ~ '^[a-f0-9]{40}$'),
  hints JSONB NOT NULL CHECK (jsonb_typeof(hints) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE match_analytics (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES feedback_reports(id) ON DELETE CASCADE,
  calls_used INTEGER NOT NULL CHECK (calls_used > 0),
  rate_headroom BIGINT CHECK (rate_headroom IS NULL OR rate_headroom >= 0),
  hit BOOLEAN NOT NULL,
  latency_ms BIGINT NOT NULL CHECK (latency_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX match_analytics_report_created_idx
  ON match_analytics (report_id, created_at DESC, id DESC);

CREATE TABLE code_match_queue (
  report_id UUID PRIMARY KEY REFERENCES feedback_reports(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  claim_token UUID,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dead_lettered_at TIMESTAMPTZ,
  last_error TEXT,
  CHECK ((claimed_at IS NULL) = (claim_token IS NULL)),
  CHECK (dead_lettered_at IS NULL OR claimed_at IS NULL)
);

CREATE INDEX code_match_queue_claimable_idx
  ON code_match_queue (available_at, enqueued_at, report_id)
  WHERE claimed_at IS NULL AND dead_lettered_at IS NULL;
