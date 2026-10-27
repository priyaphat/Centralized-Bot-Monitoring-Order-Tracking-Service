import { pool, inTransaction } from '../db.js';
import { config } from '../config.js';
import { withRetry } from '../retry.js';
import { publish } from '../events.js';
import { isAgentConnected, sendAgentCommand } from '../agent-gateway.js';

export async function syncBotsFromPayload(bots) {
  await inTransaction(async (client) => {
    for (const bot of bots) {
      await client.query(
        `INSERT INTO oxide_bot_agents
           (id, name, device_name, status, cpu_percent, memory_percent, uptime_seconds, last_heartbeat, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, device_name=EXCLUDED.device_name, status=EXCLUDED.status,
           cpu_percent=EXCLUDED.cpu_percent, memory_percent=EXCLUDED.memory_percent,
           uptime_seconds=EXCLUDED.uptime_seconds, last_heartbeat=now(), updated_at=now()`,
        [bot.id, bot.name, bot.deviceName, bot.status, bot.cpuPercent, bot.memoryPercent, bot.uptimeSeconds]
      );
    }
  });
  publish('bots.changed');
  return bots;
}

export async function syncBots() {
  const response = await fetch(`${config.simulatorUrl}/bots`, { signal: AbortSignal.timeout(2500) });
  if (!response.ok) throw new Error(`simulator returned ${response.status}`);
  const bots = await response.json();
  return syncBotsFromPayload(bots);
}

export async function getSystemEnabled(client = pool) {
  const { rows } = await client.query("SELECT value FROM system_settings WHERE key='system_enabled'");
  return rows[0]?.value?.enabled !== false;
}

export async function setSystemEnabled(enabled, actor) {
  await inTransaction(async (client) => {
    await client.query(
      `INSERT INTO system_settings (key, value, updated_at) VALUES ('system_enabled', $1, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [{ enabled }]
    );
    await client.query(
      `INSERT INTO audit_logs(actor,action,target_type,target_id,metadata)
       VALUES ($1,'system.toggle','system','global',$2)`,
      [actor, { enabled }]
    );
  });
  publish('system.changed', { enabled });
  return enabled;
}

export async function sendBotCommand(botId, command, requestedBy) {
  if (!['start', 'stop', 'restart', 'status'].includes(command)) {
    const error = new Error('command must be start, stop, restart, or status');
    error.statusCode = 400;
    error.code = 'invalid_command';
    throw error;
  }
  if ((command === 'start' || command === 'restart') && !(await getSystemEnabled())) {
    const error = new Error('global kill-switch is active');
    error.statusCode = 409;
    error.code = 'system_disabled';
    throw error;
  }

  const { rows } = await pool.query(
    `INSERT INTO oxide_bot_commands(bot_id,command,requested_by,status)
     VALUES ($1,$2,$3,'running') RETURNING *`,
    [botId, command, requestedBy]
  );
  const record = rows[0];
  try {
    const result = await withRetry(async () => {
      if (isAgentConnected(botId)) {
        const message = await sendAgentCommand(botId, command);
        return { ok: true, bot: message.bot, command, transport: 'websocket' };
      }
      const response = await fetch(`${config.simulatorUrl}/bots/${encodeURIComponent(botId)}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(2500)
      });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error || `simulator returned ${response.status}`), { retryable: response.status >= 500 });
      return { ...body, transport: 'rest-fallback' };
    }, { attempts: config.commandRetries });
    await pool.query(
      `UPDATE oxide_bot_commands SET status='success',result=$1,completed_at=now() WHERE id=$2`,
      [result, record.id]
    );
    if (command === 'start' || command === 'restart' || command === 'stop') {
      await pool.query(
        'UPDATE oxide_bot_agents SET accepting_orders=$1,updated_at=now() WHERE id=$2',
        [command !== 'stop', botId]
      );
    }
    await pool.query(
      `INSERT INTO audit_logs(actor,action,target_type,target_id,metadata)
       VALUES ($1,'bot.command','bot',$2,$3)`,
      [requestedBy, botId, { command, commandId: record.id, result: 'success' }]
    );
    await syncBots();
    publish('commands.changed', { botId });
    return { ...record, status: 'success', result };
  } catch (error) {
    await pool.query(
      `UPDATE oxide_bot_commands SET status='failed',result=$1,completed_at=now() WHERE id=$2`,
      [{ error: error.message }, record.id]
    );
    publish('commands.changed', { botId });
    throw error;
  }
}

export async function markStaleBots() {
  const seconds = Math.max(config.heartbeatTimeoutSeconds, 5);
  return inTransaction(async (client) => {
    const stale = await client.query(
      `UPDATE oxide_bot_agents SET status='offline',updated_at=now()
       WHERE last_heartbeat < now() - ($1 * interval '1 second') AND status <> 'offline'
       RETURNING id`,
      [seconds]
    );
    if (!stale.rowCount) return [];
    const ids = stale.rows.map((row) => row.id);
    const delayed = await client.query(
      `UPDATE orders SET status='delayed',updated_at=now()
       WHERE assigned_bot_id = ANY($1::text[]) AND status='in_progress' RETURNING id`,
      [ids]
    );
    for (const order of delayed.rows) {
      await client.query(
        `INSERT INTO order_events(order_id,event_type,payload) VALUES ($1,'heartbeat_timeout',$2)`,
        [order.id, { staleBotIds: ids }]
      );
    }
    publish('bots.changed');
    publish('orders.changed');
    return ids;
  });
}
