ALTER TABLE api_keys
  DROP CONSTRAINT api_keys_environment_id_fkey,
  ADD CONSTRAINT api_keys_environment_id_fkey
    FOREIGN KEY (environment_id) REFERENCES product_environments(id) ON DELETE CASCADE;

ALTER TABLE sessions_v2
  DROP CONSTRAINT sessions_v2_environment_id_fkey,
  ADD CONSTRAINT sessions_v2_environment_id_fkey
    FOREIGN KEY (environment_id) REFERENCES product_environments(id) ON DELETE CASCADE;

ALTER TABLE interactions_v2
  DROP CONSTRAINT interactions_v2_environment_id_fkey,
  ADD CONSTRAINT interactions_v2_environment_id_fkey
    FOREIGN KEY (environment_id) REFERENCES product_environments(id) ON DELETE CASCADE;
