UPDATE products
SET name = 'Existing product', updated_at = NOW()
WHERE slug = 'existing-product';
