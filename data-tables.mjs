// Tables: rows that workflows, residents, programs and people keep between runs, in data/tables.db.
// Each table has typed columns. A row is kept as JSON with the values of its columns, and has an id of its own
// that is never given again in that table. Text is compared without case, so "Ana@x.ro" finds "ana@x.ro".
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

export const TABLE_MAX = 50, COLUMN_MAX = 30, ROW_MAX = 50000, CELL_MAX = 5000, ROW_SIZE_MAX = 20000, PAGE_MAX = 500, IMPORT_MAX = 10000, CSV_MAX = 5e6;
export const COLUMN_TYPES = {text: 'text', number: 'number', boolean: 'yes or no', date: 'date', json: 'JSON'};
// Names a column cannot have: the parts every row has, and the fields table steps use for themselves.
export const RESERVED = new Set(['id', 'row_id', 'created', 'updated', 'limit', 'order_by', 'match_on', 'search']);
export const FILTER_OPS = ['eq', 'ne', 'contains', 'starts', 'gt', 'gte', 'lt', 'lte', 'empty', 'filled'];
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
// A row's own value in a column. A column named like something every object has, such as constructor, reads as empty
// when the row has no value there, not as that built-in.
const own = (o, k) => Object.hasOwn(o, k) ? o[k] : undefined;
const short = v => { const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v); return s.length > 40 ? s.slice(0, 40) + '...' : s; };

// A value as the column keeps it. Empty means no value. A value that does not fit the column is refused, never guessed.
export function cellValue(col, v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && !v.trim()) return null;
  switch (col.type) {
    case 'number': {
      if (typeof v === 'number') { if (!Number.isFinite(v)) fail(`${col.name} takes a number, not "${short(v)}".`); return v; }
      // 3,5 is read as 3.5, and spaces between thousands are left out.
      const s = String(v).trim().replace(/[\s_]/g, ''), n = Number(/^-?\d+,\d+$/.test(s) ? s.replace(',', '.') : s);
      if (typeof v === 'boolean' || !s || !Number.isFinite(n)) fail(`${col.name} takes a number, not "${short(v)}".`);
      return n;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const t = String(v).trim().toLowerCase();
      if (['true', 'yes', 'y', '1', 'da'].includes(t)) return true;
      if (['false', 'no', 'n', '0', 'nu'].includes(t)) return false;
      fail(`${col.name} takes yes or no, not "${short(v)}".`);
    }
    case 'date': {
      const s = String(v).trim();
      // A day stays a day; anything with a time is kept as an exact moment in UTC.
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const d = new Date(s + 'T00:00:00Z'); if (!isNaN(d) && d.toISOString().slice(0, 10) === s) return s; fail(`${col.name} takes a date like 2026-11-15, not "${short(v)}".`); }
      // 15.11.2026 is read day first, as in Romania and most of Europe.
      const eu = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (eu) return cellValue(col, `${eu[3]}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}`);
      const t = typeof v === 'number' ? v : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) ? Date.parse(s.replace(' ', 'T')) : NaN;
      // A number past the year 275760 is no date either; toISOString would throw on it.
      if (!Number.isFinite(t) || Number.isNaN(new Date(t).getTime())) fail(`${col.name} takes a date like 2026-11-15 or 2026-11-15T09:30, not "${short(v)}".`);
      return new Date(t).toISOString();
    }
    case 'json': {
      let x = v;
      if (typeof v === 'string') { try { x = JSON.parse(v); } catch { x = v.trim(); } }
      if (JSON.stringify(x).length > CELL_MAX) fail(`${col.name} is longer than ${CELL_MAX} characters.`);
      return x;
    }
    default: {
      const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (s.length > CELL_MAX) fail(`${col.name} is longer than ${CELL_MAX} characters.`);
      return s;
    }
  }
}

