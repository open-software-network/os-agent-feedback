UPDATE api_keys
SET expires_at = NOW() + INTERVAL '90 days'
WHERE expires_at IS NULL AND revoked_at IS NULL;

