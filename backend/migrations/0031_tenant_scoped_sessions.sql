ALTER TABLE sessions_v2
  ADD COLUMN customer_scope_hash BYTEA,
  ADD COLUMN raw_ref_hash BYTEA;

-- The three-column constraint is a rollout ABI: the production binary uses it
-- as an explicit ON CONFLICT arbiter. Keep it while encoding customer scope in
-- ref_hash; raw_ref_hash preserves the original correlation proof for reads.

CREATE TEMP TABLE epode_session_scope_map (
  old_session_id UUID NOT NULL,
  customer_scope_hash BYTEA NOT NULL,
  target_session_id UUID NOT NULL,
  PRIMARY KEY (old_session_id, customer_scope_hash),
  UNIQUE (target_session_id)
) ON COMMIT DROP;

WITH scopes AS (
  SELECT s.id AS old_session_id,
    sha256(convert_to(
      CASE
        WHEN i.customer_ref IS NULL THEN 'scope:anonymous'
        ELSE 'scope:customer:' || i.customer_ref
      END,
      'UTF8'
    )) AS customer_scope_hash
  FROM sessions_v2 s
  LEFT JOIN interactions_v2 i ON i.session_id = s.id
  GROUP BY s.id,
    CASE
      WHEN i.customer_ref IS NULL THEN 'scope:anonymous'
      ELSE 'scope:customer:' || i.customer_ref
    END
), ranked AS (
  SELECT old_session_id, customer_scope_hash,
    ROW_NUMBER() OVER (
      PARTITION BY old_session_id
      ORDER BY customer_scope_hash
    ) AS scope_rank
  FROM scopes
)
INSERT INTO epode_session_scope_map
  (old_session_id, customer_scope_hash, target_session_id)
SELECT old_session_id, customer_scope_hash,
  CASE WHEN scope_rank = 1 THEN old_session_id ELSE gen_random_uuid() END
FROM ranked;

INSERT INTO sessions_v2
  (id, workspace_id, environment_id, customer_scope_hash, source, ref_hash,
   raw_ref_hash, ref_hint, started_at, last_seen_at, created_at)
SELECT m.target_session_id, s.workspace_id, s.environment_id, m.customer_scope_hash,
  s.source, sha256(m.customer_scope_hash || s.ref_hash), s.ref_hash,
  s.ref_hint, s.started_at, s.last_seen_at, s.created_at
FROM epode_session_scope_map m
JOIN sessions_v2 s ON s.id = m.old_session_id
WHERE m.target_session_id <> m.old_session_id;

UPDATE sessions_v2 s
SET customer_scope_hash = m.customer_scope_hash,
  raw_ref_hash = s.ref_hash,
  ref_hash = sha256(m.customer_scope_hash || s.ref_hash)
FROM epode_session_scope_map m
WHERE m.old_session_id = s.id
  AND m.target_session_id = s.id;

UPDATE interactions_v2 i
SET session_id = m.target_session_id
FROM epode_session_scope_map m
WHERE i.session_id = m.old_session_id
  AND m.customer_scope_hash = sha256(convert_to(
    CASE
      WHEN i.customer_ref IS NULL THEN 'scope:anonymous'
      ELSE 'scope:customer:' || i.customer_ref
    END,
    'UTF8'
  ));

ALTER TABLE sessions_v2
  ALTER COLUMN customer_scope_hash SET DEFAULT
    decode('a907d38c2932af1bdae3f083ac2e5fb37ffc315e345bfad86f0cb487250b2347', 'hex'),
  ALTER COLUMN customer_scope_hash SET NOT NULL;
