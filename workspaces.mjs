// SILO for several teams on one server: separate workspaces, each a SILO of its own with its own people, keys,
// residents, files and budget, for agencies and service providers that run SILO for their clients.
// One host process listens on PORT and starts one SILO for each workspace on a port of its own on 127.0.0.1. A visitor
// reaches a workspace by its name in front of the domain: acme.silo.example.com, or acme.localhost:3000 on this
// computer. The domain itself opens the main workspace, the one with the data SILO had before, whose owners make,
// pause and remove the others in System. Workspaces never see each other: each runs in its own process with its own
// folders, cannot start programs or reach this server's network (tenant-guard.mjs), and only answers requests that
// come through the host with the token the host gave it.
// Start: SILO_WORKSPACES=1 node supervisor.mjs, or node workspaces.mjs. SILO_WORKSPACE_DOMAIN is the domain when it is
// not the one in SILO_PUBLIC_URL; it needs a wildcard DNS record (*.silo.example.com) and certificate.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const RESERVED = new Set(['main', 'www', 'api', 'app', 'admin', 'silo', 'mail', 'static', 'assets', 'status', 'localhost']);
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
// What a hosted workspace gets from the host's environment: what Node needs to run, never the host's keys.
const KEEP_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'SILO_TENANT_ALLOW_HOSTS', 'SILO_GALLERY_FEED', 'SILO_CONTAINER'];
// Headers only the host sets.
const OWN_HEADERS = ['x-silo-hosted', 'x-silo-control', 'x-silo-local', 'x-silo-client', 'x-silo-proto'];
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const loopback = a => /^(127\.|::1$|::ffff:127\.)/.test(String(a || ''));
const fault = (message, status = 400) => Object.assign(new Error(message), { status });

