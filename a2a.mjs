// Agent2Agent (A2A, protocol 0.3): agents from other frameworks find SILO by its Agent Card and send it tasks over
// JSON-RPC; residents can send tasks to outside agents too. This module holds the protocol: the card, tasks, their
// events, the JSON-RPC methods and the client. server.mjs decides who may do what and runs the work.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
export const A2A_VERSION = '0.3.0';
export const TERMINAL = new Set(['completed', 'canceled', 'failed', 'rejected']);
export const ERR = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603, taskNotFound: -32001, taskNotCancelable: -32002, pushNotSupported: -32003, unsupported: -32004, contentType: -32005 };

export class A2aError extends Error { constructor(code, message) { super(message); this.code = code; } }

export function agentCard({ name, description, url, version, skills, organization, siteUrl }) {
  return {
    protocolVersion: A2A_VERSION, name, description, url, preferredTransport: 'JSONRPC', version,
    ...(organization && { provider: { organization, url: siteUrl } }),
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'A SILO API token (silo_pat_...) with the read and run scopes.' } },
    security: [{ bearer: [] }],
    defaultInputModes: ['text/plain', 'application/json'], defaultOutputModes: ['text/plain'],
    skills,
  };
}

// The text of a message: its text parts, and its data parts as JSON. Files are not taken.
export function messageText(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.parts)) throw new A2aError(ERR.params, 'A message needs parts.');
  if (message.role !== 'user') throw new A2aError(ERR.params, 'Only messages with role "user" can be sent.');
  const out = [];
  for (const p of message.parts.slice(0, 50)) {
    const kind = p?.kind || p?.type;
    if (kind === 'text' && typeof p.text === 'string') out.push(p.text);
    else if (kind === 'data' && p.data !== undefined) out.push('```json\n' + JSON.stringify(p.data).slice(0, 20000) + '\n```');
    else throw new A2aError(ERR.contentType, 'Only text and data parts are accepted, not files.');
  }
  const text = out.join('\n\n').trim();
  if (!text) throw new A2aError(ERR.params, 'The message has no text.');
  if (text.length > 15000) throw new A2aError(ERR.params, 'The message is longer than 15,000 characters.');
  return text;
}
export const textPart = text => ({ kind: 'text', text: String(text ?? '') });
export const agentMessage = (text, task) => ({ kind: 'message', role: 'agent', messageId: randomUUID(), parts: [textPart(text)], ...(task && { taskId: task.id, contextId: task.contextId }) });

// Tasks live in memory: at most 300, each for a day after its last change. Every task belongs to whoever made it.
export class TaskStore extends EventEmitter {
  constructor({ max = 300, ttl = 24 * 3600_000 } = {}) { super(); this.setMaxListeners(200); this.tasks = new Map(); this.max = max; this.ttl = ttl; }
  create({ owner, contextId, skill, message }) {
    this.prune();
    const t = { kind: 'task', id: randomUUID(), contextId: typeof contextId === 'string' && /^[\w.:-]{1,100}$/.test(contextId) ? contextId : randomUUID(), status: { state: 'submitted', timestamp: new Date().toISOString() }, history: [message], artifacts: [], metadata: { skill } };
    Object.defineProperty(t, 'owner', { value: owner, enumerable: false });
    Object.defineProperty(t, 'touched', { value: Date.now(), enumerable: false, writable: true });
    this.tasks.set(t.id, t);
    return t;
  }
  get(id, owner) { const t = this.tasks.get(id); if (!t || t.owner !== owner) throw new A2aError(ERR.taskNotFound, 'Task not found.'); return t; }
  status(t, state, text) {
    if (TERMINAL.has(t.status.state)) return;
    t.status = { state, timestamp: new Date().toISOString(), ...(text && { message: agentMessage(text, t) }) };
    if (text) t.history.push(t.status.message);
    t.touched = Date.now();
    this.emit(t.id, { kind: 'status-update', taskId: t.id, contextId: t.contextId, status: t.status, final: TERMINAL.has(state) });
  }
  artifact(t, name, text) {
    const a = { artifactId: randomUUID(), name, parts: [textPart(text)] };
    t.artifacts.push(a); t.touched = Date.now();
    this.emit(t.id, { kind: 'artifact-update', taskId: t.id, contextId: t.contextId, artifact: a, lastChunk: true });
  }
  // The earlier turns of a conversation, for a follow-up in the same context.
  context(contextId, owner, limit = 20) {
    const turns = [];
    for (const t of this.tasks.values()) if (t.owner === owner && t.contextId === contextId && t.status.state === 'completed') turns.push(t);
    return turns.slice(-limit);
  }
  prune() {
    const now = Date.now();
    for (const [id, t] of this.tasks) if (TERMINAL.has(t.status.state) && now - t.touched > this.ttl) this.tasks.delete(id);
    while (this.tasks.size >= this.max) { const old = [...this.tasks.values()].filter(t => TERMINAL.has(t.status.state)).sort((a, b) => a.touched - b.touched)[0]; if (!old) throw new A2aError(ERR.internal, 'Too many tasks are running. Try again later.'); this.tasks.delete(old.id); }
  }
}
// A task as sent: history cut to the length asked for.
export function view(t, historyLength) {
  const n = Number.isInteger(historyLength) && historyLength >= 0 ? historyLength : undefined;
  return { ...t, history: n === undefined ? t.history : n === 0 ? [] : t.history.slice(-n) };
}

