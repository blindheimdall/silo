// Remote access through a Cloudflare Tunnel, with a fake cloudflared, and compressed, cached answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanHostname, checkToken } from '../tunnel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = path.join(root, 'tests', 'fake-cloudflared.mjs');
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 10000, what = 'condition') { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error('Timed out waiting for ' + what); await wait(100); } }
const TOKEN = Buffer.from(JSON.stringify({ a: 'a'.repeat(32), t: '6f1b7c2e-0000-4000-8000-000000000000', s: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0' })).toString('base64');

test('hostnames and tunnel tokens are checked', () => {
  assert.equal(cleanHostname('https://Silo.Example.com/path'), 'silo.example.com');
  assert.equal(cleanHostname(''), '');
  assert.throws(() => cleanHostname('not a host'), /hostname/);
  assert.equal(checkToken(TOKEN), TOKEN);
  assert.equal(checkToken('cloudflared.exe service install ' + TOKEN), TOKEN, 'the whole install command works');
  assert.throws(() => checkToken('hello'), /tunnel token/);
});

test('SILO opens over the tunnel only with an account, HTTPS rules and login limits', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-remote-'));
  const port = 14331, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', b => { errors += b; });
  t.after(async () => { child.kill(); await new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', b => { if (b.toString().includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); });

  // Raw requests, so the Host header can be what Cloudflare sends.
  const raw = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        let buf = Buffer.concat(chunks); const enc = res.headers['content-encoding'];
        if (enc === 'br') buf = zlib.brotliDecompressSync(buf); else if (enc === 'gzip') buf = zlib.gunzipSync(buf);
        let data; try { data = JSON.parse(buf.toString()); } catch { data = buf.toString(); }
        resolve({ status: res.statusCode, headers: res.headers, data, size: chunks.reduce((n, c) => n + c.length, 0) });
      });
    });
    req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
  const ses = await fetch(api + '/api/session'); const local = { token: (await ses.json()).token, cookie: ses.headers.get('set-cookie').split(';')[0] };
  const localPost = async (route, body) => { const r = await fetch(api + '/api' + route, { method: 'POST', headers: { cookie: local.cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': local.token }, body: JSON.stringify(body) }); const d = await r.json().catch(() => ({})); return { status: r.status, data: d }; };
  const localGet = async route => (await fetch(api + '/api' + route, { headers: { cookie: local.cookie } })).json();

  await t.test('it cannot be turned on without an owner account', async () => {
    const r = await localPost('/remote', { enabled: true, mode: 'quick', path: fake });
    assert.equal(r.status, 400); assert.match(r.data.error, /owner account/);
  });

  const owner = await localPost('/users', { name: 'Owner', password: 'long test password' });
  assert.equal(owner.status, 201, JSON.stringify(owner.data)); local.token = owner.data.token || local.token;
  const relog = await fetch(api + '/api/session'); Object.assign(local, { token: (await relog.json()).token, cookie: relog.headers.get('set-cookie').split(';')[0] });
  const login = await fetch(api + '/api/login', { method: 'POST', headers: { cookie: local.cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': local.token }, body: JSON.stringify({ name: 'Owner', password: 'long test password' }) });
  Object.assign(local, { token: (await login.json()).token, cookie: login.headers.get('set-cookie').split(';')[0] });

  const HOST = 'fake-quiet-river.trycloudflare.com';
  const cf = (ip = '203.0.113.9', host = HOST) => ({ host, 'cf-connecting-ip': ip, 'cf-ray': '8abc-OTP', 'x-forwarded-proto': 'https' });

  await t.test('a quick tunnel starts and reports its address', async () => {
    const r = await localPost('/remote', { enabled: true, mode: 'quick', path: fake });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const s = await until(async () => { const x = await localGet('/remote'); return x.state === 'on' && x; }, 10000, 'the tunnel');
    assert.equal(s.url, 'https://' + HOST); assert.equal(s.here, 'computer');
    const st = await localGet('/state'); assert.equal(st.remote.url, 'https://' + HOST);
    assert.ok(st.events.some(e => e.title === 'Remote access is on'));
  });

  await t.test('tunneled requests need the tunnel host, HTTPS origin and a sign-in', async () => {
    assert.equal((await raw('/', { headers: cf('203.0.113.9', 'evil.example.com') })).status, 403, 'another host');
    assert.equal((await raw('/', { headers: { 'cf-connecting-ip': '203.0.113.9', host: `127.0.0.1:${port}` } })).status, 403, 'local host name with Cloudflare headers');
    const page = await raw('/', { headers: cf() });
    assert.equal(page.status, 200); assert.match(page.headers['strict-transport-security'], /max-age/);
    const s = await raw('/api/session', { headers: cf() });
    assert.match(s.headers['set-cookie'][0], /; Secure/); assert.equal(s.data.accounts, true);
    const cookie = s.headers['set-cookie'][0].split(';')[0], token = s.data.token;
    assert.equal((await raw('/api/state', { headers: { ...cf(), cookie } })).status, 401, 'state needs a sign-in');
    const wrongOrigin = await raw('/api/login', { method: 'POST', headers: { ...cf(), cookie, 'x-silo-token': token, origin: 'http://' + HOST }, body: { name: 'Owner', password: 'long test password' } });
    assert.equal(wrongOrigin.status, 403);
    const ok = await raw('/api/login', { method: 'POST', headers: { ...cf(), cookie, 'x-silo-token': token, origin: 'https://' + HOST }, body: { name: 'Owner', password: 'long test password' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.match(ok.headers['set-cookie'][0], /; Secure/);
    const st = await raw('/api/state', { headers: { ...cf(), cookie: ok.headers['set-cookie'][0].split(';')[0] } });
    assert.equal(st.status, 200); assert.equal(st.data.remote.state, 'on');
    assert.ok((await localGet('/state')).events.some(e => e.title === 'Signed in' && /over the internet from 203\.0\.113\.9/.test(e.detail)));
    assert.equal((await raw('/decide/' + '0'.repeat(36), { headers: cf() })).status, 404, 'notification links stay on this computer');
  });

  await t.test('wrong passwords lock one address after 10 and the whole internet after 30', async () => {
    const tryLogin = async ip => { const s = await raw('/api/session', { headers: cf(ip) }); return raw('/api/login', { method: 'POST', headers: { ...cf(ip), cookie: s.headers['set-cookie'][0].split(';')[0], 'x-silo-token': s.data.token, origin: 'https://' + HOST }, body: { name: 'Owner', password: 'wrong password' } }); };
    for (let i = 0; i < 10; i++) assert.equal((await tryLogin('198.51.100.1')).status, 401);
    assert.equal((await tryLogin('198.51.100.1')).status, 429);
    for (let n = 2; n <= 3; n++) for (let i = 0; i < 10; i++) await tryLogin('198.51.100.' + n);
    const blocked = await tryLogin('198.51.100.99');
    assert.equal(blocked.status, 429); assert.match(blocked.data.error, /from the internet/);
    const here = await fetch(api + '/api/state', { headers: { cookie: local.cookie } }); assert.equal(here.status, 200, 'this computer still works');
  });

  await t.test('answers are compressed and files are revalidated with an ETag', async () => {
    const js = await raw('/app.js', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
    assert.equal(js.headers['content-encoding'], 'br'); assert.ok(js.size < js.data.length / 3, `compressed ${js.size} of ${js.data.length}`);
    const again = await raw('/app.js', { headers: { 'if-none-match': js.headers.etag } }); assert.equal(again.status, 304);
    const lib = await raw('/vendor/three.core.js', { headers: { 'accept-encoding': 'gzip' } }); assert.equal(lib.headers['content-encoding'], 'gzip'); assert.match(lib.headers['cache-control'], /max-age/);
    const st = await raw('/api/state', { headers: { cookie: local.cookie, 'accept-encoding': 'gzip' } });
    assert.equal(st.headers['content-encoding'], 'gzip'); assert.ok(st.data.tag);
    assert.equal((await raw('/api/state', { headers: { cookie: local.cookie, 'x-silo-since': st.data.tag } })).status, 204);
    const manifest = await raw('/manifest.webmanifest'); assert.equal(manifest.headers['content-type'], 'application/manifest+json'); assert.equal(manifest.data.display, 'standalone');
  });

  await t.test('your own domain needs a token and uses it through the environment', async () => {
    let r = await localPost('/remote', { mode: 'token', hostname: 'silo.example.com' });
    assert.equal(r.status, 200);
    r = await localPost('/remote', { token: 'nonsense' }); assert.equal(r.status, 400);
    r = await localPost('/remote', { token: TOKEN }); assert.equal(r.status, 200);
    const s = await until(async () => { const x = await localGet('/remote'); return x.state === 'on' && x.mode === 'token' && x; }, 10000, 'the token tunnel');
    assert.equal(s.url, 'https://silo.example.com'); assert.equal(s.hasToken, true);
    assert.ok(!JSON.stringify(s).includes(TOKEN), 'the token is never sent back');
    assert.equal((await raw('/', { headers: cf('203.0.113.9', 'silo.example.com') })).status, 200);
    assert.equal((await raw('/', { headers: cf() })).status, 403, 'the old quick address is gone');
  });

  await t.test('turning it off closes the door', async () => {
    const r = await localPost('/remote', { enabled: false }); assert.equal(r.status, 200);
    assert.equal((await localGet('/remote')).state, 'off');
    assert.equal((await raw('/', { headers: cf('203.0.113.9', 'silo.example.com') })).status, 403);
  });
});
