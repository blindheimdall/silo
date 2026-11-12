// Silo-to-Silo Radio, version 2: a registry of peer silos, each with its own shared key.
// A transmission says which key signed it (a key id derived from the key, so it reveals nothing), and the receiver
// knows the sender from the key that checks out, never from what the message claims. Answers are signed too and
// carry the nonce of the question, so a reply cannot be forged, swapped or replayed.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const RADIO_VERSION = '2';
export const WINDOW_MS = 5 * 60_000;
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const keyId = key => hmac(key, 'silo-radio-key-id').slice(0, 16);
export const newKey = () => randomBytes(32).toString('base64url');
// Requests and replies are signed with different prefixes, so one can never be passed off as the other.
export const signRequest = (key, raw) => 'sha256=' + hmac(key, 'req\n' + raw);
export const signReply = (key, raw) => 'sha256=' + hmac(key, 'res\n' + raw);
export const checkRequest = (key, raw, sig) => same(signRequest(key, raw), String(sig || ''));
export const checkReply = (key, raw, sig) => same(signReply(key, raw), String(sig || ''));

export function checkKey(key) {
  const k = String(key ?? '').trim();
  if (k.length < 24 || k.length > 300) throw Object.assign(new Error('Use a shared key of 24 to 300 characters. Generate one and give the same key to the other silo.'), { status: 400 });
  return k;
}

// This computer or the local network (private IPv4 ranges, .local, .lan, .home.arpa, IPv6 unique and link-local).
// Plain http is allowed there: radio v3 signs every question and answer, so it cannot be forged on the way.
export function localNetwork(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || /\.(local|lan|home\.arpa)$/.test(h) || /^f[cd][0-9a-f]{2}:|^fe80:/.test(h)) return true;
  const ip = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/); if (!ip) return false;
  const [a, b] = [+ip[1], +ip[2]];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}
export function checkUrl(raw) {
  let text = String(raw || '').trim(), u;
  // An address written without http:// or https://: http on the local network, https anywhere else.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && /^(\[[0-9a-f:]+\]|localhost|[^\s/:]+\.[^\s/:]+)(:\d+)?(\/|$)/i.test(text)) text = (localNetwork(text.startsWith('[') ? text.slice(1, text.indexOf(']')) : text.replace(/[:/].*$/, '')) ? 'http://' : 'https://') + text;
  try { u = new URL(text); } catch { throw Object.assign(new Error('Give the address of the silo, like https://silo-7.example.com or http://192.168.1.20:3000.'), { status: 400 }); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localNetwork(u.hostname))) throw Object.assign(new Error('Use an https address. Plain http only works on this computer or the local network (like http://192.168.1.20:3000).'), { status: 400 });
  if (u.username || u.password || u.search || u.hash) throw Object.assign(new Error('Give the address without a name, password, query or #part.'), { status: 400 });
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/radio$/, '');
  return u.toString().replace(/\/+$/, '');
}

// A peer as kept in settings. Its key lives in the vault as radio:<id>.
export function cleanPeer(input, existing = {}) {
  const name = String(input.name ?? existing.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 40) throw Object.assign(new Error('Give the other silo a name of up to 40 characters.'), { status: 400 });
  const residents = (Array.isArray(input.residents) ? input.residents : String(input.residents ?? (existing.residents || []).join(',')).split(','))
    .map(s => String(s).trim()).filter(Boolean).slice(0, 50).map(s => s.slice(0, 60));
  const perHour = input.perHour === undefined ? (existing.perHour ?? 30) : Math.round(Number(input.perHour));
  if (!Number.isInteger(perHour) || perHour < 1 || perHour > 600) throw Object.assign(new Error('Allow between 1 and 600 messages an hour.'), { status: 400 });
  // Tokens a day its questions may use here, 0 for no limit.
  const tokensPerDay = input.tokensPerDay === undefined || input.tokensPerDay === '' ? (existing.tokensPerDay ?? 0) : Math.round(Number(input.tokensPerDay));
  if (!Number.isInteger(tokensPerDay) || tokensPerDay < 0 || tokensPerDay > 100_000_000) throw Object.assign(new Error('Tokens a day is a whole number, 0 for no limit.'), { status: 400 });
  return {
    id: existing.id || randomBytes(8).toString('hex'), name, url: checkUrl(input.url ?? existing.url),
    send: input.send === undefined ? existing.send !== false : input.send === true,
    receive: input.receive === undefined ? existing.receive !== false : input.receive === true,
    residents: [...new Set(residents)], perHour, tokensPerDay, ...(existing.publicKey && { publicKey: existing.publicKey }), ...(existing.dayUse && { dayUse: existing.dayUse }),
    created: existing.created || Date.now(), lastIn: existing.lastIn || null, lastOut: existing.lastOut || null,
  };
}

// The resident a transmission is for: exact name first, then exact role. Nothing partial, no fallback.
export function pickResident(agents, wanted, allowed = []) {
  const w = String(wanted || '').trim().toLowerCase();
  if (!w) return null;
  const open = allowed.length ? agents.filter(a => allowed.some(n => n.toLowerCase() === a.name.toLowerCase())) : agents;
  return open.find(a => a.name.toLowerCase() === w) || open.find(a => String(a.role || '').toLowerCase() === w) || null;
}

// Messages per peer per hour, and nonces seen per peer within the time window.
export class RadioGuard {
  constructor() { this.hits = new Map(); this.nonces = new Map(); }
  limited(peer, now = Date.now()) {
    const list = (this.hits.get(peer.id) || []).filter(t => now - t < 3_600_000);
    if (list.length >= peer.perHour) { this.hits.set(peer.id, list); return true; }
    list.push(now); this.hits.set(peer.id, list); return false;
  }
  replay(peer, nonce, now = Date.now()) {
    for (const [n, t] of this.nonces) if (now - t > 2 * WINDOW_MS) this.nonces.delete(n);
    const k = peer.id + ':' + nonce;
    if (this.nonces.has(k)) return true;
    this.nonces.set(k, now);
    if (this.nonces.size > 20_000) this.nonces.delete(this.nonces.keys().next().value);
    return false;
  }
  forget(peerId) { this.hits.delete(peerId); for (const k of this.nonces.keys()) if (k.startsWith(peerId + ':')) this.nonces.delete(k); }
}

// Reads at most max bytes of a response, so a peer cannot flood this silo with a huge answer.
export async function readLimited(res, max = 200_000) {
  const reader = res.body?.getReader(); if (!reader) return '';
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > max) { await reader.cancel().catch(() => {}); throw new Error('The other silo answered with too much data.'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}
