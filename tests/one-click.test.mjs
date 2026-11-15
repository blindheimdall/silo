// One-click sign-in with SILO's own app registration: Google and Microsoft with PKCE and nothing pasted, your own app
// winning when you give one, and GitHub's device flow against a fake GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('Timed out waiting for ' + what); await wait(100); } }

test('apps connect with one click when SILO has its own app', async t => {
  const seen = [];let devices = 0;const polls = {};
  const fake = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const p = new URL(req.url, 'http://x').pathname, f = new URLSearchParams(body); seen.push({ path: p, body, auth: req.headers.authorization });
    const json = (d, s = 200) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (p === '/googleToken') return f.get('code') === 'good-code' && f.get('code_verifier') ? json({ access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    if (p === '/gmail/users/me/profile') return json({ emailAddress: 'ana@example.com' });
    if (p === '/ghDevice') { devices++; return json({ device_code: devices === 1 ? 'dc-ok' : 'dc-deny', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 0.2 }); }
    if (p === '/ghToken') {
      const dc = f.get('device_code'), n = polls[dc] = (polls[dc] || 0) + 1;
      if (f.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code' || f.get('client_id') !== 'gh-silo-app') return json({ error: 'incorrect_client_credentials' });
      if (dc === 'dc-deny') return json({ error: 'access_denied' });
      if (n === 1) return json({ error: 'authorization_pending' });
      if (n === 2) return json({ error: 'slow_down', interval: 0.2 });
      return json({ access_token: 'gho_fixturedevicetoken', token_type: 'bearer', scope: 'repo,read:user' });
    }
    if (p === '/github/user') return req.headers.authorization === 'Bearer gho_fixturedevicetoken' ? json({ login: 'octo' }) : json({ message: 'Bad credentials' }, 401);
    json({ error: 'not found ' + p }, 404);
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-oneclick-'));
  const port = 14447, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), SILO_TEST_CONNECTOR_BASE: base, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '',
    SILO_GOOGLE_CLIENT_ID: 'g-silo-app.apps.googleusercontent.com', SILO_GOOGLE_CLIENT_SECRET: 'GOCSPX-silo-desktop', SILO_MICROSOFT_CLIENT_ID: 'ms-silo-app', SILO_GITHUB_CLIENT_ID: 'gh-silo-app' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); fake.close(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });
  const ses = await fetch(api + '/api/session'); const { token } = await ses.json(), cookie = ses.headers.get('set-cookie').split(';')[0];
  const request = async (route, body) => { const r = await fetch(api + '/api' + route, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const service = async id => (await request('/services')).data.services.find(s => s.id === id);

  await t.test('the apps SILO has its own registration for say so', async () => {
    const list = (await request('/services')).data.services, by = Object.fromEntries(list.map(s => [s.id, s]));
    assert.equal(by.google.oneClick, true); assert.equal(by.microsoft.oneClick, true); assert.equal(by.github.oneClick, true);
    assert.equal(by.slack.oneClick, false); assert.equal(by.notion.oneClick, false);
    assert.ok(!JSON.stringify(list).includes('GOCSPX-silo-desktop'), 'the secret of SILO\'s app is not sent to the page');
  });

  await t.test('Google signs in with SILO\'s app and nothing pasted', async () => {
    const st = await request('/services/google', {});
    assert.equal(st.status, 200, JSON.stringify(st.data));
    const auth = new URL(st.data.url);
    assert.equal(auth.searchParams.get('client_id'), 'g-silo-app.apps.googleusercontent.com'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    const back = await fetch(`${api}/connect/callback?state=${auth.searchParams.get('state')}&code=good-code`);
    assert.match(await back.text(), /is connected/);
    const ex = new URLSearchParams(seen.find(x => x.path === '/googleToken').body);
    assert.equal(ex.get('client_id'), 'g-silo-app.apps.googleusercontent.com'); assert.equal(ex.get('client_secret'), 'GOCSPX-silo-desktop');
    const g = await service('google');
    assert.equal(g.connected, true); assert.equal(g.account, 'ana@example.com'); assert.equal(g.builtin, true);
    assert.equal(g.hasClient, false); assert.equal(g.clientId, '', 'SILO\'s app is not shown as yours');
  });

  await t.test('your own app wins when you give one, and stays until you choose SILO\'s', async () => {
    let st = await request('/services/microsoft', { clientId: 'my-own-ms' });
    assert.equal(new URL(st.data.url).searchParams.get('client_id'), 'my-own-ms');
    st = await request('/services/microsoft', {});
    assert.equal(new URL(st.data.url).searchParams.get('client_id'), 'my-own-ms', 'a saved own app is not swapped silently');
    assert.equal((await service('microsoft')).clientId, 'my-own-ms');
    st = await request('/services/microsoft', { builtin: true });
    assert.equal(new URL(st.data.url).searchParams.get('client_id'), 'ms-silo-app');
    assert.equal((await service('microsoft')).hasClient, false);
    const g = await request('/services/google', { clientId: 'mine.apps.googleusercontent.com' });
    assert.equal(g.status, 400, 'your own Google app still needs its secret, SILO\'s is not lent to it');
  });

  await t.test('GitHub connects with a code, waiting and slowing down as GitHub asks', async () => {
    const st = await request('/services/github', { device: true });
    assert.equal(st.status, 200, JSON.stringify(st.data));
    assert.equal(st.data.userCode, 'WDJB-MJHT'); assert.equal(st.data.verificationUri, 'https://github.com/login/device');
    assert.equal((await service('github')).code.userCode, 'WDJB-MJHT');
    const gh = await until(async () => { const s = await service('github'); return s.connected && s; }, 10000, 'the GitHub sign-in');
    assert.equal(gh.account, 'octo'); assert.equal(gh.code, undefined, 'the code is gone once the token is in');
    assert.ok(polls['dc-ok'] >= 3, 'it kept asking while GitHub waited');
    const all = JSON.stringify((await request('/services')).data) + JSON.stringify((await request('/state')).data);
    assert.ok(!all.includes('gho_fixture'), 'the token is never sent back');
    const ask = seen.find(x => x.path === '/ghDevice');
    assert.equal(new URLSearchParams(ask.body).get('client_id'), 'gh-silo-app');
  });

  await t.test('a code you refuse on GitHub ends with a clear reason and keeps the old token', async () => {
    const st = await request('/services/github', { device: true });assert.equal(st.status, 200);
    const s = await until(async () => { const x = await service('github'); return x.code?.error && x; }, 10000, 'the refusal');
    assert.match(s.code.error, /did not allow SILO/);
    assert.equal(s.connected, true); assert.equal(s.account, 'octo');
    await request('/services/github', { disconnect: true });
    const gone = await service('github');assert.equal(gone.connected, false);assert.equal(gone.code, undefined);
  });
});
