import http from 'node:http';
import WebSocket from 'ws';

const bots = new Map([
  ['bot-01', { id: 'bot-01', name: 'Oxide Bot 01', deviceName: 'oxide-worker-01', status: 'online', cpuPercent: 18.4, memoryPercent: 41.2, uptimeSeconds: 86400 }],
  ['bot-02', { id: 'bot-02', name: 'Oxide Bot 02', deviceName: 'oxide-worker-02', status: 'online', cpuPercent: 7.1, memoryPercent: 33.8, uptimeSeconds: 4200 }],
  ['bot-03', { id: 'bot-03', name: 'Oxide Bot 03', deviceName: 'oxide-worker-03', status: 'offline', cpuPercent: 0, memoryPercent: 0, uptimeSeconds: 0 }]
]);

function send(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function executeCommand(botId, command) {
  const bot = bots.get(botId);
  if (!bot) return { ok: false, error: 'bot_not_found' };
  if (!['start', 'stop', 'restart', 'status'].includes(command)) return { ok: false, error: 'invalid_command' };
  if (command === 'start' || command === 'restart') bot.status = 'online';
  if (command === 'stop') { bot.status = 'offline'; bot.cpuPercent = 0; bot.memoryPercent = 0; }
  return { ok: true, bot, command };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && url.pathname === '/bots') return send(res, 200, [...bots.values()]);
  const match = url.pathname.match(/^\/bots\/([^/]+)\/commands$/);
  if (req.method === 'POST' && match) {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'invalid_json' }); }
    const result = executeCommand(match[1], payload.command);
    return send(res, result.ok ? 200 : result.error === 'bot_not_found' ? 404 : 400, result);
  }
  send(res, 404, { error: 'not_found' });
});

server.listen(process.env.PORT || 8788, '0.0.0.0', () => console.log('Bot Simulator listening on http://localhost:8788'));

const centralUrl = process.env.CENTRAL_WS_URL;
if (centralUrl) {
  let heartbeatTimer;
  function connectCentral() {
    const socket = new WebSocket(centralUrl);
    socket.on('open', () => {
      console.log(`Bot Simulator connected to Central Server at ${centralUrl}`);
      const heartbeat = () => socket.send(JSON.stringify({ type: 'heartbeat', bots: [...bots.values()] }));
      heartbeat();
      heartbeatTimer = setInterval(heartbeat, 2000);
    });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type !== 'command') return;
      const result = executeCommand(message.botId, message.command);
      socket.send(JSON.stringify({ type: 'command.result', requestId: message.requestId, ...result }));
    });
    socket.on('close', () => {
      clearInterval(heartbeatTimer);
      setTimeout(connectCentral, 1000).unref();
    });
    socket.on('error', () => socket.close());
  }
  connectCentral();
}
