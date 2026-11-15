// The talk inbox: every conversation of the talk channels, kept in data/talk.db so a restart loses nothing. The resident
// answers while a conversation is with it; a person on your team can take a conversation over, answer in its place and
// give it back. The resident's memory of a conversation is its last turns here, not the whole history.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

// person: someone outside writes. resident: the resident's answer. human: an answer from your team. notice: a short note
// SILO sent instead of an answer (paused, too many, failed). note: for your team only, never sent and never shown to a model.
export const TALK_ROLES = ['person', 'resident', 'human', 'notice', 'note'];
const SENT = new Set(['resident', 'human', 'notice']);
export const INBOX_MAX = 2000, MESSAGES_MAX = 300, KEEP_DAYS = 30, TEXT_MAX = 4000, HANDBACK = 24 * 3600000;

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };

export class Inbox {
  constructor(dir, {max = INBOX_MAX, messages = MESSAGES_MAX} = {}) { this.dir = dir; this.file = path.join(dir, 'talk.db'); this.max = max; this.messagesMax = messages; this.db = null; this.onChange = null; }

  open() {
    if (this.db) return this;
    mkdirSync(this.dir, {recursive: true});
    const pragmas = 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;';
    // A damaged file is moved aside, not deleted, and a new one is started.
    try {
      this.db = new DatabaseSync(this.file);this.db.exec(pragmas);
      if (this.db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('quick_check failed');
    } catch {
      try { this.db?.close(); } catch {}
      this.damaged = `${this.file}.damaged-${Date.now()}`;
      for (const ext of ['', '-wal', '-shm']) { try { renameSync(this.file + ext, this.damaged + ext); } catch {} }
      this.db = new DatabaseSync(this.file);this.db.exec(pragmas);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS talk_conv (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, who TEXT NOT NULL, route TEXT NOT NULL,
        mode TEXT NOT NULL, unread INTEGER NOT NULL DEFAULT 0, since INTEGER NOT NULL DEFAULT 1, next INTEGER NOT NULL DEFAULT 1, count INTEGER NOT NULL DEFAULT 0,
        started INTEGER NOT NULL, updated INTEGER NOT NULL, heard INTEGER NOT NULL DEFAULT 0, last TEXT NOT NULL DEFAULT '', lastRole TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS talk_conv_updated ON talk_conv (updated);
      CREATE TABLE IF NOT EXISTS talk_msg (conv TEXT NOT NULL, n INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL DEFAULT '', PRIMARY KEY (conv, n)) WITHOUT ROWID;
    `);
    const q = sql => this.db.prepare(sql);
    this.sql = {
      byKey: q('SELECT * FROM talk_conv WHERE key = ?'),
      byId: q('SELECT * FROM talk_conv WHERE id = ?'),
      add: q('INSERT INTO talk_conv (id, key, kind, who, route, mode, started, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      take: q('UPDATE talk_conv SET next = next + 1 WHERE id = ? RETURNING next - 1 AS n'),
      after: q('UPDATE talk_conv SET who = ?, route = ?, updated = ?, unread = unread + ?, count = count + 1, heard = MAX(heard, ?), last = ?, lastRole = ? WHERE id = ?'),
      msg: q('INSERT INTO talk_msg (conv, n, role, text, at, by) VALUES (?, ?, ?, ?, ?, ?)'),
      trim: q('DELETE FROM talk_msg WHERE conv = ? AND n <= ?'),
      recount: q('UPDATE talk_conv SET count = (SELECT COUNT(*) FROM talk_msg WHERE conv = ?) WHERE id = ?'),
      messages: q('SELECT n, role, text, at, by FROM talk_msg WHERE conv = ? AND n > ? ORDER BY n LIMIT ?'),
      lastOf: q('SELECT n, role, text, at, by FROM talk_msg WHERE conv = ? AND n >= ? ORDER BY n DESC LIMIT ?'),
      mode: q('UPDATE talk_conv SET mode = ? WHERE id = ?'),
      read: q('UPDATE talk_conv SET unread = 0 WHERE id = ?'),
      since: q('UPDATE talk_conv SET since = next WHERE id = ?'),
      sinceKind: q('UPDATE talk_conv SET since = next WHERE kind = ?'),
      drop: q('DELETE FROM talk_conv WHERE id = ?'),
      dropMsgs: q('DELETE FROM talk_msg WHERE conv = ?'),
      old: q('SELECT id FROM talk_conv WHERE updated < ?'),
      over: q('SELECT id FROM talk_conv ORDER BY updated DESC LIMIT -1 OFFSET ?'),
      idle: q("SELECT id FROM talk_conv WHERE mode = 'person' AND updated < ?"),
      counts: q("SELECT COUNT(*) AS conversations, COALESCE(SUM(unread > 0), 0) AS unread, COALESCE(SUM(mode = 'person'), 0) AS taken, COALESCE(SUM(mode = 'person' AND lastRole = 'person'), 0) AS waiting, COALESCE(MAX(updated), 0) AS latest FROM talk_conv"),
    };
    return this;
  }
  close() { try { this.db?.close(); } catch {} this.db = null; }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  changed() { this.onChange?.(); }

  view(c) { return c && {id: c.id, kind: c.kind, who: c.who, mode: c.mode, unread: c.unread, count: c.count, started: c.started, updated: c.updated, heard: c.heard, last: c.last, lastRole: c.lastRole}; }
  byKey(key) { return this.sql.byKey.get(String(key)) || null; }
  conv(id) { const c = this.sql.byId.get(String(id ?? '')); if (!c) fail('That conversation is gone.', 404); return c; }
  route(c) { try { return JSON.parse(c.route) || {}; } catch { return {}; } }
  get(id) { return this.view(this.conv(id)); }
  counts() { const r = this.sql.counts.get(); return {conversations: Number(r.conversations), unread: Number(r.unread), taken: Number(r.taken), waiting: Number(r.waiting), latest: Number(r.latest)}; }

  // One message of a conversation. The first one makes the conversation; the oldest messages go past the cap.
  record({kind, key, who = '', route, role, text, by = '', now = Date.now()}) {
    if (!TALK_ROLES.includes(role)) fail('Unknown message role.');
    const body = String(text ?? '').slice(0, TEXT_MAX);
    const r = this.tx(() => {
      let c = this.byKey(key);
      if (!c) {
        const id = randomUUID();
        this.sql.add.run(id, String(key), String(kind), String(who).slice(0, 80) || 'someone', JSON.stringify(route || {}), 'resident', now, now);
        c = this.sql.byId.get(id);
      }
      const n = Number(this.sql.take.get(c.id).n);
      this.sql.msg.run(c.id, n, role, body, now, String(by).slice(0, 80));
      const person = role === 'person';
      this.sql.after.run(person && who ? String(who).slice(0, 80) : c.who, person && route ? JSON.stringify(route) : c.route, now, person ? 1 : 0, person ? now : 0, role === 'note' ? c.last : body.slice(0, 200), role === 'note' ? c.lastRole : role, c.id);
      if (n > this.messagesMax) { this.sql.trim.run(c.id, n - this.messagesMax); this.sql.recount.run(c.id, c.id); }
      return {conv: this.sql.byId.get(c.id), n};
    });
    this.changed();
    return {...this.view(r.conv), n: r.n};
  }

  // The turns a resident remembers: the last ones since it took the conversation (or since its memory was cleared), and
  // none after two idle hours. Notes and notices are left out; answers from your team count as the assistant's.
  history(key, {keep = 12, idle = 2 * 3600000, now = Date.now()} = {}) {
    const c = this.byKey(key); if (!c || now - c.updated > idle) return [];
    return this.sql.lastOf.all(c.id, c.since, keep * 2).reverse().filter(m => m.role === 'person' || m.role === 'resident' || m.role === 'human').slice(-keep)
      .map(m => ({role: m.role === 'person' ? 'user' : 'assistant', content: m.text}));
  }
  messages(id, {after = 0, limit = 500, sent = false} = {}) {
    const c = this.conv(id), list = this.sql.messages.all(c.id, Math.max(0, Number(after) || 0), Math.max(1, Math.min(500, Number(limit) || 500)));
    return sent ? list.filter(m => SENT.has(m.role)) : list;
  }
  // Who answers: the resident, or a person of your team. The change is noted in the conversation.
  setMode(id, mode, by = '') {
    if (mode !== 'resident' && mode !== 'person') fail('A conversation is with the resident or with a person.');
    const c = this.conv(id); if (c.mode === mode) return this.view(c);
    this.tx(() => {
      this.sql.mode.run(mode, c.id);
      // Given back: the resident starts from here, so it does not answer for what your team said.
      if (mode === 'resident') this.sql.since.run(c.id);
      const n = Number(this.sql.take.get(c.id).n), text = mode === 'person' ? `Taken over${by ? ' by ' + by : ''}.` : `Given back to the resident${by ? ' by ' + by : ''}.`;
      this.sql.msg.run(c.id, n, 'note', text, Date.now(), String(by).slice(0, 80));this.sql.recount.run(c.id, c.id);
    });
    this.changed();
    return this.get(id);
  }
  read(id) { const c = this.conv(id); if (c.unread) { this.sql.read.run(c.id); this.changed(); } return this.get(id); }
  // Another resident, or the channel turned off: the conversations stay, the resident's memory of them starts over.
  forgetKind(kind) { this.sql.sinceKind.run(String(kind)); }
  remove(id) { const c = this.conv(id); this.tx(() => { this.sql.dropMsgs.run(c.id); this.sql.drop.run(c.id); }); this.changed(); }

  list({kind = '', mode = '', search = '', limit = 50, offset = 0} = {}) {
    const where = [], args = [];
    if (kind) { where.push('kind = ?'); args.push(String(kind)); }
    if (mode === 'waiting') where.push("mode = 'person' AND lastRole = 'person'");
    else if (mode === 'unread') where.push('unread > 0');
    else if (mode) { where.push('mode = ?'); args.push(String(mode)); }
    const words = String(search || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    for (const w of words) {
      const like = '%' + w.replace(/[\\%_]/g, c => '\\' + c) + '%';
      where.push("(lower(who) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM talk_msg m WHERE m.conv = talk_conv.id AND lower(m.text) LIKE ? ESCAPE '\\'))");args.push(like, like);
    }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM talk_conv' + w).get(...args).n);
    const rows = this.db.prepare(`SELECT * FROM talk_conv${w} ORDER BY updated DESC LIMIT ? OFFSET ?`).all(...args, Math.max(1, Math.min(200, Number(limit) || 50)), Math.max(0, Number(offset) || 0));
    return {conversations: rows.map(r => this.view(r)), total};
  }

  // Old conversations go after keepDays, the oldest past the cap, and one a person took over but left for a day goes
  // back to the resident, so nobody waits for an answer that never comes. Returns how many were given back.
  prune({keepDays = KEEP_DAYS, now = Date.now()} = {}) {
    const gone = [...this.sql.old.all(now - keepDays * 86400000), ...this.sql.over.all(this.max)].map(r => r.id);
    const back = this.sql.idle.all(now - HANDBACK).map(r => r.id).filter(id => !gone.includes(id));
    if (gone.length) this.tx(() => { for (const id of new Set(gone)) { this.sql.dropMsgs.run(id); this.sql.drop.run(id); } });
    for (const id of back) this.setMode(id, 'resident', 'SILO after a day without an answer');
    if (gone.length) this.changed();
    return {removed: new Set(gone).size, givenBack: back.length};
  }
}
