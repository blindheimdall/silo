// Personal API tokens: scripts, CI and other programs call /api/* with "Authorization: Bearer silo_pat_...".
// Only a SHA-256 of each token is kept, so the data folder cannot be used to sign in. A token acts as the person
// who made it, never with more rights: its scopes are cut to that person's role, now, on every request.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { roleAllows } from './vault.mjs';

export const TOKEN_PREFIX = 'silo_pat_';
export const SCOPES = {
  read: 'Read the state, residents, workflows, runs, traces and files',
  run: 'Talk to residents, run workflows and change residents, workflows and files',
  approve: 'Allow or deny tool requests, approve runs and save or discard proposed files',
  admin: 'Owner settings: connections, channels, connectors, audit log and system',
};
const ROLE_SCOPES = { viewer: ['read'], operator: ['read', 'run', 'approve'], owner: ['read', 'run', 'approve', 'admin'] };
// Never with a token: signing in and out, passwords, accounts, tokens, single sign-on and the key vault.
// A stolen token can then not make itself a new account or a new token that outlives it.
const NEVER = [/^\/api\/(login|logout|password)$/, /^\/api\/users(\/|$)/, /^\/api\/tokens(\/|$)/, /^\/api\/sso(\/|$)/, /^\/api\/vault(\/|$)/];
const APPROVE = [/^\/api\/requests\/[^/]+$/, /^\/api\/runs\/[^/]+\/approve$/, /^\/api\/proposals\/[^/]+$/, /^\/api\/(workflows|agents)\/[^/]+\/candidate$/];
// The MCP server and the A2A agent check each method against the token themselves, so getting in needs only read.
const SERVE = /^\/api\/serve\/(mcp|a2a)$/;
const MAX_PER_PERSON = 20;
const RATE = { windowMs: 60_000, max: 300 };

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const TOKEN_SHAPE = /^silo_pat_[A-Za-z0-9_-]{43}$/;

export const scopesForRole = role => ROLE_SCOPES[role] || [];

// The scope a request needs. Owner-only routes need admin; the rest is read, approve or run.
export function scopeFor(method, route) {
  if (NEVER.some(r => r.test(route))) return null;
  if (SERVE.test(route)) return 'read';
  if (!roleAllows('operator', method, route)) return 'admin';
  if (method === 'GET') return 'read';
  return APPROVE.some(r => r.test(route)) ? 'approve' : 'run';
}

export function bearerFrom(header) {
  if (header === undefined) return undefined;
  const m = /^Bearer ([^\s]+)$/.exec(String(header).trim());
  return m && TOKEN_SHAPE.test(m[1]) ? m[1] : null;
}

export class TokenStore {
  constructor(list) { this.list = list; this.hits = new Map(); }

  // Makes a token. The secret is returned once and never kept.
  create({ name, userId, role, scopes, days, anywhere }) {
    const label = String(name || '').trim().replace(/\s+/g, ' ');
    if (!label || label.length > 60) throw Object.assign(new Error('Give the token a name of up to 60 characters.'), { status: 400 });
    const allowed = scopesForRole(role);
    const wanted = [...new Set(Array.isArray(scopes) ? scopes : [])];
    if (!wanted.length || wanted.some(s => !Object.hasOwn(SCOPES, s))) throw Object.assign(new Error('Choose at least one of: ' + Object.keys(SCOPES).join(', ') + '.'), { status: 400 });
    const over = wanted.filter(s => !allowed.includes(s));
    if (over.length) throw Object.assign(new Error(`Your role cannot give a token ${over.join(' or ')}.`), { status: 403 });
    const life = days === 0 || days === null ? 0 : Number(days);
    if (![0, 7, 30, 90, 365].includes(life)) throw Object.assign(new Error('Choose 7, 30, 90 or 365 days, or no expiry.'), { status: 400 });
    if (this.list().filter(t => (t.userId || null) === (userId || null)).length >= MAX_PER_PERSON) throw Object.assign(new Error(`A person can have at most ${MAX_PER_PERSON} tokens. Revoke one first.`), { status: 409 });
    const secret = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const now = Date.now();
    const token = { id: randomBytes(12).toString('hex'), name: label, hash: sha256(secret), hint: secret.slice(0, TOKEN_PREFIX.length + 4), userId: userId || null,
      scopes: Object.keys(SCOPES).filter(s => wanted.includes(s)), anywhere: anywhere === true, created: now, expiresAt: life ? now + life * 86_400_000 : null, lastUsed: null, lastIp: null };
    this.list().push(token);
    return { token, secret };
  }

  // The token behind a secret, if it is still good. Every stored hash is compared in constant time.
  find(secret) {
    if (!secret) return null;
    const h = Buffer.from(sha256(secret), 'hex');
    let hit = null;
    for (const t of this.list()) if (timingSafeEqual(Buffer.from(t.hash, 'hex'), h)) hit = t;
    if (!hit || (hit.expiresAt && hit.expiresAt <= Date.now())) return null;
    return hit;
  }

  // At most RATE.max requests a minute per token.
  limited(token, now = Date.now()) {
    const w = this.hits.get(token.id);
    if (!w || now - w.start >= RATE.windowMs) { this.hits.set(token.id, { start: now, n: 1 }); return false; }
    return ++w.n > RATE.max;
  }

  revoke(id) {
    const list = this.list(), i = list.findIndex(t => t.id === id);
    if (i < 0) return null;
    const [gone] = list.splice(i, 1); this.hits.delete(id);
    return gone;
  }

  // Tokens whose person is gone, and tokens made before accounts existed once there are accounts.
  prune(users) {
    const ids = new Set(users.map(u => u.id)), list = this.list();
    const keep = list.filter(t => t.userId ? ids.has(t.userId) : !users.length);
    const removed = list.length - keep.length;
    if (removed) list.splice(0, list.length, ...keep);
    return removed;
  }
}

// What a page or a program may see of a token: never the hash.
export const publicToken = t => ({ id: t.id, name: t.name, hint: t.hint, userId: t.userId, scopes: t.scopes, anywhere: t.anywhere, created: t.created, expiresAt: t.expiresAt, lastUsed: t.lastUsed, expired: !!(t.expiresAt && t.expiresAt <= Date.now()) });
