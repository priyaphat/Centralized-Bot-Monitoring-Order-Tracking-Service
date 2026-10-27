import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';

async function request(path, { method = 'GET', body, headers = {}, expected = 200 } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body instanceof FormData ? headers : { 'content-type': 'application/json', ...headers },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload;
}

function waitForMessage(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('timed out waiting for WebSocket event'));
    }, timeoutMs);
    function onMessage(raw) {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

test('complete Oxide Monitor flow', async (t) => {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const externalOrderId = `E2E-${runId}`;
  const idempotencyKey = `e2e-key-${runId}`;
  let orderId;
  let initiallyOnline = [];

  await t.test('TC01 services and dashboard are available', async () => {
    const health = await request('/api/health');
    assert.equal(health.ok, true);
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Oxide Bot Monitor/);
  });

  await t.test('TC02 dashboard WebSocket receives real-time events', async () => {
    const socket = new WebSocket(wsUrl);
    await once(socket, 'open');
    const event = waitForMessage(socket, (message) => message.type === 'system.changed');
    await request('/api/system/enabled', { method: 'POST', body: { enabled: true, actor: 'e2e' } });
    assert.equal((await event).payload.enabled, true);
    socket.close();
  });

  await t.test('TC03 at least three bots report heartbeat', async () => {
    const bots = await request('/api/bots?sync=true');
    assert.ok(bots.length >= 3);
    assert.ok(bots.every((bot) => bot.last_heartbeat));
    initiallyOnline = bots.filter((bot) => bot.status === 'online').map((bot) => bot.id);
    assert.ok(initiallyOnline.length > 0);
  });

  await t.test('TC04 bot command uses agent WebSocket', async () => {
    const result = await request(`/api/bots/${initiallyOnline[0]}/commands`, {
      method: 'POST', expected: 201,
      body: { command: 'status', requestedBy: 'e2e' }
    });
    assert.equal(result.status, 'success');
    assert.equal(result.result.transport, 'websocket');
  });

  await t.test('TC05 order creation is idempotent', async () => {
    const options = {
      method: 'POST', expected: 201,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { externalOrderId, amount: 199, currency: 'THB', actor: 'e2e' }
    };
    const first = await request('/api/orders', options);
    orderId = first.order.id;
    assert.equal(first.order.status, 'pending_payment');
    const duplicate = await request('/api/orders', { ...options, expected: 200 });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.order.id, orderId);
  });

  await t.test('TC06 order follows queue and automatic dispatch flow', async () => {
    const queued = await request(`/api/orders/${orderId}/transition`, {
      method: 'POST', body: { status: 'queued', actor: 'e2e' }
    });
    assert.equal(queued.status, 'queued');
    const dispatched = await request(`/api/orders/${orderId}/dispatch`, {
      method: 'POST', body: { actor: 'e2e' }
    });
    assert.equal(dispatched.status, 'in_progress');
    assert.ok(dispatched.assigned_bot_id);
  });

  await t.test('TC07 order completes and timeline is recorded', async () => {
    const completed = await request(`/api/orders/${orderId}/transition`, {
      method: 'POST', body: { status: 'completed', actor: 'e2e' }
    });
    assert.equal(completed.status, 'completed');
    const orders = await request('/api/orders');
    const order = orders.find((item) => String(item.id) === String(orderId));
    assert.ok(order);
    assert.ok(order.timeline.some((event) => event.event_type === 'order.created'));
    assert.ok(order.timeline.some((event) => event.event_type === 'order.dispatched'));
    assert.ok(order.timeline.some((event) => event.event_type === 'order.transitioned'));
  });

  await t.test('TC08 invalid state transition is rejected', async () => {
    const result = await request(`/api/orders/${orderId}/transition`, {
      method: 'POST', expected: 409, body: { status: 'in_progress', actor: 'e2e' }
    });
    assert.equal(result.error, 'invalid_state_transition');
  });

  await t.test('TC09 zip deployment supports selected bots', async () => {
    const form = new FormData();
    form.append('package', new Blob(['PK\u0003\u0004oxide-e2e'], { type: 'application/zip' }), 'oxide-e2e.zip');
    form.append('targetBotIds', JSON.stringify([initiallyOnline[0]]));
    form.append('actor', 'e2e');
    const deployment = await request('/api/deployments', { method: 'POST', expected: 201, body: form });
    assert.equal(deployment.status, 'success');
    assert.deepEqual(deployment.targetBotIds, [initiallyOnline[0]]);
  });

  await t.test('TC10 audit log contains command, dispatch, transition and deployment', async () => {
    const logs = await request('/api/audit-logs');
    const actions = new Set(logs.filter((log) => log.actor === 'e2e').map((log) => log.action));
    assert.ok(actions.has('bot.command'));
    assert.ok(actions.has('order.dispatch'));
    assert.ok(actions.has('order.transition'));
    assert.ok(actions.has('deployment.create'));
  });

  await t.test('TC11 kill-switch rejects new orders and bot starts', async () => {
    await request('/api/system/enabled', { method: 'POST', body: { enabled: false, actor: 'e2e' } });
    const rejectedOrder = await request('/api/orders', {
      method: 'POST', expected: 409,
      headers: { 'Idempotency-Key': `disabled-${runId}` },
      body: { externalOrderId: `DISABLED-${runId}`, amount: 1 }
    });
    assert.equal(rejectedOrder.error, 'system_disabled');
    const rejectedStart = await request(`/api/bots/${initiallyOnline[0]}/commands`, {
      method: 'POST', expected: 409, body: { command: 'start', requestedBy: 'e2e' }
    });
    assert.equal(rejectedStart.error, 'system_disabled');
  });

  await t.test('TC12 system can be restored after kill-switch', async () => {
    await request('/api/system/enabled', { method: 'POST', body: { enabled: true, actor: 'e2e' } });
    for (const botId of initiallyOnline) {
      const result = await request(`/api/bots/${botId}/commands`, {
        method: 'POST', expected: 201, body: { command: 'start', requestedBy: 'e2e-restore' }
      });
      assert.equal(result.status, 'success');
    }
  });
});
