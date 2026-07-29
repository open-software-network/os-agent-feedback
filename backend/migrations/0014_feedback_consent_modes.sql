ALTER TABLE workspaces
  DROP CONSTRAINT IF EXISTS workspaces_feedback_mode_check;

ALTER TABLE product_environments
  DROP CONSTRAINT IF EXISTS product_environments_feedback_mode_check;

UPDATE workspaces
SET feedback_mode = 'ask_always'
WHERE feedback_mode = 'ask';

UPDATE product_environments
SET feedback_mode = 'ask_always'
WHERE feedback_mode = 'ask';

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_feedback_mode_check
  CHECK (feedback_mode IN ('auto', 'ask', 'ask_once', 'ask_always', 'off'));

ALTER TABLE product_environments
  ADD CONSTRAINT product_environments_feedback_mode_check
  CHECK (feedback_mode IN ('auto', 'ask', 'ask_once', 'ask_always', 'off'));

-- Keep the legacy `ask` value temporarily so an old pod can finish a rolling
-- deploy without failing writes. All current application paths normalize it
-- to `ask_always`; a later migration can remove it after old builds are gone.
