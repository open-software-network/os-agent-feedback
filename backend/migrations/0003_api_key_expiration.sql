ALTER TABLE api_keys ADD COLUMN expires_at TIMESTAMPTZ;

CREATE INDEX api_keys_active_lookup
ON api_keys (key_hash)
WHERE revoked_at IS NULL;

