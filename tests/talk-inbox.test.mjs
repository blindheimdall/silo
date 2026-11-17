// The talk inbox: every conversation kept through a restart, a person of your team taking one over and answering in
// the resident's place on the website, in Slack and on WhatsApp, giving it back, and who may read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inbox } from '../talk-inbox.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms, what) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('Timed out waiting for ' + what); await wait(50); } };

test('the inbox keeps conversations, trims them and gives forgotten ones back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-inbox-unit-'));
  const box = new Inbox(dir, { max: 3, messages: 5 }).open();
  try {
    const say = (key, role, text, now) => box.record({ kind: 'widget', key, who: 'visitor ' + key, role, text, now });
    const t0 = Date.now() - 3600000;
    for (let i = 1; i <= 4; i++) say('a', i % 2 ? 'person' : 'resident', 'm' + i, t0 + i);
    assert.deepEqual(box.history('a', { now: t0 + 10 }), [{ role: 'user', content: 'm1' }, { role: 'assistant', content: 'm2' }, { role: 'user', content: 'm3' }, { role: 'assistant', content: 'm4' }]);
    assert.deepEqual(box.history('a', { now: t0 + 3 * 3600000 }), [], 'nothing after two idle hours');
    const id = box.byKey('a').id;
    box.setMode(id, 'person', 'Ana');
    say('a', 'person', 'm6', t0 + 20); say('a', 'human', 'm7', t0 + 21);
    assert.deepEqual(box.messages(id).map(m => m.role), ['person', 'resident', 'note', 'person', 'human'], 'the note of the take over is kept with the messages');
    assert.equal(box.messages(id).length, 5, 'the oldest messages go past the cap');
    assert.equal(box.get(id).count, 5);
    assert.ok(box.history('a', { now: t0 + 30 }).some(m => m.content === 'm7' && m.role === 'assistant'), 'an answer from your team counts as the assistant\'s');
    assert.equal(box.counts().waiting, 0); say('a', 'person', 'm8', t0 + 40); assert.equal(box.counts().waiting, 1);
    box.setMode(id, 'resident', 'Ana');
    assert.deepEqual(box.history('a', { now: t0 + 50 }), [], 'given back, the resident starts from there');
    assert.deepEqual(box.messages(id, { sent: true }).map(m => m.role).filter(r => r === 'note' || r === 'person'), [], 'notes and the person\'s own messages are not sent back');
    say('b', 'person', 'x', Date.now()); say('c', 'person', 'y', Date.now()); say('d', 'person', 'z', Date.now());
    box.setMode(box.byKey('b').id, 'person', 'Ana');
    let r = box.prune({ keepDays: 30 });
    assert.equal(r.removed, 1, 'the oldest goes past the cap'); assert.equal(box.byKey('a'), null);
    r = box.prune({ keepDays: 30, now: Date.now() + 25 * 3600000 });
    assert.equal(r.givenBack, 1); assert.equal(box.byKey('b').mode, 'resident', 'a conversation left for a day goes back to the resident');
    assert.match(box.messages(box.byKey('b').id).at(-1).text, /Given back to the resident by SILO after a day/);
    assert.equal(box.list({ search: 'Z' }).total, 1, 'search finds message text without case');
    assert.equal(box.list({ search: '100%' }).total, 0, 'a % is a letter, not a wildcard');
    const all = box.list().total;
    assert.equal(box.list({ limit: 1 }).total, all, 'a full page counts every match');
    assert.equal(box.list({ limit: 1, offset: 1 }).total, all);
    assert.equal(box.list({ limit: 200 }).total, all, 'a page that is not full counts what it holds');
    r = box.prune({ keepDays: 1, now: Date.now() + 2 * 86400000 });
    assert.equal(r.removed, 3); assert.equal(box.counts().conversations, 0);
    assert.throws(() => box.get('nope'), /That conversation is gone/);
  } finally { box.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('your team takes conversations over, answers and gives them back', async t => {
  const seen = [];
  const fake = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const p = new URL(req.url, 'http://x').pathname; seen.push({ path: p, body });
    const json = (d, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (p === '/slack/auth.test') return json({ ok: true, user: 'silo', team: 'Acme' });
    if (p === '/slack/chat.postMessage') return json({ ok: true, ts: '9.9' });
    if (p === '/graph/123456789/messages') return json({ messages: [{ id: 'wamid.out' }] });
    json({ error: 'not found ' + p }, 404);
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-talk-inbox-'));
  const port = 14473, api = `http://127.0.0.1:${port}`;
  let child, errors = '';
  const start = async () => {
    child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), SILO_TEST_CONNECTOR_BASE: base, SILO_TEST_TALK_BASE: base, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', b => { errors += b; });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  };
  const stop = async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); };
  t.after(async () => { await stop(); fake.close(); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await start();
  const client = async () => {
    const ses = await fetch(api + '/api/session'); const c = { ...(await ses.json()), cookie: ses.headers.get('set-cookie')?.split(';')[0] };
    c.request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie: c.cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': c.token }, body: body === undefined ? undefined : JSON.stringify(body) }); const set = r.headers.get('set-cookie'); if (set) { c.cookie = set.split(';')[0]; c.token = c.cookie.split('=')[1]; } return { status: r.status, data: await r.json().catch(() => ({})) }; };
    return c;
  };
  let owner = await client(), request = owner.request;
  await request('/connections', { provider: 'compatible', key: 'fixture-talk-key', model: 'talk', endpoint: 'https://example.com/v1/chat/completions' });
  const agent = (await request('/agents', { name: 'Front Desk', role: 'Answers people', floor: 2, provider: 'compatible', model: 'talk', instructions: 'Be kind.' })).data;
  const key = (await request('/talk/widget', { enabled: true, agentId: agent.id, origins: ['https://shop.example'] })).data.widget.key;
  const chat = body => fetch(`${api}/widget/${key}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://shop.example' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
  const visitor = 'ana_' + 'a'.repeat(20);
  const inbox = async (q = '') => (await request('/talk/inbox' + q)).data;
  const conv = async id => (await request('/talk/inbox/' + id)).data;
  let cid, lastSeen;

  await t.test('every website message is kept, and the resident remembers the conversation', async () => {
    let r = await chat({ visitor, text: 'Hello' });
    assert.equal(r.reply, 'turns=1 tools=0 said=Hello'); assert.ok(r.n > 0);
    r = await chat({ visitor, text: 'Do you ship to Cluj?', after: r.n });
    assert.equal(r.reply, 'turns=2 tools=0 said=Do you ship to Cluj?'); assert.deepEqual(r.missed, []); lastSeen = r.n;
    const list = await inbox();
    assert.equal(list.total, 1); assert.equal(list.counts.conversations, 1); assert.equal(list.counts.unread, 1);
    const c = list.conversations[0]; cid = c.id;
    assert.equal(c.kind, 'widget'); assert.equal(c.who, 'visitor ana_aa'); assert.equal(c.mode, 'resident'); assert.equal(c.unread, 2); assert.equal(c.count, 4);
    assert.equal(list.channels.widget.agent, 'Front Desk');
    const d = await conv(cid);
    assert.deepEqual(d.messages.map(m => [m.role, m.by]), [['person', ''], ['resident', 'Front Desk'], ['person', ''], ['resident', 'Front Desk']]);
    assert.equal((await request('/talk/inbox/' + cid + '/read', {})).data.unread, 0);
    assert.equal((await inbox('?q=CLUJ')).total, 1); assert.equal((await inbox('?q=berlin')).total, 0);
    assert.equal((await inbox('?kind=slack')).total, 0); assert.equal((await request('/talk/inbox?kind=fax')).status, 400);
    assert.equal((await request('/state')).data.talkInbox.conversations, 1);
  });

  await t.test('taken over: the resident is quiet, the visitor hears from your team', async () => {
    const taken = await request('/talk/inbox/' + cid + '/mode', { mode: 'person' });
    assert.equal(taken.status, 200); assert.equal(taken.data.mode, 'person');
    let r = await chat({ visitor, text: 'Can I talk to a person?', after: lastSeen });
    assert.equal(r.reply, null); assert.equal(r.human, true);
    assert.equal((await inbox('?mode=waiting')).total, 1);
    assert.ok((await request('/state')).data.events.some(e => e.type === 'talk' && /visitor ana_aa is waiting for an answer/.test(e.title)), 'your team is told');
    const sent = await request('/talk/inbox/' + cid + '/reply', { text: 'Hi, this is Dan. Yes, we ship to Cluj.' });
    assert.equal(sent.status, 200, JSON.stringify(sent.data)); assert.equal(sent.data.conversation.unread, 0);
    assert.equal((await request('/talk/inbox/' + cid + '/reply', { text: 'Hi, this is Dan. Yes, we ship to Cluj.' })).status, 409, 'the same answer is not sent twice at once');
    assert.equal((await inbox('?mode=waiting')).total, 0);
    const poll = await chat({ visitor, after: lastSeen });
    assert.equal(poll.human, true);
    assert.deepEqual(poll.messages.map(m => m.t), ['Hi, this is Dan. Yes, we ship to Cluj.'], 'only answers come back, not what the visitor wrote or notes');
    assert.equal((await chat({ visitor: 'bob_' + 'b'.repeat(20), after: 0 })).messages.length, 0, 'a visitor sees only their own conversation');
    lastSeen = poll.messages.at(-1).n;
    const d = await conv(cid);
    assert.deepEqual(d.messages.slice(-3).map(m => m.role), ['note', 'person', 'human'], 'kept in order');
    assert.ok(d.messages.some(m => m.role === 'note' && /^Taken over/.test(m.text)));
    assert.equal(d.messages.at(-1).role, 'human');
  });

  await t.test('given back, the resident answers again and a missed answer comes along', async () => {
    await request('/talk/inbox/' + cid + '/reply', { text: 'Anything else?' });
    assert.equal((await request('/talk/inbox/' + cid + '/mode', { mode: 'resident' })).data.mode, 'resident');
    const r = await chat({ visitor, text: 'No, thanks', after: lastSeen });
    assert.equal(r.reply, 'turns=1 tools=0 said=No, thanks', 'the resident starts from where it got the conversation back');
    assert.deepEqual(r.missed.map(m => m.t), ['Anything else?'], 'the answer the chat had not shown yet comes with this one');
    assert.equal((await request('/talk/inbox/' + cid + '/mode', { mode: 'nobody' })).status, 400);
  });

  await t.test('Slack and WhatsApp: your answer goes back the way the person wrote', async () => {
    assert.equal((await request('/services/slack', { token: 'xoxb-fixture-slack-token' })).status, 200);
    const secret = 'abcdef0123456789abcdef0123456789';
    assert.equal((await request('/talk/slack', { enabled: true, agentId: agent.id, signingSecret: secret })).status, 200);
    const slack = body => { const ts = Math.floor(Date.now() / 1000), raw = JSON.stringify(body); return fetch(api + '/talk/slack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${raw}`).digest('hex') }, body: raw }); };
    const posts = () => seen.filter(x => x.path === '/slack/chat.postMessage');
    await slack({ type: 'event_callback', team_id: 'T1', event_id: 'Ev1', event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '100.1', text: '<@UBOT> refund please' } });
    await until(() => posts().length === 1, 10000, 'the resident in Slack');
    const sc = (await inbox('?kind=slack')).conversations[0];
    assert.equal(sc.who, 'user U1');
    await request('/talk/inbox/' + sc.id + '/mode', { mode: 'person' });
    await slack({ type: 'event_callback', team_id: 'T1', event_id: 'Ev2', event: { type: 'app_mention', user: 'U1', channel: 'C1', ts: '100.2', thread_ts: '100.1', text: '<@UBOT> hello?' } });
    await until(async () => (await inbox('?mode=waiting')).total === 1, 10000, 'the message waiting for your team');
    await wait(300); assert.equal(posts().length, 1, 'the resident does not answer a conversation your team has');
    assert.equal((await request('/talk/inbox/' + sc.id + '/reply', { text: 'Refund sent today.' })).status, 200);
    const out = JSON.parse(posts().at(-1).body);
    assert.equal(out.channel, 'C1'); assert.equal(out.thread_ts, '100.1'); assert.equal(out.text, 'Refund sent today.');
    const sign = raw => 'sha256=' + createHmac('sha256', 'wa-fixture-secret').update(raw).digest('hex');
    assert.equal((await request('/talk/whatsapp', { enabled: true, agentId: agent.id, phoneId: '123456789', token: 'wa-fixture-token', appSecret: 'wa-fixture-secret' })).status, 200);
    const raw = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '123456789' }, contacts: [{ wa_id: '40712345678', profile: { name: 'Ioana' } }], messages: [{ id: 'wamid.1', from: '40712345678', type: 'text', text: { body: 'Is it open?' } }] } }] }] });
    assert.equal((await fetch(api + '/talk/whatsapp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sign(raw) }, body: raw })).status, 200);
    const wa = await until(async () => (await inbox('?kind=whatsapp')).conversations.find(c => c.count >= 2), 10000, 'the WhatsApp conversation');
    assert.equal(wa.who, 'Ioana');
    assert.equal((await request('/talk/inbox/' + wa.id + '/reply', { text: 'Yes, until 18:00.' })).status, 200);
    const w = JSON.parse(seen.filter(x => x.path === '/graph/123456789/messages').at(-1).body);
    assert.equal(w.to, '40712345678'); assert.equal(w.text.body, 'Yes, until 18:00.');
    assert.equal((await conv(wa.id)).conversation.mode, 'person', 'answering takes the conversation over');
    await request('/talk/whatsapp', { enabled: false });
    const off = await request('/talk/inbox/' + wa.id + '/reply', { text: 'Still there?' });
    assert.equal(off.status, 409); assert.match(off.data.error, /WhatsApp is off/);
    assert.equal((await conv(wa.id)).messages.filter(m => m.role === 'human').length, 1, 'an answer that was not sent is not kept as sent');
  });

  await t.test('conversations are kept through a restart, and only owners and operators read them', async () => {
    await stop(); await start();
    owner = await client(); request = owner.request;
    const list = await inbox();
    assert.equal(list.total, 3);
    const r = await chat({ visitor, text: 'One more thing', after: 0 });
    assert.equal(r.reply, 'turns=2 tools=0 said=One more thing', 'the resident remembers after a restart');
    assert.equal((await request('/talk/inbox/settings', { keepDays: 0 })).status, 400);
    assert.equal((await request('/talk/inbox/settings', { keepDays: 7 })).data.keepDays, 7);
    assert.equal((await request('/users', { name: 'Ana', password: 'owner-pass-1' })).status, 201);
    assert.equal((await request('/users', { name: 'Vic', password: 'viewer-pass-1', role: 'viewer' })).status, 201);
    assert.equal((await request('/users', { name: 'Oli', password: 'operator-pass-1', role: 'operator' })).status, 201);
    const v = await client(); assert.equal((await v.request('/login', { name: 'Vic', password: 'viewer-pass-1' })).status, 200);
    assert.equal((await v.request('/talk/inbox')).status, 403);
    assert.equal((await v.request('/talk/inbox/' + cid)).status, 403);
    assert.equal((await v.request('/state')).data.talkInbox, undefined, 'viewers do not get the counts either');
    const o = await client(); assert.equal((await o.request('/login', { name: 'Oli', password: 'operator-pass-1' })).status, 200);
    assert.equal((await o.request('/talk/inbox')).data.total, 3);
    const keep = await o.request('/talk/inbox/settings', { keepDays: 9 });
    assert.equal(keep.status, 403); assert.match(keep.data.error, /Only an owner/, 'only an owner says how long they are kept');
    const sent = await o.request('/talk/inbox/' + cid + '/reply', { text: 'Oli here.' });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal((await o.request('/talk/inbox/' + cid)).data.messages.at(-1).by, 'Oli', 'the answer names who sent it');
    assert.equal((await o.request('/talk/inbox/' + cid, undefined, 'DELETE')).status, 200);
    assert.equal((await o.request('/talk/inbox/' + cid)).status, 404);
    assert.equal((await o.request('/talk/inbox')).data.total, 2);
  });
});
