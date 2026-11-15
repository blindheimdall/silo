// The procedures of the Order that keep their rows in tables: adopted the way the Order does it (their tables made
// first, found by name), saved, and run against a fresh server, with a public form, a code step and a failure log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES, materialize, procedureTables } from '../public/flow-templates.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const tpl = key => TEMPLATES.find(t => t.key === key);

test('procedures with tables', () => {
  const t = tpl('leads');
  assert.deepEqual(procedureTables(t).map(x => x.name), ['Leads'], 'a table named by several steps is listed once');
  assert.equal(procedureTables(t)[0].columns[0].name, 'email');
  const shared = { shared: true, name: 'P', steps: [{ type: 'action', app: 'table:other-silo', table: 'Orders', op: 'count_rows', fields: {} }] };
  assert.deepEqual(procedureTables(shared), [{ name: 'Orders', columns: null }], 'a procedure from a file names its table without columns');
  assert.equal(materialize(t, [], []).steps[0].app, 'table:', 'a missing table leaves the step without one');
  assert.equal(materialize(t, [], [{ id: 'T1', name: 'leads' }]).steps[0].app, 'table:T1', 'the table is found by its name, without case');
  assert.equal(materialize(shared, [], [{ id: 'T2', name: 'Orders' }]).steps[0].app, 'table:T2');
  const w = materialize(t, [], []);
  w.form.fields[0].name = 'changed'; w.steps[0].fields.status = 'changed';
  assert.equal(t.form.fields[0].name, 'name'); assert.equal(t.steps[0].fields.status, 'new', 'changing a workflow in the editor leaves the procedure as it was');
  for (const x of TEMPLATES) for (const tb of procedureTables(x)) assert.ok(tb.columns, x.key + ' describes the ' + tb.name + ' table');
});

