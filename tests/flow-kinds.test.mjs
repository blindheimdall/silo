// Code steps, workflows run as a step, a workflow started when another fails, and public forms that start a workflow.
// No model is called: every workflow here is made of code steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

test('code steps, workflows inside workflows, failure workflows and public forms', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-flowkinds-'));
  const port = 14463, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const runs = async () => (await request('/state')).data.runs;
  const finished = async (find, ms = 20000) => { for (let i = 0; i < ms / 100; i++) { const run = (await runs()).find(find); if (run && !['running', 'retrying', 'queued'].includes(run.status)) return run; await wait(100); } throw Error('The run did not finish.'); };
  const make = async (name, steps, extra = {}) => { const r = await request('/workflows', { name, steps, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
  const start = async (wid, input = 'go') => { const r = await request('/workflows/' + wid + '/run', { input }); assert.ok(r.status < 300, JSON.stringify(r.data)); return finished(x => x.id === r.data.id); };
  const code = (c, more = {}) => ({ type: 'code', code: c, ...more });

  await t.test('a code step turns earlier answers into the next one, also for each item', async () => {
    const w = await make('Numbers', [code('return json(input).items'), code('return steps[1].length+" / "+json(previous).length'), code('return item*10', { each: '{{step 1}}' })]);
    const run = await start(w.id, '{"items":[1,2,3]}');
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(JSON.parse(run.output), [10, 20, 30]);
    const bad = await make('Throws', [code('throw new Error("no rows")')]);
    const failed = await start(bad.id);
    assert.equal(failed.status, 'failed'); assert.match(failed.error, /Step 1 \(code\): no rows/);
    const loop = await make('Loops', [code('while(true){}')]);
    assert.match((await start(loop.id)).error, /longer than 5 seconds/);
    const away = await make('Reaches out', [code('return typeof process+typeof require+typeof fetch')]);
    assert.equal((await start(away.id)).output, 'undefinedundefinedundefined');
    assert.match((await request('/workflows', { name: 'Empty code', steps: [code('  ')] })).data.error, /needs its code/);
  });

  let inner, outer;
  await t.test('a workflow runs another one as a step and gets its answer', async () => {
    inner = await make('Inner', [code('return "inner got " + input')]);
    outer = await make('Outer', [code('return "hello"'), { type: 'workflow', workflowId: inner.id }, code('return previous + "!"')]);
    const run = await start(outer.id);
    assert.equal(run.status, 'completed', run.error);
    assert.equal(run.output, 'inner got hello!');
    const sub = (await runs()).find(r => r.workflowId === inner.id && r.parentRunId === run.id);
    assert.ok(sub, 'the inner run names the outer one'); assert.equal(sub.trigger, 'workflow'); assert.equal(sub.status, 'completed');
    const brief = await make('Outer with brief', [{ type: 'workflow', workflowId: inner.id, prompt: 'the brief was {{brief}}' }]);
    assert.equal((await start(brief.id, 'X')).output, 'inner got the brief was X');
  });

  await t.test('workflows that run each other in a circle, or themselves, are refused', async () => {
    const r = await request('/workflows/' + inner.id, { name: 'Inner', steps: [{ type: 'workflow', workflowId: outer.id }] }, 'PUT');
    assert.equal(r.status, 400); assert.match(r.data.error, /never end/);
    const self = await request('/workflows/' + inner.id, { name: 'Inner', steps: [{ type: 'workflow', workflowId: inner.id }] }, 'PUT');
    assert.match(self.data.error, /cannot run the workflow it is in/);
    assert.match((await request('/workflows', { name: 'Nothing', steps: [{ type: 'workflow', workflowId: 'nope' }] })).data.error, /pick the workflow/);
  });

  await t.test('an inner workflow that fails fails the step, with its reason', async () => {
    const broken = await make('Broken inner', [code('throw new Error("inner broke")')]);
    const w = await make('Calls broken', [{ type: 'workflow', workflowId: broken.id }]);
    const run = await start(w.id);
    assert.equal(run.status, 'failed'); assert.match(run.error, /Step 1: Broken inner failed: .*inner broke/);
  });

  await t.test('a failed run starts the failure workflow once, and failure workflows do not start each other', async () => {
    const handler = await make('On failure', [code('const f=json(input);return "handled "+f.workflow+": "+f.error')]);
    const w = await make('Fragile', [code('throw new Error("disk full")')], { onFailure: handler.id });
    assert.equal(w.onFailure, handler.id);
    const run = await start(w.id);
    assert.equal(run.status, 'failed');
    const handled = await finished(r => r.workflowId === handler.id && r.trigger === 'failure');
    assert.equal(handled.status, 'completed', handled.error); assert.match(handled.output, /handled Fragile: Step 1 \(code\): disk full/);
    // Two that fail and watch each other: each starts the other once, then it stops.
    const a = await make('Ping', [code('throw new Error("ping")')]);
    const b = await make('Pong', [code('throw new Error("pong")')], { onFailure: a.id });
    assert.equal((await request('/workflows/' + a.id, { name: 'Ping', steps: [code('throw new Error("ping")')], onFailure: b.id }, 'PUT')).status, 200);
    await start(a.id);
    await finished(r => r.workflowId === b.id && r.trigger === 'failure');
    await wait(800);
    const all = await runs();
    assert.equal(all.filter(r => r.workflowId === a.id).length, 1, 'Ping ran once');
    assert.equal(all.filter(r => r.workflowId === b.id).length, 1, 'Pong ran once');
    assert.match((await request('/workflows/' + a.id, { name: 'Ping', steps: [code('return 1')], onFailure: a.id }, 'PUT')).data.error, /cannot start itself/);
  });

  await t.test('a public form starts the workflow with the answers as JSON', async () => {
    const w = await make('Quotes', [code('const a=json(input);return a.name+" wants "+a.qty')], { form: { title: 'Ask for a quote', intro: 'We answer within a day.', fields: [{ name: 'name', label: 'Your name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'qty', label: 'How many', type: 'number' }, { name: 'note', label: 'Anything else', type: 'textarea' }] } });
    assert.match(w.formToken, /^[a-f0-9]{32}$/);
    const url = `${api}/form/${w.formToken}`;
    const page = await fetch(url);
    assert.equal(page.status, 200); const html = await page.text();
    assert.match(html, /Ask for a quote/); assert.match(html, /name="email" type="email"/); assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await fetch(`${api}/form/${'0'.repeat(32)}`)).status, 404);
    const send = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    const wrong = await send({ name: 'Ana', email: 'not-mail', qty: 'many' });
    assert.equal(wrong.status, 400); const wrongText = await wrong.text();
    assert.match(wrongText, /Email: this is not an email address/); assert.match(wrongText, /How many: this is not a number/); assert.match(wrongText, /value="Ana"/, 'what was typed stays');
    const before = (await runs()).filter(r => r.workflowId === w.id).length;
    const bot = await send({ name: 'Bot', email: 'b@example.com', website: 'http://spam.example' });
    assert.equal(bot.status, 200); assert.match(await bot.text(), /Thank you/);
    const ok = await send({ name: 'Ana <b>', email: 'ana@example.com', qty: '12' });
    assert.equal(ok.status, 200); assert.match(await ok.text(), /Thank you/);
    const run = await finished(r => r.workflowId === w.id && r.trigger === 'form');
    assert.equal(run.output, 'Ana <b> wants 12');
    assert.deepEqual(JSON.parse(run.input), { name: 'Ana <b>', email: 'ana@example.com', qty: 12 });
    assert.equal((await runs()).filter(r => r.workflowId === w.id).length, before + 1, 'the bot started nothing');
    // A few answers a minute from one address.
    let last;for (let i = 0; i < 5; i++) last = await send({ name: 'N' + i, email: 'n@example.com' });
    assert.equal(last.status, 429);
    // A new address on save: the old one is gone.
    const moved = await request('/workflows/' + w.id, { name: 'Quotes', steps: w.steps, form: { ...w.form, newAddress: true } }, 'PUT');
    assert.equal(moved.status, 200, JSON.stringify(moved.data)); assert.notEqual(moved.data.formToken, w.formToken);
    assert.equal((await fetch(url)).status, 404);
    const off = await request('/workflows/' + w.id, { name: 'Quotes', steps: w.steps, form: null }, 'PUT');
    assert.equal(off.data.form, null); assert.equal(off.data.formToken, null);
  });
});
