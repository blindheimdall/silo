// More apps and faster triggers: the built-in app list, the public API directory, how often a trigger checks, and
// GitHub and Slack events that arrive the moment they happen (signed webhooks). A fake service and temporary data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_PACKS, packSpec } from '../public/app-packs.js';
import { compileSpec, OpenApiClient } from '../openapi-tools.mjs';
import { triggerConfig, triggerWhat, verifyAppEvent, appEvent } from '../app-triggers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('Timed out waiting for ' + what); await wait(100); } }
const ghSign = (secret, raw) => 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
const slackSign = (secret, ts, raw) => 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex');

test('every built-in app compiles into tools, with safe names and the right read-only marks', () => {
  const ids = Object.keys(APP_PACKS);
  assert.ok(ids.length >= 40, 'at least 40 apps');
  let total = 0;
  for (const id of ids) {
    const p = APP_PACKS[id], c = compileSpec(packSpec(id), {});
    assert.equal(c.ops.length, p.ops.length, id);
    for (const op of c.ops) {
      assert.match(op.name, /^[a-zA-Z0-9_-]{1,64}$/, id + ' ' + op.name);
      for (const k of Object.keys(op.tool.inputSchema.properties)) assert.match(k, /^[a-zA-Z0-9_.-]{1,64}$/, id + ' ' + k);
      if (op.method === 'GET') assert.equal(op.readOnly, true, id + ' ' + op.name);
    }
    assert.ok(p.key && !/[–—]/.test(p.key + JSON.stringify(p.ops)), id + ' plain text');
    total += c.ops.length;
  }
  assert.ok(total >= 160, 'operations: ' + total);
});

