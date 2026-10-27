import express from 'express';
import multer from 'multer';
import { pool } from './db.js';
import { uploadDirectory, createDeployment } from './services/deployments.js';
import { createOrder, dispatchOrder, listOrders, transitionOrder } from './services/orders.js';
import { getSystemEnabled, sendBotCommand, setSystemEnabled, syncBots } from './services/bots.js';

const upload = multer({ dest: uploadDirectory, limits: { fileSize: 25 * 1024 * 1024 } });

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static('public'));

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'oxide-monitor' });
  });

  app.get('/api/summary', async (_req, res) => {
    const [enabled, bots, orders] = await Promise.all([
      getSystemEnabled(),
      pool.query(`SELECT count(*) FILTER (WHERE status='online')::int AS online,
                         count(*) FILTER (WHERE status='online' AND accepting_orders)::int AS active,
                         count(*) FILTER (WHERE status='online' AND NOT accepting_orders)::int AS standby FROM oxide_bot_agents`),
      pool.query("SELECT count(*) FILTER (WHERE status='in_progress')::int AS in_progress FROM orders")
    ]);
    res.json({ systemEnabled: enabled, ...bots.rows[0], ...orders.rows[0] });
  });

  app.get('/api/bots', async (req, res) => {
    if (req.query.sync === 'true') await syncBots();
    const { rows } = await pool.query(
      `SELECT b.*,
        (SELECT row_to_json(c) FROM oxide_bot_commands c WHERE c.bot_id=b.id ORDER BY c.created_at DESC LIMIT 1) AS last_command,
        (SELECT row_to_json(o) FROM orders o WHERE o.assigned_bot_id=b.id AND o.status IN ('completed','failed') ORDER BY o.updated_at DESC LIMIT 1) AS last_job
       FROM oxide_bot_agents b ORDER BY b.id`
    );
    res.json(rows);
  });
  app.post('/api/bots/sync', async (_req, res) => res.json(await syncBots()));
  app.post('/api/bots/:id/commands', async (req, res) => {
    const result = await sendBotCommand(req.params.id, req.body.command, req.body.requestedBy || 'dashboard');
    res.status(201).json(result);
  });
  app.get('/api/bots/:id/commands', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM oxide_bot_commands WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    res.json(rows);
  });

  app.post('/api/system/enabled', async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled_must_be_boolean' });
    const enabled = await setSystemEnabled(req.body.enabled, req.body.actor || 'dashboard');
    if (!enabled) {
      const { rows } = await pool.query("SELECT id FROM oxide_bot_agents WHERE status='online'");
      await Promise.allSettled(rows.map((bot) => sendBotCommand(bot.id, 'stop', req.body.actor || 'kill-switch')));
    }
    res.json({ enabled });
  });

  app.get('/api/orders', async (_req, res) => res.json(await listOrders()));
  app.post('/api/orders', async (req, res) => {
    const result = await createOrder({
      ...req.body,
      idempotencyKey: req.get('Idempotency-Key'),
      actor: req.body.actor || 'api'
    });
    res.status(result.idempotent ? 200 : 201).json(result);
  });
  app.post('/api/orders/:id/transition', async (req, res) => {
    res.json(await transitionOrder(req.params.id, { ...req.body, actor: req.body.actor || 'dashboard' }));
  });
  app.post('/api/orders/:id/dispatch', async (req, res) => {
    res.json(await dispatchOrder(req.params.id, { botId: req.body.botId, actor: req.body.actor || 'dashboard' }));
  });

  app.post('/api/deployments', upload.single('package'), async (req, res) => {
    let targetBotIds = [];
    try { targetBotIds = JSON.parse(req.body.targetBotIds || '[]'); } catch { return res.status(400).json({ error: 'invalid_target_bot_ids' }); }
    const deployment = await createDeployment({ file: req.file, targetBotIds, actor: req.body.actor || 'dashboard' });
    res.status(201).json(deployment);
  });
  app.get('/api/audit-logs', async (_req, res) => {
    const { rows } = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  });

  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.code || 'internal_error', message: error.message });
  });
  return app;
}
