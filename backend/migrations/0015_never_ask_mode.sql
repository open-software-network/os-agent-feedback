ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_feedback_mode_check;

ALTER TABLE product_environments
  DROP CONSTRAINT IF EXISTS product_environments_feedback_mode_check;

UPDATE workspaces
SET feedback_mode = 'never_ask'
WHERE feedback_mode = 'auto';

UPDATE product_environments
SET feedback_mode = 'never_ask'
WHERE feedback_mode = 'auto';

ALTER TABLE workspaces
  ALTER COLUMN feedback_mode SET DEFAULT 'never_ask',
  ADD CONSTRAINT workspaces_feedback_mode_check
  CHECK (feedback_mode IN ('never_ask', 'ask_once', 'ask_always', 'off'));

ALTER TABLE product_environments
  ALTER COLUMN feedback_mode SET DEFAULT 'never_ask',
  ADD CONSTRAINT product_environments_feedback_mode_check
  CHECK (feedback_mode IN ('never_ask', 'ask_once', 'ask_always', 'off'));
