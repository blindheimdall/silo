// Talk channels against fake services: the website chat (sites allowed, memory per visitor, limits), Slack (signatures,
// threads, retries, bots), WhatsApp (the handshake, signatures, the daily cap, other numbers) and Microsoft Teams (the
// Bot Framework token, the service address, the bot's own token). Tools are offered only where they are allowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('Timed out waiting for ' + what); await wait(50); } }

test('residents answer on a website, in Slack, on WhatsApp and in Teams', async t => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', endorsements: ['msteams'] };
  const seen = [];let tokenAsks = 0;
  const fake = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const p = new URL(req.url, 'http://x').pathname; seen.push({ path: p, body, auth: req.headers.authorization });
    const json = (d, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (p === '/slack/auth.test') return json({ ok: true, user: 'silo', team: 'Acme' });
    if (p === '/slack/chat.postMessage') return json({ ok: true, ts: '9.9' });
    if (p === '/graph/123456789/messages') return json({ messages: [{ id: 'wamid.out' }] });
    if (p === '/bfOpenId') return json({ issuer: 'https://api.botframework.com', jwks_uri: base + '/bfKeys' });
    if (p === '/bfKeys') return json({ keys: [jwk] });
    if (p.endsWith('/oauth2/v2.0/token')) { tokenAsks++; return json({ access_token: 'bot-token', expires_in: 3600 }); }
    if (p.startsWith('/teams/v3/conversations/')) return json({ id: 'r1' });
    json({ error: 'not found ' + p }, 404);
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-talk-'));
  const port = 14465, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), SILO_TEST_CONNECTOR_BASE: base, SILO_TEST_TALK_BASE: base, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); fake.close(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body) => { const r = await fetch(api + '/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  await request('/connections', { provider: 'compatible', key: 'fixture-talk-key', model: 'talk', endpoint: 'https://example.com/v1/chat/completions' });
  const agent = (await request('/agents', { name: 'Front Desk', role: 'Answers people', floor: 2, provider: 'compatible', model: 'talk', instructions: 'Be kind.', tools: ['read_files'] })).data;
  const posted = p => seen.filter(x => x.path === p);

  await t.test('a channel turns on only when it has what it needs', async () => {
    assert.match((await request('/talk/widget', { enabled: true })).data.error, /Pick the resident/);
    assert.match((await request('/talk/slack', { enabled: true, agentId: agent.id })).data.error, /Connect Slack in Apps first/);
    assert.match((await request('/talk/whatsapp', { enabled: true, agentId: agent.id, phoneId: '12ab' })).data.error, /digits only/);
    assert.match((await request('/talk/teams', { appId: 'not-an-id' })).data.error, /looks like/);
    assert.match((await request('/talk/widget', { origins: ['ftp://x.example'] })).data.error, /starts with https/);
  });

  let key;
  await t.test('the website chat answers allowed sites, remembers each visitor and keeps its limits', async () => {
    const on = await request('/talk/widget', { enabled: true, agentId: agent.id, origins: ['https://shop.example/', 'https://shop.example'], title: 'Help </script>', color: '#123456' });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    key = on.data.widget.key; assert.match(key, /^[a-f0-9]{32}$/);
    assert.deepEqual(on.data.widget.origins, ['https://shop.example']);
    assert.match(on.data.widget.script, new RegExp(`/widget/${key}\\.js`));
    const js = await fetch(`${api}/widget/${key}.js`);
    assert.equal(js.status, 200); assert.equal(js.headers.get('cross-origin-resource-policy'), 'cross-origin');
    const src = await js.text(); assert.ok(!/<\/script/i.test(src), 'the title cannot close a script tag'); assert.match(src, /Help/);
    assert.doesNotThrow(() => new Function(src));
    assert.equal((await fetch(`${api}/widget/${'0'.repeat(32)}.js`)).status, 404);
    const chat = (origin, body) => fetch(`${api}/widget/${key}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin && { Origin: origin }) }, body: JSON.stringify(body) });
    const pre = await fetch(`${api}/widget/${key}/chat`, { method: 'OPTIONS', headers: { Origin: 'https://shop.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204); assert.equal(pre.headers.get('access-control-allow-origin'), 'https://shop.example');
    assert.equal((await fetch(`${api}/widget/${key}/chat`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 403);
    const evil = await chat('https://evil.example', { visitor: 'v'.repeat(20), text: 'hi' });
    assert.equal(evil.status, 403); assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const ana = 'ana_' + 'a'.repeat(20), bo = 'bob_' + 'b'.repeat(20);
    let r = await chat('https://shop.example', { visitor: ana, text: 'Hello' });
    assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), 'https://shop.example');
    assert.equal((await r.json()).reply, 'turns=1 tools=0 said=Hello', 'no tools on the website');
    assert.equal((await (await chat('https://shop.example', { visitor: ana, text: 'And then?' })).json()).reply, 'turns=2 tools=0 said=And then?');
    assert.equal((await (await chat('https://shop.example', { visitor: bo, text: 'Hi' })).json()).reply, 'turns=1 tools=0 said=Hi', 'each visitor has a conversation of their own');
    assert.equal((await chat('https://shop.example', { visitor: 'short', text: 'x' })).status, 400);
    assert.equal((await chat(api, { visitor: 'own_' + 'c'.repeat(20), text: 'From SILO' })).status, 200, 'SILO\'s own page may try it');
    for (let i = 0; i < 6; i++) await chat('https://shop.example', { visitor: ana, text: 'more ' + i });
    const many = await chat('https://shop.example', { visitor: ana, text: 'too many' });
    assert.equal(many.status, 429); assert.match((await many.json()).error, /Wait a minute/);
    assert.equal((await fetch(`${api}/widget/${key}/try`)).status, 200);
  });

  await t.test('Slack: signed events only, an answer in the thread, a retry answered once, bots ignored', async () => {
    assert.equal((await request('/services/slack', { token: 'xoxb-fixture-slack-token' })).status, 200);
    const secret = 'abcdef0123456789abcdef0123456789';
    assert.equal((await request('/talk/slack', { enabled: true, agentId: agent.id, signingSecret: secret, tools: true })).status, 200);
    const slack = (body, { ts = Math.floor(Date.now() / 1000), key = secret } = {}) => { const raw = JSON.stringify(body); return fetch(api + '/talk/slack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': 'v0=' + createHmac('sha256', key).update(`v0:${ts}:${raw}`).digest('hex') }, body: raw }); };
    const check = await slack({ type: 'url_verification', challenge: 'chal-123' });
    assert.equal(check.status, 200); assert.equal(await check.text(), 'chal-123');
    assert.equal((await slack({ type: 'url_verification', challenge: 'x' }, { key: 'wrong' })).status, 401);
    assert.equal((await slack({ type: 'url_verification', challenge: 'x' }, { ts: Math.floor(Date.now() / 1000) - 900 })).status, 401, 'an old event is refused');
    const mention = { type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '100.1', text: '<@UBOT> what is up' } };
    assert.equal((await slack(mention)).status, 200);
    const first = await until(() => posted('/slack/chat.postMessage')[0], 10000, 'the Slack answer');
    const sent = JSON.parse(first.body);
    assert.equal(sent.channel, 'C1'); assert.equal(sent.thread_ts, '100.1'); assert.match(sent.text, /^turns=1 tools=[1-9]\d* said=what is up$/, 'tools when allowed');
    assert.equal(first.auth, 'Bearer xoxb-fixture-slack-token');
    await slack(mention); await slack({ ...mention, event: { ...mention.event, bot_id: 'B1', event_id: 'Ev2' }, event_id: 'Ev2' });
    await wait(600); assert.equal(posted('/slack/chat.postMessage').length, 1, 'a retry and a bot are not answered');
    await slack({ type: 'event_callback', team_id: 'T1', event_id: 'Ev3', event: { type: 'message', channel_type: 'im', user: 'U2', channel: 'D1', ts: '200.1', text: 'hello there' } });
    const dm = JSON.parse((await until(() => posted('/slack/chat.postMessage')[1], 10000, 'the DM answer')).body);
    assert.equal(dm.channel, 'D1'); assert.equal(dm.thread_ts, undefined, 'a direct message is answered in the chat, not a thread');
  });

  await t.test('WhatsApp: the handshake, signed messages, other numbers, non-text and the daily cap', async () => {
    const on = await request('/talk/whatsapp', { enabled: true, agentId: agent.id, phoneId: '123456789', token: 'wa-fixture-token', appSecret: 'wa-fixture-secret', daily: 2 });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    const verify = on.data.whatsapp.verifyToken; assert.match(verify, /^[a-f0-9]{32}$/);
    const hs = await fetch(`${api}/talk/whatsapp?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=42`);
    assert.equal(hs.status, 200); assert.equal(await hs.text(), '42');
    assert.equal((await fetch(`${api}/talk/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status, 403);
    const note = (msgs, phone = '123456789', key = 'wa-fixture-secret') => { const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phone }, contacts: [{ wa_id: '40700111222', profile: { name: 'Ion' } }], messages: msgs } }] }] }); return fetch(api + '/talk/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', key).update(raw).digest('hex') }, body: raw }); };
    const text = (id, body) => ({ from: '40700111222', id, type: 'text', text: { body } });
    assert.equal((await note([text('w1', 'hi')], '123456789', 'wrong')).status, 401);
    assert.equal((await note([text('w1', 'hi')])).status, 200);
    const out = await until(() => posted('/graph/123456789/messages')[0], 10000, 'the WhatsApp answer');
    const msg = JSON.parse(out.body);
    assert.equal(msg.to, '40700111222'); assert.equal(msg.text.body, 'turns=1 tools=0 said=hi'); assert.equal(out.auth, 'Bearer wa-fixture-token');
    await note([text('w1', 'hi')]); await note([text('w9', 'other number')], '999999999');
    await note([{ from: '40700111222', id: 'w2', type: 'image', image: { id: 'm1' } }]);
    await until(() => posted('/graph/123456789/messages')[1], 10000, 'the note about text');
    assert.match(JSON.parse(posted('/graph/123456789/messages')[1].body).text.body, /text messages only/);
    await note([text('w3', 'second')]);
    await until(() => posted('/graph/123456789/messages')[2], 10000, 'the second answer');
    await note([text('w4', 'third')]);
    await until(() => posted('/graph/123456789/messages')[3], 10000, 'the cap note');
    assert.match(JSON.parse(posted('/graph/123456789/messages')[3].body).text.body, /Too many questions today/);
    await wait(300); assert.equal(posted('/graph/123456789/messages').length, 4, 'a repeated id and another number get nothing');
  });

  await t.test('Teams: a Bot Framework token for this bot, an answer to the message, and one bot token', async () => {
    const appId = '11111111-2222-3333-4444-555555555555';
    assert.equal((await request('/talk/teams', { enabled: true, agentId: agent.id, appId, password: 'teams-fixture-pw' })).status, 200);
    const serviceUrl = base + '/teams/';
    const jwt = (claims, kid = 'k1') => { const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url'), p = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${h}.${p}.${sign('sha256', Buffer.from(h + '.' + p), privateKey).toString('base64url')}`; };
    const now = Math.floor(Date.now() / 1000), good = { iss: 'https://api.botframework.com', aud: appId, exp: now + 600, nbf: now - 10, serviceurl: serviceUrl };
    const activity = (id, text, url = serviceUrl) => ({ type: 'message', id, channelId: 'msteams', serviceUrl: url, text, from: { id: 'u1', name: 'Maria' }, conversation: { id: 'conv-1' } });
    const send = (a, tok) => fetch(api + '/talk/teams', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok && { Authorization: 'Bearer ' + tok }) }, body: JSON.stringify(a) });
    assert.equal((await send(activity('a0', 'hi'))).status, 401, 'no token');
    assert.equal((await send(activity('a0', 'hi'), jwt({ ...good, aud: 'another-bot' }))).status, 401, 'a token for another bot');
    assert.equal((await send(activity('a0', 'hi'), jwt({ ...good, exp: now - 3600 }))).status, 401, 'an expired token');
    assert.equal((await send(activity('a0', 'hi', 'https://evil.example/'), jwt(good))).status, 401, 'a token for another service address');
    assert.equal((await send(activity('a0', 'hi'), jwt(good, 'other-key'))).status, 401, 'a key the Bot Framework does not publish');
    assert.equal((await send(activity('a1', '<at>Front Desk</at> hello'), jwt(good))).status, 200);
    const reply = await until(() => seen.find(x => x.path === '/teams/v3/conversations/conv-1/activities/a1'), 10000, 'the Teams answer');
    assert.equal(JSON.parse(reply.body).text, 'turns=1 tools=0 said=hello'); assert.equal(reply.auth, 'Bearer bot-token');
    const ask = new URLSearchParams(seen.find(x => x.path.endsWith('/oauth2/v2.0/token')).body);
    assert.equal(ask.get('client_id'), appId); assert.equal(ask.get('client_secret'), 'teams-fixture-pw'); assert.equal(ask.get('scope'), 'https://api.botframework.com/.default');
    await send(activity('a2', 'again'), jwt(good));
    await until(() => seen.find(x => x.path === '/teams/v3/conversations/conv-1/activities/a2'), 10000, 'the second answer');
    assert.equal(tokenAsks, 1, 'the bot token is used again until it runs out');
  });

  await t.test('secrets never leave SILO, and a channel turned off stops answering', async () => {
    const all = JSON.stringify((await request('/talk')).data) + JSON.stringify((await request('/state')).data);
    for (const s of ['wa-fixture-token', 'wa-fixture-secret', 'teams-fixture-pw', 'abcdef0123456789abcdef0123456789']) assert.ok(!all.includes(s), s + ' stays in the vault');
    assert.equal((await request('/talk/widget', { enabled: false })).status, 200);
    assert.equal((await fetch(`${api}/widget/${key}.js`)).status, 404);
    const r = await fetch(`${api}/widget/${key}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://shop.example' }, body: JSON.stringify({ visitor: 'z'.repeat(20), text: 'hi' }) });
    assert.equal(r.status, 404);
  });
});
