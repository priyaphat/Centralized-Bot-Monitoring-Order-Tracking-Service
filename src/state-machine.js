export const orderTransitions = Object.freeze({
  pending_payment: ['queued', 'cancelled'],
  queued: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'delayed', 'failed'],
  delayed: ['queued', 'in_progress', 'failed', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: []
});

export function canTransition(from, to) {
  return Boolean(orderTransitions[from]?.includes(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const error = new Error(`invalid order transition: ${from} -> ${to}`);
    error.statusCode = 409;
    error.code = 'invalid_state_transition';
    throw error;
  }
}
