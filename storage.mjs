import {DatabaseSync} from 'node:sqlite';
import {promises as fs, existsSync, readFileSync, writeFileSync, renameSync, copyFileSync, unlinkSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

// SQLite is the source of truth: every save writes only the rows that changed, in one transaction.
// state.json is a readable copy written every few minutes and on shutdown, and state.json.bak is the copy before it.
// A full snapshot also goes into SQLite once an hour, so a bad state can be rolled back further than one copy.
const COLLECTIONS = ['agents', 'workflows', 'runs', 'jobs', 'goals', 'grants', 'events', 'proposals', 'requests', 'users', 'channels', 'mcp', 'traces', 'meetings', 'templates'];
const JSON_EVERY = 5 * 60_000;
const SNAPSHOT_EVERY = 60 * 60_000;
const SNAPSHOTS_KEPT = 3;
// A row that is finished (a completed run, an old event) and has not changed for SETTLE_MS is not serialized again on
// every save. A save that names it (save(state, [row])) still writes it, and every VERIFY_EVERY all rows are compared
// again, so a change nobody named reaches the file within that time, and always on close.
const SETTLE_MS = 10_000;
const VERIFY_EVERY = 60_000;
const SCHEMA = 2;

const validState = s => !!s && typeof s === 'object' && Array.isArray(s.agents);
// Row keys: the item's own id, or its position when it has none or repeats one, so no two rows share a key.
function rowKeys(list) {
  const seen = new Set();
  return list.map((item, i) => {
    const own = item && (typeof item.id === 'string' || typeof item.id === 'number') && String(item.id) !== '' ? 'i:' + item.id : null;
    const key = own && !seen.has(own) ? own : '#' + i;
    seen.add(key);
    return key;
  });
}

export class StateStore {
  // settled(collection, row): whether the row is finished. Without it every row is compared on every save, as before.
  constructor(dataDir, {jsonEvery = JSON_EVERY, snapshotEvery = SNAPSHOT_EVERY, settled = null, settleMs = SETTLE_MS, verifyEvery = VERIFY_EVERY} = {}) {
    this.dir = dataDir;
    this.settled = settled;
    this.settleMs = settleMs;
    this.verifyEvery = verifyEvery;
    // row object -> {key, hash, since, seen}: the last hash of the row while it was finished, when that hash was first
    // seen and when it was last serialized and found the same. A row is skipped once those two are SETTLE_MS apart.
    this.quiet = new WeakMap();
    this.touched = new Set();
    this.lastVerifyAt = Date.now();
    this.stats = {saves: 0, lastMs: 0, maxMs: 0, avgMs: 0, rows: 0, serialized: 0, skipped: 0, written: 0, bytes: 0, verifies: 0, missed: 0, lastMissed: null};
    // Called with {col, id} when a full comparison finds a settled row that changed without being named in save().
    this.onMissed = null;
    this.jsonFile = path.join(dataDir, 'state.json');
    this.bakFile = path.join(dataDir, 'state.json.bak');
    this.dbFile = path.join(dataDir, 'state.db');
    this.jsonEvery = jsonEvery;
    this.snapshotEvery = snapshotEvery;
    this.db = null;
    this.rowHashes = new Map();
    this.state = null;
    this.pendingState = null;
    this.writing = Promise.resolve();
    this.flushScheduled = false;
    this.flushResolvers = [];
    this.jsonDirty = false;
    this.jsonWriting = null;
    this.lastJsonAt = 0;
    this.lastSnapshotAt = 0;
    this.closed = false;
    this.timer = null;
  }

  init() {
    if (this.db) return;
    mkdirSync(this.dir, {recursive: true});
    this.db = this.open();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_rows (collection TEXT NOT NULL, id TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id));
      CREATE TABLE IF NOT EXISTS state_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, snapshot TEXT NOT NULL);
    `);
    const q = sql => this.db.prepare(sql);
    this.sql = {
      migrated: q('SELECT MAX(version) AS v FROM schema_migrations'),
      migrate: q('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)'),
      getKv: q('SELECT value, sha256 FROM kv_store WHERE key = ?'),
      putKv: q(`INSERT INTO kv_store (key, sha256, updated_at, value) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET sha256 = excluded.sha256, updated_at = excluded.updated_at, value = excluded.value`),
      putRow: q(`INSERT INTO collection_rows (collection, id, sha256, updated_at, data) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET sha256 = excluded.sha256, updated_at = excluded.updated_at, data = excluded.data`),
      rowIds: q('SELECT id FROM collection_rows WHERE collection = ?'),
      rows: q('SELECT id, sha256, data FROM collection_rows WHERE collection = ?'),
      dropRow: q('DELETE FROM collection_rows WHERE collection = ? AND id = ?'),
      dropOtherCollections: q(`DELETE FROM collection_rows WHERE collection NOT IN (${COLLECTIONS.map(() => '?').join(',')})`),
      addSnapshot: q('INSERT INTO state_backups (created_at, sha256, bytes, snapshot) VALUES (?, ?, ?, ?)'),
      lastSnapshots: q('SELECT id, sha256, snapshot FROM state_backups ORDER BY id DESC LIMIT ?'),
      snapshot: q('SELECT sha256, snapshot FROM state_backups WHERE id = ?'),
      trimSnapshots: q('DELETE FROM state_backups WHERE id NOT IN (SELECT id FROM state_backups ORDER BY id DESC LIMIT ?)'),
      lastSnapshotAt: q('SELECT MAX(created_at) AS t FROM state_backups'),
    };
    this.lastSnapshotAt = Number(this.sql.lastSnapshotAt.get()?.t) || 0;
  }

  // Opens the database and checks it. A damaged file is moved aside, not deleted, and a new one is started.
  open() {
    const pragmas = 'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;';
    let db = null;
    try {
      db = new DatabaseSync(this.dbFile);
      db.exec(pragmas);
      if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new Error('quick_check failed');
      return db;
    } catch {
      try { db?.close(); } catch {}
      const aside = `${this.dbFile}.damaged-${Date.now()}`;
      for (const ext of ['', '-wal', '-shm']) { try { renameSync(this.dbFile + ext, aside + ext); } catch {} }
      this.damaged = aside;
      db = new DatabaseSync(this.dbFile);
      db.exec(pragmas);
      return db;
    }
  }

  readJson(file) {
    try {
      if (!existsSync(file)) return null;
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return validState(parsed) ? {state: parsed, sha: sha256(raw)} : null;
    } catch { return null; }
  }

  // Newest good copy wins: the SQLite rows, unless state.json was replaced by hand (or comes from before SQLite
  // kept the order of rows). Then the snapshots, then state.json.bak, then a new world.
  load(fallbackFactory) {
    this.init();
    const json = this.readJson(this.jsonFile);
    const version = Number(this.sql.migrated.get()?.v) || 0;
    const ours = this.knownJson();
    let state = null, source = '';
    if (json && (version < SCHEMA || !ours.includes(json.sha))) { state = json.state; source = 'json'; }
    if (!state) { try { state = this.reconstructFromTables(); if (state) source = 'tables'; } catch { state = null; } }
    if (!state && json) { state = json.state; source = 'json'; }
    if (!state) {
      for (const row of this.sql.lastSnapshots.all(SNAPSHOTS_KEPT + 2)) {
        try { if (sha256(row.snapshot) === row.sha256) { const s = JSON.parse(row.snapshot); if (validState(s)) { state = s; source = 'snapshot'; break; } } } catch {}
      }
    }
    if (!state) { const bak = this.readJson(this.bakFile); if (bak) { state = bak.state; source = 'bak'; } }
    if (!state) { state = fallbackFactory(); source = 'new'; }
    this.loadedFrom = source;
    this.state = state;
    this.syncToSqlite(state, {full: source !== 'tables'});
    this.sql.migrate.run(SCHEMA, Date.now());
    // The rows now match state.json, so on the next start it counts as a copy written here, not one replaced by hand.
    if (source === 'json') this.rememberJson(json.sha);
    // A state that did not come from state.json is written there now, so the readable copy is never behind on start.
    this.jsonDirty = source !== 'json';
    this.startTimer();
    return state;
  }

  reconstructFromTables() {
    this.init();
    const meta = this.sql.getKv.get('root_meta');
    if (!meta) return null;
    const base = JSON.parse(meta.value);
    if (!base || typeof base !== 'object') return null;
    for (const col of COLLECTIONS) {
      const saved = this.sql.getKv.get('order:' + col), order = saved ? JSON.parse(saved.value) : null;
      const rows = this.sql.rows.all(col);
      // No order saved: a database from before order was kept, so the rows cannot be put back in order.
      if (!saved && rows.length) return null;
      if (!Array.isArray(order)) { if (rows.length) throw new Error(`Rows of ${col} have no order.`); this.rowHashes.set('order:' + col, 'null'); continue; }
      const byKey = new Map();
      for (const r of rows) {
        if (sha256(r.data) !== r.sha256) throw new Error(`Row ${col}/${r.id} does not match its checksum.`);
        byKey.set(r.id, r);
      }
      if (order.length !== byKey.size || order.some(k => !byKey.has(k))) throw new Error(`Rows of ${col} are incomplete.`);
      base[col] = order.map(k => JSON.parse(byKey.get(k).data));
      for (const k of order) this.rowHashes.set(`${col}\u0000${k}`, byKey.get(k).sha256);
      this.rowHashes.set('order:' + col, JSON.stringify(order));
    }
    this.rowHashes.set('kv:root_meta', meta.sha256);
    return validState(base) ? base : null;
  }

  // Writes the rows that changed since the last save and says whether anything was written.
  // full: compare against what is in the file, not the cache. verify: serialize every row, settled or not.
  syncToSqlite(state, {full = false, verify = false} = {}) {
    this.init();
    if (full) this.rowHashes.clear();
    const now = Date.now(), started = performance.now(), touched = this.touched;
    verify = verify || full || !this.settled || now - this.lastVerifyAt >= this.verifyEvery;
    this.touched = new Set();
    let changed = false, rows = 0, serialized = 0, skipped = 0, written = 0, bytes = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rootMeta = {};
      for (const [k, v] of Object.entries(state)) if (!COLLECTIONS.includes(k)) rootMeta[k] = v;
      const metaJson = JSON.stringify(rootMeta), metaHash = sha256(metaJson);
      if (this.rowHashes.get('kv:root_meta') !== metaHash) {
        this.sql.putKv.run('root_meta', metaHash, now, metaJson);
        changed = true;
        this.rowHashes.set('kv:root_meta', metaHash);
      }
      for (const col of COLLECTIONS) {
        const present = Array.isArray(state[col]), list = present ? state[col] : [];
        const keys = rowKeys(list);
        for (let i = 0; i < list.length; i++) {
          const item = list[i], cacheKey = `${col}\u0000${keys[i]}`, obj = item && typeof item === 'object';
          rows++;
          const done = obj && this.settled ? this.settled(col, item) : false, q = done ? this.quiet.get(item) : null;
          const quiet = q && q.key === cacheKey && q.seen - q.since >= this.settleMs && !touched.has(item) && this.rowHashes.get(cacheKey) === q.hash;
          if (!verify && quiet) { skipped++; continue; }
          const json = JSON.stringify(item ?? null), h = sha256(json);
          serialized++; bytes += json.length;
          // A row that would have been skipped but changed: the code that changed it did not name it. It is written now,
          // and counted, so the place that forgot can be found (the tests fail on it).
          if (quiet && h !== q.hash) { const id = item.id ?? keys[i]; this.stats.missed++; this.stats.lastMissed = {col, id, at: now}; try { this.onMissed?.({col, id}); } catch {} }
          if (this.rowHashes.get(cacheKey) !== h) {
            this.sql.putRow.run(col, keys[i], h, now, json);
            changed = true; written++;
            this.rowHashes.set(cacheKey, h);
          }
          if (done) { if (q && q.key === cacheKey && q.hash === h) q.seen = now; else this.quiet.set(item, {key: cacheKey, hash: h, since: now, seen: now}); }
          else if (obj) this.quiet.delete(item);
        }
        const order = present ? JSON.stringify(keys) : 'null';
        if (full || this.rowHashes.get('order:' + col) !== order) {
          const keep = new Set(keys);
          for (const {id} of this.sql.rowIds.all(col)) {
            if (!keep.has(id)) { this.sql.dropRow.run(col, id); this.rowHashes.delete(`${col}\u0000${id}`); }
          }
          this.sql.putKv.run('order:' + col, sha256(order), now, order);
          changed = true;
          this.rowHashes.set('order:' + col, order);
        }
      }
      if (full) this.sql.dropOtherCollections.run(...COLLECTIONS);
      this.db.exec('COMMIT');
      if (verify) { this.lastVerifyAt = now; this.stats.verifies++; }
      const ms = performance.now() - started, st = this.stats;
      st.saves++; st.lastMs = ms; st.maxMs = Math.max(st.maxMs, ms); st.avgMs = st.saves === 1 ? ms : st.avgMs * .9 + ms * .1;
      Object.assign(st, {rows, serialized, skipped, written, bytes});
      return changed;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.rowHashes.clear();
      this.quiet = new WeakMap();
      for (const t of touched) this.touched.add(t);
      throw e;
    }
  }

  // Rows changed where no save follows at once (a span that ends after its trace): written by the next save even if
  // they look settled.
  touch(...rows) { for (const t of rows) if (t && typeof t === 'object') this.touched.add(t); }

  // Resolves once the change is committed to SQLite. Saves in the same tick are written once.
  // touched: rows changed by this save that may be finished, so they are written even if they look settled.
  save(state, touched) {
    if (this.closed) return Promise.reject(new Error('The state store is closed.'));
    this.state = state;
    this.pendingState = state;
    if (touched) for (const t of touched) if (t && typeof t === 'object') this.touched.add(t);
    return new Promise((resolve, reject) => {
      this.flushResolvers.push({resolve, reject});
      if (this.flushScheduled) return;
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        const target = this.pendingState, batch = this.flushResolvers.splice(0);
        this.pendingState = null;
        this.writing = this.writing.catch(() => {}).then(() => {
          try {
            if (this.closed) throw new Error('The state store is closed.');
            if (this.syncToSqlite(target)) this.jsonDirty = true;
            this.maintain();
            for (const r of batch) r.resolve();
          } catch (err) {
            for (const r of batch) r.reject(err);
          }
        });
      });
    });
  }

  // What the timer does: a save when a row was touched or the full comparison is due, so a change to a settled row
  // reaches SQLite even if no other save follows, then the periodic copies.
  tick(now = Date.now()) {
    if (this.closed || !this.state) return;
    if (this.settled && !this.flushScheduled && (this.touched.size || now - this.lastVerifyAt >= this.verifyEvery)) { this.save(this.state).catch(() => {}); return; }
    this.maintain(now);
  }

  // The periodic copies: state.json every few minutes, a SQLite snapshot every hour.
  maintain(now = Date.now()) {
    if (this.closed || !this.state) return;
    if (this.jsonDirty && !this.jsonWriting && now - this.lastJsonAt >= this.jsonEvery) this.writeJson().catch(() => {});
    if (now - this.lastSnapshotAt >= this.snapshotEvery) { try { this.createBackup(this.state); } catch {} }
  }

  startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), Math.min(60_000, Math.max(1000, Math.min(this.jsonEvery / 5, this.verifyEvery / 2))));
    this.timer.unref?.();
  }

  // Remembers the hash of state.json, so on start a copy written here is told apart from one replaced by hand
  // (state.json.bak copied back counts as by hand). While a copy is being written both hashes count, in case of a crash.
  knownJson() { try { return JSON.parse(this.sql.getKv.get('json_shas')?.value || '[]'); } catch { return []; } }
  rememberJson(sha, writing = false) {
    const next = JSON.stringify(writing ? [...new Set([...this.knownJson().slice(0, 1), sha])] : [sha]);
    this.sql.putKv.run('json_shas', sha256(next), Date.now(), next);
  }

  async writeJson() {
    if (this.closed || !this.state) return;
    this.jsonDirty = false;
    this.lastJsonAt = Date.now();
    const text = JSON.stringify(this.state, null, 2), sha = sha256(text);
    const tmp = `${this.jsonFile}.${process.pid}.${Date.now()}.tmp`;
    this.jsonWriting = (async () => {
      try {
        this.rememberJson(sha, true);
        await fs.writeFile(tmp, text, {encoding: 'utf8', mode: 0o600});
        // Closed meanwhile: close() already wrote a newer copy, which this older one must not replace.
        if (this.closed) { await fs.unlink(tmp).catch(() => {}); return; }
        await fs.copyFile(this.jsonFile, this.bakFile).catch(() => {});
        if (this.closed) { await fs.unlink(tmp).catch(() => {}); return; }
        await fs.rename(tmp, this.jsonFile);
        this.rememberJson(sha);
      } catch (e) {
        this.jsonDirty = true;
        await fs.unlink(tmp).catch(() => {});
        throw e;
      } finally { this.jsonWriting = null; }
    })();
    return this.jsonWriting;
  }

  createBackup(state) {
    this.init();
    const snapshot = JSON.stringify(state), digest = sha256(snapshot), now = Date.now();
    const res = this.sql.addSnapshot.run(now, digest, Buffer.byteLength(snapshot), snapshot);
    this.sql.trimSnapshots.run(SNAPSHOTS_KEPT);
    this.lastSnapshotAt = now;
    return Number(res.lastInsertRowid);
  }

  verifyBackup(backupId) {
    this.init();
    const row = backupId ? this.sql.snapshot.get(backupId) : this.sql.lastSnapshots.get(1);
    return !!row && sha256(row.snapshot) === row.sha256;
  }

  // Synchronous, so it also works from process.on('exit'): the last change goes to SQLite and state.json.
  close() {
    if (this.closed) return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.db && this.state) {
      try { if (this.syncToSqlite(this.state, {verify: true})) this.jsonDirty = true; } catch {}
      if (this.jsonDirty || this.jsonWriting) {
        const text = JSON.stringify(this.state, null, 2), tmp = `${this.jsonFile}.${process.pid}.close.tmp`;
        try {
          const sha = sha256(text);
          this.rememberJson(sha, true);
          writeFileSync(tmp, text, {encoding: 'utf8', mode: 0o600});
          try { copyFileSync(this.jsonFile, this.bakFile); } catch {}
          renameSync(tmp, this.jsonFile);
          this.rememberJson(sha);
          this.jsonDirty = false;
        } catch { try { unlinkSync(tmp); } catch {} }
      }
    }
    this.closed = true;
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}
