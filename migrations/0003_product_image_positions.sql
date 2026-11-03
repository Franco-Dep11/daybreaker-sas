CREATE UNIQUE INDEX IF NOT EXISTS idx_product_images_position
ON product_images(product_id, position)
WHERE active = 1;