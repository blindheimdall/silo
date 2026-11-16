// The gallery: procedures other people share, installed with one click. A catalog is an index.json with an entry per
// procedure file next to it, each with the SHA-256 of the file, so a file that changed after it was listed is refused.
// SILO ships with the catalog in gallery/, and reads the newest one from a feed (the SILO repository by default, or a
// catalog of your own) only when someone opens the gallery. Nothing about this SILO is sent with the request.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';

export const GALLERY_FEED = 'https://raw.githubusercontent.com/blindheimdall/silo/main/gallery/index.json';
export const FILE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.silo\.json$/;
const STEP_TYPES = new Set(['agent', 'review', 'approval', 'action', 'wait', 'code', 'workflow']);
const MAX_INDEX = 1_000_000, MAX_FILE = 512_000, MAX_ENTRIES = 500;
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

// A file is fingerprinted with LF line ends, so a checkout that turned them into CRLF still matches.
export const fingerprint = raw => createHash('sha256').update(String(raw).replace(/\r\n/g, '\n')).digest('hex');

// A feed is an https address, or http on this computer for a catalog you serve yourself while you try it.
export function checkFeed(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let u; try { u = new URL(s); } catch { throw Object.assign(new Error('The gallery address is not a web address.'), { status: 400 }); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || (isIP(host) && /^(127\.|::1$)/.test(host));
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw Object.assign(new Error('The gallery address must start with https://.'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('The gallery address cannot hold a user name or password.'), { status: 400 });
  if (!/\.json$/i.test(u.pathname)) throw Object.assign(new Error('The gallery address is the address of its index.json.'), { status: 400 });
  u.hash = '';
  return u.href;
}

// Keeps what an index may say, and drops entries that are not right instead of refusing the whole catalog.
export function cleanIndex(raw) {
  if (!raw || typeof raw !== 'object' || raw.silo !== 'gallery') throw new Error('This is not a SILO gallery index.');
  if (raw.format !== 1) throw new Error('This gallery was made for a newer SILO. Update SILO to read it.');
  const seen = new Set(), procedures = [];
  for (const e of Array.isArray(raw.procedures) ? raw.procedures.slice(0, MAX_ENTRIES) : []) {
    if (!e || typeof e !== 'object' || !FILE_NAME.test(e.file) || seen.has(e.file) || !/^[a-f0-9]{64}$/.test(e.sha256)) continue;
    const name = text(e.name, 100); if (!name) continue;
    const steps = (Array.isArray(e.steps) ? e.steps : []).slice(0, 12).map(s => ({ type: STEP_TYPES.has(s?.type) ? s.type : 'agent', ...(typeof s?.app === 'string' && /^svc:[a-z]{2,20}$/.test(s.app) && { app: s.app }) }));
    if (!steps.length) continue;
    seen.add(e.file);
    procedures.push({
      file: e.file, name, description: text(e.description, 300), author: text(e.author, 60),
      tags: [...new Set((Array.isArray(e.tags) ? e.tags : []).map(t => text(t, 24).toLowerCase()).filter(Boolean))].slice(0, 6),
      ...(/^\d{4}-\d{2}-\d{2}$/.test(e.made) && { made: e.made }),
      needs: [...new Set((Array.isArray(e.needs) ? e.needs : []).map(n => text(n, 24)).filter(n => /^[a-z_|]+$/.test(n)))].slice(0, 8),
      steps, sha256: e.sha256
    });
  }
  return { name: text(raw.name, 80) || 'Gallery', procedures };
}

// Writes the index for the procedure files in a folder (tools/gallery.mjs). The order is the order of the entries
// that were there, then new files by name; what the files say wins over the old entries.
export function makeIndex(files, was = {}) {
  const old = new Map((was.procedures || []).map(e => [e.file, e]));
  const names = [...[...old.keys()].filter(f => files.has(f)), ...[...files.keys()].filter(f => !old.has(f)).sort()];
  return {
    silo: 'gallery', format: 1, name: was.name || 'SILO gallery',
    procedures: names.map(file => {
      const raw = files.get(file), t = JSON.parse(raw), o = old.get(file) || {};
      if (t?.silo !== 'procedure' || !Array.isArray(t.steps)) throw new Error(`${file} is not a SILO procedure file.`);
      const needs = [...new Set(t.steps.flatMap(s => s.needs || []))];
      return {
        file, name: t.name, description: t.description || '', author: o.author || t.author || '', tags: o.tags || [],
        ...(t.made && { made: t.made }), ...(needs.length && { needs }),
        steps: t.steps.map(s => ({ type: s.type || 'agent', ...(String(s.app || '').startsWith('svc:') && { app: s.app }) })),
        sha256: fingerprint(raw)
      };
    })
  };
}

export class Gallery {
  constructor({ dir, fetch: get = globalThis.fetch, ttl = 30 * 60_000, now = Date.now }) {
    Object.assign(this, { dir, get, ttl, now, remote: new Map(), shipped: null });
  }
  async fetchText(url, max) {
    const r = await this.get(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`The gallery answered ${r.status}.`);
    if (Number(r.headers.get('content-length')) > max) throw new Error('The gallery file is too large.');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > max) throw new Error('The gallery file is too large.');
    return buf.toString('utf8');
  }
  // The catalog that came with this SILO. A broken one is left out, so the feed still works.
  async bundled() {
    if (this.shipped) return this.shipped;
    try { this.shipped = cleanIndex(JSON.parse(await fs.readFile(path.join(this.dir, 'index.json'), 'utf8'))); }
    catch { this.shipped = { name: 'Gallery', procedures: [] }; }
    return this.shipped;
  }
  // The feed is read again after ttl, or at once with fresh. When it cannot be read, the last copy is used, and the
  // error says why. Two requests at the same time share one read.
  async feed(url, fresh = false) {
    let c = this.remote.get(url);
    if (c?.pending) return c.pending;
    if (c?.index && !fresh && this.now() - c.checked < this.ttl) return c;
    const pending = this.fetchText(url, MAX_INDEX)
      .then(raw => ({ index: cleanIndex(JSON.parse(raw)), checked: this.now(), error: '' }))
      .catch(e => ({ index: c?.index || null, checked: c?.checked || 0, error: e instanceof SyntaxError ? 'The gallery index is not JSON.' : String(e?.message || e).slice(0, 200) }))
      .then(r => { this.remote.set(url, r); return r; });
    this.remote.set(url, { ...(c || {}), pending });
    return pending;
  }
  // Entries from the feed replace the shipped ones with the same file; the rest of the shipped ones stay.
  async list(url, { fresh = false } = {}) {
    const shipped = await this.bundled(), f = url ? await this.feed(url, fresh) : null;
    const all = new Map(shipped.procedures.map(e => [e.file, { ...e, from: 'bundled' }]));
    for (const e of f?.index?.procedures || []) all.set(e.file, { ...e, from: 'feed' });
    return { name: f?.index?.name || shipped.name, feed: url || '', checked: f?.checked || 0, error: f?.error || '', procedures: [...all.values()] };
  }
  async procedure(url, file) {
    if (!FILE_NAME.test(String(file))) throw Object.assign(new Error('There is no such procedure in the gallery.'), { status: 404 });
    const list = await this.list(url), entry = list.procedures.find(e => e.file === file);
    if (!entry) throw Object.assign(new Error('There is no such procedure in the gallery.'), { status: 404 });
    let raw;
    try { raw = entry.from === 'feed' ? await this.fetchText(new URL(file, url).href, MAX_FILE) : await fs.readFile(path.join(this.dir, file), 'utf8'); }
    catch (e) { throw Object.assign(new Error('The procedure could not be read: ' + String(e?.message || e).slice(0, 200)), { status: 502 }); }
    if (raw.length > MAX_FILE) throw Object.assign(new Error('The procedure file is too large.'), { status: 502 });
    if (fingerprint(raw) !== entry.sha256) throw Object.assign(new Error('The file does not match the fingerprint in the gallery, so it is not used. It may have changed after the gallery was made; try again later.'), { status: 502 });
    let t; try { t = JSON.parse(raw); } catch { throw Object.assign(new Error('The procedure file is not JSON.'), { status: 502 }); }
    return { entry, template: t };
  }
}
