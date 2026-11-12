import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs, existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {StateStore} from '../storage.mjs';

const world = () => ({version: 4, settings: {theme: 'crt'}, agents: [{id: 'a1', name: 'Atlas'}, {id: 'a2', name: 'Echo'}], runs: [], events: [], traces: [], workflows: [], users: []});
const tempDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'silo-store-'));
const readJson = async dir => JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));

test('restarts from SQLite with the newest-first order and every row intact', async t => {
  const dir = await tempDir();t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const a = new StateStore(dir);
  const s = a.load(world);
  for (let i = 0; i < 5; i++) { s.runs.unshift({id: 'r' + i, n: i}); s.events.unshift({id: 'e' + i, title: 'E' + i}); await a.save(s); }
  s.agents[1].name = 'Echo II';
  s.events.push({title: 'no id'}, {id: 'e1', title: 'repeated id'}, {id: 0, title: 'zero id'});
  s.agents.splice(0, 1);
  await a.save(s);
  a.close();
  const b = new StateStore(dir);
  const back = b.load(() => assert.fail('must not start a new world'));
  assert.equal(b.loadedFrom, 'tables');
  assert.deepEqual(back.runs.map(r => r.id), ['r4', 'r3', 'r2', 'r1', 'r0']);
  assert.deepEqual(back, JSON.parse(JSON.stringify(s)));
  b.close();
});

test('writes state.json only now and then, and always on close', async t => {
  const dir = await tempDir();t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const st = new StateStore(dir, {jsonEvery: 3_600_000, snapshotEvery: 3_600_000});
  const s = st.load(world);
  await st.save(s);await st.jsonWriting;
  assert.equal((await readJson(dir)).agents[0].name, 'Atlas', 'the first save writes the readable copy');
  s.agents[0].name = 'Atlas II';await st.save(s);
  assert.equal((await readJson(dir)).agents[0].name, 'Atlas', 'later saves only touch SQLite');
  st.close();
  assert.equal((await readJson(dir)).agents[0].name, 'Atlas II', 'close writes the latest state');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'state.json.bak'), 'utf8')).agents[0].name, 'Atlas', 'the copy before it is kept');
  await assert.rejects(st.save(s), /closed/);
});

test('a state.json replaced by hand wins over SQLite; a damaged one does not', async t => {
  const dir = await tempDir();t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const a = new StateStore(dir);const s = a.load(world);await a.save(s);a.close();
  const edited = {...world(), agents: [{id: 'z', name: 'Restored'}]};
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(edited));
  const b = new StateStore(dir);
  assert.equal(b.load(world).agents[0].name, 'Restored');assert.equal(b.loadedFrom, 'json');b.close();
  await fs.writeFile(path.join(dir, 'state.json'), '{broken');
  const c = new StateStore(dir);
  assert.equal(c.load(world).agents[0].name, 'Restored');assert.equal(c.loadedFrom, 'tables');c.close();
});

test('a damaged database is moved aside and the state comes back from state.json', async t => {
  const dir = await tempDir();t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const a = new StateStore(dir);const s = a.load(world);s.agents[0].name = 'Kept';await a.save(s);a.close();
  await fs.writeFile(path.join(dir, 'state.db'), 'this is not a database'.repeat(100));
  const b = new StateStore(dir);
  assert.equal(b.load(world).agents[0].name, 'Kept');
  assert.ok(b.damaged && existsSync(b.damaged), 'the damaged file is kept for inspection');
  b.close();
});

test('a row that no longer matches its checksum is not trusted', async t => {
  const dir = await tempDir();t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const a = new StateStore(dir);const s = a.load(world);await a.save(s);a.close();
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.prepare("UPDATE collection_rows SET data = ? WHERE collection = 'agents' AND id = 'i:a1'").run('{"id":"a1","name":"Tampered"}');db.close();
  const b = new StateStore(dir);
  assert.equal(b.load(world).agents[0].name, 'Atlas');assert.equal(b.loadedFrom, 'json');b.close();
});

test('moves a data folder from the first storage format', async t => {
  const dir = await tempDir();t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const old = {...world(), runs: [{id: 'new'}, {id: 'old'}]};
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(old, null, 2));
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);INSERT INTO schema_migrations VALUES (1, 0);
    CREATE TABLE collection_rows (collection TEXT NOT NULL, id TEXT NOT NULL, sha256 TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (collection, id));
    INSERT INTO collection_rows VALUES ('runs','old','x',0,'{"id":"old"}'),('runs','new','x',0,'{"id":"new"}');`);db.close();
  const a = new StateStore(dir);
  assert.deepEqual(a.load(world).runs.map(r => r.id), ['new', 'old']);assert.equal(a.loadedFrom, 'json');a.close();
  const b = new StateStore(dir);
  assert.deepEqual(b.load(world).runs.map(r => r.id), ['new', 'old']);assert.equal(b.loadedFrom, 'tables');b.close();
});

test('keeps a few verified snapshots', async t => {
  const dir = await tempDir();t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const st = new StateStore(dir);const s = st.load(world);
  let id;for (let i = 0; i < 6; i++) id = st.createBackup(s);
  assert.ok(st.verifyBackup(id));assert.ok(st.verifyBackup());
  assert.equal(st.db.prepare('SELECT COUNT(*) AS n FROM state_backups').get().n, 3);
  st.close();
});

test('state.json.bak copied back by hand is loaded', async t => {
  const dir = await tempDir();t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const a = new StateStore(dir);const s = a.load(world);await a.save(s);await a.jsonWriting;
  s.agents[0].name = 'Later';a.close();
  await fs.copyFile(path.join(dir, 'state.json.bak'), path.join(dir, 'state.json'));
  const b = new StateStore(dir);
  assert.equal(b.load(world).agents[0].name, 'Atlas');assert.equal(b.loadedFrom, 'json');b.close();
});
