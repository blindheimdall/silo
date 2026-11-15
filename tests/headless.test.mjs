// Running SILO without anyone at the screen: scheduled times missed while it was off run once or are skipped as each
// workflow says, and a SILO listening on every address (as in a container) lets the first account be made only with
// the setup code it printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
const baseEnv = temp => ({ ...process.env, SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' });
// The server is asked to stop the way the supervisor does it, so it saves first.
function server(env) {
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env: { ...env, SILO_SUPERVISED: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let out = '', errors = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { errors += b; });
  const ready = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', () => { if (out.includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); child.once('exit', code => { clearTimeout(timer); reject(Error(`Exited with ${code}: ${errors}`)); }); });
  const stop = () => new Promise(r => { if (child.exitCode !== null) return r(); child.once('exit', r); try { child.send('stop'); } catch { child.kill(); } setTimeout(() => { child.kill(); r(); }, 10000); });
  return { child, ready, stop, out: () => out, errors: () => errors };
}
async function client(api) {
  const ses = await fetch(api + '/api/session'); const c = { ...(await ses.json()), cookie: ses.headers.get('set-cookie')?.split(';')[0] };
  c.request = async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie: c.cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': c.token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  return c;
}

test('scheduled times missed while SILO was off run once or are skipped, as each workflow says', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-missed-'));
  const port = 14475, api = `http://127.0.0.1:${port}`, env = { ...baseEnv(temp), PORT: String(port) };
  let s = server(env);
  t.after(async () => { await s.stop(); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await s.ready;
  let { request } = await client(api);
  const make = async (name, extra) => { const r = await request('/workflows', { name, enabled: true, mode: 'interval', interval: 60, steps: [{ type: 'code', code: 'return "ran"' }], ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data; };
  assert.equal((await request('/workflows', { name: 'Bad', steps: [{ type: 'code', code: 'return 1' }], catchUpHours: 200 })).status, 400);
  const once = await make('Once'), skip = await make('Skip', { catchUp: 'skip' }), near = await make('Near', { catchUpHours: 2 }), fresh = await make('Fresh');
  assert.equal(once.catchUp, 'once'); assert.equal(once.catchUpHours, 0); assert.equal(skip.catchUp, 'skip'); assert.equal(near.catchUpHours, 2);
  const kept = (await request('/workflows/' + near.id, { ...near, name: 'Near' }, 'PUT')).data;
  assert.equal(kept.catchUpHours, 2, 'a change that does not name it keeps it');

  // SILO is off for three and a half hours: every time after that passed. Fresh was due only a minute ago.
  await s.stop();
  const file = path.join(temp, 'data', 'state.json'), saved = JSON.parse(await fs.readFile(file, 'utf8')), now = Date.now();
  for (const w of saved.workflows) w.nextRun = w.id === fresh.id ? now - 60000 : now - 3.5 * 3600000;
  await fs.writeFile(file, JSON.stringify(saved));
  s = server(env); await s.ready;
  ({ request } = await client(api));
  let st;
  for (let i = 0; i < 100; i++) { st = (await request('/state')).data; if (['Once', 'Fresh'].every(n => st.runs.some(r => r.name === n && r.status === 'completed')) && st.events.filter(e => /^Missed: /.test(e.title)).length >= 3) break; await wait(150); }
  const runs = n => st.runs.filter(r => r.name === n && r.trigger === 'schedule'), said = n => st.events.find(e => e.title === 'Missed: ' + n)?.detail || '';
  assert.equal(runs('Once').length, 1, 'four missed times run once'); assert.match(said('Once'), /at 4 of its times, from .*It runs once now\./);
  assert.equal(runs('Skip').length, 0); assert.match(said('Skip'), /Skipped, as the workflow says\. Next: /);
  assert.equal(runs('Near').length, 0); assert.match(said('Near'), /more than 2 hours late, so it was skipped/);
  assert.equal(runs('Fresh').length, 1, 'a minute late is not missed'); assert.equal(said('Fresh'), '');
  for (const w of st.workflows.filter(x => x.enabled)) assert.ok(w.nextRun > Date.now(), w.name + ' is due again in the future');
});

test('listening on every address: the first account needs the setup code, then everyone signs in', async t => {
  const lan = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
  const bad = server({ ...baseEnv(await fs.mkdtemp(path.join(os.tmpdir(), 'silo-host-bad-'))), PORT: '14477', SILO_HOST: 'my laptop' });
  await assert.rejects(bad.ready, /SILO_HOST must be an IP address/);
  if (!lan) { t.skip('this computer has no network address to come in from'); return; }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-host-'));
  const port = 14476, local = `http://127.0.0.1:${port}`, outside = `http://${lan}:${port}`;
  const s = server({ ...baseEnv(temp), PORT: String(port), SILO_HOST: '0.0.0.0' });
  t.after(async () => { await s.stop(); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await s.ready;
  for (let i = 0; i < 40 && !/\?setup=/.test(s.out()); i++) await wait(50);
  const code = /\?setup=([a-f0-9]{32})/.exec(s.out())?.[1];
  assert.ok(code, 'the setup address is printed');
  assert.equal((await fetch(local + '/api/health')).status, 200, 'this computer needs no code');
  const no = await fetch(outside + '/api/session');
  assert.equal(no.status, 403); assert.match((await no.json()).error, /Open the setup address SILO printed/);
  assert.equal((await fetch(outside + '/?setup=' + 'f'.repeat(32), { redirect: 'manual' })).status, 403, 'a wrong code');
  const open = await fetch(outside + '/?setup=' + code, { redirect: 'manual' });
  assert.equal(open.status, 302); assert.equal(open.headers.get('location'), '/', 'the code leaves the address bar');
  const kept = open.headers.get('set-cookie').split(';')[0];
  assert.match(open.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const ses = await fetch(outside + '/api/session', { headers: { cookie: kept } });
  assert.equal(ses.status, 200);
  const { token } = await ses.json(), cookie = kept + '; ' + ses.headers.get('set-cookie').split(';')[0];
  const made = await fetch(outside + '/api/users', { method: 'POST', headers: { cookie, origin: outside, 'Content-Type': 'application/json', 'x-silo-token': token }, body: JSON.stringify({ name: 'Ana', password: 'owner-pass-1' }) });
  assert.equal(made.status, 201, 'the owner is made from outside with the code');
  const later = await fetch(outside + '/api/state', { headers: { cookie: kept } });
  assert.equal(later.status, 401, 'with an account, the code is no way in: everyone signs in');
});
