// Starts SILO in its container. Hosting services (Render, Fly.io, Railway) mount their disks owned by root, so when
// the container starts as root, the data and workspace folders are given to the node user first, and SILO then runs as
// node, never as root. Started as node already (docker run --user, Docker Compose), it starts SILO straight away.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USER = 'node';

// The node user's ids, from /etc/passwd. The official Node image gives it 1000.
export function userIds(passwd, name = USER) {
  for (const line of String(passwd).split('\n')) {
    const f = line.split(':');
    if (f[0] === name && /^\d+$/.test(f[2]) && /^\d+$/.test(f[3])) return { uid: Number(f[2]), gid: Number(f[3]), home: f[5] || '/home/' + name };
  }
  return { uid: 1000, gid: 1000, home: '/home/' + name };
}

// Everything under dir that the user does not own yet, without following links out of it.
export function giveTo(dir, uid, gid) {
  let changed = 0;
  const walk = p => {
    let st; try { st = fs.lstatSync(p); } catch { return; }
    if (st.uid !== uid || st.gid !== gid) { try { fs.lchownSync(p, uid, gid); changed++; } catch {} }
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) walk(path.join(p, e));
  };
  walk(dir);
  return changed;
}

// Railway attaches one volume and names its folder; unless they were set, the data and the workspace both go on it.
// Without a volume, everything would be gone at the next deploy, so the log says so.
export function cloudDirs(env, log = console.log) {
  const vol = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (vol) {
    if (!env.SILO_DATA_DIR || env.SILO_DATA_DIR === '/data') env.SILO_DATA_DIR = vol;
    if (!env.SILO_WORK_DIR || env.SILO_WORK_DIR === '/workspace') env.SILO_WORK_DIR = path.posix.join(vol, 'workspace');
  } else if (env.RAILWAY_ENVIRONMENT) log('No volume is attached. Attach one at /data, or residents, workflows and keys are lost at the next deploy.');
  return env;
}

export function prepare({ dirs, ids, log = console.log }) {
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    // A disk SILO already used is the node user's; only a new or root-owned one is walked.
    const st = fs.statSync(dir);
    if (st.uid === ids.uid && st.gid === ids.gid) continue;
    const n = giveTo(dir, ids.uid, ids.gid);
    log(`Gave ${dir} to the ${USER} user (${n} ${n === 1 ? 'item' : 'items'}).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cloudDirs(process.env);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    let passwd = ''; try { passwd = fs.readFileSync('/etc/passwd', 'utf8'); } catch {}
    const ids = userIds(passwd), env = process.env;
    const dirs = [...new Set([env.SILO_DATA_DIR || '/data', env.SILO_WORK_DIR || '/workspace'].map(d => path.resolve(d)))];
    try { prepare({ dirs, ids }); } catch (e) { console.error(`The data folders could not be prepared: ${e.message}`); process.exit(1); }
    process.setgroups([ids.gid]); process.setgid(ids.gid); process.setuid(ids.uid);
    Object.assign(env, { HOME: ids.home, USER, LOGNAME: USER });
  }
  await import('./supervisor.mjs');
}
