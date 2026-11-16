// The workflow builder against a fake model: a description becomes a draft checked like a saved workflow, a refused
// draft goes back with the reason, a draft is changed as asked, and nothing is saved or started until you save it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

test('the workflow builder drafts, fixes and changes workflows without saving them', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-builder-'));
  const port = 14469, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const draft = body => request('/workflows/draft', body);

  await t.test('it needs a resident with a real model', async () => {
    const none = await draft({ text: 'Greet visitors.' });
    assert.equal(none.status, 400); assert.match(none.data.error, /needs a resident with a model/);
    const demo = (await request('/state')).data.agents.find(a => a.provider === 'demo');
    assert.match((await draft({ text: 'Greet visitors.', agentId: demo.id })).data.error, /scripted answers only/);
    assert.match((await draft({ text: '  ' })).data.error, /Say what the workflow should do/);
  });

  let builder, table, made;
  await t.test('a description becomes a checked draft, and nothing is saved', async () => {
    await request('/connections', { provider: 'compatible', key: 'fixture-builder-key', model: 'builder', endpoint: 'https://example.com/v1/chat/completions' });
    builder = (await request('/agents', { name: 'Builder Fixture', role: 'Designs workflows', floor: 2, provider: 'compatible', model: 'builder', instructions: 'Fixture.' })).data;
    table = (await request('/tables', { name: 'Visitors', columns: [{ name: 'email', type: 'text', unique: true }] })).data;
    const before = (await request('/state')).data.workflows.length;
    const r = await draft({ text: 'Keep every visitor who signs in, and greet them.', test: false });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.agent, 'Builder Fixture'); assert.equal(r.data.tries, 1); assert.equal(r.data.tested, undefined, 'not tested when asked not to'); assert.equal(r.data.notes, 'Fill the table first.');
    const d = r.data.draft; made = d;
    assert.equal(d.name, 'Visitor log'); assert.equal(d.enabled, false);
    assert.deepEqual(d.steps[0], { type: 'action', app: 'table:' + table.id, op: 'upsert_row', fields: { match_on: 'email', email: '{{brief.email}}' } }, 'a field the operation does not have is left out');
    assert.equal(d.steps[1].agentId, builder.id);
    assert.equal(d.form.fields[0].name, 'email'); assert.equal(d.formToken, undefined); assert.equal(d.hook, undefined);
    assert.equal((await request('/state')).data.workflows.length, before, 'a draft is not saved');
  });

  await t.test('a refused draft goes back with the reason; one that never passes says why', async () => {
    const fixed = await draft({ text: 'BROKEN FIRST: keep visitors.', agentId: builder.id, test: false });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.data)); assert.equal(fixed.data.tries, 2);
    const never = await draft({ text: 'NEVER RIGHT', agentId: builder.id, test: false });
    assert.equal(never.status, 422); assert.match(never.data.error, /Builder Fixture could not make a workflow that passes the checks\. The last reason: Step 1: there is no resident with the id "not-a-resident"/);
  });

  await t.test('a draft is changed as asked, then saved and run like any workflow', async () => {
    const changed = await draft({ text: 'Run it every weekday at 8:30.', current: made, test: false });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const d = changed.data.draft;
    assert.equal(d.name, 'Visitor log, daily'); assert.equal(d.enabled, true); assert.equal(d.mode, 'daily'); assert.equal(d.at, '08:30'); assert.deepEqual(d.days, [1, 2, 3, 4, 5]);
    const saved = await request('/workflows', { ...d, enabled: false });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const start = await request('/workflows/' + saved.data.id + '/run', { input: '{"email":"ana@example.com"}' });
    assert.ok(start.status < 300, JSON.stringify(start.data));
    let run;
    for (let i = 0; i < 150 && !(run && !['running', 'queued', 'retrying'].includes(run.status)); i++) { await wait(100); run = (await request('/state')).data.runs.find(x => x.id === start.data.id); }
    assert.equal(run.status, 'completed', run.error);
    assert.equal((await request('/tables/Visitors/rows')).data.rows[0].email, 'ana@example.com');
  });

  await t.test('a draft is run on its own tests, fixed once when one fails, and keeps its tests', async () => {
    const runsBefore = (await request('/state')).data.runs.length, before = (await request('/state')).data.workflows.length;
    const r = await draft({ text: 'WITH TESTS: greet the person named in the brief.', agentId: builder.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.tested, true); assert.equal(r.data.repaired, true); assert.equal(r.data.tries, 2); assert.equal(r.data.notes, 'Fixed the greeting.');
    assert.deepEqual(r.data.results.map(x => [x.name, x.pass, x.output]), [['Greets Ana', true, 'Hello Ana'], ['Greets Bob', true, 'Hello Bob']]);
    assert.match(r.data.draft.steps[1].code, /Hello/); assert.equal(r.data.draft.tests.length, 2);
    const st = (await request('/state')).data, runs = st.runs.slice(0, st.runs.length - runsBefore);
    assert.equal(runs.length, 4, 'two tests, run twice'); assert.ok(runs.every(x => x.trigger === 'test' && x.status === 'completed'), 'test runs: the approval given');
    assert.equal(st.workflows.length, before, 'still not saved');
    // The tests go with the workflow when it is saved.
    const saved = await request('/workflows', { ...r.data.draft, tests: undefined });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal((await request('/workflows/' + saved.data.id + '/tests', { tests: r.data.draft.tests })).status, 200);
    assert.equal((await request('/state')).data.workflows.find(w => w.id === saved.data.id).tests.length, 2);
  });

  await t.test('a draft that still fails after its fix is shown with what failed; one without tests is refused', async () => {
    const r = await draft({ text: 'NEVER PASSES: greet them.', agentId: builder.id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.repaired, true); assert.equal(r.data.tries, 2);
    const ana = r.data.results.find(x => x.name === 'Greets Ana'), bob = r.data.results.find(x => x.name === 'Greets Bob');
    assert.equal(ana.pass, false); assert.match(ana.failures[0], /does not contain "Hello Ana"/); assert.equal(ana.output, 'Hi Ana');
    assert.deepEqual(bob.checks.map(c => c.pass), [false, false]);
    const none = await draft({ text: 'NO TESTS: greet them.', agentId: builder.id });
    assert.equal(none.status, 422); assert.match(none.data.error, /The last reason: Add "tests"/);
  });
});
