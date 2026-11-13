// Notebooks for residents: a Python kernel that keeps its variables from cell to cell, and the cells saved as a
// Jupyter notebook (.ipynb). The kernel works in its own copy of the workspace, like run_code: files a cell writes
// come back to be proposed, never written into the workspace. With Docker it runs in a container without network.
// The kernel needs only Python, not Jupyter.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { localCommand, dockerAvailable, copyTree, snapshot, kill } from './sandbox.mjs';

export const KERNEL_FILE = '.silo_kernel.py';
// The kernel: reads one JSON request a line, runs the code in one namespace, answers on its real stdout with a mark
// only it knows. The value of a last expression is shown, like in Jupyter. Matplotlib figures come back as PNG.
export const KERNEL_SOURCE = String.raw`import ast, base64, contextlib, io, json, os, sys, traceback
MARK = '\x1e' + os.environ.pop('SILO_KERNEL_MARK', '')
OUT, IN = sys.__stdout__, sys.__stdin__
os.environ.setdefault('MPLBACKEND', 'Agg')
NS = {'__name__': '__main__', '__builtins__': __builtins__}
HERE = os.path.abspath(__file__)
def figures():
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return []
    out = []
    for n in plt.get_fignums()[:4]:
        b = io.BytesIO()
        plt.figure(n).savefig(b, format='png', bbox_inches='tight')
        out.append(base64.b64encode(b.getvalue()).decode())
    plt.close('all')
    return out
def run(code):
    so, se = io.StringIO(), io.StringIO()
    res = {'stdout': '', 'stderr': '', 'result': None, 'error': None, 'images': []}
    try:
        tree = ast.parse(code, '<cell>', 'exec')
        last = ast.Expression(tree.body.pop().value) if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        sys.stdin = io.StringIO('')
        with contextlib.redirect_stdout(so), contextlib.redirect_stderr(se):
            exec(compile(tree, '<cell>', 'exec'), NS)
            if last is not None:
                v = eval(compile(last, '<cell>', 'eval'), NS)
                if v is not None:
                    NS['_'] = v
                    r = repr(v)
                    res['result'] = r if len(r) <= 5000 else r[:5000] + '...'
    except BaseException as e:
        frames = [f for f in traceback.extract_tb(e.__traceback__) if os.path.abspath(f.filename) != HERE]
        if isinstance(e, SyntaxError):
            frames = []
        tb = traceback.format_list(frames) + traceback.format_exception_only(type(e), e)
        res['error'] = {'ename': type(e).__name__, 'evalue': str(e)[:2000], 'traceback': [l.rstrip('\n') for l in tb][-15:]}
    finally:
        sys.stdin = IN
    try:
        res['images'] = figures()
    except Exception as e:
        res['stderr'] += '\n(figure not saved: %s)' % e
    res['stdout'] = so.getvalue()[:20000] + res['stdout']
    res['stderr'] = se.getvalue()[:8000] + res['stderr']
    return res
OUT.write(MARK + json.dumps({'ready': True, 'python': sys.version.split()[0]}) + '\n'); OUT.flush()
for line in IN:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    res = run(str(req.get('code', '')))
    res['id'] = req.get('id')
    OUT.write(MARK + json.dumps(res) + '\n'); OUT.flush()
`;

