-- Add a semantic outcome beside the legacy answer status. Keeping this
-- nullable and unconstrained lets the previous application continue writing
-- and restart after expansion; new readers normalize NULL from legacy status.
ALTER TABLE enrichment_answers
  ADD COLUMN outcome TEXT;
