INSERT INTO oxide_bot_agents (id, name, device_name, status, accepting_orders)
VALUES
  ('bot-01', 'Oxide Bot 01', 'oxide-worker-01', 'online', true),
  ('bot-02', 'Oxide Bot 02', 'oxide-worker-02', 'online', false),
  ('bot-03', 'Oxide Bot 03', 'oxide-worker-03', 'offline', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (external_order_id, idempotency_key, status, amount, currency)
VALUES
  ('TEST-ORDER-001', 'seed-order-001', 'in_progress', 1250.00, 'THB'),
  ('TEST-ORDER-002', 'seed-order-002', 'pending_payment', 499.00, 'THB')
ON CONFLICT (external_order_id) DO NOTHING;
