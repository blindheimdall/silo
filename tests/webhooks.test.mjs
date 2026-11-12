// Events from apps: each app's signature, made here the way the app's documentation says, is accepted; a wrong
// secret, a changed body and an old event are refused; the address checks (Asana, Notion, Dropbox, Meta, Trello,
// Zoom, Discord) get the answer the app expects. Then a running SILO starts a workflow from a signed Stripe event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, createHash, generateKeyPairSync, sign as edSign, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_APPS, HOOK_APP_LIST, readWebhook } from '../webhook-apps.mjs';
import { triggerConfig } from '../app-triggers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 15000, what = 'condition') { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('Timed out waiting for ' + what); await wait(100); } }
const hmac = (alg, key, data, enc = 'hex') => createHmac(alg, key).update(data).digest(enc);
const URL_ = 'https://silo.example.com/apphook/0123456789abcdef0123456789abcdef';
const b64url = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const discordKeys = generateKeyPairSync('ed25519');
const discordPublic = discordKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
const svixSecret = 'whsec_' + randomBytes(24).toString('base64');

// app: [secret, body (object or form string), sign(secret, raw, nowSeconds) => headers, expected event type]
const CASES = {
  stripe: ['whsec_abc123', { id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1', amount_paid: 1200 } } }, (s, raw, t) => ({ 'stripe-signature': `t=${t},v1=${hmac('sha256', s, `${t}.${raw}`)},v0=old` }), 'invoice.paid'],
  shopify: ['shpss_1', { id: 820982911946154500, total_price: '19.00' }, (s, raw) => ({ 'x-shopify-hmac-sha256': hmac('sha256', s, raw, 'base64'), 'x-shopify-topic': 'orders/create', 'x-shopify-webhook-id': 'w1' }), 'orders/create'],
  woocommerce: ['wc-secret', { id: 77, status: 'processing' }, (s, raw) => ({ 'x-wc-webhook-signature': hmac('sha256', s, raw, 'base64'), 'x-wc-webhook-topic': 'order.created', 'x-wc-webhook-delivery-id': 'd1' }), 'order.created'],
  square: ['sq-key', { type: 'payment.created', event_id: 'e1', data: { id: 'p1' } }, (s, raw) => ({ 'x-square-hmacsha256-signature': hmac('sha256', s, URL_ + raw, 'base64') }), 'payment.created'],
  paddle: ['pdl_ntfset_1', { event_id: 'evt_1', event_type: 'transaction.completed', data: { id: 'txn_1' } }, (s, raw, t) => ({ 'paddle-signature': `ts=${t};h1=${hmac('sha256', s, `${t}:${raw}`)}` }), 'transaction.completed'],
  lemonsqueezy: ['ls-secret', { meta: { event_name: 'order_created' }, data: { id: '1', attributes: {} } }, (s, raw) => ({ 'x-signature': hmac('sha256', s, raw) }), 'order_created'],
  github: ['gh-secret', { ref: 'refs/heads/main' }, (s, raw) => ({ 'x-hub-signature-256': 'sha256=' + hmac('sha256', s, raw), 'x-github-event': 'push', 'x-github-delivery': 'd-1' }), 'push'],
  gitlab: ['gl-token', { object_kind: 'merge_request', object_attributes: { action: 'open' } }, s => ({ 'x-gitlab-token': s, 'x-gitlab-event': 'Merge Request Hook' }), 'Merge Request Hook.open'],
  bitbucket: ['bb-secret', { push: {} }, (s, raw) => ({ 'x-hub-signature': 'sha256=' + hmac('sha256', s, raw), 'x-event-key': 'repo:push', 'x-request-uuid': 'u1' }), 'repo:push'],
  sentry: ['sentry-client-secret', { action: 'created', data: { issue: { id: '1' } } }, (s, raw) => ({ 'sentry-hook-signature': hmac('sha256', s, raw), 'sentry-hook-resource': 'issue', 'request-id': 'r1' }), 'issue.created'],
  pagerduty: ['pd-secret', { event: { id: 'e1', event_type: 'incident.triggered', data: {} } }, (s, raw) => ({ 'x-pagerduty-signature': `v1=deadbeef, v1=${hmac('sha256', s, raw)}` }), 'incident.triggered'],
  vercel: ['vc-secret', { id: 'e1', type: 'deployment.error', payload: {} }, (s, raw) => ({ 'x-vercel-signature': hmac('sha1', s, raw) }), 'deployment.error'],
  netlify: ['jws-secret', { id: 'd1', state: 'ready' }, (s, raw) => { const hd = b64url({ alg: 'HS256', typ: 'JWT' }), pl = b64url({ iss: 'netlify', sha256: createHash('sha256').update(raw).digest('hex') }); return { 'x-webhook-signature': `${hd}.${pl}.${hmac('sha256', s, `${hd}.${pl}`, 'base64url')}` }; }, 'deploy ready'],
  jira: ['jira-secret', { webhookEvent: 'jira:issue_created', issue: { key: 'OPS-1' } }, (s, raw) => ({ 'x-hub-signature': 'sha256=' + hmac('sha256', s, raw), 'x-atlassian-webhook-identifier': 'j1' }), 'jira:issue_created'],
  linear: ['lin_wh_1', { type: 'Issue', action: 'create', data: { id: 'i1' }, webhookTimestamp: Date.now() }, (s, raw) => ({ 'linear-signature': hmac('sha256', s, raw), 'linear-delivery': 'l1' }), 'Issue.create'],
  trello: ['trello-app-secret', { action: { id: 'a1', type: 'createCard' } }, (s, raw) => ({ 'x-trello-webhook': hmac('sha1', s, raw + URL_, 'base64') }), 'createCard'],
  clickup: ['cu-secret', { event: 'taskCreated', task_id: 't1', webhook_id: 'w1', history_items: [{ id: 'h1' }] }, (s, raw) => ({ 'x-signature': hmac('sha256', s, raw) }), 'taskCreated'],
  todoist: ['td-client-secret', { event_name: 'item:added', event_data: { id: '1' } }, (s, raw) => ({ 'x-todoist-hmac-sha256': hmac('sha256', s, raw, 'base64'), 'x-todoist-delivery-id': 't1' }), 'item:added'],
  calendly: ['cal-key', { event: 'invitee.created', payload: { uri: 'https://api.calendly.com/x/1' } }, (s, raw, t) => ({ 'calendly-webhook-signature': `t=${t},v1=${hmac('sha256', s, `${t}.${raw}`)}` }), 'invitee.created'],
  typeform: ['tf-secret', { event_id: 'e1', event_type: 'form_response', form_response: { answers: [] } }, (s, raw) => ({ 'typeform-signature': 'sha256=' + hmac('sha256', s, raw, 'base64') }), 'form_response'],
  zoom: ['zoom-secret', { event: 'meeting.started', event_ts: 1, payload: { object: { id: 9 } } }, (s, raw, t) => ({ 'x-zm-request-timestamp': String(t), 'x-zm-signature': 'v0=' + hmac('sha256', s, `v0:${t}:${raw}`) }), 'meeting.started'],
  discord: [discordPublic, { version: 1, type: 1, event: { type: 'APPLICATION_AUTHORIZED', data: { user: { id: '1' } } } }, (s, raw, t) => ({ 'x-signature-timestamp': String(t), 'x-signature-ed25519': edSign(null, Buffer.from(String(t) + raw), discordKeys.privateKey).toString('hex') }), 'APPLICATION_AUTHORIZED'],
  telegram: ['tg-secret-token', { update_id: 5, message: { text: 'hi' } }, s => ({ 'x-telegram-bot-api-secret-token': s }), 'message'],
  meta: ['meta-app-secret', { object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messages: [{ text: { body: 'hi' } }] } }] }] }, (s, raw) => ({ 'x-hub-signature-256': 'sha256=' + hmac('sha256', s, raw) }), 'whatsapp_business_account.messages'],
  twilio: ['twilio-auth-token', 'Body=Hello&From=%2B40700000000&MessageSid=SM1&To=%2B15550000000', (s, raw) => { const f = Object.fromEntries(new URLSearchParams(raw)); return { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': hmac('sha1', s, URL_ + Object.keys(f).sort().map(k => k + f[k]).join(''), 'base64') }; }, 'incoming message'],
  mailgun: ['mg-signing-key', null, null, 'delivered'],
  svix: [svixSecret, { type: 'email.bounced', data: { email_id: 'm1' } }, (s, raw, t) => ({ 'svix-id': 'msg_1', 'svix-timestamp': String(t), 'svix-signature': 'v1,bad v1,' + hmac('sha256', Buffer.from(s.slice(6), 'base64'), `msg_1.${t}.${raw}`, 'base64') }), 'email.bounced'],
  zendesk: ['zd-secret', { id: 'z1', type: 'zen:event-type:ticket.created' }, (s, raw) => { const ts = new Date().toISOString(); return { 'x-zendesk-webhook-signature-timestamp': ts, 'x-zendesk-webhook-signature': hmac('sha256', s, ts + raw, 'base64') }; }, 'zen:event-type:ticket.created'],
  intercom: ['ic-client-secret', { id: 'n1', topic: 'conversation.user.created', data: { item: {} } }, (s, raw) => ({ 'x-hub-signature': 'sha1=' + hmac('sha1', s, raw) }), 'conversation.user.created'],
  hubspot: ['hs-client-secret', [{ eventId: 1, subscriptionType: 'contact.creation' }, { eventId: 2, subscriptionType: 'deal.propertyChange' }], (s, raw) => { const ts = Date.now(); return { 'x-hubspot-request-timestamp': String(ts), 'x-hubspot-signature-v3': hmac('sha256', s, 'POST' + URL_ + raw + ts, 'base64') }; }, 'contact.creation'],
  webflow: ['wf-secret', { triggerType: 'form_submission', payload: { name: 'Contact' } }, (s, raw) => { const ts = Date.now(); return { 'x-webflow-timestamp': String(ts), 'x-webflow-signature': hmac('sha256', s, `${ts}:${raw}`) }; }, 'form_submission'],
  dropbox: ['dbx-app-secret', { list_folder: { accounts: ['dbid:1'] } }, (s, raw) => ({ 'x-dropbox-signature': hmac('sha256', s, raw) }), 'files changed'],
  basic: ['hook:pass-word', { RecordType: 'Bounce', MessageID: 'm1' }, s => ({ authorization: 'Basic ' + Buffer.from(s).toString('base64') }), 'Bounce'],
  hmac: ['any-secret', { type: 'thing.happened', id: 't1' }, (s, raw) => ({ 'x-webhook-signature': 'sha256=' + hmac('sha256', s, raw) }), 'thing.happened'],
  token: ['shared-token-123', { event: 'build.done', id: 'b1' }, s => ({ authorization: 'Bearer ' + s }), 'build.done'],
};
const mailgunBody = (s, t) => ({ signature: { timestamp: String(t), token: 'tok123', signature: hmac('sha256', s, `${t}tok123`) }, 'event-data': { event: 'delivered', id: 'ev1' } });

test('every app on the list has a test here, a hint and a place to paste the address', () => {
  assert.ok(HOOK_APP_LIST.length >= 35, 'apps: ' + HOOK_APP_LIST.length);
  for (const a of HOOK_APP_LIST) {
    assert.ok(a.hint && a.setup && a.group, a.value);
    assert.ok(!/[–—]/.test(a.hint + a.setup + a.label), a.value + ' plain text');
    if (!['asana', 'notion'].includes(a.value)) assert.ok(CASES[a.value], 'a test for ' + a.value);
  }
});

test('each app\'s signature is accepted; a wrong secret, a changed body or an old event is not', () => {
  const now = Date.now(), t = Math.floor(now / 1000);
  for (const [app, [secret, body, sign, type]] of Object.entries(CASES)) {
    const raw = app === 'mailgun' ? JSON.stringify(mailgunBody(secret, t)) : typeof body === 'string' ? body : JSON.stringify(body);
    const headers = app === 'mailgun' ? {} : sign(secret, raw, t);
    const call = (s, r = raw, h = headers, when = now) => readWebhook({ app }, { method: 'POST', headers: h, raw: r, url: URL_, secret: s, now: when });
    const ok = call(secret);
    assert.equal(ok.status, 200, `${app}: ${JSON.stringify(ok.json)}`);
    assert.ok(ok.items.length >= 1, app + ' items');
    assert.equal(ok.items[0].title, `${HOOK_APPS[app].name.replace(/ \(.*$/, '')}: ${type}`, app + ' title');
    assert.ok(ok.items[0].id.startsWith(app + ':'), app + ' id');
    assert.match(ok.items[0].text, new RegExp(`event: ${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), app + ' text');
    assert.equal(call(app === 'discord' ? generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex') : app === 'svix' ? 'whsec_' + randomBytes(24).toString('base64') : secret + 'x').status, 401, app + ' wrong secret');
    if (!['gitlab', 'telegram', 'basic', 'token'].includes(app)) assert.equal(call(secret, raw.replace(/.$/, ' ')).status, 401, app + ' changed body');
    assert.equal(call('').status, 401, app + ' no secret');
  }
  // Old events, where the app sends the time.
  for (const app of ['stripe', 'paddle', 'calendly', 'zoom', 'svix', 'discord']) {
    const [secret, body, sign] = CASES[app], raw = JSON.stringify(body), old = Math.floor(Date.now() / 1000) - 3600;
    assert.equal(readWebhook({ app }, { method: 'POST', headers: sign(secret, raw, old), raw, url: URL_, secret }).status, 401, app + ' old');
  }
  // HubSpot sends a batch: one item each.
  { const [secret, body, sign] = CASES.hubspot, raw = JSON.stringify(body);
    assert.equal(readWebhook({ app: 'hubspot' }, { method: 'POST', headers: sign(secret, raw), raw, url: URL_, secret }).items.length, 2); }
});

test('only the events you want, and the app\'s address checks', () => {
  const [secret, , sign] = CASES.stripe, t = Math.floor(Date.now() / 1000);
  const ev = type => { const raw = JSON.stringify({ id: 'evt_' + type, type, data: { object: {} } }); return readWebhook({ app: 'stripe', events: 'invoice, checkout.session' }, { method: 'POST', headers: sign(secret, raw, t), raw, url: URL_, secret }); };
  assert.equal(ev('invoice.paid').items.length, 1);
  assert.equal(ev('checkout.session.completed').items.length, 1);
  assert.equal(ev('customer.created').items.length, 0, 'not wanted');
  assert.equal(ev('customer.created').status, 200, 'but still answered, so the app does not retry');

  // Asana: the first request carries the secret; SILO answers with it and keeps it.
  const hs = readWebhook({ app: 'asana' }, { method: 'POST', headers: { 'x-hook-secret': 'asana-s3cret' }, raw: '', secret: '' });
  assert.equal(hs.status, 200); assert.equal(hs.headers['X-Hook-Secret'], 'asana-s3cret'); assert.equal(hs.learn, 'asana-s3cret');
  assert.equal(readWebhook({ app: 'asana' }, { method: 'POST', headers: { 'x-hook-secret': 'other' }, raw: '', secret: 'asana-s3cret' }).status, 401, 'a second handshake cannot change it');
  const araw = JSON.stringify({ events: [{ action: 'added', resource: { resource_type: 'task', gid: '1' } }, { action: 'changed', resource: { resource_type: 'task', gid: '2' } }] });
  assert.equal(readWebhook({ app: 'asana' }, { method: 'POST', headers: { 'x-hook-signature': hmac('sha256', 'asana-s3cret', araw) }, raw: araw, secret: 'asana-s3cret' }).items.length, 2);
  // Notion: the verification token arrives once, to be pasted back in Notion.
  assert.equal(readWebhook({ app: 'notion' }, { method: 'POST', headers: {}, raw: '{"verification_token":"secret_v1"}', secret: '' }).learn, 'secret_v1');
  const nraw = JSON.stringify({ id: 'n1', type: 'page.created' });
  assert.equal(readWebhook({ app: 'notion' }, { method: 'POST', headers: { 'x-notion-signature': 'sha256=' + hmac('sha256', 'secret_v1', nraw) }, raw: nraw, secret: 'secret_v1' }).items[0].title, 'Notion: page.created');
  // Dropbox, Meta, Trello.
  assert.deepEqual(readWebhook({ app: 'dropbox' }, { method: 'GET', query: new URLSearchParams('challenge=abc123'), secret: 'x' }).text, 'abc123');
  const tok = '0123456789abcdef0123456789abcdef';
  assert.equal(readWebhook({ app: 'meta' }, { method: 'GET', query: new URLSearchParams(`hub.mode=subscribe&hub.verify_token=${tok}&hub.challenge=99`), token: tok, secret: 'x' }).text, '99');
  assert.equal(readWebhook({ app: 'meta' }, { method: 'GET', query: new URLSearchParams('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=99'), token: tok, secret: 'x' }).status, 403);
  assert.equal(readWebhook({ app: 'trello' }, { method: 'HEAD', secret: 'x' }).status, 200);
  assert.equal(readWebhook({ app: 'stripe' }, { method: 'GET', secret: 'x' }).status, 405);
  // Zoom's address check, signed.
  const zraw = JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'plain1' } });
  const z = readWebhook({ app: 'zoom' }, { method: 'POST', headers: CASES.zoom[2]('zoom-secret', zraw, t), raw: zraw, secret: 'zoom-secret' });
  assert.deepEqual(z.json, { plainToken: 'plain1', encryptedToken: hmac('sha256', 'zoom-secret', 'plain1') });
  assert.equal(readWebhook({ app: 'zoom' }, { method: 'POST', headers: {}, raw: zraw, secret: 'zoom-secret' }).status, 401, 'not without a signature');
  // Discord's ping.
  const draw = JSON.stringify({ version: 1, type: 0 });
  assert.equal(readWebhook({ app: 'discord' }, { method: 'POST', headers: CASES.discord[2](discordPublic, draw, t), raw: draw, secret: discordPublic }).status, 204);
  // The trigger settings.
  assert.deepEqual(triggerConfig({ kind: 'webhook.app', app: 'stripe', events: 'invoice' }), { kind: 'webhook.app', app: 'stripe', events: 'invoice', every: 60, instant: true });
  assert.throws(() => triggerConfig({ kind: 'webhook.app', app: 'nope' }), /listed choices/);
});

test('a signed Stripe event starts a workflow in a running SILO; Asana keeps its secret; a key check shows on the card', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-webhooks-'));
  const port = 14371, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), SILO_APP_TRIGGER_INTERVAL: '300', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); const resolved = path.resolve(temp); assert.ok(path.basename(resolved).startsWith('silo-webhooks-')); await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 15000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => null) }; };
  const state = async () => (await request('/state')).data;
  const first = (await state()).agents[0];
  const flow = (name, app) => request('/workflows', { name, steps: [{ agentId: first.id, prompt: 'Handle it.' }], app });
  const runsOf = async id => (await state()).runs.filter(r => r.workflowId === id && r.trigger === 'app');
  const post = (tok, raw, headers, method = 'POST') => fetch(`${api}/apphook/${tok}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? raw : undefined });

  assert.ok((await state()).appTriggers.find(x => x.kind === 'webhook.app').fields[0].options.length >= 35);
  const missing = await flow('Paid', { kind: 'webhook.app', app: 'stripe' });
  assert.equal(missing.status, 400); assert.match(missing.data.error, /secret for Stripe/);
  const w = (await flow('Paid', { kind: 'webhook.app', app: 'stripe', events: 'invoice', signing: 'whsec_live1' })).data;
  assert.match(w.appHook, /^[a-f0-9]{32}$/); assert.equal(JSON.stringify(w).includes('whsec_live1'), false);
  const info = (await request('/workflows/' + w.id + '/apphook')).data;
  assert.equal(info.via, 'any'); assert.equal(info.app, 'Stripe'); assert.match(info.setup, /Developers, Webhooks/);
  const ts = Math.floor(Date.now() / 1000), send = (type, secret = 'whsec_live1') => { const raw = JSON.stringify({ id: 'evt_' + type, type, data: { object: { amount_paid: 4200 } } }); return post(w.appHook, raw, { 'stripe-signature': `t=${ts},v1=${hmac('sha256', secret, `${ts}.${raw}`)}` }); };
  assert.equal((await send('invoice.paid', 'wrong')).status, 401);
  assert.equal((await send('customer.created')).status, 200);
  assert.equal((await send('invoice.paid')).status, 200);
  const runs = await until(async () => { const r = await runsOf(w.id); return r.length ? r : null; }, 5000, 'stripe run');
  assert.match(runs[0].input, /<event source="webhook.app">\nStripe event: invoice\.paid[\s\S]*"amount_paid": 4200/);
  await send('invoice.paid'); await wait(500);
  assert.equal((await runsOf(w.id)).length, 1, 'once, and not for the unwanted event');
  assert.equal(await (await post(w.appHook, '', {}, 'GET')).status, 405);

  // Asana: no secret to give; the handshake brings it.
  const a = (await flow('Tasks', { kind: 'webhook.app', app: 'asana' })).data;
  assert.equal((await request('/workflows/' + a.id + '/apphook')).data.waiting, true);
  const hs = await post(a.appHook, '', { 'x-hook-secret': 'asana-123' });
  assert.equal(hs.status, 200); assert.equal(hs.headers.get('x-hook-secret'), 'asana-123');
  assert.equal((await request('/workflows/' + a.id + '/apphook')).data.waiting, false);
  const araw = JSON.stringify({ events: [{ action: 'added', resource: { resource_type: 'task', gid: '7' } }] });
  assert.equal((await post(a.appHook, araw, { 'x-hook-signature': hmac('sha256', 'asana-123', araw) })).status, 200);
  await until(async () => (await runsOf(a.id)).length, 5000, 'asana run');
  // Editing the workflow keeps the learned secret.
  const keep = await request('/workflows/' + a.id, { ...a, app: { kind: 'webhook.app', app: 'asana', events: 'task' } }, 'PUT');
  assert.equal(keep.status, 200, JSON.stringify(keep.data));
  assert.equal((await post(a.appHook, araw.replace('"7"', '"8"'), { 'x-hook-signature': hmac('sha256', 'asana-123', araw.replace('"7"', '"8"')) })).status, 200);

  // A built-in app with a fake address: the card says whether the key works with that account.
  const fakeApi = http.createServer((req, res) => { res.writeHead(req.headers.authorization === 'Bearer rk_good_123456' ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(req.headers.authorization === 'Bearer rk_good_123456' ? '{"available":[]}' : '{"error":{"message":"Invalid API Key provided"}}'); });
  await new Promise(r => fakeApi.listen(0, '127.0.0.1', r)); t.after(() => fakeApi.close());
  const apiBase = 'http://127.0.0.1:' + fakeApi.address().port;
  const good = await request('/mcp', { name: 'Stripe', transport: 'openapi', builtin: 'stripe', base: apiBase, authValue: 'rk_good_123456' });
  assert.equal(good.status, 201, JSON.stringify(good.data));
  let card = (await state()).mcp.find(c => c.id === good.data.id);
  assert.equal(card.keyCheck.ok, true); assert.equal(card.keyCheck.status, 200);
  await request('/mcp', { id: good.data.id, name: 'Stripe', transport: 'openapi', builtin: 'stripe', base: apiBase, authValue: 'rk_bad_654321' });
  card = (await state()).mcp.find(c => c.id === good.data.id);
  assert.equal(card.keyCheck.ok, false); assert.equal(card.keyCheck.status, 401); assert.match(card.keyCheck.detail, /Invalid API Key/);
  assert.equal(JSON.stringify(card).includes('rk_bad_654321'), false, 'the key is not on the card');
});
