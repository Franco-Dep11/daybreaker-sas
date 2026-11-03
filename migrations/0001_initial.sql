CREATE TABLE products (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  short_description TEXT NOT NULL DEFAULT '', specifications TEXT NOT NULL DEFAULT '',
  retail_price_cents INTEGER NOT NULL CHECK (retail_price_cents > 0),
  availability TEXT NOT NULL CHECK (availability IN ('available','sold_out','on_request')),
  image_url TEXT, technical_pdf_url TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, tracking_token_hash TEXT NOT NULL, customer_name TEXT NOT NULL,
  email TEXT NOT NULL, phone TEXT NOT NULL, address TEXT NOT NULL, province TEXT NOT NULL,
  locality TEXT NOT NULL, postal_code TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents > 0),
  freight_cents INTEGER CHECK (freight_cents IS NULL OR freight_cents >= 0),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0), status TEXT NOT NULL,
  carrier TEXT NOT NULL DEFAULT '', shipment_tracking TEXT NOT NULL DEFAULT '',
  freight_accepted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE order_items (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), product_id TEXT,
  product_slug TEXT NOT NULL, product_name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0), line_total_cents INTEGER NOT NULL CHECK (line_total_cents > 0)
);
CREATE TABLE quotes (
  id TEXT PRIMARY KEY, company_name TEXT NOT NULL DEFAULT '', contact_name TEXT NOT NULL DEFAULT '',
  cuit TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, phone TEXT NOT NULL, destination TEXT NOT NULL,
  items_json TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','responded','closed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL CHECK (method IN ('transfer','mercadopago')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('pending_verification','pending','confirmed','failed')),
  provider_preference_id TEXT UNIQUE, checkout_url TEXT, provider_payment_id TEXT UNIQUE,
  created_at TEXT NOT NULL, confirmed_at TEXT
);
CREATE TABLE admin_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE order_events (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), event_type TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
CREATE INDEX idx_quotes_status_created ON quotes(status, created_at);
CREATE INDEX idx_payments_order ON payments(order_id, created_at);