export function checkColumns(list) {
  if (!Array.isArray(list) || !list.length) fail('A table needs at least one column.');
  if (list.length > COLUMN_MAX) fail(`A table has at most ${COLUMN_MAX} columns.`);
  const seen = new Set();
  return list.map((c, i) => {
    const name = String(c?.name ?? '').trim();
    if (!NAME.test(name)) fail(`Column ${i + 1} needs a name of letters, digits and _, starting with a letter, at most 40 long.`);
    const low = name.toLowerCase();
    if (RESERVED.has(low)) fail(`"${name}" is kept for SILO. Pick another column name.`);
    if (seen.has(low)) fail(`The column "${name}" is there twice.`);
    seen.add(low);
    const type = Object.hasOwn(COLUMN_TYPES, c?.type) ? c.type : 'text';
    return {name, type, ...(c?.required === true && {required: true}), ...(c?.unique === true && type !== 'json' && {unique: true}), ...(typeof c?.was === 'string' && c.was && {was: c.was})};
  });
}
const tableName = v => { const s = String(v ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim(); if (!s) fail('Name the table.'); if (s.length > 60) fail('A table name has at most 60 characters.'); return s; };

// CSV as spreadsheets write it: quotes, quotes doubled inside, line breaks inside quotes, a comma, semicolon or tab.
export function parseCsv(text) {
  let s = String(text ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const head = s.slice(0, s.search(/\r?\n|$/)), count = ch => head.split('"').filter((_, i) => i % 2 === 0).join('').split(ch).length - 1;
  const sep = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
// Cells that start like a formula get a quote mark first, so a spreadsheet does not run them.
const csvCell = v => { const s = v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n\r;]|^[=+\-@\t\r]/.test(s) ? '"' + (/^[=+\-@\t\r]/.test(s) ? "'" : '') + s.replace(/"/g, '""') + '"' : s; };
// A header from a file as a column name: letters without their marks, other signs as _.
export function columnName(header, i) {
  let n = String(header ?? '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!/^[A-Za-z]/.test(n)) n = ('c_' + n).slice(0, 40).replace(/_+$/, '') || 'c';
  if (n === 'c') n = 'column_' + (i + 1);
  return n;
}
// The type most of a column's values fit, with every value fitting: number, yes or no, date, or text.
function guessType(values) {
  const v = values.map(x => x.trim()).filter(Boolean);
  if (!v.length) return 'text';
  const fits = type => v.every(x => { try { cellValue({name: '', type}, x); return true; } catch { return false; } });
  if (v.every(x => /^-?\d[\d\s]*([.,]\d+)?$/.test(x) && !/^0\d/.test(x)) && fits('number')) return 'number';
  if (v.every(x => /^(true|false|yes|no|da|nu)$/i.test(x))) return 'boolean';
  if (v.every(x => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}.*)?$/.test(x)) && fits('date')) return 'date';
  return 'text';
}

export class Tables {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'tables.db'); this.db = null; this.meta = new Map(); this.counts = new Map(); this.onChange = null; }

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
      CREATE TABLE IF NOT EXISTS silo_tables (id TEXT PRIMARY KEY, name TEXT NOT NULL, columns TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, next INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS silo_rows (tid TEXT NOT NULL, id INTEGER NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (tid, id)) WITHOUT ROWID;
    `);
    const q = sql => this.db.prepare(sql);
    this.sql = {
      tables: q('SELECT * FROM silo_tables'),
      counts: q('SELECT tid, COUNT(*) AS n FROM silo_rows GROUP BY tid'),
      addTable: q('INSERT INTO silo_tables (id, name, columns, created, updated, next) VALUES (?, ?, ?, ?, ?, 1)'),
      setTable: q('UPDATE silo_tables SET name = ?, columns = ?, updated = ? WHERE id = ?'),
      touch: q('UPDATE silo_tables SET updated = ? WHERE id = ?'),
      take: q('UPDATE silo_tables SET next = next + ? WHERE id = ? RETURNING next'),
      dropTable: q('DELETE FROM silo_tables WHERE id = ?'),
      dropRows: q('DELETE FROM silo_rows WHERE tid = ?'),
      row: q('SELECT * FROM silo_rows WHERE tid = ? AND id = ?'),
      all: q('SELECT id, data FROM silo_rows WHERE tid = ? ORDER BY id'),
      add: q('INSERT INTO silo_rows (tid, id, data, created, updated) VALUES (?, ?, ?, ?, ?)'),
      set: q('UPDATE silo_rows SET data = ?, updated = ? WHERE tid = ? AND id = ?'),
      setData: q('UPDATE silo_rows SET data = ? WHERE tid = ? AND id = ?'),
      remove: q('DELETE FROM silo_rows WHERE tid = ? AND id = ?'),
    };
    for (const t of this.sql.tables.all()) this.meta.set(t.id, {id: t.id, name: t.name, columns: JSON.parse(t.columns), created: t.created, updated: t.updated});
    for (const c of this.sql.counts.all()) this.counts.set(c.tid, c.n);
    return this;
  }
  close() { try { this.db?.close(); } catch {} this.db = null; this.stmts = null; }
  // A statement made from SQL that is built per table and filter, kept so the same query is not compiled again for every
  // row of a loop. The SQL holds only column names and placeholders, so a few hundred cover every shape in use.
  prep(sql) {
    const m = this.stmts ||= new Map();
    let s = m.get(sql);
    if (!s) { if (m.size >= 300) m.clear(); s = this.db.prepare(sql); m.set(sql, s); }
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch {} throw e; }
  }
  changed(t) { t.updated = Date.now(); this.sql.touch.run(t.updated, t.id); this.onChange?.(t); }

  view(t) { return {id: t.id, name: t.name, columns: t.columns.map(c => ({...c})), rows: this.counts.get(t.id) || 0, created: t.created, updated: t.updated}; }
  list() { return [...this.meta.values()].sort((a, b) => a.name.localeCompare(b.name)).map(t => this.view(t)); }
  // A table by its id, or by its name without case.
  table(ref) {
    const r = String(ref ?? '').trim(), low = r.toLowerCase();
    const t = this.meta.get(r) || [...this.meta.values()].find(x => x.name.toLowerCase() === low);
    if (!t) fail(r ? `There is no table "${r.slice(0, 60)}".` : 'Say which table.', 404);
    return t;
  }
  column(t, name) {
    const low = String(name ?? '').trim().toLowerCase(), c = t.columns.find(c => c.name.toLowerCase() === low);
    if (!c) fail(`${t.name} has no column "${String(name ?? '').slice(0, 40)}". Its columns: ${t.columns.map(c => c.name).join(', ')}.`);
    return c;
  }
  sameName(name, except) { const low = name.toLowerCase(); if ([...this.meta.values()].some(t => t.id !== except && t.name.toLowerCase() === low)) fail(`There is already a table called ${name}.`); }

  create({name, columns}) {
    if (this.meta.size >= TABLE_MAX) fail(`SILO keeps at most ${TABLE_MAX} tables. Delete one first.`);
    const n = tableName(name);this.sameName(n);
    const cols = checkColumns(columns).map(({was, ...c}) => c), now = Date.now(), t = {id: randomUUID(), name: n, columns: cols, created: now, updated: now};
    this.sql.addTable.run(t.id, t.name, JSON.stringify(cols), now, now);
    this.meta.set(t.id, t);this.counts.set(t.id, 0);this.onChange?.(t);
    return this.view(t);
  }

  // A new name or new columns. A column keeps its values when it is renamed ("was" names it before), and they are
  // changed to a new type only when every one of them fits it; otherwise nothing changes and the rows are named.
  change(ref, {name, columns}) {
    const t = this.table(ref), n = name === undefined ? t.name : tableName(name);
    this.sameName(n, t.id);
    if (columns === undefined) { t.name = n; this.sql.setTable.run(n, JSON.stringify(t.columns), Date.now(), t.id); this.changed(t); return this.view(t); }
    const cols = checkColumns(columns), old = new Map(t.columns.map(c => [c.name, c]));
    const from = cols.map(c => { const was = c.was ?? c.name; if (c.was !== undefined && !old.has(was)) fail(`${t.name} has no column "${was}" to rename.`); return old.get(was) || null; });
    if (new Set(from.filter(Boolean).map(c => c.name)).size !== from.filter(Boolean).length) fail('Two columns cannot come from the same column.');
    const next = cols.map(({was, ...c}) => c);
    // Only adding columns, moving them or loosening a rule leaves the rows as they are.
    const reshape = t.columns.some(c => !from.includes(c)) || next.some((c, i) => { const s = from[i]; return s ? s.name !== c.name || s.type !== c.type || (c.required && !s.required) || (c.unique && !s.unique) : !!c.required; });
    if (reshape) {
      const updates = [], problems = [], seen = next.map(() => new Map());
      let more = 0;const problem = p => { if (problems.length < 3) problems.push(p); else more++; };
      for (const r of this.sql.all.all(t.id)) {
        const data = JSON.parse(r.data), out = {};
        next.forEach((c, i) => {
          const src = from[i];if (!src || own(data, src.name) === undefined) { if (c.required) problem(`row ${r.id} has no ${c.name}`); return; }
          let v;
          try { v = src.type === c.type ? data[src.name] : cellValue(c, src.type === 'json' && typeof data[src.name] === 'object' ? JSON.stringify(data[src.name]) : data[src.name]); }
          catch (e) { problem(`row ${r.id}: ${e.message.replace(/[.]$/, '')}`); return; }
          if (v === null) { if (c.required) problem(`row ${r.id} has no ${c.name}`); return; }
          out[c.name] = v;
          if (c.unique) { const k = this.key(c, v), at = seen[i].get(k); if (at !== undefined) problem(`rows ${at} and ${r.id} have the same ${c.name}`); else seen[i].set(k, r.id); }
        });
        const j = JSON.stringify(out);if (j !== r.data) updates.push([j, r.id]);
      }
      if (problems.length) fail(`The columns were not changed: ${problems.join('; ')}${more ? `, and ${more} more` : ''}.`);
      this.tx(() => { for (const [j, id] of updates) this.sql.setData.run(j, t.id, id); this.sql.setTable.run(n, JSON.stringify(next), Date.now(), t.id); });
    } else this.sql.setTable.run(n, JSON.stringify(next), Date.now(), t.id);
    t.name = n;t.columns = next;this.changed(t);
    return this.view(t);
  }

  drop(ref) {
    const t = this.table(ref);
    this.tx(() => { this.sql.dropRows.run(t.id); this.sql.dropTable.run(t.id); });
    this.meta.delete(t.id);this.counts.delete(t.id);this.onChange?.(t);
    return {id: t.id, name: t.name};
  }

  // The values of one row, checked against the columns. base: the row before, for a change. null or empty clears a value.
  clean(t, input, base = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Give the values as column names and values.');
    const out = {...(base || {})};
    for (const [k, v] of Object.entries(input)) {
      if (RESERVED.has(k.toLowerCase())) continue;
      const c = this.column(t, k), x = cellValue(c, v);
      if (x === null) delete out[c.name]; else out[c.name] = x;
    }
    for (const c of t.columns) if (c.required && own(out, c.name) === undefined) fail(`${t.name} needs ${c.name}.`);
    const ordered = {};for (const c of t.columns) if (own(out, c.name) !== undefined) ordered[c.name] = out[c.name];
    if (JSON.stringify(ordered).length > ROW_SIZE_MAX) fail(`A row holds at most ${ROW_SIZE_MAX} characters.`);
    return ordered;
  }
  // How two values of a column are the same: text without case, the rest exactly.
  key(c, v) { return c.type === 'text' ? String(v).toLowerCase() : c.type === 'boolean' ? String(!!v) : JSON.stringify(v); }
  expr(t, name) {
    const low = String(name ?? '').trim().toLowerCase();
    if (low === 'id' || low === 'created' || low === 'updated') return {sql: low, col: {name: low, type: low === 'id' ? 'number' : 'moment'}};
    // Column names are letters, digits and _, so the path can stand in the SQL as it is.
    const c = this.column(t, name);return {sql: `json_extract(data, '$.${c.name}')`, col: c};
  }
  bind(c, v) { return v === true ? 1 : v === false ? 0 : v; }
  // The rows with this value in a column, other than one row.
  matching(t, c, v, except = 0) {
    const {sql} = this.expr(t, c.name), text = c.type === 'text';
    return this.prep(`SELECT * FROM silo_rows WHERE tid = ? AND id <> ? AND ${text ? `lower(${sql}) = lower(?)` : `${sql} = ?`} ORDER BY id LIMIT 2`).all(t.id, except, text ? String(v) : this.bind(c, c.type === 'json' ? JSON.stringify(v) : v));
  }
  unique(t, data, except = 0) {
    for (const c of t.columns) if (c.unique && own(data, c.name) !== undefined && this.matching(t, c, data[c.name], except).length) fail(`${t.name} already has a row with ${c.name} ${short(data[c.name])}.`, 409);
  }
  rowView(r) { return {id: r.id, ...JSON.parse(r.data), created: r.created, updated: r.updated}; }

  // filters: [{column, op, value}]. search: words found in any value.
  where(t, filters = [], search = '') {
    const parts = ['tid = ?'], args = [t.id];
    if (!Array.isArray(filters)) fail('Filters are a list of column, op and value.');
    if (filters.length > 20) fail('At most 20 filters.');
    for (const f of filters) {
      const {sql, col} = this.expr(t, f?.column), op = FILTER_OPS.includes(f?.op) ? f.op : 'eq';
      if (op === 'empty' || op === 'filled') { parts.push(`${op === 'filled' ? 'NOT ' : ''}(${sql} IS NULL OR ${sql} = '')`); continue; }
      let v = f?.value;
      if (v === undefined || v === null || String(v) === '') fail(`The filter on ${col.name} needs a value.`);
      if (op === 'contains' || op === 'starts') {
        v = String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase();
        parts.push(op === 'contains' ? `instr(lower(CAST(${sql} AS TEXT)), ?) > 0` : `substr(lower(CAST(${sql} AS TEXT)), 1, ?) = ?`);
        args.push(...(op === 'contains' ? [v] : [v.length, v]));continue;
      }
      if (col.type === 'moment') { const n = typeof v === 'number' ? v : Date.parse(String(v)); if (!Number.isFinite(n)) fail(`${col.name} is compared with a date, not "${short(v)}".`); v = n; }
      else if (col.type !== 'json') v = cellValue(col, v);
      const cmp = {eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<='}[op];
      // A day matches every moment of that day.
      if (col.type === 'date' && typeof v === 'string' && v.length === 10 && (op === 'eq' || op === 'ne')) { parts.push(`${op === 'ne' ? `(${sql} IS NULL OR ` : '('}substr(${sql}, 1, 10) ${cmp} ?)`);args.push(v);continue; }
      const lhs = col.type === 'text' || col.type === 'json' ? `lower(CAST(${sql} AS TEXT))` : sql;
      parts.push(op === 'ne' ? `(${sql} IS NULL OR ${lhs} <> ?)` : `${lhs} ${cmp} ?`);
      args.push(col.type === 'text' || col.type === 'json' ? String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase() : this.bind(col, v));
    }
    const words = String(search ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    for (const w of words) { parts.push('EXISTS (SELECT 1 FROM json_each(silo_rows.data) WHERE instr(lower(CAST(value AS TEXT)), ?) > 0)'); args.push(w); }
    return {sql: parts.join(' AND '), args};
  }
  rows(ref, {filters = [], search = '', sort = '', desc = false, limit = 50, offset = 0} = {}) {
    const t = this.table(ref), w = this.where(t, filters, search);
    const n = Math.max(1, Math.min(PAGE_MAX, Math.round(Number(limit)) || 50)), skip = Math.max(0, Math.round(Number(offset)) || 0);
    let order = 'id';
    if (sort) { const {sql, col} = this.expr(t, sort); order = `${col.type === 'text' ? `lower(${sql})` : sql} ${desc ? 'DESC' : 'ASC'}, id`; }
    else if (desc) order = 'id DESC';
    const list = this.prep(`SELECT * FROM silo_rows WHERE ${w.sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...w.args, n, skip).map(r => this.rowView(r));
    const total = !filters.length && !String(search ?? '').trim() ? this.counts.get(t.id) || 0 : this.prep(`SELECT COUNT(*) AS n FROM silo_rows WHERE ${w.sql}`).get(...w.args).n;
    return {table: this.view(t), rows: list, total};
  }
  count(ref, filters = [], search = '') { const t = this.table(ref), w = this.where(t, filters, search); return this.prep(`SELECT COUNT(*) AS n FROM silo_rows WHERE ${w.sql}`).get(...w.args).n; }
  row(ref, id) {
    const t = this.table(ref), n = Number(id);
    if (!Number.isInteger(n) || n < 1) fail('A row id is a whole number from 1.');
    const r = this.sql.row.get(t.id, n);if (!r) fail(`${t.name} has no row ${n}.`, 404);
    return this.rowView(r);
  }

  // Inside a transaction; the count is raised by the caller once it is committed, so a rollback leaves it right.
  insert(t, data, now) {
    const id = this.sql.take.get(1, t.id).next - 1;
    this.sql.add.run(t.id, id, JSON.stringify(data), now, now);
    return id;
  }
  added(t, n) { this.counts.set(t.id, (this.counts.get(t.id) || 0) + n); }
  add(ref, values) {
    const t = this.table(ref);
    if ((this.counts.get(t.id) || 0) >= ROW_MAX) fail(`${t.name} is full: a table keeps at most ${ROW_MAX} rows.`, 409);
    const data = this.clean(t, values), now = Date.now();
    const id = this.tx(() => { this.unique(t, data); return this.insert(t, data, now); });
    this.added(t, 1);this.changed(t);
    return {id, ...data, created: now, updated: now};
  }
  update(ref, id, values) {
    const t = this.table(ref), before = this.row(t.id, id), {id: rid, created, updated, ...base} = before;
    const data = this.clean(t, values, base), now = Date.now();
    if (JSON.stringify(data) === JSON.stringify(base)) return before;
    this.tx(() => { this.unique(t, data, rid); this.sql.set.run(JSON.stringify(data), now, t.id, rid); });
    this.changed(t);
    return {id: rid, ...data, created, updated: now};
  }
  // Changes the row whose match_on column has this value, or adds one when there is none. Two such rows are refused.
  upsert(ref, matchOn, values) {
    const t = this.table(ref), c = this.column(t, matchOn), probe = this.clean({...t, columns: t.columns.map(x => ({...x, required: false}))}, values);
    const v = own(probe, c.name);if (v === undefined) fail(`Give a value for ${c.name}, the column that finds the row.`);
    const found = this.matching(t, c, v);
    if (found.length > 1) fail(`${t.name} has more than one row with ${c.name} ${short(v)} (rows ${found.map(r => r.id).join(' and ')}), so it is not clear which to change.`, 409);
    if (found.length) return {row: this.update(t.id, found[0].id, values), added: false};
    return {row: this.add(t.id, values), added: true};
  }
  remove(ref, ids) {
    const t = this.table(ref), list = [...new Set((Array.isArray(ids) ? ids : [ids]).map(Number))];
    if (!list.length || list.length > 1000 || list.some(n => !Number.isInteger(n) || n < 1)) fail('Give 1 to 1000 row ids.');
    const gone = this.tx(() => list.reduce((n, id) => n + Number(this.sql.remove.run(t.id, id).changes), 0));
    if (!gone) fail(list.length === 1 ? `${t.name} has no row ${list[0]}.` : `${t.name} has none of these rows.`, 404);
    this.counts.set(t.id, Math.max(0, (this.counts.get(t.id) || 0) - gone));this.changed(t);
    return gone;
  }

  // Rows from CSV, all or none: a value that does not fit stops it, with its line. Headers that are not columns are
  // left out and named; id, created and updated (from an export) are left out without a word.
  importCsv(ref, text, {name} = {}) {
    if (String(text ?? '').length > CSV_MAX) fail('A CSV file can have at most 5 MB.');
    const lines = parseCsv(text);
    if (lines.length < 2) fail('The CSV needs a header line and at least one row.');
    if (lines.length - 1 > IMPORT_MAX) fail(`At most ${IMPORT_MAX} rows at once.`);
    const head = lines[0].map(h => h.trim()), body = lines.slice(1);
    let t, made = null;
    if (ref) t = this.table(ref);
    else {
      const names = new Set(), cols = [];
      head.forEach((h, i) => {
        if (!h || RESERVED.has(h.toLowerCase())) return;
        let n = columnName(h, i), k = 2;
        while (names.has(n.toLowerCase()) || RESERVED.has(n.toLowerCase())) n = `${n.slice(0, 37)}_${k++}`;
        names.add(n.toLowerCase());cols.push({name: n, type: guessType(body.map(r => r[i] ?? '')), at: i});
      });
      if (!cols.length) fail('The CSV has no columns to keep.');
      if (cols.length > COLUMN_MAX) fail(`A table has at most ${COLUMN_MAX} columns; this CSV has ${cols.length}.`);
      made = this.create({name: name || 'Imported', columns: cols.map(({at, ...c}) => c)});t = this.table(made.id);
      head.forEach((h, i) => { const c = cols.find(c => c.at === i); head[i] = c ? c.name : ''; });
    }
    const map = head.map(h => { if (!h || RESERVED.has(h.toLowerCase())) return null; return t.columns.find(c => c.name.toLowerCase() === h.toLowerCase()) || undefined; });
    const skipped = head.filter((h, i) => map[i] === undefined && h);
    if (!map.some(Boolean)) { if (made) this.drop(made.id); fail(`None of the headers is a column of ${t.name}. Its columns: ${t.columns.map(c => c.name).join(', ')}.`); }
    if ((this.counts.get(t.id) || 0) + body.length > ROW_MAX) { if (made) this.drop(made.id); fail(`${t.name} would have more than ${ROW_MAX} rows.`, 409); }
    const rows = [];
    try {
      body.forEach((r, n) => {
        const values = {};map.forEach((c, i) => { if (c) values[c.name] = r[i] ?? ''; });
        try { rows.push(this.clean(t, values)); } catch (e) { fail(`Line ${n + 2}: ${e.message}`); }
      });
      // Unique columns: against the rows there and the rows before in the file, without asking the database each time.
      const uniq = t.columns.filter(c => c.unique).map(c => ({c, seen: new Set(this.sql.all.all(t.id).map(r => own(JSON.parse(r.data), c.name)).filter(v => v !== undefined).map(v => this.key(c, v)))}));
      rows.forEach((d, n) => { for (const {c, seen} of uniq) { if (own(d, c.name) === undefined) continue; const k = this.key(c, d[c.name]); if (seen.has(k)) fail(`Line ${n + 2}: ${t.name} already has a row with ${c.name} ${short(d[c.name])}.`, 409); seen.add(k); } });
      const now = Date.now();
      this.tx(() => { for (const d of rows) this.insert(t, d, now); });
      this.added(t, rows.length);
    } catch (e) { if (made) this.drop(made.id); throw e; }
    this.changed(t);
    return {table: this.view(t), added: rows.length, skipped, made: !!made};
  }
  csv(ref) {
    const t = this.table(ref), cols = t.columns.map(c => c.name), out = [['id', ...cols, 'created', 'updated'].join(',')];
    for (const r of this.db.prepare('SELECT * FROM silo_rows WHERE tid = ? ORDER BY id').iterate(t.id)) {
      const d = JSON.parse(r.data);
      out.push([r.id, ...cols.map(c => csvCell(own(d, c))), new Date(r.created).toISOString(), new Date(r.updated).toISOString()].join(','));
    }
    return {name: t.name, text: out.join('\r\n') + '\r\n'};
  }
}
