// Environments through Git: a development SILO pushes its workflows and table layouts to a Git repository, and a
// production SILO pulls them, after you read what would change. Git runs as a program with its arguments, never
// through a shell, without prompts, and only over https, ssh, git or a local folder. Its sign-in is Git's own (a
// credential manager or an SSH key): SILO never holds a password or token for the repository.
import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, lstatSync} from 'node:fs';
import path from 'node:path';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
export const SYNC_FORMAT = 1, SYNC_FILE_MAX = 2e6, SYNC_FILES_MAX = 2000;
export const ENVIRONMENTS = {'': 'No environment', development: 'Development', testing: 'Testing', production: 'Production'};

// A repository address Git may use: https or ssh without a password in it, user@host:path, or a folder on this computer.
export function checkRemote(raw) {
  const r = String(raw ?? '').trim();
  if (!r) fail('Give the address of the Git repository.');
  if (r.length > 500 || /[\s\0]/.test(r) || r.startsWith('-')) fail('That is not a Git repository address.');
  if (/^[a-z][\w+.-]*::/i.test(r)) fail('That kind of Git address is not allowed.');
  if (/^[a-z][\w+.-]*:\/\//i.test(r)) {
    let u; try { u = new URL(r); } catch { fail('That is not a Git repository address.'); }
    if (!['https:', 'ssh:', 'git:', 'file:'].includes(u.protocol)) fail('Use an https, ssh or git address, or a folder.');
    if (u.password || (u.protocol === 'https:' && u.username)) fail('Leave the password or token out of the address. Git signs in on its own, with a credential manager or an SSH key.');
    return r;
  }
  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(r)) return r;
  if (path.isAbsolute(r)) return path.resolve(r);
  fail('Use an https, ssh or git address, user@host:path, or the full path of a folder.');
}
export function checkBranch(raw) {
  const b = String(raw ?? '').trim() || 'main';
  if (!/^[\w][\w./-]{0,99}$/.test(b) || b.includes('..') || b.includes('//') || b.endsWith('/') || b.endsWith('.lock') || b.endsWith('.')) fail('Give a branch name like main or silo/production.');
  return b;
}
// A file name from a name: lower case letters, digits and dashes.
export const slug = (n, max = 50) => String(n || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, max).replace(/^-|-$/g, '') || 'item';

export class GitSync {
  constructor(dir, {timeout = 60000} = {}) { this.dir = dir; this.repo = path.join(dir, 'repo'); this.timeout = timeout; this.chain = Promise.resolve(); }

  // One sync at a time: a push and a pull never share the working copy.
  run(fn) { const next = this.chain.catch(() => {}).then(fn); this.chain = next.catch(() => {}); return next; }