test('the table procedures of the Order run as described', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-table-templates-'));
  const port = 14471, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const state = async () => (await request('/state')).data;
  const rows = async name => (await request(`/tables/${name}/rows`)).data.rows;
  const settled = r => r && !['running', 'queued', 'retrying'].includes(r.status) && !r.waiting;
  const until = async (find, what) => { for (let i = 0; i < 200; i++) { const r = (await state()).runs.find(find); if (r && (settled(r) || r.waiting)) return r; await wait(100); } throw Error('Timed out waiting for ' + what); };
  // Adopting in the Order: the tables it describes are made, then the workflow is filled with them and saved.
  const adopt = async key => {
    const x = tpl(key), have = (await state()).tables;
    for (const tb of procedureTables(x)) if (!have.some(h => h.name.toLowerCase() === tb.name.toLowerCase())) assert.equal((await request('/tables', { name: tb.name, columns: tb.columns })).status, 201);
    const s = await state(), w = materialize(x, s.agents, s.tables);
    assert.ok(w.steps.every(st => st.app !== 'table:'), key + ': every table step has its table');
    const saved = await request('/workflows', { ...w, enabled: false });
    assert.equal(saved.status, 201, key + ': ' + JSON.stringify(saved.data));
    return saved.data;
  };
  const run = async (w, input) => { const r = await request('/workflows/' + w.id + '/run', { input }); assert.ok(r.status < 300, JSON.stringify(r.data)); return until(x => x.id === r.data.id, w.name); };

  await t.test('a contact form keeps the lead, and the reply joins it after the OK', async () => {
    const w = await adopt('leads');
    assert.equal(w.form.fields.length, 3); assert.match(w.formToken, /^[a-f0-9]{32}$/);
    let r = await run(w, JSON.stringify({ name: 'Ana', email: 'ana@example.com', message: 'Do you ship to Cluj?' }));
    assert.ok(r.waiting, 'it waits for the OK');
    assert.deepEqual((await rows('Leads')).map(x => [x.email, x.status]), [['ana@example.com', 'new']]);
    assert.equal((await request('/runs/' + r.id + '/approve', { approve: true })).status, 200);
    r = await until(x => x.id === r.id && settled(x), 'the reply');
    assert.equal(r.status, 'completed', r.error);
    const lead = (await rows('Leads'))[0];
    assert.equal(lead.status, 'reply ready'); assert.ok(lead.reply.length > 0, 'the reply is kept with the lead');
  });

  await t.test('signups through the public form: the same email changes its signup', async () => {
    const w = await adopt('signups');
    const send = body => fetch(`${api}/form/${w.formToken}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    const done = async n => { for (let i = 0; i < 200; i++) { const list = (await state()).runs.filter(x => x.workflowId === w.id && settled(x)); if (list.length >= n) return list.sort((a, b) => a.started - b.started)[n - 1]; await wait(100); } throw Error('no run'); };
    assert.equal((await send({ name: 'Ana', email: 'ana@example.com', seats: '2' })).status, 200);
    assert.equal((await done(1)).output, 'New signup: Ana, 2 seats. 1 signed up so far.');
    assert.equal((await send({ name: 'Ana', email: 'ANA@example.com', seats: '3' })).status, 200);
    assert.equal((await done(2)).output, 'Changed signup: Ana, 3 seats. 1 signed up so far.');
    assert.equal((await send({ name: 'Dan', email: 'dan@example.com', seats: '1' })).status, 200);
    assert.equal((await done(3)).output, 'New signup: Dan, 1 seats. 2 signed up so far.');
    assert.deepEqual((await rows('Signups')).map(x => x.seats).sort(), [1, 3]);
  });

  await t.test('low stock is found by code, and a resident is asked only when something is low', async () => {
    const w = await adopt('stock');
    for (const values of [{ item: 'Flour', quantity: 40, minimum: 10 }, { item: 'Salt', quantity: 2, minimum: 5 }]) assert.equal((await request('/tables/Stock/rows', { values })).status, 201);
    let r = await run(w, 'Stock check.');
    assert.equal(r.status, 'completed', r.error);
    assert.equal(r.steps[1].output, 'Salt: 2 left, minimum 5');
    assert.ok(!r.steps[2].skipped, 'the resident writes the order list');
    await request('/tables/Stock/rows', { values: { item: 'Salt', quantity: 20 }, matchOn: 'item' });
    r = await run(w, 'Stock check.');
    assert.equal(r.status, 'completed', r.error);
    assert.equal(r.steps[1].output, 'Nothing is low.'); assert.ok(r.steps[2].skipped, 'nothing low, no resident');
  });

  await t.test('the leads of the week leave out the older ones', async () => {
    const w = await adopt('leads-week');
    assert.ok(w.steps[0].app.startsWith('table:') && (await state()).tables.filter(x => x.name === 'Leads').length === 1, 'a table that is there already is used, not made again');
    const r = await request('/workflows/' + w.id + '/run', { input: 'Leads of the week.' });
    const done = await until(x => x.id === r.data.id, 'the summary');
    assert.match(done.steps[1].output, /Ana <ana@example\.com>, reply ready: Do you ship to Cluj\?/);
  });

  await t.test('a failed run is kept in the failure log', async () => {
    const log = await adopt('failures');
    const bad = (await request('/workflows', { name: 'Breaks', steps: [{ type: 'code', code: 'throw new Error("the printer is on fire")' }], onFailure: log.id })).data;
    const r = await request('/workflows/' + bad.id + '/run', { input: 'go' });
    assert.equal((await until(x => x.id === r.data.id, 'the failure')).status, 'failed');
    await until(x => x.workflowId === log.id && x.trigger === 'failure' && settled(x), 'the failure log');
    const [row] = await rows('Failures');
    assert.equal(row.workflow, 'Breaks'); assert.equal(row.step, 1); assert.equal(row.run, r.data.id);
    assert.match(row.error, /the printer is on fire/);
  });

  await t.test('feedback is sorted and kept', async () => {
    const w = await adopt('feedback');
    const r = await run(w, JSON.stringify({ message: 'The app is slow on Mondays.', email: '' }));
    assert.equal(r.status, 'completed', r.error);
    const [row] = await rows('Feedback');
    assert.equal(row.message, 'The app is slow on Mondays.');
    assert.equal(row.topic, 'other'); assert.equal(row.mood, 'neutral', 'an answer that is not JSON is kept as other and neutral');
  });
});
