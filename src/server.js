import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createApp } from './app.js';
import { config } from './config.js';
import { events } from './events.js';
import { markStaleBots, syncBots, syncBotsFromPayload } from './services/bots.js';
import { pool } from './db.js';
import { agentEvents, attachAgentSocket } from './agent-gateway.js';

pool.on('error', (error) => console.warn('Database connection error:', error.message));

const server = http.createServer(createApp());
const dashboardSockets = new WebSocketServer({ noServer: true });
const agentSockets = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const target = pathname === '/ws' ? dashboardSockets : pathname === '/agent-ws' ? agentSockets : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(request, socket, head, (webSocket) => target.emit('connection', webSocket, request));
});

agentSockets.on('connection', attachAgentSocket);
agentEvents.on('heartbeat', (bots) => {
  syncBotsFromPayload(bots).catch((error) => console.warn('Agent heartbeat failed:', error.message));
});

events.on('message', (message) => {
  const data = JSON.stringify(message);
  for (const client of dashboardSockets.clients) {
    if (client.readyState === 1) client.send(data);
  }
});

server.listen(config.port, '0.0.0.0', async () => {
  console.log(`Oxide Monitor listening on http://localhost:${config.port}`);
  try { await syncBots(); } catch (error) { console.warn('Initial simulator sync failed:', error.message); }
});

const timer = setInterval(async () => {
  try { await syncBots(); } catch (error) { console.warn('Simulator sync failed:', error.message); }
  try { await markStaleBots(); } catch (error) { console.warn('Heartbeat scan failed:', error.message); }
}, config.syncIntervalMs);
timer.unref();

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  clearInterval(timer);
  dashboardSockets.close();
  agentSockets.close();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
