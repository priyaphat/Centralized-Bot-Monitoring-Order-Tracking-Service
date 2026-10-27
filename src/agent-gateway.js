import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export const agentEvents = new EventEmitter();

const botSockets = new Map();
const pendingCommands = new Map();

export function attachAgentSocket(socket) {
  const registeredBotIds = new Set();

  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === 'heartbeat' && Array.isArray(message.bots)) {
      for (const bot of message.bots) {
        botSockets.set(bot.id, socket);
        registeredBotIds.add(bot.id);
      }
      agentEvents.emit('heartbeat', message.bots);
      socket.send(JSON.stringify({ type: 'heartbeat.ack', at: new Date().toISOString() }));
    }

    if (message.type === 'command.result' && message.requestId) {
      const pending = pendingCommands.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingCommands.delete(message.requestId);
      if (message.ok) pending.resolve(message);
      else pending.reject(Object.assign(new Error(message.error || 'agent command failed'), { retryable: false }));
    }
  });

  socket.on('close', () => {
    for (const botId of registeredBotIds) {
      if (botSockets.get(botId) === socket) botSockets.delete(botId);
    }
  });
}

export function isAgentConnected(botId) {
  return botSockets.get(botId)?.readyState === 1;
}

export function sendAgentCommand(botId, command, timeoutMs = 2500) {
  const socket = botSockets.get(botId);
  if (!socket || socket.readyState !== 1) {
    throw Object.assign(new Error('bot agent websocket is not connected'), { code: 'agent_not_connected' });
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error('bot agent command timed out'));
    }, timeoutMs);
    pendingCommands.set(requestId, { resolve, reject, timer });
    socket.send(JSON.stringify({ type: 'command', requestId, botId, command }));
  });
}