// --- Client: SILO residents sending tasks to outside agents ---
const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
export function checkAgentUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { throw new Error('That is not a valid address.'); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.includes(u.hostname))) throw new Error('Use an https address, or http on this computer only.');
  if (u.username || u.password) throw new Error('Put the token in its own field, not in the address.');
  u.hash = '';
  return u;
}
async function readLimited(res, max = 500_000) {
  const reader = res.body?.getReader(); if (!reader) return '';
  const chunks = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) { reader.cancel().catch(() => {}); throw new Error('The answer is too large.'); } chunks.push(value); }
  return Buffer.concat(chunks).toString('utf8');
}
// Finds the Agent Card from the address of the agent or of its card. The JSON-RPC address it gives must be on the same
// origin, so a card cannot send the token anywhere else.
export async function fetchCard(address, { fetch: f = fetch, timeout = 10000 } = {}) {
  const u = checkAgentUrl(address);
  const tries = /\.json$/i.test(u.pathname) ? [u.href] : [new URL('/.well-known/agent-card.json', u).href, new URL('/.well-known/agent.json', u).href];
  let last;
  for (const href of tries) {
    try {
      const r = await f(href, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (!r.ok) { last = new Error(`HTTP ${r.status} from ${href}`); continue; }
      const card = JSON.parse(await readLimited(r, 200_000));
      if (!card || typeof card.name !== 'string' || typeof card.url !== 'string') throw new Error('That is not an Agent Card: it needs a name and a url.');
      const end = checkAgentUrl(new URL(card.url, href).href);
      if (end.origin !== new URL(href).origin) throw new Error(`The card sends tasks to ${end.origin}, not to ${new URL(href).origin}. SILO only sends the token to the agent's own address.`);
      const skills = (Array.isArray(card.skills) ? card.skills : []).slice(0, 50).map(s => ({ id: String(s?.id || '').slice(0, 100), name: String(s?.name || s?.id || '').slice(0, 100), description: String(s?.description || '').slice(0, 300) })).filter(s => s.id);
      return { name: String(card.name).slice(0, 80), description: String(card.description || '').slice(0, 500), endpoint: end.href, cardUrl: href, version: String(card.protocolVersion || ''), streaming: !!card.capabilities?.streaming, skills };
    } catch (e) { last = e; if (/not an Agent Card|sends tasks to/.test(e.message)) throw e; }
  }
  throw new Error(`No Agent Card found: ${last?.message || 'no answer'}.`);
}
let rpcId = 0;
async function rpc(endpoint, token, method, params, { fetch: f = fetch, timeout = 60000, signal } = {}) {
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const r = await f(endpoint, { method: 'POST', redirect: 'error', signal: sig, headers: { 'content-type': 'application/json', accept: 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const text = await readLimited(r);
  let body; try { body = JSON.parse(text); } catch { throw new Error(`The agent answered HTTP ${r.status} without JSON.`); }
  if (body.error) throw new Error(`The agent refused: ${String(body.error.message || body.error.code).slice(0, 300)}`);
  if (!r.ok) throw new Error(`The agent answered HTTP ${r.status}.`);
  return body.result;
}
// The text an outside agent gave back: the artifacts of a task, or its last message.
export function resultText(result) {
  if (result?.kind === 'message') return (result.parts || []).map(p => p.text ?? (p.data !== undefined ? JSON.stringify(p.data) : '')).join('\n').trim();
  const arts = (result?.artifacts || []).flatMap(a => a.parts || []).map(p => p.text ?? (p.data !== undefined ? JSON.stringify(p.data) : '')).join('\n').trim();
  return arts || (result?.status?.message?.parts || []).map(p => p.text || '').join('\n').trim();
}
// Sends one message and waits for the task to end, up to `wait` ms. Returns {state, text, taskId, contextId}.
export async function sendTask({ endpoint, token, text, skill, contextId, wait = 300000, fetch: f = fetch, signal }) {
  const message = { kind: 'message', role: 'user', messageId: randomUUID(), parts: [textPart(text)], ...(contextId && { contextId }) };
  let res = await rpc(endpoint, token, 'message/send', { message, configuration: { blocking: true, acceptedOutputModes: ['text/plain', 'application/json'] }, ...(skill && { metadata: { skill } }) }, { fetch: f, signal, timeout: Math.min(wait, 120000) });
  const end = Date.now() + wait;
  while (res?.kind === 'task' && !TERMINAL.has(res.status?.state) && res.status?.state !== 'input-required' && res.status?.state !== 'auth-required') {
    if (Date.now() > end) throw new Error(`The outside agent did not finish in ${Math.round(wait / 1000)} seconds (task ${res.id}).`);
    if (signal?.aborted) { rpc(endpoint, token, 'tasks/cancel', { id: res.id }, { fetch: f }).catch(() => {}); throw signal.reason || new Error('Stopped.'); }
    await new Promise(r => setTimeout(r, 1500));
    res = await rpc(endpoint, token, 'tasks/get', { id: res.id }, { fetch: f, signal });
  }
  return { state: res?.kind === 'message' ? 'completed' : res?.status?.state || 'unknown', text: resultText(res), taskId: res?.kind === 'task' ? res.id : res?.taskId, contextId: res?.contextId };
}
