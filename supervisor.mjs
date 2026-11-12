// Keeps SILO running. Starts the server, starts it again after a crash (waiting longer each time) or after an
// update, and puts the old version back when an updated SILO cannot start twice in a row.
// Start: node supervisor.mjs [--open]. --open opens SILO in the browser once it is ready.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmUpdate, countCrash, rollback } from './update.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// An installed SILO keeps its data and workspace elsewhere; launch.json says where.
let launch = {};
try { launch = JSON.parse(fs.readFileSync(path.join(ROOT, 'launch.json'), 'utf8')); } catch {}
const env = { ...process.env, SILO_SUPERVISED: '1' };
if (!env.SILO_DATA_DIR && launch.dataDir) env.SILO_DATA_DIR = launch.dataDir;
if (!env.SILO_WORK_DIR && launch.workDir) env.SILO_WORK_DIR = launch.workDir;
if (!env.PORT && launch.port) env.PORT = String(launch.port);
const DATA = path.resolve(ROOT, env.SILO_DATA_DIR || 'data'), PORT = Number(env.PORT || 3000), URL_ = `http://127.0.0.1:${PORT}`;
const OPEN = process.argv.includes('--open'), SERVER = process.env.SILO_SERVER_SCRIPT || 'server.mjs';
const LOGS = path.join(DATA, 'logs'), LOG = path.join(LOGS, 'silo.log'), PID = path.join(DATA, 'silo.pid.json');
fs.mkdirSync(LOGS, { recursive: true });

// The log keeps about 5 MB, plus the three files before it.
function log(line) {
  const text = `${new Date().toISOString()} ${String(line).replace(/\s+$/, '')}\n`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5e6) { for (let i = 2; i >= 1; i--) if (fs.existsSync(LOG + '.' + i)) fs.renameSync(LOG + '.' + i, LOG + '.' + (i + 1)); fs.renameSync(LOG, LOG + '.1'); }
    fs.appendFileSync(LOG, text);
  } catch {}
  process.stdout.write(text);
}
function openBrowser() {
  if (process.env.SILO_NO_BROWSER) return log('Would open ' + URL_);
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL_]] : process.platform === 'darwin' ? ['open', [URL_]] : ['xdg-open', [URL_]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}
async function answering() { try { const r = await fetch(URL_ + '/api/session', { signal: AbortSignal.timeout(1500) }); return r.ok || r.status === 401; } catch { return false; } }

// One SILO per data folder.
try {
  const old = JSON.parse(fs.readFileSync(PID, 'utf8'));
  let alive = false; try { process.kill(old.supervisor, 0); alive = old.supervisor !== process.pid; } catch {}
  if (alive && await answering()) { log(`SILO is already running (process ${old.supervisor}).`); if (OPEN) openBrowser(); process.exit(0); }
} catch {}

let child = null, stopping = false, opened = false, crashes = [];
const writePid = () => { try { fs.writeFileSync(PID, JSON.stringify({ supervisor: process.pid, server: child?.pid || null, port: PORT, root: ROOT })); } catch {} };
function start() {
  let ready = false, portBusy = false;
  child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  writePid();
  log(`Starting SILO (process ${child.pid}).`);
  const lines = (stream, onLine) => { let buf = ''; stream.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } }); };
  lines(child.stdout, l => {
    log(l);
    if (!ready && l.includes('SILO is ready')) {
      ready = true; crashes = [];
      confirmUpdate(DATA).catch(() => {});
      if (OPEN && !opened) { opened = true; openBrowser(); }
    }
  });
  lines(child.stderr, l => { log('! ' + l); if (/EADDRINUSE/.test(l)) portBusy = true; });
  child.on('exit', async (code, signal) => {
    child = null; writePid();
    if (stopping) { log('SILO stopped.'); process.exit(0); }
    if (code === 0) { log('SILO stopped.'); try { fs.rmSync(PID, { force: true }); } catch {} process.exit(0); }
    if (code === 75) { log('Restarting SILO.'); return start(); }
    if (portBusy) { log(`Port ${PORT} is used by another program. Close it, or start SILO on another port.`); process.exit(1); }
    log(`SILO ended unexpectedly (${signal || 'code ' + code}).`);
    // An update that cannot start twice is undone.
    if (!ready) {
      const p = await countCrash(DATA).catch(() => null);
      if (p && p.crashes >= 2) {
        try { const r = await rollback({ root: ROOT, dataDir: DATA, reason: `version ${p.to} could not start` }); log(`Version ${r.from} could not start. Went back to version ${r.to}.`); return start(); }
        catch (e) { log('Going back failed: ' + e.message); }
      }
    }
    const now = Date.now(); crashes = crashes.filter(t => now - t < 10 * 60000); crashes.push(now);
    const wait = Math.min(60000, 1000 * 2 ** (crashes.length - 1));
    log(`Starting again in ${Math.round(wait / 1000)} s.`);
    setTimeout(start, wait);
  });
}
function stop() {
  if (stopping) return; stopping = true;
  try { fs.rmSync(PID, { force: true }); } catch {}
  if (!child) process.exit(0);
  // The server saves and closes cleanly when asked; after ten seconds it is ended.
  try { child.send('stop'); } catch { child.kill(); }
  setTimeout(() => { try { child?.kill(); } catch {} process.exit(0); }, 10000).unref();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);
start();
