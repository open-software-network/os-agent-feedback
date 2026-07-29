ALTER TABLE api_keys ADD COLUMN kind TEXT NOT NULL DEFAULT 'write'
  CHECK (kind IN ('write', 'read'));
