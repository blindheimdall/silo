// Events that could not start their workflow (it was busy, paused or without power) wait in its pendingQueue, at most
// QUEUE_MAX. What happens to the others is counted in queueStats: skipped (the workflow skips while busy), merged (the
// same event was already waiting), dropped (the queue was full, the oldest goes) and gaveUp (five starts failed).
export const QUEUE_MAX = 15;
export const TRIGGER_WORD = {schedule: 'scheduled run', email: 'email', app: 'app event', file: 'file change', webhook: 'webhook'};

export function countLost(w, kind, detail = '', now = Date.now()) {
  const q = w.queueStats ||= {skipped: 0, merged: 0, dropped: 0, gaveUp: 0};
  q[kind] = (q[kind] || 0) + 1;
  if (kind !== 'merged') q.lastLost = {kind, time: now, detail: String(detail).slice(0, 160)};
}

// Returns whether the event waits now, and the events pushed out to make room for it.
export function enqueueTrigger(w, trigger, input, {now = Date.now(), id = () => Math.random().toString(36).slice(2)} = {}) {
  if (w.missedPolicy === 'skip') { countLost(w, 'skipped', TRIGGER_WORD[trigger] || trigger, now); return {queued: false, dropped: []}; }
  w.pendingQueue ||= [];
  if (w.missedPolicy !== 'queue' && w.pendingQueue.some(q => q.trigger === trigger && q.input === input)) { countLost(w, 'merged', '', now); return {queued: true, dropped: []}; }
  w.pendingQueue.push({id: id(), trigger, input, time: now});
  const dropped = w.pendingQueue.length > QUEUE_MAX ? w.pendingQueue.splice(0, w.pendingQueue.length - QUEUE_MAX) : [];
  for (const g of dropped) countLost(w, 'dropped', `${TRIGGER_WORD[g.trigger] || g.trigger} from ${new Date(g.time).toISOString()}`, now);
  return {queued: true, dropped};
}

// What the workflow card shows. why: the reason the events wait right now, from the server.
export function queueInfo(w, why = '') {
  const waiting = w.pendingQueue?.length || 0;
  return {waiting, oldest: w.pendingQueue?.[0]?.time || null, why: waiting ? why : '', max: QUEUE_MAX, skipped: 0, merged: 0, dropped: 0, gaveUp: 0, ...(w.queueStats || {})};
}
