// The audit log: who did what, when, from where. One JSON line per record, one file per month, never rewritten.
// Every record carries the hash of the one before it, made with a key from the vault (HMAC-SHA256), so a record
// that is changed, removed or slipped in breaks the chain and the check says where.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = /^audit-(\d{4})-(\d{2})\.jsonl$/;
export const AUDIT_FIELDS = ['seq', 'time', 'action', 'outcome', 'actor', 'role', 'ip', 'via', 'target', 'detail', 'status', 'hash'];
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}' : JSON.stringify(v);
const clip = (v, n) => v === undefined || v === null || v === '' ? undefined : String(v).replace(/[\r\n\t]+/g, ' ').slice(0, n);
export const monthOf = ms => new Date(ms).toISOString().slice(0, 7);
export function chainHash(key, prev, body) { return crypto.createHmac('sha256', key || 'silo-audit').update(String(prev || '') + '\n' + canonical(body)).digest('hex'); }

export class AuditLog {
  // key: returns the chain key. onRecord: gets every new record (for OpenTelemetry).
  constructor(dir, { key = () => '', onRecord = () => {} } = {}) {
    this.dir = dir; this.key = key; this.onRecord = onRecord; this.seq = 0; this.prev = ''; this.queue = Promise.resolve(); this.error = '';
    this.ready = this.open();
  }
  async files() {
    let names = []; try { names = await fs.readdir(this.dir); } catch { return []; }
    return names.filter(n => FILE.test(n)).sort();
  }
  // Picks up the chain where the last file ends. A last line cut off by a crash is set aside, not lost.
  async open() {
    await fs.mkdir(this.dir, { recursive: true });
    const files = await this.files(); if (!files.length) return;
    const f = path.join(this.dir, files.at(-1)), text = await fs.readFile(f, 'utf8');
    const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
    let last = null;
    while (lines.length) { try { last = JSON.parse(lines.at(-1)); break; } catch { const bad = lines.pop(); await fs.appendFile(path.join(this.dir, 'damaged.txt'), bad + '\n'); } }
    if (lines.length !== text.split('\n').filter(Boolean).length) await fs.writeFile(f, lines.map(l => l + '\n').join(''));
    if (last) { this.seq = last.seq || 0; this.prev = last.hash || ''; }
  }
  // Adds a record. Returns it once it is on disk.
  record(r) {
    const job = this.queue.then(async () => {
      await this.ready;
      const time = Date.now();
      const body = {
        seq: this.seq + 1, time: new Date(time).toISOString(), action: clip(r.action, 80) || 'unknown', outcome: ['ok', 'denied', 'failed'].includes(r.outcome) ? r.outcome : 'ok',
        actor: clip(r.actor, 120) || 'system', role: clip(r.role, 20), ip: clip(r.ip, 64), via: clip(r.via, 20), target: clip(r.target, 200), detail: clip(r.detail, 500), status: Number.isInteger(r.status) ? r.status : undefined, prev: this.prev,
      };
      const rec = { ...body, hash: chainHash(this.key(), this.prev, body) };
      await fs.mkdir(this.dir, { recursive: true });
      await fs.appendFile(path.join(this.dir, `audit-${monthOf(time)}.jsonl`), JSON.stringify(rec) + '\n');
      this.seq = rec.seq; this.prev = rec.hash; this.error = '';
      try { this.onRecord(rec); } catch {}
      return rec;
    });
    this.queue = job.catch(e => { this.error = e.message; });
    return job;
  }
  // Records from..to (ms), newest last. filter is matched against action, actor, target and detail.
  async read({ from = 0, to = Date.now(), filter = '', limit = 100000 } = {}) {
    await this.queue; const out = [], f = String(filter || '').toLowerCase();
    const first = monthOf(from), last = monthOf(to);
    for (const n of await this.files()) {
      const m = n.slice(6, 13); if (m < first || m > last) continue;
      for (const line of (await fs.readFile(path.join(this.dir, n), 'utf8')).split('\n')) {
        if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
        const t = Date.parse(r.time); if (t < from || t > to) continue;
        if (f && ![r.action, r.actor, r.target, r.detail, r.ip].some(x => String(x || '').toLowerCase().includes(f))) continue;
        out.push(r); if (out.length > limit) out.shift();
      }
    }
    return out;
  }
  async recent(n = 50) { return (await this.read({ from: Date.now() - 62 * 86400000 })).slice(-n).reverse(); }
  // Walks the whole chain. The first record kept may point at an older one that was removed by the keep period.
  async verify() {
    await this.queue; const key = this.key(); let prev = null, seq = null, count = 0, first = null;
    for (const n of await this.files()) {
      const lines = (await fs.readFile(path.join(this.dir, n), 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        const where = { file: n, line: i + 1 };
        let r; try { r = JSON.parse(lines[i]); } catch { return { ok: false, records: count, broken: { ...where, reason: 'A line is not a record.' } }; }
        const { hash, ...body } = r;
        if (prev !== null && r.prev !== prev) return { ok: false, records: count, broken: { ...where, seq: r.seq, reason: 'A record is missing or out of order before this one.' } };
        if (seq !== null && r.seq !== seq + 1) return { ok: false, records: count, broken: { ...where, seq: r.seq, reason: `Record ${seq + 1} is missing.` } };
        if (chainHash(key, r.prev, body) !== hash) return { ok: false, records: count, broken: { ...where, seq: r.seq, reason: 'This record was changed, or the audit key changed.' } };
        if (first === null) first = r.seq;
        prev = hash; seq = r.seq; count++;
      }
    }
    return { ok: true, records: count, first, last: seq, head: prev };
  }
  // Removes whole months older than the keep period. 0 keeps everything.
  async prune(months) {
    if (!months) return 0; const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - months); const limit = monthOf(d.getTime());
    let n = 0; for (const f of await this.files()) if (f.slice(6, 13) < limit) { await fs.rm(path.join(this.dir, f), { force: true }); n++; }
    return n;
  }
  size() { let s = 0; try { for (const f of fss.readdirSync(this.dir)) if (FILE.test(f)) s += fss.statSync(path.join(this.dir, f)).size; } catch {} return s; }
}
const csvCell = v => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]|^[=+\-@\t\r]/.test(s) ? '"' + (/^[=+\-@\t\r]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
// CSV for spreadsheets. Cells that start like a formula get a quote mark first, so a spreadsheet does not run them.
export function auditCsv(records) { return [AUDIT_FIELDS.join(','), ...records.map(r => AUDIT_FIELDS.map(f => csvCell(r[f])).join(','))].join('\r\n') + '\r\n'; }
export function auditJsonl(records) { return records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''); }
