ALTER TABLE orders ADD COLUMN idempotency_key_hash TEXT;
ALTER TABLE orders ADD COLUMN idempotency_fingerprint TEXT;
CREATE UNIQUE INDEX idx_orders_idempotency_key_hash
ON orders(idempotency_key_hash)
WHERE idempotency_key_hash IS NOT NULL;

ALTER TABLE payments ADD COLUMN active_request INTEGER NOT NULL DEFAULT 0 CHECK (active_request IN (0,1));
CREATE UNIQUE INDEX idx_payments_active_request
ON payments(order_id, method)
WHERE active_request = 1;
