ALTER TABLE products
  ADD CONSTRAINT products_id_workspace_id_unique UNIQUE (id, workspace_id);

CREATE TABLE product_activation_milestones (
  product_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  first_opportunity_at TIMESTAMPTZ,
  first_confirmed_interaction_at TIMESTAMPTZ,
  first_report_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_activation_milestones_product_fkey
    FOREIGN KEY (product_id, workspace_id)
    REFERENCES products (id, workspace_id)
    ON DELETE CASCADE
);

-- Preserve every activation fact still recoverable at migration time. These
-- timestamps record only server-side acceptance history; no customer or
-- interaction content is copied into the durable milestone record.
INSERT INTO product_activation_milestones (
  product_id,
  workspace_id,
  first_opportunity_at,
  first_confirmed_interaction_at,
  first_report_at
)
SELECT
  product.id,
  product.workspace_id,
  MIN(interaction.created_at) FILTER (WHERE interaction.id IS NOT NULL),
  MIN(
    CASE
      WHEN interaction.classification <> 'confirmed' THEN NULL
      WHEN interaction.confirmation_method = 'feedback_report'
        THEN COALESCE(report.created_at, interaction.updated_at)
      ELSE interaction.created_at
    END
  ),
  MIN(report.created_at)
FROM products product
LEFT JOIN product_environments environment
  ON environment.product_id = product.id
 AND environment.workspace_id = product.workspace_id
LEFT JOIN interactions_v2 interaction
  ON interaction.environment_id = environment.id
 AND interaction.workspace_id = product.workspace_id
LEFT JOIN feedback_reports report
  ON report.interaction_id = interaction.id
 AND report.workspace_id = product.workspace_id
GROUP BY product.id, product.workspace_id;