test('trigger timing and instant settings', () => {
  assert.equal(triggerConfig({ kind: 'github.issue', repo: 'a/b' }).every, 60);
  assert.equal(triggerConfig({ kind: 'github.issue', repo: 'a/b', every: '15' }).every, 15);
  assert.equal(triggerConfig({ kind: 'github.issue', repo: 'a/b', every: '7' }).every, 60, 'only 15, 60 or 300');
  assert.equal(triggerConfig({ kind: 'web.feed', url: 'https://x.example/f', every: 15 }).every, 60, 'other people\'s sites at most once a minute');
  assert.equal(triggerConfig({ kind: 'github.pull', repo: 'a/b', instant: 'on' }).instant, true);
  assert.equal(triggerConfig({ kind: 'google.mail', instant: 'on' }).instant, undefined, 'Gmail has no instant events here');
  assert.deepEqual(triggerWhat(triggerConfig({ kind: 'github.issue', repo: 'a/b', every: 15, instant: true })), { kind: 'github.issue', repo: 'a/b' });

  const raw = '{"x":1}';
  assert.equal(verifyAppEvent('github.issue', 's3cret', { 'x-hub-signature-256': ghSign('s3cret', raw) }, raw), true);
  assert.equal(verifyAppEvent('github.issue', 's3cret', { 'x-hub-signature-256': ghSign('other', raw) }, raw), false);
  assert.equal(verifyAppEvent('github.issue', '', { 'x-hub-signature-256': ghSign('', raw) }, raw), false, 'no secret, no event');
  const now = Date.now(), ts = Math.floor(now / 1000);
  assert.equal(verifyAppEvent('slack.message', 'abc', { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': slackSign('abc', ts, raw) }, raw, now), true);
  assert.equal(verifyAppEvent('slack.message', 'abc', { 'x-slack-request-timestamp': String(ts - 600), 'x-slack-signature': slackSign('abc', ts - 600, raw) }, raw, now), false, 'old events are refused');
  assert.equal(verifyAppEvent('google.mail', 'abc', {}, raw), false);

  const cfg = { kind: 'github.issue', repo: 'Acme/Plant', label: 'bug' };
  const issue = (action, labels, extra = {}) => appEvent('github.issue', cfg, { 'x-github-event': 'issues' }, { action, repository: { full_name: 'acme/plant' }, issue: { number: 7, title: 'Leak', labels: labels.map(name => ({ name })), user: { login: 'ana' } }, ...extra }).items;
  assert.equal(issue('opened', ['bug']).length, 1);
  assert.equal(issue('opened', []).length, 0, 'without the label');
  assert.equal(issue('labeled', ['bug'], { label: { name: 'bug' } }).length, 1, 'the label added later');
  assert.equal(issue('closed', ['bug']).length, 0);
  assert.equal(appEvent('github.issue', cfg, { 'x-github-event': 'issues' }, { action: 'opened', repository: { full_name: 'other/repo' }, issue: { number: 1, labels: [{ name: 'bug' }] } }).items.length, 0, 'another repository');
  assert.deepEqual(appEvent('github.issue', cfg, { 'x-github-event': 'ping' }, {}).reply, { ok: true });
  assert.deepEqual(appEvent('slack.message', { channel: 'C1' }, {}, { type: 'url_verification', challenge: 'xyz' }).reply, { challenge: 'xyz' });
  const msg = (event) => appEvent('slack.message', { channel: 'C1', contains: 'help' }, {}, { type: 'event_callback', event }).items;
  assert.equal(msg({ type: 'message', channel: 'C1', ts: '1.1', text: 'need help' })[0].id, '1.1');
  assert.equal(msg({ type: 'message', channel: 'C2', ts: '1.1', text: 'need help' }).length, 0);
  assert.equal(msg({ type: 'message', channel: 'C1', ts: '1.1', text: 'need help', subtype: 'message_changed' }).length, 0);
});

test('apps, the API directory and instant events in a running SILO', async t => {
  const fakeState = { issues: [{ number: 1, title: 'Old', user: { login: 'ana' }, labels: [] }] };
  const seen = [];
  const fake = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x'), p = u.pathname; seen.push({ method: req.method, path: p, query: u.search, body, auth: req.headers.authorization || '' });
    const json = (d, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (p === '/directory.json') return json({
      'spotify.com': { preferred: 'v1', versions: { v1: { info: { title: 'Spotify Web API', description: 'Music <b>catalog</b> and playlists.' }, swaggerUrl: 'https://api.apis.guru/v2/specs/spotify.com/v1/openapi.json' } } },
      'twilio.com:api': { preferred: '1', versions: { 1: { info: { title: 'Twilio - Api', description: 'Messages and calls.' }, swaggerUrl: 'https://api.apis.guru/v2/specs/twilio.com/api/1/openapi.json' } } },
      'bad.example': { preferred: '1', versions: { 1: { info: { title: 'Spotify clone' }, swaggerUrl: 'http://insecure.example/spec.json' } } },
    });
    if (p === '/todo/projects') return json([{ id: 'p1', name: 'Home' }]);
    if (p === '/github/user') return json({ login: 'octo' });
    if (p === '/github/repos/acme/plant/issues' && req.method === 'GET') return json([...fakeState.issues].reverse());
    if (p === '/github/repos/acme/plant/hooks' && req.method === 'POST') return json({ id: 77 }, 201);
    if (p === '/slack/auth.test') return json({ ok: true, user: 'silo', team: 'Acme' });
    if (p === '/slack/conversations.history') return json({ ok: true, messages: [] });
    json({ error: 'not found ' + p }, 404);
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-instant-'));
  const port = 14369, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), SILO_TEST_CONNECTOR_BASE: base, SILO_API_DIRECTORY: base + '/directory.json', SILO_APP_TRIGGER_INTERVAL: '300', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); fake.close(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); const resolved = path.resolve(temp); assert.ok(path.basename(resolved).startsWith('silo-instant-')); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 15000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const state = async () => (await request('/state')).data;
  const first = (await state()).agents[0];
  const flow = (name, appTrigger, extra = {}) => request('/workflows', { name, steps: [{ agentId: first.id, prompt: 'Handle it.' }], app: appTrigger, ...extra });
  const runsOf = async id => (await state()).runs.filter(r => r.workflowId === id && r.trigger === 'app');
  const hook = (tokenPath, raw, headers) => fetch(api + '/apphook/' + tokenPath, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw });

  await t.test('a built-in app is added with only its key, and its key goes where the app wants it', async () => {
    const bad = await request('/mcp', { name: 'Shop', transport: 'openapi', builtin: 'shopify' });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /your own address/i);
    assert.equal((await request('/mcp', { name: 'X', transport: 'openapi', builtin: 'nope' })).status, 400);
    const added = await request('/mcp', { name: 'Todoist', transport: 'openapi', builtin: 'todoist', base: base + '/todo', authKind: 'none', authValue: 'todo-secret-token' });
    assert.equal(added.status, 201, JSON.stringify(added.data)); assert.equal(added.data.tools, 4);
    const c = (await state()).mcp.find(x => x.id === added.data.id);
    assert.equal(c.builtin, 'todoist'); assert.deepEqual(c.apiAuth, { kind: 'bearer' }, 'the app decides how the key is sent'); assert.equal(c.keySaved, true);
    assert.deepEqual(c.tools.map(x => x.name).sort(), ['close_task', 'create_task', 'list_projects', 'list_tasks']);
    const client = new OpenApiClient({ spec: 'builtin:todoist', base: base + '/todo', auth: { kind: 'bearer', value: 'todo-secret-token' } });
    const r = await client.callTool('list_projects', {});
    assert.match(JSON.stringify(r), /Home/);
    assert.equal(seen.find(x => x.path === '/todo/projects').auth, 'Bearer todo-secret-token');
  });

  await t.test('the API directory finds APIs by name, and only ones with a safe address', async () => {
    const r = await request('/apis?q=spotify');
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.apis.map(a => a.id), ['spotify.com']);
    assert.equal(r.data.apis[0].description, 'Music catalog and playlists.');
    assert.deepEqual((await request('/apis?q=messages%20twilio')).data.apis.map(a => a.id), ['twilio.com:api']);
    assert.deepEqual((await request('/apis?q=')).data.apis, []);
    assert.equal(seen.filter(x => x.path === '/directory.json').length, 1, 'read once, then kept');
  });

  await t.test('a GitHub issue arrives at once, signed, and the regular check does not start it again', async () => {
    assert.equal((await request('/services/github', { token: 'ghp_fixturetoken1234567890' })).status, 200);
    const w = (await flow('Instant issues', { kind: 'github.issue', repo: 'acme/plant', every: '15', instant: 'on' })).data;
    assert.equal(w.app.every, 15); assert.equal(w.app.instant, true); assert.match(w.appHook, /^[a-f0-9]{32}$/);
    const info = await request('/workflows/' + w.id + '/apphook');
    assert.equal(info.status, 200); assert.equal(info.data.via, 'github'); assert.equal(info.data.url, null, 'no address the internet can reach without remote access');
    assert.match(info.data.secret, /^[a-f0-9]{40}$/);
    const add = await request('/workflows/' + w.id + '/apphook/github', {});
    assert.equal(add.status, 409); assert.match(add.data.error, /remote access/);
    await until(async () => (await state()).workflows.find(x => x.id === w.id)?.appChecked, 15000, 'first check');

    const payload = JSON.stringify({ action: 'opened', repository: { full_name: 'acme/plant' }, issue: { number: 5, title: 'Valve stuck', body: 'Level 4.', user: { login: 'bob' }, labels: [] } });
    assert.equal((await hook(w.appHook, payload, { 'x-github-event': 'issues', 'x-hub-signature-256': ghSign('wrong', payload) })).status, 401);
    assert.equal((await hook('0'.repeat(32), payload, { 'x-github-event': 'issues', 'x-hub-signature-256': ghSign(info.data.secret, payload) })).status, 404);
    const ping = JSON.stringify({ zen: 'hi' });
    assert.deepEqual(await (await hook(w.appHook, ping, { 'x-github-event': 'ping', 'x-hub-signature-256': ghSign(info.data.secret, ping) })).json(), { ok: true });
    const ok = await hook(w.appHook, payload, { 'x-github-event': 'issues', 'x-hub-signature-256': ghSign(info.data.secret, payload) });
    assert.equal(ok.status, 200);
    const runs = await until(async () => { const r = await runsOf(w.id); return r.length ? r : null; }, 5000, 'instant run');
    assert.match(runs[0].input, /<event source="github.issue">[\s\S]*Issue #5 in acme\/plant: Valve stuck/);
    // The same issue again (GitHub retries), and then the regular check finds it too.
    await hook(w.appHook, payload, { 'x-github-event': 'issues', 'x-hub-signature-256': ghSign(info.data.secret, payload) });
    fakeState.issues.push({ number: 5, title: 'Valve stuck', user: { login: 'bob' }, labels: [] });
    const before = (await state()).workflows.find(x => x.id === w.id).appChecked;
    await until(async () => (await state()).workflows.find(x => x.id === w.id).appChecked > before + 600, 15000, 'two more checks');
    assert.equal((await runsOf(w.id)).length, 1, 'once');
    assert.ok((await state()).events.some(e => /\(instant\)/.test(e.title)), 'the event says it came at once');

    const off = await request('/workflows/' + w.id, { ...w, app: { kind: 'github.issue', repo: 'acme/plant', every: '60' } }, 'PUT');
    assert.equal(off.status, 200); assert.equal(off.data.appHook, null, 'instant off: the address is gone');
    assert.equal((await hook(w.appHook, payload, { 'x-github-event': 'issues', 'x-hub-signature-256': ghSign(info.data.secret, payload) })).status, 404);
  });

  await t.test('Slack needs your signing secret, answers its address check, and starts on a message', async () => {
    assert.equal((await request('/services/slack', { token: 'xoxb-fixture-slack-token' })).status, 200);
    const missing = await flow('Instant Slack', { kind: 'slack.message', channel: 'C0123456', instant: 'on' });
    assert.equal(missing.status, 400); assert.match(missing.data.error, /signing secret/);
    const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const w = (await flow('Instant Slack', { kind: 'slack.message', channel: 'C0123456', instant: 'on', signing: secret })).data;
    assert.equal(JSON.stringify(w).includes(secret), false, 'the secret is not in the workflow');
    assert.equal((await request('/workflows/' + w.id + '/apphook')).data.secret, '', 'Slack\'s secret is never shown back');
    const ts = Math.floor(Date.now() / 1000), send = obj => { const raw = JSON.stringify(obj); return hook(w.appHook, raw, { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': slackSign(secret, ts, raw) }); };
    assert.deepEqual(await (await send({ type: 'url_verification', challenge: 'chal-123' })).json(), { challenge: 'chal-123' });
    await send({ type: 'event_callback', event: { type: 'message', channel: 'C0123456', ts: '1900000000.000100', user: 'U7', text: 'Pump 2 is down' } });
    const runs = await until(async () => { const r = await runsOf(w.id); return r.length ? r : null; }, 5000, 'slack run');
    assert.match(runs[0].input, /Slack message in C0123456[\s\S]*Pump 2 is down/);
    // Editing other things keeps the saved secret.
    const again = await request('/workflows/' + w.id, { ...w, app: { kind: 'slack.message', channel: 'C0123456', instant: 'on', every: '300' } }, 'PUT');
    assert.equal(again.status, 200, JSON.stringify(again.data)); assert.equal(again.data.appHook, w.appHook, 'the same address');
  });
});
