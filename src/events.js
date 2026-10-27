import { EventEmitter } from 'node:events';

export const events = new EventEmitter();

export function publish(type, payload = {}) {
  events.emit('message', { type, payload, at: new Date().toISOString() });
}
