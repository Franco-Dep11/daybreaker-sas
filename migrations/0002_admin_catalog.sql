CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE subcategories (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (category_id, name),
  UNIQUE (category_id, slug)
);

ALTER TABLE products ADD COLUMN visible_in_store INTEGER NOT NULL DEFAULT 1 CHECK (visible_in_store IN (0,1));
ALTER TABLE products ADD COLUMN stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0);
ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES categories(id);
ALTER TABLE products ADD COLUMN subcategory_id TEXT REFERENCES subcategories(id);
ALTER TABLE products ADD COLUMN attributes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attributes_json));

CREATE TABLE product_images (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  url TEXT NOT NULL,
  object_key TEXT,
  alt_text TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 5),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_products_category_active ON products(category_id, active, visible_in_store);
CREATE INDEX idx_subcategories_category ON subcategories(category_id, name);
CREATE INDEX idx_product_images_product ON product_images(product_id, active, position);
CREATE UNIQUE INDEX idx_product_images_primary ON product_images(product_id) WHERE is_primary = 1 AND active = 1;

INSERT INTO product_images (id, product_id, url, alt_text, position, is_primary, active, created_at)
SELECT 'legacy-image-' || id, id, image_url, name, 0, 1, 1, created_at
FROM products
WHERE image_url IS NOT NULL AND trim(image_url) <> '';
