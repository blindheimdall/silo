// Runs the tests of a SILO from a terminal or CI, waits for them and fails when something got worse.
//   SILO_TOKEN=silo_pat_... npm run eval                         every workflow and resident that has tests
//   SILO_TOKEN=silo_pat_... npm run eval -- "Invoice reader" Atlas   only these (names or ids)
// Options: --url http://127.0.0.1:3000 (or SILO_URL), --repeat 1-5, --min-score 0-100, --strict (every case must pass),
// --timeout 1800 (seconds), --json (the reports as JSON on stdout).
// Exit code: 0 all good, 1 something got worse, fell under --min-score, failed with --strict or did not finish,
// 2 the command or the connection is wrong. The token needs the read and run scopes.
const args = process.argv.slice(2), flags = new Set(['--strict', '--json']);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const names = args.filter((a, i) => !a.startsWith('--') && !(i && args[i - 1].startsWith('--') && !flags.has(args[i - 1])));
const base = String(opt('--url') || process.env.SILO_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = process.env.SILO_TOKEN || '', strict = args.includes('--strict'), asJson = args.includes('--json');
const repeat = opt('--repeat') === undefined ? undefined : Number(opt('--repeat'));
const minScore = opt('--min-score') === undefined ? null : Number(opt('--min-score'));
const timeout = Number(opt('--timeout') || 1800) * 1000;
const stop = (msg, code = 2) => { console.error(msg); process.exit(code); };
if (!/^silo_pat_[A-Za-z0-9_-]{43}$/.test(token)) stop('Set SILO_TOKEN to a token made in System > API tokens, with the read and run scopes.');
if (repeat !== undefined && !(Number.isInteger(repeat) && repeat >= 1 && repeat <= 5)) stop('--repeat is 1 to 5.');
if (minScore !== null && !(minScore >= 0 && minScore <= 100)) stop('--min-score is 0 to 100.');
if (!(timeout > 0)) stop('--timeout is a number of seconds.');

async function api(route, body) {
  let r;
  try { r = await fetch(base + '/api' + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }); }
  catch (e) { stop(`Cannot reach SILO at ${base}: ${e.cause?.code || e.message}`); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { const err = new Error(data.error || `HTTP ${r.status}`); err.status = r.status; throw err; }
  return data;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

let state;
try { state = await api('/state'); } catch (e) { stop(e.status === 401 || e.status === 403 ? `The token was refused: ${e.message}` : e.message); }
const all = [...state.workflows.map(o => ({ kind: 'workflow', o })), ...state.agents.map(o => ({ kind: 'agent', o }))].filter(x => x.o.tests?.length);
const wanted = names.length ? names.map(n => {
  const hit = all.filter(x => x.o.id === n || x.o.name.toLowerCase() === n.toLowerCase());
  if (!hit.length) stop(`No workflow or resident with tests is called "${n}".`);
  if (hit.length > 1) stop(`"${n}" is both a workflow and a resident. Use its id.`);
  return hit[0];
}) : all;
if (!wanted.length) stop('Nothing here has tests yet. Add them in the Tests window of a workflow or resident.');

const reports = [];
for (const { kind, o } of wanted) {
  const path = (kind === 'agent' ? '/agents/' : '/workflows/') + o.id;
  let started;
  for (let tries = 0; ; tries++) {
    try { started = await api(path + '/evaluate', { trigger: 'ci', ...(repeat && { repeat }) }); break; }
    catch (e) {
      // Busy: the workflow is running or its tests already are. Wait a little and try again.
      if (e.status === 409 && tries < 60) { await sleep(5000); continue; }
      reports.push({ kind, name: o.name, error: e.message });started = null; break;
    }
  }
  if (!started) continue;
  const end = Date.now() + timeout;let rep = started;
  while (rep.status === 'running' || rep.status === 'waiting') {
    if (Date.now() > end) { rep = { ...rep, status: 'timeout' }; break; }
    await sleep(2000);
    try { rep = (await api('/evals/' + started.id)).report; } catch (e) { rep = { ...rep, status: 'lost', error: e.message }; break; }
  }
  reports.push({ kind, name: o.name, report: rep });
  if (!asJson) {
    const c = rep.compare, line = rep.status !== 'done' ? `${rep.status.toUpperCase()}${rep.error ? ': ' + rep.error : ''}` :
      `${rep.passed}/${rep.total} passed  score ${rep.score}${c?.scoreDelta != null ? ` (${c.scoreDelta > 0 ? '+' : ''}${c.scoreDelta})` : ''}` +
      (c ? ['broke', 'worse', 'flaky', 'fixed', 'new'].filter(k => c.count[k]).map(k => `  ${c.count[k]} ${k}`).join('') : '') + (rep.worse ? '  GOT WORSE' : '');
    console.log(`${pad(kind === 'agent' ? 'resident' : 'workflow', 9)} ${pad(o.name, 32)} ${line}`);
    if (rep.status === 'done') for (const r of rep.results) if (!r.ok || c?.cases?.[r.testId] === 'broke') console.log(`          - ${r.name}: ${(r.failures || []).join('; ').slice(0, 300) || c.cases[r.testId]}`);
  }
}
const bad = reports.filter(x => x.error || x.report.status !== 'done' || x.report.worse || (minScore !== null && x.report.score < minScore) || (strict && x.report.passed < x.report.total));
if (asJson) console.log(JSON.stringify({ ok: !bad.length, reports }, null, 2));
else {
  for (const x of reports.filter(x => x.error)) console.log(`${pad(x.kind === 'agent' ? 'resident' : 'workflow', 9)} ${pad(x.name, 32)} NOT STARTED: ${x.error}`);
  console.log(bad.length ? `\n${bad.length} of ${reports.length} did not pass.` : `\nAll ${reports.length} passed.`);
}
process.exit(bad.length ? 1 : 0);
