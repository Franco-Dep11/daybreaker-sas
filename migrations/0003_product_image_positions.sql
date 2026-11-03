CREATE UNIQUE INDEX idx_product_images_position
ON product_images(product_id, position)
WHERE active = 1;