const SAFE_ENV = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT', 'LANG', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA'];
export class Kernel {
  // mode: 'docker' or 'local'. work: the workspace it starts from (copied, never changed).
  constructor({ key, work, mode }) { this.key = key; this.work = work; this.mode = mode; this.used = Date.now(); this.count = 0; this.queue = Promise.resolve(); this.dead = false; this.pending = 0; }
  // Busy while a cell runs or waits for its turn: such a kernel is never stopped to make room.
  get busy() { return this.pending > 0; }
  async start() {
    this.temp = await fs.mkdtemp(path.join(os.tmpdir(), 'silo-kernel-'));this.dir = path.join(this.temp, 'work');
    await copyTree(this.work, this.dir, { files: 0, bytes: 0 });
    await fs.writeFile(path.join(this.dir, KERNEL_FILE), KERNEL_SOURCE);
    this.mark = randomBytes(16).toString('hex');
    if (this.mode === 'docker') {
      this.container = 'silo-kernel-' + randomBytes(6).toString('hex');
      this.child = spawn('docker', ['run', '-i', '--rm', '--name', this.container, '--network', 'none', '--memory', '1g', '--cpus', '1', '--pids-limit', '256', '--security-opt', 'no-new-privileges', '-e', 'SILO_KERNEL_MARK=' + this.mark, '-e', 'MPLBACKEND=Agg', '-e', 'PYTHONIOENCODING=utf-8', '-v', `${this.dir}:/work`, '-w', '/work', 'python:3.12-slim', 'python', '-u', KERNEL_FILE], { windowsHide: true });
    } else {
      const py = await localCommand('python'); if (!py) throw new Error('Python 3 is not installed on this computer.');
      const env = Object.fromEntries(SAFE_ENV.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
      Object.assign(env, { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', MPLBACKEND: 'Agg', SILO_KERNEL_MARK: this.mark });
      this.child = spawn(py.cmd, [...py.pre, '-u', KERNEL_FILE], { cwd: this.dir, env, windowsHide: true });
    }
    this.buffer = ''; this.stray = ''; this.waiting = null;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', d => { this.buffer += d; let i; while ((i = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1); this.line(line); } });
    this.child.stderr.setEncoding('utf8'); this.child.stderr.on('data', d => { this.stray = (this.stray + d).slice(-4000); });
    this.child.once('exit', code => { this.dead = true; const w = this.waiting; this.waiting = null; w?.reject(new Error(`The kernel stopped (exit code ${code}). ${this.stray.trim().split('\n').slice(-2).join(' ')}`.trim())); });
    this.child.once('error', e => { this.dead = true; const w = this.waiting; this.waiting = null; w?.reject(e); });
    const hello = await this.wait(this.mode === 'docker' ? 120000 : 20000);
    this.python = hello.python;
    this.before = await snapshot(this.dir);
    return this;
  }
  line(line) {
    const tag = '\x1e' + this.mark;
    if (!line.startsWith(tag)) { this.stray = (this.stray + line + '\n').slice(-4000); return; }
    let msg; try { msg = JSON.parse(line.slice(tag.length)); } catch { return; }
    const w = this.waiting; this.waiting = null; w?.resolve(msg);
  }
  wait(ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting = null; reject(Object.assign(new Error(`The cell ran longer than ${Math.round(ms / 1000)} seconds. The kernel was stopped, so its variables are gone.`), { timedOut: true })); this.stop(); }, ms);
      this.waiting = { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } };
    });
  }
  // Runs one cell. Cells of one kernel run one after the other.
  exec(code, { timeout = 120000, signal } = {}) {
    this.pending++;
    const job = this.queue.then(async () => {
      if (this.dead) throw new Error('The kernel is not running.');
      if (signal?.aborted) throw signal.reason || new Error('Stopped.');
      this.used = Date.now();
      const id = ++this.count, p = this.wait(timeout);
      const onAbort = () => { this.stop(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.child.stdin.write(JSON.stringify({ id, code }) + '\n');
      try {
        const r = await p;
        const after = await snapshot(this.dir), changed = [];
        for (const [name, sig] of after) {
          if (name === KERNEL_FILE || this.before.get(name) === sig || !/\.(txt|md|json|csv|js|mjs|ts|py|html|css|yaml|yml|xml|svg|log|ipynb)$/i.test(name)) continue;
          const full = path.join(this.dir, name); if ((await fs.stat(full)).size > 200000) continue;
          changed.push({ name, content: await fs.readFile(full, 'utf8') }); if (changed.length >= 10) break;
        }
        this.before = after;
        return { ...r, count: id, changed };
      } catch (e) { if (signal?.aborted) throw signal.reason || new Error('Stopped.'); throw e; }
      finally { signal?.removeEventListener('abort', onAbort); this.used = Date.now(); }
    }).finally(() => { this.pending--; this.used = Date.now(); this.onIdle?.(); });
    this.queue = job.catch(() => {});
    return job;
  }
  stop() {
    if (this.stopped) return; this.stopped = true; this.dead = true;
    if (this.child && this.child.exitCode === null) { if (this.container) spawn('docker', ['rm', '-f', this.container], { windowsHide: true }).on('error', () => {}); kill(this.child); }
    const temp = this.temp; setTimeout(() => fs.rm(temp, { recursive: true, force: true }).catch(() => {}), 1500);
  }
}

// Keeps the kernels: at most `max` at once, each stopped after `idle` ms without a cell. To make room for a new one
// only an idle kernel is stopped, the one unused the longest; when all are busy the new one waits up to `wait` ms.
export class Kernels {
  constructor({ work, max = 4, idle = 15 * 60_000, wait = 120_000, make = o => new Kernel(o) }) { this.make = make; this.work = work; this.max = max; this.idle = idle; this.wait = wait; this.list = new Map(); this.waiters = new Set(); this.timer = setInterval(() => this.sweep(), 60_000); this.timer.unref?.(); }
  // Resolves when a kernel finishes a cell or stops, or after ms.
  freed(ms) { return new Promise(resolve => { const done = () => { clearTimeout(t); this.waiters.delete(done); resolve(); }; const t = setTimeout(done, ms); this.waiters.add(done); }); }
  wake() { for (const w of [...this.waiters]) w(); }
  async get(key, sandbox) {
    const k = this.list.get(key);
    if (k && !k.dead) return { kernel: k, fresh: false };
    if (k) this.list.delete(key);
    const mode = sandbox === 'docker' || (sandbox === 'auto' && await dockerAvailable()) ? 'docker' : 'local';
    if (sandbox === 'docker' && !await dockerAvailable()) throw new Error('The sandbox is set to Docker, but Docker is not running.');
    const until = Date.now() + this.wait;
    while (this.list.size >= this.max) {
      for (const [k, x] of this.list) if (x.dead) this.list.delete(k);
      if (this.list.size < this.max) break;
      const idle = [...this.list.entries()].filter(([, x]) => !x.busy && !x.starting).sort((a, b) => a[1].used - b[1].used)[0];
      if (idle) { idle[1].stop(); this.list.delete(idle[0]); break; }
      if (Date.now() >= until) throw new Error(`All ${this.max} notebook kernels are busy running cells. Try again when one is done.`);
      await this.freed(Math.min(1000, until - Date.now()));
      const again = this.list.get(key); if (again && !again.dead) return { kernel: again, fresh: false };
    }
    const kernel = this.make({ key, work: this.work, mode });
    kernel.onIdle = () => this.wake(); kernel.starting = true;
    this.list.set(key, kernel);
    try { await kernel.start(); } catch (e) { kernel.stop(); this.list.delete(key); this.wake(); throw e; } finally { kernel.starting = false; }
    return { kernel, fresh: true };
  }
  stop(key) { const k = this.list.get(key); if (!k) return false; k.stop(); this.list.delete(key); this.wake(); return true; }
  stopWhere(test) { for (const key of [...this.list.keys()]) if (test(key)) this.stop(key); }
  running(key) { const k = this.list.get(key); return !!k && !k.dead; }
  sweep() { const now = Date.now(); for (const [key, k] of this.list) if (k.dead || (!k.busy && !k.starting && now - k.used > this.idle)) { k.stop(); this.list.delete(key); this.wake(); } }
  close() { clearInterval(this.timer); for (const k of this.list.values()) k.stop(); this.list.clear(); this.wake(); }
}

// --- The .ipynb file (nbformat 4.5) ---
export const notebookName = s => String(s || 'main').trim().replace(/\.ipynb$/i, '').replace(/[^\p{L}\p{N} _.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'main';
const lines = text => { const parts = String(text).split(/(?<=\n)/); return parts.length && parts.at(-1) === '' ? parts.slice(0, -1) : parts; };
export function emptyNotebook() {
  return { cells: [], metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, language_info: { name: 'python' }, silo: { restarts: 0 } }, nbformat: 4, nbformat_minor: 5 };
}
export function cellFrom(code, r, count) {
  const outputs = [];
  if (r.stdout) outputs.push({ output_type: 'stream', name: 'stdout', text: lines(r.stdout) });
  if (r.stderr) outputs.push({ output_type: 'stream', name: 'stderr', text: lines(r.stderr) });
  for (const png of r.images || []) outputs.push({ output_type: 'display_data', data: { 'image/png': png, 'text/plain': ['<Figure>'] }, metadata: {} });
  if (r.result != null) outputs.push({ output_type: 'execute_result', execution_count: count, data: { 'text/plain': lines(r.result) }, metadata: {} });
  if (r.error) outputs.push({ output_type: 'error', ename: r.error.ename, evalue: r.error.evalue, traceback: r.error.traceback });
  return { cell_type: 'code', id: randomUUID().slice(0, 8), execution_count: count, metadata: {}, source: lines(code), outputs };
}
export function markdownCell(text) { return { cell_type: 'markdown', id: randomUUID().slice(0, 8), metadata: {}, source: lines(text) }; }
// What the resident reads back from one cell.
export function cellText(r, fresh) {
  const parts = [];
  if (fresh) parts.push(`(A new kernel started${r.python ? ', Python ' + r.python : ''}. Variables from earlier cells are not there.)`);
  if (r.stdout) parts.push('--- output ---\n' + r.stdout);
  if (r.result != null) parts.push(`Out[${r.count}]: ${r.result}`);
  if (r.images?.length) parts.push(`${r.images.length} figure${r.images.length === 1 ? '' : 's'} saved in the notebook.`);
  if (r.stderr) parts.push('--- errors ---\n' + r.stderr);
  // The traceback ends with "Name: message" already; without frames the name and message are the whole error.
  if (r.error) parts.push(r.error.traceback?.length ? r.error.traceback.join('\n') : `${r.error.ename}: ${r.error.evalue}`);
  return parts.join('\n') || '(no output)';
}
