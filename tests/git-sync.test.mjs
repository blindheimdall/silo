// Environments through Git: a development SILO pushes its workflows and table layouts to a repository, a protected
// production SILO pulls them after reading what would change, and keeps what is its own (on or off, ids, runs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRemote, checkBranch, slug, GitSync } from '../git-sync.mjs';
import { roleAllows } from '../vault.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(r => setTimeout(r, ms));
let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }

function server(temp, port) {
  const env = { ...process.env, PORT: String(port), SILO_DATA_DIR: path.join(temp, 'data'), SILO_WORK_DIR: path.join(temp, 'workspace'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPATIBLE_API_KEY: '', SILO_SECRET: '' };
  const child = spawn(process.execPath, ['--import', './tests/provider-mock.mjs', 'server.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', errors = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { errors += b; });
  const ready = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Test server did not start: ' + errors)), 10000); child.stdout.on('data', () => { if (out.includes('SILO is ready')) { clearTimeout(timer); resolve(); } }); child.once('exit', code => { clearTimeout(timer); reject(Error(`Exited with ${code}: ${errors}`)); }); });
  return { child, ready };
}
async function client(api) {
  const ses = await fetch(api + '/api/session'), c = { ...(await ses.json()), cookie: ses.headers.get('set-cookie')?.split(';')[0] };
  return async (route, body, method = body === undefined ? 'GET' : 'POST') => { const r = await fetch(api + '/api' + route, { method, headers: { cookie: c.cookie, origin: api, 'Content-Type': 'application/json', 'x-silo-token': c.token }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
}

test('a link in the repository is never followed to a file of this computer', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-gitread-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const g = new GitSync(dir), wf = path.join(g.repo, 'workflows'), secret = path.join(dir, 'secret.json');
  await fs.mkdir(wf, { recursive: true }); await fs.writeFile(secret, '{"key":"do-not-read"}'); await fs.writeFile(path.join(wf, 'real.json'), '{"name":"Real"}');
  // A folder link (a junction on Windows needs no rights) and, where this account may make one, a file link.
  await fs.symlink(dir, path.join(g.repo, 'tables'), 'junction');
  try { await fs.symlink(secret, path.join(wf, 'link.json'), 'file'); } catch (e) { if (e.code !== 'EPERM') throw e; }
  const files = g.read();
  assert.deepEqual([...files.keys()], ['workflows/real.json']);
  assert.ok(![...files.values()].some(v => v.includes('do-not-read')));
});

test('repository addresses and branch names', () => {
  assert.equal(checkRemote('https://github.com/acme/flows.git'), 'https://github.com/acme/flows.git');
  assert.equal(checkRemote('git@github.com:acme/flows.git'), 'git@github.com:acme/flows.git');
  assert.equal(checkRemote('ssh://git@example.com/acme/flows.git'), 'ssh://git@example.com/acme/flows.git');
  assert.throws(() => checkRemote('https://someone:secret@github.com/acme/flows.git'), /Leave the password or token out/);
  assert.throws(() => checkRemote('https://token@github.com/acme/flows.git'), /Leave the password or token out/);
  assert.throws(() => checkRemote('ext::sh -c touch% /tmp/x'), /not a Git repository address|not allowed/);
  assert.throws(() => checkRemote('-uhelp'), /not a Git repository address/);
  assert.throws(() => checkRemote('http://example.com/a.git'), /https, ssh or git/);
  assert.throws(() => checkRemote('flows'), /full path of a folder/);
  assert.throws(() => checkRemote(''), /Give the address/);
  assert.equal(checkBranch(''), 'main');
  assert.equal(checkBranch('silo/production'), 'silo/production');
  for (const b of ['..', 'a..b', '-x', 'a b', 'x.lock', 'x/', 'a//b']) assert.throws(() => checkBranch(b), /branch name/, b);
  assert.equal(slug('Weekly Leads: report!'), 'weekly-leads-report');
  assert.equal(slug('***'), 'item');
  assert.equal(roleAllows('operator', 'GET', '/api/sync'), false, 'only owners see the Git settings');
  assert.equal(roleAllows('viewer', 'GET', '/api/sync/pull'), false);
});

test('development pushes, protected production pulls what you pick and keeps its own', { skip: !hasGit && 'Git is not installed' }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-git-'));
  const bare = path.join(temp, 'flows.git');
  execFileSync('git', ['init', '--bare', '--quiet', bare]);
  const dev = server(path.join(temp, 'dev'), 14479), prod = server(path.join(temp, 'prod'), 14480);
  t.after(async () => { dev.child.kill(); prod.child.kill(); await wait(300); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); });
  await Promise.all([dev.ready, prod.ready]);
  const d = await client('http://127.0.0.1:14479'), p = await client('http://127.0.0.1:14480');

  assert.equal((await d('/sync', { remote: 'https://me:tok@github.com/a/b.git' })).status, 400);
  assert.equal((await d('/sync', { branch: 'a..b' })).status, 400);
  assert.equal((await d('/sync/push', {})).status, 409, 'no repository yet');
  const set = await d('/sync', { environment: 'development', remote: bare, branch: 'main' });
  assert.equal(set.status, 200, JSON.stringify(set.data)); assert.equal(set.data.environment, 'development');

  // Two workflows: one runs the other, and one keeps rows in a table.
  const agents = (await d('/state')).data.agents, ana = agents[0];
  const leads = (await d('/tables', { name: 'Leads', columns: [{ name: 'email', type: 'text' }, { name: 'name' }] })).data;
  const tally = (await d('/workflows', { name: 'Tally', steps: [{ type: 'action', app: 'table:' + leads.id, op: 'count_rows', fields: {} }] })).data;
  const main = await d('/workflows', { name: 'Morning brief', brief: 'Sum up the day.', enabled: true, mode: 'daily', at: '08:30', days: [1, 2, 3, 4, 5], catchUp: 'skip', hook: true, steps: [{ type: 'agent', agentId: ana.id, prompt: 'Write the morning brief.' }, { type: 'workflow', workflowId: tally.id, prompt: 'Count.' }], tests: undefined });
  assert.equal(main.status, 201, JSON.stringify(main.data));
  const pushed = await d('/sync/push', { message: 'First workflows' });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data)); assert.equal(pushed.data.changed, true); assert.match(pushed.data.commit, /^[a-f0-9]{40}$/);
  const listed = execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'main'], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(listed.includes('silo.json') && listed.filter(f => f.startsWith('workflows/')).length >= 2 && listed.some(f => /^tables\/leads-[a-f0-9]{6}\.json$/.test(f)), listed.join(' '));
  const file = JSON.parse(execFileSync('git', ['--git-dir', bare, 'show', 'main:' + listed.find(f => f.startsWith('workflows/morning-brief-'))], { encoding: 'utf8' }));
  assert.equal(file.steps[0].resident.name, ana.name); assert.equal(file.steps[0].agentId, undefined, 'no ids of this SILO');
  assert.equal(file.steps[1].workflow.name, 'Tally'); assert.equal(file.hook, true); assert.equal(file.enabled, undefined);
  assert.ok(!JSON.stringify(file).includes(main.data.hook), 'the hook address stays here');
  assert.equal((await d('/sync/push', {})).data.changed, false, 'nothing new, nothing committed');

  // Production: protected, reads what a pull would do, takes it.
  await p('/sync', { environment: 'production', protect: true, remote: bare, branch: 'main' });
  const look = await p('/sync/pull'), ours = list => list.filter(w => ['Morning brief', 'Tally'].includes(w.name));
  assert.equal(look.status, 200, JSON.stringify(look.data));
  assert.deepEqual(ours(look.data.workflows).map(w => w.status), ['new', 'new'], JSON.stringify(look.data.workflows));
  assert.ok(look.data.onlyHere.some(w => w.name === 'From idea to blueprint'), 'its own starter workflow is only here');
  assert.equal(look.data.workflows.find(w => w.name === 'From idea to blueprint').twin, true, 'one with the same name made here is not ticked at first');
  assert.deepEqual(look.data.tables, [{ name: 'Leads', status: 'new' }]);
  assert.equal((await p('/sync/pull', { ids: ours(look.data.workflows).map(w => w.syncId), head: 'f'.repeat(40) })).status, 409, 'the repository changed since you looked');
  const took = await p('/sync/pull', { ids: ours(look.data.workflows).map(w => w.syncId), head: look.data.head });
  assert.equal(took.status, 200, JSON.stringify(took.data)); assert.equal(took.data.pulled.length, 2, JSON.stringify(took.data.failed)); assert.deepEqual(took.data.tables, ['Leads']);
  let ps = (await p('/state')).data;
  const pMain = ps.workflows.find(w => w.name === 'Morning brief'), pTally = ps.workflows.find(w => w.name === 'Tally');
  assert.equal(pMain.enabled, false, 'a new workflow arrives turned off'); assert.equal(pMain.steps[1].workflowId, pTally.id, 'it runs the workflow pulled with it');
  assert.equal(pMain.at, '08:30'); assert.equal(pMain.catchUp, 'skip'); assert.ok(pMain.hook && pMain.hook !== main.data.hook, 'an address of its own');
  assert.ok(pTally.steps[0].app === 'table:' + ps.tables.find(x => x.name === 'Leads').id);
  assert.deepEqual(ours((await p('/sync/pull')).data.workflows).map(w => w.status), ['same', 'same']);

  // Protected: what comes through Git is not changed here, but it can be turned on.
  assert.equal((await p('/workflows', { name: 'Here', steps: [{ type: 'code', code: 'return 1' }] })).status, 409);
  const on = await p('/workflows/' + pMain.id, { ...pMain, enabled: true }, 'PUT');
  assert.equal(on.status, 200, JSON.stringify(on.data)); assert.equal(on.data.enabled, true);
  const edit = await p('/workflows/' + pMain.id, { ...pMain, enabled: true, brief: 'Changed here.' }, 'PUT');
  assert.equal(edit.status, 409); assert.match(edit.data.error, /protected \(Production\).*in development/);
  assert.equal((await p('/workflows/' + pMain.id, undefined, 'DELETE')).status, 409);
  assert.equal((await p('/workflows/' + pMain.id + '/tests', { tests: [] })).status, 409);

  // A change in development reaches production in place.
  const dm = (await d('/state')).data.workflows.find(w => w.name === 'Morning brief');
  assert.equal((await d('/workflows/' + dm.id, { ...dm, brief: 'Sum up the day, briefly.' }, 'PUT')).status, 200);
  await d('/sync/push', { message: 'Shorter brief' });
  const again = await p('/sync/pull');
  assert.deepEqual(ours(again.data.workflows).map(w => [w.name, w.status]).sort(), [['Morning brief', 'changed'], ['Tally', 'same']]);
  const second = await p('/sync/pull', { ids: [again.data.workflows.find(w => w.status === 'changed').syncId], head: again.data.head });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  ps = (await p('/state')).data;
  const after = ps.workflows.find(w => w.id === pMain.id);
  assert.equal(after.brief, 'Sum up the day, briefly.'); assert.equal(after.enabled, true, 'on stays on'); assert.equal(after.hook, pMain.hook, 'the address stays');
  assert.ok(after.version > (pMain.version || 1), 'the version before is kept');
  assert.equal(ps.workflows.length, (await d('/state')).data.workflows.length, 'nothing made twice');

  // A workflow deleted in development leaves the repository on a full push; production keeps its copy.
  assert.equal((await d('/workflows/' + dm.id, undefined, 'DELETE')).status, 200);
  await d('/sync/push', { message: 'Remove the brief' });
  const third = (await p('/sync/pull')).data;
  assert.ok(!third.workflows.some(w => w.name === 'Morning brief') && third.onlyHere.some(w => w.id === pMain.id));
});