  git(args, {cwd = this.repo, allowFail = false} = {}) {
    const env = {...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ALLOW_PROTOCOL: 'https:ssh:git:file', LC_ALL: 'C'};
    if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=20';
    // core.symlinks=false: a link in the repository is checked out as a small file holding its target, never as a link
    // that could lead read() to a file of this computer.
    const all = ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'core.symlinks=false', '-c', 'protocol.ext.allow=never', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(this.dir, 'no-hooks'), ...args];
    return new Promise((resolve, reject) => execFile('git', all, {cwd, env, windowsHide: true, timeout: this.timeout, maxBuffer: 20e6}, (e, out, err) => {
      if (e && !allowFail) {
        const text = String(err || e.message).trim().split('\n').filter(l => !/^hint:/.test(l)).slice(-3).join(' ').slice(0, 400);
        return reject(Object.assign(new Error(e.code === 'ENOENT' ? 'Git is not installed on this computer. Install it from git-scm.com, then try again.' : e.killed ? 'Git took too long. Check the address and the network.' : 'Git: ' + text), {status: e.code === 'ENOENT' ? 409 : 502, gitText: text}));
      }
      resolve({ok: !e, out: String(out), err: String(err)});
    }));
  }

  // The working copy, with origin at the address and the branch as it is there now. An empty repository, or one
  // without the branch, starts the branch from nothing.
  async prepare({remote, branch}) {
    mkdirSync(this.dir, {recursive: true});
    // Made from nothing at most once: a copy just made needs no second start for a branch that is not there yet.
    let made = false;
    const fresh = async () => { made = true; rmSync(this.repo, {recursive: true, force: true}); mkdirSync(this.repo, {recursive: true}); await this.git(['init', '--quiet']); await this.git(['remote', 'add', 'origin', '--', remote]); };
    if (!existsSync(path.join(this.repo, '.git'))) await fresh();
    else if (!(await this.git(['remote', 'set-url', 'origin', '--', remote], {allowFail: true})).ok) await fresh();
    const ls = await this.git(['ls-remote', '--heads', 'origin', 'refs/heads/' + branch]);
    const there = ls.out.trim().length > 0;
    if (!there && !made) await fresh();
    if (there) {
      await this.git(['fetch', '--quiet', '--depth', '50', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      await this.git(['checkout', '--quiet', '-B', branch, 'origin/' + branch]);
      await this.git(['reset', '--quiet', '--hard', 'origin/' + branch]);
    } else {
      // A new working copy with nothing in it: the first push starts the branch.
      await this.git(['checkout', '--quiet', '--orphan', branch]);
    }
    await this.git(['clean', '-fdxq']);
    const head = there ? (await this.git(['rev-parse', 'HEAD'])).out.trim() : '';
    return {head, empty: !there};
  }

  // The files SILO keeps there: silo.json, workflows/*.json and tables/*.json. Only plain files in plain folders: a
  // link (made by hand in the working copy, or by a Git that keeps links) is never followed out of the repository.
  read() {
    const files = new Map(), plain = (p, dir) => { try { const s = lstatSync(p); return dir ? s.isDirectory() : s.isFile(); } catch { return false; } };
    for (const sub of ['workflows', 'tables']) {
      const d = path.join(this.repo, sub); if (!plain(d, true)) continue;
      for (const name of readdirSync(d)) {
        if (!name.endsWith('.json')) continue;
        const f = path.join(d, name);
        if (!plain(f)) continue;
        const st = lstatSync(f);
        if (st.size > SYNC_FILE_MAX) fail(`${sub}/${name} is larger than 2 MB.`, 422);
        files.set(sub + '/' + name, readFileSync(f, 'utf8'));
        if (files.size > SYNC_FILES_MAX) fail(`The repository holds more than ${SYNC_FILES_MAX} SILO files.`, 422);
      }
    }
    return files;
  }

  // Writes the files, removes the ones named, and commits and pushes when something changed.
  async write({files, remove = [], message, author, branch}) {
    for (const [rel, text] of files) { const f = path.join(this.repo, rel); mkdirSync(path.dirname(f), {recursive: true}); writeFileSync(f, text); }
    for (const rel of remove) rmSync(path.join(this.repo, rel), {force: true});
    await this.git(['add', '-A', '--', '.']);
    const st = await this.git(['status', '--porcelain']);
    if (!st.out.trim()) return {changed: false, files: 0};
    const count = st.out.trim().split('\n').length;
    const who = `${String(author || 'SILO').replace(/[<>\n]/g, '').slice(0, 60) || 'SILO'} <silo@localhost>`;
    await this.git(['-c', 'user.name=SILO', '-c', 'user.email=silo@localhost', 'commit', '--quiet', '--no-verify', '--author', who, '-m', String(message).slice(0, 2000)]);
    const pushed = await this.git(['push', '--quiet', '--porcelain', 'origin', 'HEAD:refs/heads/' + branch], {allowFail: true});
    if (!pushed.ok) {
      const text = (pushed.err || pushed.out).trim().split('\n').slice(-2).join(' ').slice(0, 300);
      if (/rejected|non-fast-forward|fetch first/i.test(text)) fail('The branch changed in the repository meanwhile. Push again: SILO starts from what is there now.', 409);
      fail('Git could not push: ' + text, 502);
    }
    const commit = (await this.git(['rev-parse', 'HEAD'])).out.trim();
    return {changed: true, files: count, commit};
  }
}
