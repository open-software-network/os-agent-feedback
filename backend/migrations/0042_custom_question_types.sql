-- Product-authored question types. This nullable expansion keeps the legacy
-- signal_type column valid for the immediately previous API image: old code
-- reads a custom question as the conservative preference fallback, while new
-- code prefers the exact product-authored type.

ALTER TABLE enrichment_field_definitions
  ADD COLUMN question_type TEXT CHECK (
    question_type IS NULL OR question_type ~ '^[a-z][a-z0-9_]{0,47}$'
  );
