import { pool, inTransaction } from '../db.js';
import { assertTransition } from '../state-machine.js';
import { getSystemEnabled } from './bots.js';
import { publish } from '../events.js';

export async function createOrder({ externalOrderId, amount = 0, currency = 'THB', idempotencyKey, actor }) {
  if (!externalOrderId || !idempotencyKey) {
    const error = new Error('externalOrderId and Idempotency-Key are required');
    error.statusCode = 400;
    error.code = 'missing_required_field';
    throw error;
  }
  if (!(await getSystemEnabled())) {
    const error = new Error('global kill-switch is active');
    error.statusCode = 409;
    error.code = 'system_disabled';
    throw error;
  }
  const result = await inTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idempotencyKey]);
    const previous = await client.query('SELECT * FROM orders WHERE idempotency_key=$1', [idempotencyKey]);
    if (previous.rowCount) return { order: previous.rows[0], idempotent: true };
    const inserted = await client.query(
      `INSERT INTO orders(external_order_id,status,amount,currency,idempotency_key)
       VALUES ($1,'pending_payment',$2,$3,$4) RETURNING *`,
      [externalOrderId, Number(amount), String(currency).toUpperCase(), idempotencyKey]
    );
    await client.query(
      `INSERT INTO order_events(order_id,event_type,payload) VALUES ($1,'order.created',$2)`,
      [inserted.rows[0].id, { actor }]
    );
    return { order: inserted.rows[0], idempotent: false };
  });
  publish('orders.changed');
  return result;
}

export async function transitionOrder(id, { status, botId, actor }) {
  const order = await inTransaction(async (client) => {
    const currentResult = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!currentResult.rowCount) {
      const error = new Error('order not found');
      error.statusCode = 404;
      error.code = 'order_not_found';
      throw error;
    }
    const current = currentResult.rows[0];
    assertTransition(current.status, status);
    if (status === 'in_progress') {
      if (!(await getSystemEnabled(client))) {
        const error = new Error('global kill-switch is active');
        error.statusCode = 409;
        error.code = 'system_disabled';
        throw error;
      }
      if (!botId) {
        const error = new Error('botId is required for in_progress');
        error.statusCode = 400;
        error.code = 'bot_required';
        throw error;
      }
      const bot = await client.query("SELECT id FROM oxide_bot_agents WHERE id=$1 AND status='online'", [botId]);
      if (!bot.rowCount) {
        const error = new Error('bot is not online');
        error.statusCode = 409;
        error.code = 'bot_unavailable';
        throw error;
      }
    }
    const updated = await client.query(
      `UPDATE orders SET status=$1,assigned_bot_id=COALESCE($2,assigned_bot_id),updated_at=now()
       WHERE id=$3 RETURNING *`,
      [status, botId || null, id]
    );
    await client.query(
      `INSERT INTO order_events(order_id,event_type,payload) VALUES ($1,'order.transitioned',$2)`,
      [id, { from: current.status, to: status, botId: botId || null, actor }]
    );
    await client.query(
      `INSERT INTO audit_logs(actor,action,target_type,target_id,metadata)
       VALUES ($1,'order.transition','order',$2,$3)`,
      [actor, String(id), { from: current.status, to: status, botId: botId || null }]
    );
    return updated.rows[0];
  });
  publish('orders.changed', { id: Number(id) });
  return order;
}

export async function dispatchOrder(id, { botId, actor }) {
  const order = await inTransaction(async (client) => {
    const currentResult = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
    if (!currentResult.rowCount) {
      const error = new Error('order not found');
      error.statusCode = 404;
      error.code = 'order_not_found';
      throw error;
    }
    const current = currentResult.rows[0];
    if (!['queued', 'delayed'].includes(current.status)) {
      const error = new Error('only queued or delayed orders can be dispatched');
      error.statusCode = 409;
      error.code = 'order_not_dispatchable';
      throw error;
    }
    if (!(await getSystemEnabled(client))) {
      const error = new Error('global kill-switch is active');
      error.statusCode = 409;
      error.code = 'system_disabled';
      throw error;
    }

    const botResult = botId
      ? await client.query(
          `SELECT id FROM oxide_bot_agents
           WHERE id=$1 AND status='online' AND accepting_orders=true
           FOR UPDATE`,
          [botId]
        )
      : await client.query(
          `SELECT b.id FROM oxide_bot_agents b
           WHERE b.status='online' AND b.accepting_orders=true
           ORDER BY (
             SELECT count(*) FROM orders o
             WHERE o.assigned_bot_id=b.id AND o.status='in_progress'
           ), b.last_heartbeat DESC NULLS LAST
           FOR UPDATE SKIP LOCKED LIMIT 1`
        );
    if (!botResult.rowCount) {
      const error = new Error('no active bot is available');
      error.statusCode = 409;
      error.code = 'no_bot_available';
      throw error;
    }

    const selectedBotId = botResult.rows[0].id;
    const updated = await client.query(
      `UPDATE orders SET status='in_progress',assigned_bot_id=$1,updated_at=now()
       WHERE id=$2 RETURNING *`,
      [selectedBotId, id]
    );
    await client.query(
      `INSERT INTO order_events(order_id,event_type,payload)
       VALUES ($1,'order.dispatched',$2)`,
      [id, { from: current.status, to: 'in_progress', botId: selectedBotId, actor }]
    );
    await client.query(
      `INSERT INTO audit_logs(actor,action,target_type,target_id,metadata)
       VALUES ($1,'order.dispatch','order',$2,$3)`,
      [actor, String(id), { botId: selectedBotId }]
    );
    return updated.rows[0];
  });
  publish('orders.changed', { id: Number(id), dispatched: true });
  return order;
}

export async function listOrders() {
  const { rows } = await pool.query(
    `SELECT o.*, COALESCE(json_agg(e ORDER BY e.created_at DESC) FILTER (WHERE e.id IS NOT NULL),'[]') AS timeline
     FROM orders o LEFT JOIN order_events e ON e.order_id=o.id
     GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100`
  );
  return rows;
}
