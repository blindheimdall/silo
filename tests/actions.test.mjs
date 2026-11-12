// App steps: a workflow calls one operation of a connector directly, with no model. The fields are filled from the
// brief and from earlier answers (whole answers or one value out of JSON), typed the way the operation wants them.
// Saved keys are never sent, a test run does not call operations that change something, and a condition can skip
// an app step. Everything outside runs on a fake API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));

test('app steps call a connector with fields from earlier answers, typed, without a model', async t => {
  const calls = [];
  const spec = { openapi: '3.0.0', info: { title: 'Shop' }, servers: [{ url: '/' }], paths: {
    '/customers/{id}': { get: { operationId: 'getCustomer', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: {} } },
    '/invoices': { post: { operationId: 'createInvoice', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['customer', 'amount'], properties: {
      customer: { type: 'string' }, email: { type: 'string' }, amount: { type: 'integer' }, paid: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } }, meta: { type: 'object' }, note: { type: 'string', description: 'A note on the invoice' } } } } } }, responses: {} } } } };
  const fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      const json = (status, o) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/spec.json') return json(200, spec);
      calls.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization });
      const m = req.url.match(/^\/customers\/(\w+)$/);
      if (m) return m[1] === 'missing' ? json(404, { error: 'No such customer' }) : json(200, { id: 'cus_' + m[1], name: 'Ana Pop', balance: '1250', contact: { email: 'ana@example.com' }, tags: ['vip'] });
      if (req.url === '/invoices' && req.method === 'POST') return json(201, { id: 'in_1', status: 'draft' });
      json(404, {});
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r)); t.after(() => fake.close());
  const fakeUrl = 'http://127.0.0.1:' + fake.address().port;

  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-actions-'));
  const port = 14374, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); const resolved = path.resolve(temp); assert.ok(path.basename(resolved).startsWith('silo-actions-')); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 15000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const finished = async id => { for (let i = 0; i < 150; i++) { const run = (await request('/state')).data.runs.find(r => r.id === id); if (run && run.status !== 'running') return run; await wait(100); } throw Error('The run did not finish.'); };
  const start = async (wid, input) => { const r = await request('/workflows/' + wid + '/run', { input }); assert.ok(r.status < 300, JSON.stringify(r.data)); return finished(r.data.id); };

  // A connector whose key is saved in the vault.
  const added = await request('/mcp', { name: 'Shop', transport: 'openapi', spec: fakeUrl + '/spec.json', authKind: 'bearer', authValue: 'tok_shop_secret_42' });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const app = 'mcp:' + added.data.id;

  // The editor gets every operation with its fields: which read, which change something, the types and what is needed.
  const list = (await request('/workflow-actions')).data.apps.find(a => a.id === app);
  assert.equal(list.name, 'Shop'); assert.equal(list.kind, 'connector');
  const google = (await request('/workflow-actions')).data.apps.find(a => a.id === 'svc:google');
  assert.equal(google.connected, false, 'an account that is not connected yet is listed, so a procedure using it keeps its step');
  assert.ok(google.ops.some(o => o.name === 'sheet_append' && o.write && o.fields.some(f => f.name === 'values')));
  const get = list.ops.find(o => o.name === 'getCustomer'), post = list.ops.find(o => o.name === 'createInvoice');
  assert.equal(get.write, false); assert.equal(post.write, true);
  assert.deepEqual(get.fields.map(f => [f.name, f.type, f.required]), [['id', 'string', true]]);
  const amount = post.fields.find(f => f.name === 'body.amount'); assert.equal(amount.type, 'integer'); assert.equal(amount.required, true);
  assert.equal(post.fields.find(f => f.name === 'body.note').description, 'A note on the invoice');
  assert.equal(post.fields.some(f => f.name === 'body'), false, 'the body is shown part by part');

  // What cannot be saved.
  const steps = extra => ({ name: 'Bad', steps: [{ type: 'action', app, op: 'getCustomer', fields: { id: '{{brief}}' }, ...extra }] });
  assert.match((await request('/workflows', steps({ op: 'deleteEverything' }))).data.error, /has no operation deleteEverything/);
  assert.match((await request('/workflows', steps({ app: 'mcp:nope' }))).data.error, /connector was removed/);
  assert.match((await request('/workflows', steps({ app: 'svc:fax' }))).data.error, /no app called fax/);
  assert.match((await request('/workflows', steps({ op: '' }))).data.error, /pick the app and what it should do/);
  assert.match((await request('/workflows', steps({ fields: { 'bad key!': 'x' } }))).data.error, /not a field name/);
  const extra = await request('/workflows', steps({ fields: { id: '1', 'body.amount': '5', limit: '3' } }));
  assert.equal(extra.status, 201);
  assert.deepEqual((await request('/state')).data.workflows.find(w => w.id === extra.data.id).steps[0].fields, { id: '1' }, 'fields the operation does not have are left out');
  await request('/workflows/' + extra.data.id, undefined, 'DELETE');
  assert.match((await request('/workflows', { name: 'Only you', steps: [{ type: 'approval' }] })).data.error, /resident step or app step/);

  // Read a customer, then make an invoice from its answer: one value out of JSON, a number, yes or no, a list, JSON, words around a value.
  const flow = await request('/workflows', { name: 'Invoice a customer', steps: [
    { type: 'action', app, op: 'getCustomer', fields: { id: '{{brief}}' } },
    { type: 'action', app, op: 'createInvoice', fields: { 'body.customer': '{{step 1.id}}', 'body.email': '{{previous.contact.email}}', 'body.amount': '{{step 1.balance}}', 'body.paid': 'no', 'body.tags': 'monthly, {{step 1.tags[0]}}', 'body.meta': '{"source": "silo"}', 'body.note': 'For {{step 1.name}}, thank you.' } }] });
  assert.equal(flow.status, 201, JSON.stringify(flow.data));
  const saved = (await request('/state')).data.workflows.find(w => w.id === flow.data.id);
  assert.deepEqual(saved.steps[0], { type: 'action', app, op: 'getCustomer', fields: { id: '{{brief}}' } });
  const run = await start(flow.data.id, '42');
  assert.equal(run.status, 'completed', run.error);
  assert.deepEqual(calls.map(c => c.method + ' ' + c.url), ['GET /customers/42', 'POST /invoices']);
  assert.deepEqual(calls[1].body, { customer: 'cus_42', email: 'ana@example.com', amount: 1250, paid: false, tags: ['monthly', 'vip'], meta: { source: 'silo' }, note: 'For Ana Pop, thank you.' });
  assert.equal(calls[1].auth, 'Bearer tok_shop_secret_42', 'the key goes to the app');
  assert.deepEqual(run.steps.map(s => [s.type, s.agentName, s.tokens]), [['action', 'Shop / getCustomer', 0], ['action', 'Shop / createInvoice', 0]]);
  assert.match(run.output, /^201 Created\n[^]*"id": "in_1"/, 'the last answer is the result');
  assert.equal(JSON.stringify(run).includes('tok_shop_secret_42'), false, 'the key is not in the run');

  // An answer without the value asked for, and an app that refuses, stop the run with a clear reason.
  calls.length = 0;
  const gone = await request('/workflows', { name: 'Missing value', steps: [{ type: 'action', app, op: 'getCustomer', fields: { id: '{{brief}}' } }, { type: 'action', app, op: 'createInvoice', fields: { 'body.customer': '{{step 1.account.number}}', 'body.amount': '5' } }] });
  let failed = await start(gone.data.id, '7');
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /\{\{step 1\.account\.number\}\} found nothing: that answer has no account\.number/);
  assert.deepEqual(calls.map(c => c.url), ['/customers/7'], 'nothing is made from a missing value');
  failed = await start(gone.data.id, 'missing');
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /Shop getCustomer failed: .*404/);
  const notNumber = await request('/workflows', { name: 'Not a number', steps: [{ type: 'action', app, op: 'createInvoice', fields: { 'body.customer': 'c', 'body.amount': 'a lot' } }] });
  failed = await start(notNumber.data.id, 'x');
  assert.match(failed.error, /amount should be a number, not "a lot"/);
  const needs = await request('/workflows', { name: 'Needs amount', steps: [{ type: 'action', app, op: 'createInvoice', fields: { 'body.customer': 'c' } }] });
  failed = await start(needs.data.id, 'x');
  assert.match(failed.error, /needs amount/);

  // A saved key is never sent, even when an earlier answer carries it.
  calls.length = 0;
  const leak = await request('/workflows', { name: 'Leak', steps: [{ type: 'action', app, op: 'createInvoice', fields: { 'body.customer': 'c', 'body.amount': '1', 'body.note': 'here: {{brief}}' } }] });
  failed = await start(leak.data.id, 'tok_shop_secret_42');
  assert.match(failed.error, /holds a saved key or password, so Shop was not called/);
  assert.equal(calls.length, 0);

  // A condition skips the app step; the skipped step does nothing.
  const cond = await request('/workflows', { name: 'Only urgent', steps: [{ type: 'action', app, op: 'getCustomer', fields: { id: '{{brief}}' } }, { type: 'action', app, op: 'createInvoice', fields: { 'body.customer': '{{step 1.id}}', 'body.amount': '1' }, when: { op: 'contains', step: 1, text: 'URGENT' } }] });
  const skipped = await start(cond.data.id, '9');
  assert.equal(skipped.status, 'completed'); assert.equal(skipped.steps[1].skipped, true);
  assert.deepEqual(calls.map(c => c.url), ['/customers/9']);

  // Tests read for real but do not call what changes something; they show what it would get.
  calls.length = 0;
  await request('/workflows/' + flow.data.id + '/tests', { repeat: 1, tests: [{ name: 'Invoice', input: '5', checks: [{ op: 'contains', text: 'would get' }] }] });
  assert.equal((await request('/workflows/' + flow.data.id + '/evaluate', {})).status, 202);
  let report; for (let i = 0; i < 150; i++) { report = (await request('/state')).data.workflows.find(w => w.id === flow.data.id).evals?.[0]; if (report && report.status !== 'running') break; await wait(100); }
  assert.equal(report.status, 'done'); assert.equal(report.passed, 1, JSON.stringify(report.results));
  assert.deepEqual(calls.map(c => c.method + ' ' + c.url), ['GET /customers/5'], 'the invoice is not made in a test');
  const testRun = (await request('/state')).data.runs.find(r => r.trigger === 'test' && r.workflowId === flow.data.id);
  assert.equal(testRun.steps[1].dry, true); assert.match(testRun.steps[1].output, /"amount": 1250/);

  // App steps and resident steps together: the resident gets the app's answer as the previous step.
  await request('/connections', { provider: 'openai', key: 'fixture-key-openai', model: 'fixture-model' });
  const resident = (await request('/state')).data.agents[0];
  const mixed = await request('/workflows', { name: 'Mixed', steps: [{ type: 'action', app, op: 'getCustomer', fields: { id: '{{brief}}' } }, { agentId: resident.id, prompt: 'Write a thank-you line for {{step 1.name}} at {{previous.contact.email}}. Plan: {{step 1.plan}}' }] });
  assert.equal(mixed.status, 201, JSON.stringify(mixed.data));
  const both = await start(mixed.data.id, '11');
  assert.equal(both.status, 'completed', both.error);
  assert.deepEqual(both.steps.map(s => s.type), ['action', 'agent']);
  assert.match(both.steps[1].output, /for Ana Pop at ana@example\.com\. Plan: \(that answer has no plan\)/, 'a resident gets one value out of the app answer');
});
