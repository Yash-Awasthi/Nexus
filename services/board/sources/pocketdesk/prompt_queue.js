/**
 * Prompt Queue — queued follow-ups for busy chats.
 *
 * Absorbed from 1code / ccpocket / oc-remote (queue the next prompt while the
 * agent is still working; drain automatically when the turn finishes).
 *
 * Server-side state so the phone can enqueue and walk away: when the chat's
 * state returns to "idle", the next queued prompt is sent automatically.
 */

const MAX_PER_CHAT = 50;

const queues = new Map(); // chatId -> [{ id, text, enqueuedAt }]
let nextId = 1;

export function enqueue(chatId, text) {
  const q = queues.get(chatId) ?? [];
  if (q.length >= MAX_PER_CHAT) {
    return { ok: false, error: `queue full (${MAX_PER_CHAT} prompts)` };
  }
  const item = { id: "q" + nextId++, text: String(text), enqueuedAt: Date.now() };
  q.push(item);
  queues.set(chatId, q);
  return { ok: true, item };
}

export function list(chatId) {
  return [...(queues.get(chatId) ?? [])];
}

/** Pop the oldest prompt (drain target). */
export function dequeue(chatId) {
  const q = queues.get(chatId);
  if (!q || !q.length) return null;
  const item = q.shift();
  if (!q.length) queues.delete(chatId);
  return item;
}

export function remove(chatId, promptId) {
  const q = queues.get(chatId);
  if (!q) return false;
  const idx = q.findIndex((p) => p.id === promptId);
  if (idx < 0) return false;
  q.splice(idx, 1);
  if (!q.length) queues.delete(chatId);
  return true;
}
