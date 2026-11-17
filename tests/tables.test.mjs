// Tables: the store on its own (values by kind, CSV, column changes, ids, a damaged file), the API, table steps in
// workflows (rows kept between runs, the same row changed again, renamed columns followed, a table in use kept) and
// residents that read rows freely and change them only after an OK.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tables, cellValue, parseCsv, columnName } from '../data-tables.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('Timed out waiting for ' + what); await wait(50); } }

test('the table store', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-tables-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  await t.test('values are kept by the kind of their column, and refused when they do not fit', () => {
    const num = { name: 'n', type: 'number' }, yes = { name: 'b', type: 'boolean' }, day = { name: 'd', type: 'date' };
    assert.equal(cellValue(num, '3,5'), 3.5); assert.equal(cellValue(num, '1 200'), 1200); assert.equal(cellValue(num, 7), 7);
    assert.throws(() => cellValue(num, 'seven'), /takes a number/); assert.throws(() => cellValue(num, true), /takes a number/);
    assert.equal(cellValue(yes, 'da'), true); assert.equal(cellValue(yes, 'No'), false); assert.throws(() => cellValue(yes, 'maybe'), /yes or no/);
    assert.equal(cellValue(day, '2026-11-15'), '2026-11-15'); assert.equal(cellValue(day, '5.1.2026'), '2026-01-05');
    assert.equal(cellValue(day, '2026-11-15T09:30:00Z'), '2026-11-15T09:30:00.000Z');
    assert.throws(() => cellValue(day, '2026-02-31'), /date like/); assert.throws(() => cellValue(day, 'tomorrow'), /date like/);
    assert.throws(() => cellValue(day, 1e20), /date like/);
    assert.deepEqual(cellValue({ name: 'j', type: 'json' }, '{"a":[1]}'), { a: [1] });
    assert.equal(cellValue({ name: 't', type: 'text' }, '   '), null, 'empty is no value');
    assert.throws(() => cellValue({ name: 't', type: 'text' }, 'x'.repeat(5001)), /longer than 5000/);
  });

  await t.test('CSV as spreadsheets write it', () => {
    assert.deepEqual(parseCsv('﻿a;b\r\n"x; y";"say ""hi"""\r\n\r\n1;"two\nlines"\n'), [['a', 'b'], ['x; y', 'say "hi"'], ['1', 'two\nlines']]);
    assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
    assert.equal(columnName('Vârstă (ani)', 0), 'Varsta_ani'); assert.equal(columnName('2024', 1), 'c_2024'); assert.equal(columnName('!!', 2), 'column_3');
  });

  await t.test('rows, unique values, changes of columns and ids that are never given again', () => {
    const T = new Tables(dir).open();
    assert.throws(() => T.create({ name: 'Bad', columns: [{ name: 'id' }] }), /kept for SILO/);
    assert.throws(() => T.create({ name: 'Bad', columns: [{ name: 'a b' }] }), /letters, digits and _/);
    const leads = T.create({ name: 'Leads', columns: [{ name: 'email', type: 'text', unique: true, required: true }, { name: 'score', type: 'number' }] });
    assert.throws(() => T.create({ name: 'leads', columns: [{ name: 'x' }] }), /already a table called/);
    assert.equal(T.add('Leads', { email: 'Ana@x.ro', score: '2' }).id, 1);
    assert.throws(() => T.add('leads', { email: 'ana@X.RO' }), e => e.status === 409 && /already has a row with email/.test(e.message));
    assert.throws(() => T.add('Leads', { score: 1 }), /needs email/);
    assert.throws(() => T.add('Leads', { email: 'b@x', nope: 1 }), /no column "nope"/);
    const up = T.upsert('Leads', 'email', { email: 'ANA@x.ro', score: 9 });
    assert.equal(up.added, false); assert.equal(up.row.id, 1); assert.equal(up.row.score, 9);
    assert.equal(T.upsert('Leads', 'email', { email: 'bo@x.ro', score: 1 }).added, true);
    assert.deepEqual(T.rows('Leads', { filters: [{ column: 'score', op: 'gte', value: '5' }] }).rows.map(r => r.email), ['ANA@x.ro']);
    assert.equal(T.rows('Leads', { search: 'BO@' }).total, 1);
    assert.deepEqual(T.rows('Leads', { sort: 'score', desc: true }).rows.map(r => r.score), [9, 1]);
    assert.throws(() => T.rows('Leads', { filters: [{ column: 'nope', value: 1 }] }), /no column "nope"/);
    assert.throws(() => T.change('Leads', { columns: [{ name: 'email', type: 'number' }, { name: 'score', type: 'number' }] }), /were not changed: row 1: email takes a number/);
    const renamed = T.change('Leads', { columns: [{ name: 'mail', was: 'email', type: 'text', unique: true }, { name: 'score', type: 'text' }, { name: 'note', type: 'text' }] });
    assert.deepEqual(renamed.columns.map(c => c.name), ['mail', 'score', 'note']);
    assert.deepEqual(T.row('Leads', 1), { ...T.row('Leads', 1), mail: 'ANA@x.ro', score: '9' }, 'values kept under the new name and kind');
    assert.throws(() => T.change('Leads', { columns: [{ name: 'mail', type: 'text', required: true }, { name: 'note', type: 'text', required: true }] }), /row 1 has no note/);
    assert.equal(T.remove('Leads', [2]), 1);
    assert.equal(T.add('Leads', { mail: 'cy@x.ro' }).id, 3, 'the id of a deleted row is not given again');
    // A column named like something every object has is a column like any other.
    T.create({ name: 'Races', columns: [{ name: 'constructor', type: 'text', required: true }, { name: 'toString', type: 'text', unique: true }] });
    assert.throws(() => T.add('Races', { toString: 'a' }), /needs constructor/);
    T.add('Races', { constructor: 'Ferrari' }); T.add('Races', { constructor: 'McLaren' });
    assert.match(T.csv('Races').text, /^1,Ferrari,,/m);
    T.close();
    const again = new Tables(dir).open();
    assert.equal(again.list().find(x => x.id === leads.id).rows, 2, 'kept after closing');
    again.close();
  });

  await t.test('CSV in and out: all rows or none, formulas never run in a spreadsheet', () => {
    const T = new Tables(dir).open();
    const made = T.importCsv(null, 'Nume;Vârstă;Activ;Data\n"Pop, Ion";30;da;2026-01-02\nMaria;41;nu;2026-02-03\n', { name: 'People' });
    assert.equal(made.made, true); assert.equal(made.added, 2);
    assert.deepEqual(made.table.columns.map(c => [c.name, c.type]), [['Nume', 'text'], ['Varsta', 'number'], ['Activ', 'boolean'], ['Data', 'date']]);
    assert.throws(() => T.importCsv('People', 'Nume,Varsta\nAna,30\nBo,old\n'), /Line 3: Varsta takes a number/);
    assert.equal(T.table('People') && T.rows('People').total, 2, 'a failed file adds nothing');
    const more = T.importCsv('People', 'id,Nume,Other\n9,=HYPERLINK("x"),1\n');
    assert.deepEqual(more.skipped, ['Other']); assert.equal(more.added, 1);
    const csv = T.csv('People').text;
    assert.match(csv, /^id,Nume,Varsta,Activ,Data,created,updated\r\n1,"Pop, Ion",30,true,2026-01-02,/);
    assert.match(csv, /"'=HYPERLINK\(""x""\)"/, 'a formula gets a quote mark first');
    assert.throws(() => T.importCsv(null, 'id\n1\n', { name: 'Only ids' }), /no columns to keep/);
    assert.ok(!T.list().some(x => x.name === 'Only ids'));
    // A write that fails halfway through the file (a full disk) rolls it all back, and the count stays right.
    const run = T.sql.add.run, before = T.rows('People').total;let n = 0;
    T.sql.add.run = (...a) => { if (++n === 2) throw new Error('disk full'); return run.apply(T.sql.add, a); };
    try { assert.throws(() => T.importCsv('People', 'Nume\nA\nB\nC\n'), /disk full/); } finally { T.sql.add.run = run; }
    assert.equal(T.list().find(x => x.name === 'People').rows, before, 'the count is not raised by rows that were rolled back');
    assert.equal(T.count('People'), before);
    T.close();
  });

  await t.test('matching on a column uses an index of its own, made outside a transaction and gone with the column', () => {
    const other = path.join(dir, 'indexed'), T = new Tables(other).open();
    const idx = () => T.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'silo!_u!_%' ESCAPE '!'").all().map(r => r.name);
    const tb = T.create({ name: 'Mail', columns: [{ name: 'Email', type: 'text', unique: true }, { name: 'n', type: 'number' }] });
    // The first row is refused inside its transaction only after the index was made before it, so the rollback keeps it.
    T.add('Mail', { Email: 'Ana@x.ro', n: 1 });
    assert.throws(() => T.add('Mail', { Email: 'ana@X.ro' }), /already has a row with Email/);
    assert.equal(idx().length, 1, 'one index, for the unique column');
    const plan = T.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM silo_rows WHERE tid = '${tb.id}' AND id <> ? AND lower(json_extract(data, '$.Email')) = lower(?) ORDER BY id LIMIT 2`).all(0, 'x').map(r => r.detail).join(' ');
    assert.match(plan, /USING INDEX silo_u_/);
    assert.equal(T.upsert('Mail', 'n', { n: 1, Email: 'ana@x.ro' }).added, false, 'a number column is matched too');
    assert.equal(idx().length, 2);
    assert.equal(T.upsert('Mail', 'Email', { Email: 'ANA@x.ro', n: 5 }).row.n, 5);
    // Renamed: the old indexes go, the rules still hold with the new name.
    T.change('Mail', { columns: [{ name: 'Mail', was: 'Email', type: 'text', unique: true }, { name: 'n', type: 'number' }] });
    assert.equal(idx().length, 0);
    assert.throws(() => T.add('Mail', { Mail: 'ana@x.ro' }), /already has a row with Mail/);
    assert.equal(T.add('Mail', { Mail: 'ion@x.ro' }).Mail, 'ion@x.ro');
    assert.equal(idx().length, 1);
    // An index left by a table that is gone is cleared when the file is opened again.
    T.db.exec(`CREATE INDEX "silo_u_${'0'.repeat(32)}_abc" ON silo_rows (id) WHERE tid = 'gone'`);
    T.close(); const again = new Tables(other).open();
    assert.deepEqual(again.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'silo!_u!_0000%' ESCAPE '!'").all(), []);
    assert.throws(() => again.add('Mail', { Mail: 'ION@x.ro' }), /already has a row/);
    again.drop('Mail');
    assert.deepEqual(again.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'silo!_u!_%' ESCAPE '!'").all(), [], 'a dropped table takes its indexes');
    again.close();
  });

  await t.test('a damaged file is moved aside and a new one started', async () => {
    const other = path.join(dir, 'broken'); await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'tables.db'), 'this is not a database, it only looks like one '.repeat(200));
    const T = new Tables(other).open();
    assert.ok(T.damaged && (await fs.stat(T.damaged)).isFile());
    assert.equal(T.create({ name: 'Fresh', columns: [{ name: 'a' }] }).rows, 0);
    T.close();
  });
});

test('tables in SILO: the API, table steps and residents', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-tablesrv-'));
  const port = 14467, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token };
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const runs = async () => (await request('/state')).data.runs;
  const finished = async id => { for (let i = 0; i < 200; i++) { const run = (await runs()).find(r => r.id === id); if (run && !['running', 'retrying', 'queued'].includes(run.status)) return run; await wait(100); } throw Error('The run did not finish.'); };
  const start = async (wid, input = 'go') => { const r = await request('/workflows/' + wid + '/run', { input }); assert.ok(r.status < 300, JSON.stringify(r.data)); return finished(r.data.id); };

  let leads;
  await t.test('the API makes tables, keeps rows, filters them and gives them as CSV', async () => {
    const made = await request('/tables', { name: 'Leads', columns: [{ name: 'email', type: 'text', unique: true, required: true }, { name: 'name' }, { name: 'visits', type: 'number' }] });
    assert.equal(made.status, 201, JSON.stringify(made.data)); leads = made.data;
    assert.equal((await request(`/tables/${leads.id}/rows`, { values: { email: 'ana@example.com', name: 'Ana', visits: 1 } })).status, 201);
    const dup = await request('/tables/Leads/rows', { values: { email: 'ANA@example.com' } });
    assert.equal(dup.status, 409); assert.match(dup.data.error, /already has a row with email/);
    const up = await request('/tables/leads/rows', { matchOn: 'email', values: { email: 'Ana@Example.com', visits: '2' } });
    assert.equal(up.status, 200); assert.equal(up.data.added, false); assert.equal(up.data.row.visits, 2);
    assert.equal((await request(`/tables/${leads.id}/rows`, { matchOn: 'email', values: { email: 'bo@example.com', name: 'Bo', visits: 7 } })).status, 201);
    const found = await request(`/tables/${leads.id}/rows?filters=${encodeURIComponent(JSON.stringify([{ column: 'visits', op: 'gt', value: 3 }]))}`);
    assert.deepEqual(found.data.rows.map(r => r.name), ['Bo']); assert.equal(found.data.total, 1);
    assert.equal((await request(`/tables/${leads.id}/rows?filters=nope`)).status, 400);
    assert.equal((await request(`/tables/${leads.id}/rows/99`)).status, 404);
    assert.equal((await request('/state')).data.tables.find(x => x.id === leads.id).rows, 2, 'the state lists tables with their rows');
    const csv = await fetch(`${api}/api/tables/${leads.id}/csv`, { headers });
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), /Leads\.csv/);
    const bytes = Buffer.from(await csv.arrayBuffer()); assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a byte order mark for Excel');
    assert.match(bytes.toString('utf8'), /\r\n1,Ana@Example\.com,Ana,2,/, 'the row as the upsert left it');
    const imp = await fetch(`${api}/api/tables/import?name=Prices`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/csv' }, body: 'product,price\nTea,"4,5"\nCoffee,6\n' });
    const imported = await imp.json(); assert.equal(imp.status, 201, JSON.stringify(imported));
    assert.deepEqual(imported.table.columns.map(c => c.type), ['text', 'number']); assert.equal(imported.added, 2);
    const bad = await fetch(`${api}/api/tables/Prices/import`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/csv' }, body: 'product,price\nCake,cheap\n' });
    assert.equal(bad.status, 400); assert.match((await bad.json()).error, /Line 2: price takes a number/);
  });

  let flow;
  await t.test('table steps keep rows between runs and change the same row again', async () => {
    const people = { type: 'code', code: 'return [{email:"ana@example.com",name:"Ana B"},{email:"cy@example.com",name:"Cy"}]' };
    const made = await request('/workflows', { name: 'Remember visitors', steps: [people,
      { type: 'action', app: 'table:' + leads.id, op: 'upsert_row', each: '{{step 1}}', fields: { match_on: 'email', email: '{{item.email}}', name: '{{item.name}}' } },
      { type: 'action', app: 'table:' + leads.id, op: 'find_rows', fields: { order_by: '-id', limit: '10' } },
      { type: 'action', app: 'table:' + leads.id, op: 'count_rows', fields: {} }] });
    assert.equal(made.status, 201, JSON.stringify(made.data)); flow = made.data;
    const run = await start(flow.id);
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(JSON.parse(run.output), { count: 3 });
    const again = await start(flow.id);
    assert.equal(again.status, 'completed', again.error); assert.deepEqual(JSON.parse(again.output), { count: 3 }, 'the second run adds nothing');
    const ana = (await request(`/tables/${leads.id}/rows?search=ana`)).data.rows[0];
    assert.equal(ana.name, 'Ana B'); assert.equal(ana.visits, 2, 'values the step does not name stay');
    const once = await request('/workflows', { name: 'One visitor', steps: [{ type: 'action', app: 'table:' + leads.id, op: 'upsert_row', fields: { match_on: 'email', email: '{{brief}}', visits: '1' } }] });
    assert.equal(once.status, 201, JSON.stringify(once.data));
    const first = JSON.parse((await start(once.data.id, 'zed@example.com')).output), second = JSON.parse((await start(once.data.id, 'Zed@example.com')).output);
    assert.equal(first._added, true); assert.equal(second._added, false, 'the second run finds the row'); assert.equal(second.id, first.id);
    assert.equal((await request(`/workflows/${once.data.id}`, undefined, 'DELETE')).status, 200);
    assert.equal((await request(`/tables/${leads.id}/rows/${first.id}`, undefined, 'DELETE')).status, 200);
    const failing = await request('/workflows', { name: 'Bad add', steps: [{ type: 'action', app: 'table:' + leads.id, op: 'add_row', fields: { email: 'ana@example.com' } }] });
    const failed = await start(failing.data.id);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /Leads: Leads already has a row with email/);
    assert.equal((await request(`/workflows/${failing.data.id}`, undefined, 'DELETE')).status, 200);
    assert.match((await request('/workflows', { name: 'Gone', steps: [{ type: 'action', app: 'table:nope', op: 'add_row', fields: {} }] })).data.error, /table was deleted/);
  });

  await t.test('a renamed column is followed by its steps, and a table in use is kept', async () => {
    const changed = await request('/tables/' + leads.id, { columns: [{ name: 'mail', was: 'email', type: 'text', unique: true, required: true }, { name: 'name' }, { name: 'visits', type: 'number' }] }, 'PUT');
    assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal(changed.data.workflows, 1);
    const w = (await request('/state')).data.workflows.find(x => x.id === flow.id);
    assert.deepEqual(w.steps[1].fields, { match_on: 'mail', mail: '{{item.email}}', name: '{{item.name}}' });
    assert.equal((await start(flow.id)).status, 'completed');
    const kept = await request('/tables/' + leads.id, undefined, 'DELETE');
    assert.equal(kept.status, 409); assert.match(kept.data.error, /Remember visitors uses this table/);
    const proc = (await request(`/workflows/${flow.id}/template`)).data;
    assert.equal(proc.steps[1].table, 'Leads'); assert.equal(proc.steps[1].app, 'table:' + leads.id);
    const elsewhere = await request('/templates/check', { template: { ...proc, steps: proc.steps.map(s => s.table ? { ...s, app: 'table:from-another-silo' } : s) } });
    assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.data)); assert.equal(elsewhere.data.steps[1].app, 'table:' + leads.id, 'found here by its name');
    const missing = await request('/templates/check', { template: { ...proc, steps: proc.steps.map(s => s.table ? { ...s, app: 'table:x', table: 'Orders' } : s) } });
    assert.match(missing.data.error, /uses the table "Orders"\. Make a table with that name/);
    assert.equal((await request(`/workflows/${flow.id}`, undefined, 'DELETE')).status, 200);
    assert.equal((await request('/tables/' + leads.id, undefined, 'DELETE')).status, 200);
    assert.ok(!(await request('/state')).data.tables.some(x => x.id === leads.id));
  });

  await t.test('a resident reads rows freely, marked as data, and changes them only after an OK', async () => {
    await request('/connections', { provider: 'compatible', key: 'fixture-tables-key', model: 'fixture', endpoint: 'https://example.com/v1/chat/completions' });
    const clerk = (await request('/agents', { name: 'Table Clerk', role: 'Fixture', floor: 3, provider: 'compatible', model: 'tool-user', instructions: 'Fixture.', tools: ['tables'] })).data;
    const CALL = o => 'CALL ' + JSON.stringify(o), chat = m => request('/agents/' + clerk.id + '/chat', { message: m });
    let r = await chat(CALL({ tool: 'table_read', action: 'find', table: 'prices', filters: [{ column: 'price', op: 'lt', value: '5' }] }));
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.text, /Tea/); assert.doesNotMatch(r.data.text, /Coffee/);
    assert.match(r.data.text, /<table_rows table="Prices" trust="untrusted">/, 'rows are marked as data');
    const pending = () => until(async () => (await request('/state')).data.requests.find(x => x.status === 'pending'), 15000, 'approval');
    let reply = chat(CALL({ tool: 'table_write', action: 'add', table: 'Prices', values: { product: 'Cake', price: '3,2' } }));
    let req = await pending();
    assert.match(req.tool, /^tables:[0-9a-f-]{36}:add$/); assert.match(req.title, /add a row to the table Prices/); assert.match(req.detail, /Cake/);
    assert.equal((await request('/tables/Prices/rows?search=cake')).data.total, 0, 'nothing before the OK');
    await request('/requests/' + req.id, { allow: true }); r = await reply;
    assert.match(r.data.text, /Added row 3 of Prices/);
    assert.equal((await request('/tables/Prices/rows?search=cake')).data.rows[0].price, 3.2);
    reply = chat(CALL({ tool: 'table_write', action: 'delete', table: 'Prices', row_id: 1 }));
    req = await pending(); await request('/requests/' + req.id, { allow: false }); await reply;
    assert.equal((await request('/tables/Prices/rows/1')).status, 200, 'a denied change is not made');
  });
});