export function checkSlug(s) {
  const slug = String(s ?? '').trim().toLowerCase();
  if (!SLUG.test(slug)) throw fault('A workspace name in the address is 1 to 32 lower-case letters, digits and dashes, like acme or north-shop.');
  if (RESERVED.has(slug)) throw fault(`"${slug}" is kept for SILO itself. Choose another name.`);
  return slug;
}
export const cleanName = n => String(n ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
export function cleanBudget(b) {
  if (b === undefined || b === null || b === '') return 0;
  const n = Number(b);
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw fault('A budget is dollars a month, from 0 (none) to 1000000.');
  return Math.round(n * 100) / 100;
}
export function cleanRegistry(raw) {
  const out = [], seen = new Set();
  for (const w of Array.isArray(raw?.workspaces) ? raw.workspaces : []) {
    if (!w || typeof w.slug !== 'string' || !SLUG.test(w.slug) || RESERVED.has(w.slug) || seen.has(w.slug)) continue;
    let budget = 0; try { budget = cleanBudget(w.budget); } catch {}
    seen.add(w.slug); out.push({ slug: w.slug, name: cleanName(w.name) || w.slug, created: Number(w.created) || Date.now(), paused: w.paused === true, budget });
  }
  return { format: 1, workspaces: out };
}
// Which workspace a Host header names: '' for the main one, its name for another, null for none of them.
export function routeHost(host, domain) {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+?)\.?(?::\d{1,5})?$/.exec(String(host || '').trim().toLowerCase());
  if (!m) return null;
  const name = m[1];
  if (name === domain || LOCAL_NAMES.has(name)) return '';
  for (const parent of [domain, 'localhost']) {
    if (!name.endsWith('.' + parent)) continue;
    const label = name.slice(0, -parent.length - 1);
    return SLUG.test(label) && !RESERVED.has(label) ? label : null;
  }
  return null;
}
// The visitor of a request: its address, whether it is this computer, and whether the browser used https. Behind a
// hosting service's proxy (Render, Fly.io, Railway or SILO_PROXY=1) the proxy's headers say; otherwise they are ignored.
export function visitorOf(req, { trustProxy = false, onFly = false } = {}) {
  const h = req.headers, sock = req.socket.remoteAddress;
  const proxied = trustProxy && (h['x-forwarded-for'] !== undefined || h['x-forwarded-proto'] !== undefined || (onFly && h['fly-client-ip'] !== undefined));
  if (!proxied) return { ip: sock || 'unknown', local: loopback(sock) && h['cf-connecting-ip'] === undefined && h['cf-ray'] === undefined, scheme: 'http' };
  const fwd = String(h['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  const ip = [onFly ? String(h['fly-client-ip'] || '').trim() : '', fwd.at(-1)].find(x => x && net.isIP(x) && !loopback(x)) || 'unknown';
  return { ip, local: false, scheme: String(h['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https' ? 'https' : 'http' };
}

const esc = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The host's own pages, in the look of SILO's screens: a workspace that is starting, paused or not there.
function page(req, res, status, title, text, refresh = 0) {
  const head = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(refresh && { 'Retry-After': String(refresh) }) };
  if (String(req.url).startsWith('/api/')) { res.writeHead(status, { ...head, 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: `${title}. ${text}` })); }
  res.writeHead(status, { ...head, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#020503;color:#8cf57d;font:15px/1.65 'Lucida Console','Cascadia Mono',Consolas,'Courier New',monospace;text-shadow:0 0 3px #8cf57d8c}
main{box-sizing:border-box;width:min(34rem,calc(100vw - 32px));padding:26px 28px;border:1px solid #1e4a25;background:#05100a;box-shadow:inset 0 0 40px #8cf57d0d}
.mark{margin:0 0 18px;color:#ffbd4a;letter-spacing:5px;font-size:12px;text-shadow:0 0 3px #ffbd4a99,0 0 12px #ffbd4a2e}h1{margin:0 0 10px;font-size:17px;font-weight:400;letter-spacing:2px;text-transform:uppercase;color:#d4ffc2}
p{margin:0}.wait{margin-top:16px;color:#5ec557}.wait b{animation:b 1s steps(1) infinite}@keyframes b{50%{opacity:0}}@media (prefers-reduced-motion:reduce){.wait b{animation:none}}
</style></head><body><main><p class="mark">SILO // WORKSPACES</p><h1>${esc(title)}</h1><p>${esc(text)}</p>${refresh ? '<p class="wait">Checking again<b>_</b></p>' : ''}</main></body></html>`);
}
const lines = (stream, onLine) => { let buf = ''; stream.setEncoding('utf8'); stream.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } }); };
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.unref(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const hex = n => randomBytes(n).toString('hex');
const same = (a, b) => { if (!b) return false; const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

// One workspace and the SILO that serves it.
class Space extends EventEmitter {
  constructor(host, entry, dirs) {
    super(); this.setMaxListeners(0);
    Object.assign(this, { host, entry, ...dirs, proc: null, port: 0, token: '', control: '', state: 'stopped', crashes: [], timer: null, error: '', status: null, statusAt: 0, stopping: false });
  }
  get slug() { return this.entry.slug; }
  get tag() { return `[${this.slug || 'main'}] `; }
  async start() {
    if (this.proc || this.entry.paused || this.host.closing) return;
    clearTimeout(this.timer); this.timer = null;
    this.state = 'starting'; this.status = null;
    let port; try { port = await freePort(); } catch (e) { return this.down(1, null, false, e.message); }
    if (this.proc || this.entry.paused || this.host.closing) return;
    Object.assign(this, { port, token: hex(24), control: hex(24) });
    let busy = false, child;
    try { child = spawn(process.execPath, [this.host.script], { cwd: this.host.root, env: this.host.envFor(this), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); }
    catch (e) { return this.down(1, null, false, e.message); }
    this.proc = child;
    lines(child.stdout, l => {
      if (this.state === 'starting' && l.includes('SILO is ready')) { this.state = 'running'; this.error = ''; this.host.ready(this); this.emit('ready'); return; }
      this.host.log(this.tag + l);
    });
    lines(child.stderr, l => { this.host.log(this.tag + '! ' + l); if (/EADDRINUSE/.test(l)) busy = true; if (l.trim()) this.error = l.trim().slice(0, 300); });
    // Node may send both error and exit for one child: it counts once.
    child.once('error', e => { if (this.proc === child && child.exitCode === null && !child.pid) this.down(1, null, false, e.message); });
    child.once('exit', (code, signal) => { if (this.proc === child) this.down(code, signal, busy); });
  }
  down(code, signal, busy, why = '') {
    if (why) this.error = why;
    this.proc = null; this.status = null;
    const asked = this.stopping; this.stopping = false;
    try { this.settle(code, signal, busy, asked); } finally { this.emit('down'); }
  }
  settle(code, signal, busy, asked) {
    if (asked || this.host.closing) { this.state = this.entry.paused ? 'paused' : 'stopped'; return; }
    // 75: restart, asked for by SILO itself (an update, or Restart in System).
    if (code === 75) return this.host.restarted(this);
    // The main workspace that cannot start the first time ends the host, so the supervisor can go back to the version
    // before an update. Later it is started again for as long as it takes: without it nobody can reach the rest.
    if (!this.slug && !this.host.announced) return this.host.mainFailed(code, signal);
    const now = Date.now(); this.crashes = this.crashes.filter(t => now - t < 600000); this.crashes.push(now);
    if (this.crashes.length >= 5 && !busy && this.slug) {
      this.state = 'failed';
      this.host.log(`${this.tag}Stopped after ${this.crashes.length} failures in ten minutes${this.error ? ': ' + this.error : ''}. Restart it in System > Workspaces.`);
      return;
    }
    const wait = busy ? 100 : Math.min(60000, 1000 * 2 ** (this.crashes.length - 1));
    this.state = 'waiting';
    this.host.log(`${this.tag}Ended unexpectedly (${signal || 'code ' + code}). Starting again in ${Math.ceil(wait / 1000)} s.`);
    this.timer = setTimeout(() => this.start(), wait); this.timer.unref?.();
  }
  // Asks the SILO to save and stop; after ten seconds it is ended.
  stop() {
    clearTimeout(this.timer); this.timer = null;
    const p = this.proc;
    if (!p) { if (this.state !== 'failed' || this.entry.paused) this.state = this.entry.paused ? 'paused' : 'stopped'; return Promise.resolve(); }
    this.stopping = true; this.state = 'stopping';
    return new Promise(resolve => {
      p.once('exit', () => resolve());
      try { p.send('stop'); } catch { try { p.kill(); } catch {} }
      setTimeout(() => { try { p.kill(); } catch {} }, 10000).unref();
    });
  }
  whenReady(ms = 60000) {
    if (this.state === 'running') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(t); this.off('ready', ok); this.off('down', bad); fn(v); };
      const ok = () => done(resolve), bad = () => { if (this.state === 'failed' || this.state === 'paused' || this.state === 'stopped') done(reject, fault(`The workspace did not start${this.error ? ': ' + this.error : '.'}`, 502)); };
      const t = setTimeout(() => done(reject, fault('The workspace took longer than a minute to start. It goes on starting; look again soon.', 504)), ms);
      this.on('ready', ok); this.on('down', bad);
    });
  }
  // What it says of itself: accounts, residents, this month's cost, and the setup code while it has no account.
  async readStatus(fresh = false) {
    if (this.state !== 'running') return null;
    if (!fresh && this.status && Date.now() - this.statusAt < 3000) return this.status;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/api/hosted/status`, { headers: { host: `127.0.0.1:${this.port}`, 'x-silo-hosted': this.token, 'x-silo-control': this.control }, signal: AbortSignal.timeout(2500) });
      if (r.ok) { this.status = await r.json(); this.statusAt = Date.now(); }
    } catch {}
    return this.status;
  }
  async plan() {
    if (this.state !== 'running') return;
    await fetch(`http://127.0.0.1:${this.port}/api/hosted/plan`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-silo-hosted': this.token, 'x-silo-control': this.control }, body: JSON.stringify({ budget: this.entry.budget }), signal: AbortSignal.timeout(5000) }).catch(() => {});
    this.status = null;
  }
}

export class Host {
  constructor({ root, data, work, port = 3000, listen = '127.0.0.1', publicUrl = '', domain = '', trustProxy = false, onFly = false, env = process.env, script = 'server.mjs', max = 50, log } = {}) {
    const base = new URL(publicUrl || `http://localhost:${port}`);
    Object.assign(this, { root, data, work, port, listen, env, script, max, trustProxy, onFly, base, domain: String(domain || base.hostname).toLowerCase().replace(/\.$/, ''),
      dir: path.join(data, 'workspaces'), file: path.join(data, 'workspaces.json'), spaces: new Map(), queue: Promise.resolve(), closing: false, announced: false, registryError: '',
      controlToken: hex(32), controlUrl: '', agent: new http.Agent({ keepAlive: true, maxFreeSockets: 64 }), stamp: '', log: log || (l => process.stdout.write(l + '\n')) });
    this.main = new Space(this, { slug: '', name: 'Main', created: 0, paused: false, budget: 0 }, { data, work });
  }
  originFor(slug) { return `${this.base.protocol}//${slug ? slug + '.' : ''}${this.domain}${this.base.port ? ':' + this.base.port : ''}`; }
  spaceDirs(slug) { const d = path.join(this.dir, slug); return { data: path.join(d, 'data'), work: path.join(d, 'workspace') }; }
  // A workspace's vault key comes from SILO_SECRET when the host has one, different for each workspace.
  secretFor(slug) { const s = this.env.SILO_SECRET; return s ? createHmac('sha256', s).update('silo-workspace:' + slug).digest('base64url') : ''; }
  envFor(sp) {
    const tenant = !!sp.slug, base = {};
    if (tenant) { for (const k of KEEP_ENV) if (this.env[k] !== undefined) base[k] = this.env[k]; }
    else Object.assign(base, this.env);
    for (const k of ['SILO_WORKSPACES', 'SILO_SERVER_SCRIPT', 'SILO_TENANT', 'SILO_HOST_CONTROL', 'SILO_HOST_CONTROL_TOKEN', 'SILO_HOSTED_TOKEN', 'SILO_HOSTED_CONTROL']) delete base[k];
    return { ...base, PORT: String(sp.port), SILO_DATA_DIR: sp.data, SILO_WORK_DIR: sp.work, SILO_HOST: '127.0.0.1', SILO_PROXY: '0', SILO_PUBLIC_URL: this.originFor(sp.slug),
      SILO_HOSTED_TOKEN: sp.token, SILO_HOSTED_CONTROL: sp.control, SILO_WORKSPACE_BUDGET: String(sp.entry.budget || 0), SILO_SUPERVISED: '1',
      SILO_SECRET: tenant ? this.secretFor(sp.slug) : this.env.SILO_SECRET || '',
      ...(tenant ? { SILO_TENANT: '1' } : { SILO_HOST_CONTROL: this.controlUrl, SILO_HOST_CONTROL_TOKEN: this.controlToken }) };
  }
  // The code the host started with, to tell an update from a restart.
  codeStamp() { return ['server.mjs', 'workspaces.mjs', 'package.json'].map(f => { try { const s = fs.statSync(path.join(this.root, f)); return s.size + ':' + s.mtimeMs; } catch { return '-'; } }).join('|'); }
  async load() {
    let raw = null;
    try { raw = JSON.parse(await fsp.readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') { this.registryError = `${this.file} cannot be read (${e.message}). Only the main workspace runs; fix or restore the file, then restart SILO.`; this.log(this.registryError); } }
    for (const w of cleanRegistry(raw).workspaces) this.spaces.set(w.slug, new Space(this, w, this.spaceDirs(w.slug)));
  }
  async save() {
    if (this.registryError) throw fault(this.registryError, 409);
    const body = JSON.stringify({ format: 1, workspaces: [...this.spaces.values()].map(s => s.entry) }, null, 2) + '\n', tmp = `${this.file}.${process.pid}.${hex(4)}.tmp`;
    await fsp.writeFile(tmp, body);
    try { await fsp.rename(tmp, this.file); } catch (e) { await fsp.rm(tmp, { force: true }).catch(() => {}); throw e; }
  }
  // Changes run one after another, so two at once cannot undo each other.
  serial(fn) { const next = this.queue.catch(() => {}).then(fn); this.queue = next.catch(() => {}); return next; }

  async start() {
    this.stamp = this.codeStamp();
    await fsp.mkdir(this.dir, { recursive: true });
    await this.load();
    await this.startControl();
    this.server = http.createServer((req, res) => this.handle(req, res).catch(e => { if (!res.headersSent) page(req, res, 500, 'Something went wrong', e.message); else res.destroy(); }));
    this.server.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {} });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.listen, resolve); });
    this.port = this.server.address().port;
    this.main.start();
    // The others start a little apart, so a server with many does not start them all in the same second.
    let i = 0; for (const sp of this.spaces.values()) if (!sp.entry.paused) setTimeout(() => sp.start(), 300 * ++i).unref();
    return this;
  }
  ready(sp) {
    if (sp.slug) return this.log(`${sp.tag}Ready at ${this.originFor(sp.slug)}`);
    if (this.announced) return this.log(`${sp.tag}Ready again.`);
    this.announced = true;
    this.log(`SILO is ready at http://127.0.0.1:${this.port}`);
    this.log(`Workspaces: ${this.spaces.size ? [...this.spaces.keys()].map(s => this.originFor(s)).join(', ') : 'none yet. Make them in System > Workspaces.'}`);
  }
  // SILO asked to restart. After an update every workspace starts again with the new code, through the supervisor.
  async restarted(sp) {
    if (!sp.slug && this.codeStamp() !== this.stamp) { this.log('SILO was updated. Starting every workspace again.'); await this.close(); process.exit(75); }
    this.log(`${sp.tag}Restarting.`); sp.start();
  }
  async mainFailed(code, signal) {
    this.log(`The main workspace could not start (${signal || 'code ' + code}).`);
    await this.close(); process.exit(1);
  }
  async close() {
    if (this.closing) return; this.closing = true;
    await Promise.all([this.main, ...this.spaces.values()].map(s => s.stop()));
    this.server?.close(); this.controlServer?.close(); this.agent.destroy();
  }

  async handle(req, res) {
    if (req.method === 'GET' && req.url === '/api/health') { res.writeHead(this.main.state === 'running' ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ ok: this.main.state === 'running' })); }
    const slug = routeHost(req.headers.host, this.domain);
    if (slug === null) return page(req, res, 404, 'No workspace here', 'This address does not lead to a SILO workspace. Check the address you were given.');
    const sp = slug ? this.spaces.get(slug) : this.main;
    if (!sp) return page(req, res, 404, 'No workspace here', `There is no workspace called "${slug}". Check the address you were given.`);
    let route; try { route = new URL(req.url, 'http://x').pathname; } catch { return page(req, res, 400, 'Bad address', 'This address cannot be read.'); }
    if (route.startsWith('/api/hosted/')) return page(req, res, 404, 'Not found', 'There is nothing at this address.');
    if (sp.entry.paused) return page(req, res, 503, 'This workspace is paused', 'Whoever runs this SILO has paused it. Your data is kept; ask them to start it again.');
    if (sp.state === 'failed') return page(req, res, 503, 'This workspace is stopped', 'It stopped after failing to start several times. Whoever runs this SILO can restart it in System > Workspaces.');
    if (sp.state !== 'running') return page(req, res, 503, 'Starting this workspace', 'It will be ready in a few seconds.', 3);
    this.proxy(req, res, sp, visitorOf(req, this));
  }
  proxy(req, res, sp, v) {
    const headers = { ...req.headers };
    for (const k of [...HOP, ...OWN_HEADERS]) delete headers[k];
    Object.assign(headers, { 'x-silo-hosted': sp.token, 'x-silo-local': v.local ? '1' : '0', 'x-silo-client': v.ip, 'x-silo-proto': v.scheme });
    const up = http.request({ host: '127.0.0.1', port: sp.port, method: req.method, path: req.url, headers, agent: this.agent });
    up.on('response', r => {
      const h = { ...r.headers }; for (const k of HOP) delete h[k];
      res.writeHead(r.statusCode, r.statusMessage, h);
      r.pipe(res);
      r.on('error', () => res.destroy());
    });
    up.on('error', () => { if (!res.headersSent) page(req, res, 502, 'This workspace did not answer', 'It may be restarting. Try again in a moment.', 3); else res.destroy(); });
    // A visitor who leaves, a live stream included, ends the request to the workspace too.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }

  // The control API, on 127.0.0.1 only, for the main workspace: list, make, pause, start, restart, rename, budget, remove.
  async startControl() {
    this.controlServer = http.createServer(async (req, res) => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
      try {
        if (!same(String(req.headers.authorization || ''), 'Bearer ' + this.controlToken)) return send(401, { error: 'Not allowed.' });
        let body = {};
        if (req.method === 'POST') { let raw = ''; for await (const c of req) { raw += c; if (raw.length > 10000) throw fault('Request too large.', 413); } try { body = JSON.parse(raw || '{}'); } catch { throw fault('Invalid JSON.'); } }
        const route = new URL(req.url, 'http://x').pathname, one = route.match(/^\/workspaces\/([a-z0-9-]{1,40})$/);
        if (route === '/workspaces' && req.method === 'GET') return send(200, await this.list());
        if (route === '/workspaces' && req.method === 'POST') return send(201, { workspace: await this.create(body) });
        if (one && req.method === 'POST') return send(200, await this.change(one[1], body));
        send(404, { error: 'Not found.' });
      } catch (e) { send(e.status || 500, { error: e.message }); }
    });
    await new Promise((resolve, reject) => { this.controlServer.once('error', reject); this.controlServer.listen(0, '127.0.0.1', resolve); });
    this.controlUrl = `http://127.0.0.1:${this.controlServer.address().port}`;
  }
  async view(sp) {
    const st = await sp.readStatus(), url = this.originFor(sp.slug);
    return { slug: sp.slug, main: !sp.slug, name: sp.entry.name, url, state: sp.entry.paused ? 'paused' : sp.state, budget: sp.entry.budget, created: sp.entry.created,
      error: sp.state === 'failed' || sp.state === 'waiting' ? sp.error : '',
      ...(st && { accounts: st.accounts, owners: st.owners, residents: st.residents, working: st.working, month: st.month, version: st.version }),
      setupUrl: st && !st.accounts && st.setup ? `${url}/?setup=${st.setup}` : '' };
  }
  async list() {
    return { domain: this.domain, base: this.originFor(''), max: this.max, error: this.registryError, workspaces: await Promise.all([this.main, ...[...this.spaces.values()].sort((a, b) => a.entry.created - b.entry.created)].map(s => this.view(s))) };
  }
  create(b) {
    return this.serial(async () => {
      const slug = checkSlug(b.slug), name = cleanName(b.name) || slug, budget = cleanBudget(b.budget);
      if (this.spaces.has(slug)) throw fault(`There is already a workspace called "${slug}".`, 409);
      if (this.spaces.size >= this.max) throw fault(`This SILO hosts at most ${this.max} workspaces (SILO_WORKSPACES_MAX).`, 409);
      const dirs = this.spaceDirs(slug), home = path.dirname(dirs.data);
      // A folder left from before is never handed to a new workspace: it may hold another team's data.
      if (fs.existsSync(home)) throw fault(`A folder for "${slug}" is already there (${home}). Move it away first, or choose another name.`, 409);
      await fsp.mkdir(dirs.data, { recursive: true }); await fsp.mkdir(dirs.work, { recursive: true });
      const sp = new Space(this, { slug, name, created: Date.now(), paused: false, budget }, dirs);
      this.spaces.set(slug, sp);
      try { await this.save(); } catch (e) { this.spaces.delete(slug); await fsp.rm(home, { recursive: true, force: true }).catch(() => {}); throw e; }
      this.log(`${sp.tag}Made "${name}" at ${this.originFor(slug)}.`);
      sp.start();
      await sp.whenReady();
      await sp.readStatus(true);
      return this.view(sp);
    });
  }
  change(slug, b) {
    return this.serial(async () => {
      if (slug === 'main') throw fault('The main workspace is this one. Restart it in System > Updates and start.', 409);
      const sp = this.spaces.get(slug); if (!sp) throw fault(`There is no workspace called "${slug}".`, 404);
      const e = sp.entry;
      if (b.action === 'rename') { const name = cleanName(b.name); if (!name) throw fault('Give the workspace a name.'); e.name = name; await this.save(); }
      else if (b.action === 'budget') { e.budget = cleanBudget(b.budget); await this.save(); await sp.plan(); }
      else if (b.action === 'pause') { if (!e.paused) { e.paused = true; await this.save(); await sp.stop(); this.log(`${sp.tag}Paused.`); } }
      else if (b.action === 'resume') { if (e.paused || sp.state === 'failed' || sp.state === 'stopped') { e.paused = false; await this.save(); sp.crashes = []; sp.start(); await sp.whenReady(); } }
      else if (b.action === 'restart') { if (e.paused) throw fault('Start the workspace instead: it is paused.', 409); await sp.stop(); sp.crashes = []; sp.start(); await sp.whenReady(); }
      else if (b.action === 'remove') {
        // Its data is moved aside, never deleted: whoever runs the server deletes it when they are sure.
        await sp.stop();
        const home = path.dirname(sp.data), kept = path.join(this.dir, '.removed', `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        await fsp.mkdir(path.dirname(kept), { recursive: true });
        try { await fsp.rename(home, kept); } catch (err) { if (err.code !== 'ENOENT') { if (!e.paused) sp.start(); throw fault(`The folder of "${slug}" could not be moved (${err.code || err.message}). Nothing was removed.`, 500); } }
        this.spaces.delete(slug);
        try { await this.save(); } catch (err) { this.spaces.set(slug, sp); throw err; }
        this.log(`${sp.tag}Removed. Its data is in ${kept}.`);
        return { removed: slug, keptIn: kept, workspace: { slug, name: e.name } };
      }
      else throw fault('Choose pause, resume, restart, remove, budget or rename.');
      return { workspace: await this.view(sp) };
    });
  }
}

// Run as a program: the host, under the supervisor or on its own.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const ROOT = path.dirname(fileURLToPath(import.meta.url)), env = process.env;
  let launch = {}; try { launch = JSON.parse(fs.readFileSync(path.join(ROOT, 'launch.json'), 'utf8')); } catch {}
  const listen = String(env.SILO_HOST || '').trim() || '127.0.0.1';
  if (!net.isIP(listen) && listen !== 'localhost') { console.error(`SILO_HOST must be an IP address, like 0.0.0.0, not "${listen.slice(0, 60)}".`); process.exit(1); }
  const onFly = !!env.FLY_APP_NAME, proxyEnv = String(env.SILO_PROXY || '').trim();
  const trustProxy = proxyEnv === '1' || (proxyEnv !== '0' && !!(env.RENDER_EXTERNAL_URL || onFly || env.RAILWAY_PUBLIC_DOMAIN));
  const publicUrl = (() => { const u = env.SILO_PUBLIC_URL || env.RENDER_EXTERNAL_URL || (onFly && `https://${env.FLY_APP_NAME}.fly.dev`) || (env.RAILWAY_PUBLIC_DOMAIN && `https://${env.RAILWAY_PUBLIC_DOMAIN}`) || ''; try { const x = new URL(String(u).trim()); return /^https?:$/.test(x.protocol) ? x.origin : ''; } catch { return ''; } })();
  const domain = String(env.SILO_WORKSPACE_DOMAIN || '').trim().toLowerCase();
  if (domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(domain)) { console.error(`SILO_WORKSPACE_DOMAIN must be a domain name, like silo.example.com, not "${domain.slice(0, 60)}".`); process.exit(1); }
  const host = new Host({ root: ROOT, data: path.resolve(ROOT, env.SILO_DATA_DIR || launch.dataDir || 'data'), work: path.resolve(ROOT, env.SILO_WORK_DIR || launch.workDir || 'workspace'),
    port: Number(env.PORT || launch.port || 3000), listen, publicUrl, domain, trustProxy, onFly, max: Math.max(1, Math.min(1000, Number(env.SILO_WORKSPACES_MAX) || 50)) });
  const stop = async code => { await host.close(); process.exit(code); };
  process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0)); process.on('SIGBREAK', () => stop(0));
  // Under the supervisor: it asks to stop through its channel, and when it is gone the workspaces stop too.
  if (process.send) { process.on('message', m => { if (m === 'stop') stop(0); }); process.on('disconnect', () => stop(0)); }
  try { await host.start(); }
  catch (e) { console.error(e.code === 'EADDRINUSE' ? `Port ${host.port} is used by another program (EADDRINUSE).` : e.message); await host.close(); process.exit(1); }
}
