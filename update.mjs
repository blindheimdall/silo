// Updates. A release is a signed list of files with their SHA-256. Nothing is written until the signature, the
// zip and every file check out, files outside the app (data, workspace) are never touched, and the files an
// update replaces are kept so the update can be rolled back. Also used by supervisor.mjs, so no server state here.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { unzip, zip } from './documents.mjs';

// What a release never holds: your data, the workspace, tests, build output and settings of one install.
export const RELEASE_SKIP = /^(data|workspace|node_modules|tests|dist|\.git|\.claude|\.vscode)(\/|$)|^launch\.json$|\.log$|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|(^|\/)~/i;
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map(n => parseInt(n, 10) || 0), pb = String(b).split(/[.+-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
export const validVersion = v => /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(String(v));
// The same object always gives the same text, so a signature can be checked.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export function signManifest(m, privateKeyPem) {
  const { signature, ...body } = m;
  return { ...body, signature: crypto.sign(null, Buffer.from(canonical(body)), crypto.createPrivateKey(privateKeyPem)).toString('base64') };
}
export function verifyManifest(m, publicKeyPem) {
  if (!publicKeyPem) throw err('This SILO has no release key, so it cannot check updates. Put release-key.pub next to server.mjs.', 409);
  if (!m || typeof m !== 'object' || m.app !== 'silo') throw err('The update feed did not give a SILO release.', 502);
  const { signature, ...body } = m;
  let ok = false;
  try { ok = crypto.verify(null, Buffer.from(canonical(body)), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signature || ''), 'base64')); } catch {}
  if (!ok) throw err('The update is not signed with this SILO\'s release key. Nothing was installed.', 502);
  if (!validVersion(m.version)) throw err('The update has an odd version number.', 502);
  if (!m.files || typeof m.files !== 'object' || !Object.keys(m.files).length) throw err('The update lists no files.', 502);
  for (const [p, h] of Object.entries(m.files)) { safeReleasePath(p); if (!/^[a-f0-9]{64}$/.test(h)) throw err('The update lists a file without a valid hash.', 502); }
  if (!/^[a-f0-9]{64}$/.test(m.zipSha256 || '') || !/^[\w.-]+\.zip$/.test(m.zip || '')) throw err('The update has no zip, or no hash for it.', 502);
  return m;
}
// A path inside the app folder, written with forward slashes. Never data, workspace or a launch file.
export function safeReleasePath(p) {
  const s = String(p || '');
  if (!s || s.length > 200 || /[\\:*?"<>|\x00-\x1f]/.test(s) || s.startsWith('/') || s.split('/').some(x => !x || x === '.' || x === '..') || RELEASE_SKIP.test(s)) throw err('The update holds a file it may not hold: ' + s.slice(0, 80), 502);
  return s;
}
export async function listReleaseFiles(root) {
  const out = [];
  const walk = async rel => {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const p = rel ? rel + '/' + e.name : e.name;
      if (RELEASE_SKIP.test(p) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(p); else if (e.isFile()) out.push(p);
    }
  };
  await walk('');
  return out.sort();
}
// Makes the zip and its signed list. Used by tools/release.mjs.
export async function buildRelease({ root, version, notes = '', privateKeyPem, minNode = '22' }) {
  if (!validVersion(version)) throw err('Use a version like 1.2.3.');
  const names = await listReleaseFiles(root), files = {}, entries = [];
  for (const n of names) { const b = await fs.readFile(path.join(root, n)); files[n] = sha256(b); entries.push([n, b]); }
  const z = zip(entries), name = `silo-${version}.zip`;
  const manifest = signManifest({ app: 'silo', version, notes: String(notes).slice(0, 2000), date: new Date().toISOString().slice(0, 10), minNode, zip: name, zipSha256: sha256(z), size: z.length, files }, privateKeyPem);
  return { zip: z, zipName: name, manifest };
}

// Where the feed is: an https address, or a folder on this computer or the network.
async function fetchBytes(where, max, allowHttp) {
  const u = new URL(where);
  if (u.protocol === 'file:') { const f = fss.statSync(u); if (f.size > max) throw err('The update is too large.', 502); return fs.readFile(u); }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw err('The update feed needs an https address or a folder.', 400);
  const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw err(`The update feed answered ${r.status}.`, 502);
  if (Number(r.headers.get('content-length') || 0) > max) throw err('The update is too large.', 502);
  const b = Buffer.from(await r.arrayBuffer()); if (b.length > max) throw err('The update is too large.', 502);
  return b;
}
export function feedUrl(feed) {
  const s = String(feed || '').trim(); if (!s) throw err('Set the update feed first.', 409);
  if (/^[a-z]:[\\/]|^\\\\/i.test(s)) { const p = s.replace(/[\\/]+$/, ''); return new URL('file:' + (p.startsWith('\\\\') ? p.replace(/\\/g, '/') : '///' + p.replace(/\\/g, '/')) + (/\.json$/i.test(p) ? '' : '/latest.json')).href; }
  if (s.startsWith('/') && !s.startsWith('//')) { const u = pathToFileURL(s.replace(/\/+$/, '')); if (!/\.json$/i.test(u.pathname)) u.pathname += '/latest.json'; return u.href; }
  const u = new URL(s); if (!/\.json$/i.test(u.pathname)) u.pathname = u.pathname.replace(/\/?$/, '/latest.json');
  return u.href;
}
export async function fetchManifest(feed, publicKeyPem, { allowHttp = false } = {}) {
  const raw = await fetchBytes(feedUrl(feed), 2e6, allowHttp);
  let m; try { m = JSON.parse(raw.toString('utf8')); } catch { throw err('The update feed did not give JSON.', 502); }
  return verifyManifest(m, publicKeyPem);
}
// Downloads the zip and checks it against the signed list, file by file. Returns the files, nothing is written.
export async function downloadRelease(feed, manifest, { allowHttp = false } = {}) {
  const zipUrl = new URL(manifest.zip, feedUrl(feed)).href;
  const buf = await fetchBytes(zipUrl, 150e6, allowHttp);
  if (sha256(buf) !== manifest.zipSha256) throw err('The downloaded update does not match its signed hash. Nothing was installed.', 502);
  const z = unzip(buf), files = new Map();
  for (const n of z.names) {
    if (n.endsWith('/')) continue;
    const p = safeReleasePath(n);
    if (!manifest.files[p]) throw err('The update holds a file that is not in its signed list: ' + p, 502);
    const data = z.read(n); if (sha256(data) !== manifest.files[p]) throw err('A file in the update does not match its signed hash: ' + p, 502);
    files.set(p, data);
  }
  for (const p of Object.keys(manifest.files)) if (!files.has(p)) throw err('The update is missing a file: ' + p, 502);
  return files;
}

// Keeps the checked files until they are installed.
const U = dataDir => path.join(dataDir, 'update');
const readJson = async (f, fallback = null) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fallback; } };
const writeJson = async (f, v) => { await fs.mkdir(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; await fs.writeFile(tmp, JSON.stringify(v, null, 2)); await fs.rename(tmp, f); };
export async function stageUpdate(dataDir, manifest, files) {
  const dir = path.join(U(dataDir), 'staged');
  await fs.rm(dir, { recursive: true, force: true });
  for (const [p, data] of files) { const f = path.join(dir, 'files', ...p.split('/')); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, data); }
  await writeJson(path.join(dir, 'manifest.json'), manifest);
  return manifest.version;
}
export async function stagedVersion(dataDir) { return (await readJson(path.join(U(dataDir), 'staged', 'manifest.json')))?.version || null; }

async function currentFiles(root, dataDir) {
  const inst = await readJson(path.join(U(dataDir), 'installed.json'));
  if (inst?.files) return { ...inst, listed: true };
  const files = {}; for (const n of await listReleaseFiles(root)) files[n] = sha256(await fs.readFile(path.join(root, n)));
  // Without a list from an earlier update, files that are not in the new release are left alone.
  return { version: (await readJson(path.join(root, 'package.json')))?.version || '0.0.0', files, listed: false };
}
// Puts the staged files in place. The files it replaces or removes are kept for a roll back.
export async function applyUpdate({ root, dataDir, publicKeyPem }) {
  const dir = path.join(U(dataDir), 'staged'), manifest = verifyManifest(await readJson(path.join(dir, 'manifest.json')), publicKeyPem);
  // The staged files are checked again: they sat on disk since the download.
  for (const [p, h] of Object.entries(manifest.files)) { let b; try { b = await fs.readFile(path.join(dir, 'files', ...p.split('/'))); } catch { throw err('A staged file is missing. Check for the update again.', 409); } if (sha256(b) !== h) throw err('A staged file changed on disk. Check for the update again.', 409); }
  const cur = await currentFiles(root, dataDir), backup = path.join(U(dataDir), 'backup');
  await fs.rm(backup, { recursive: true, force: true });
  const keep = [], added = [];
  const gone = cur.listed ? Object.keys(cur.files).filter(p => !manifest.files[p]) : [];
  const touched = new Set([...Object.keys(manifest.files), ...gone]);
  for (const p of touched) {
    safeReleasePath(p);
    const f = path.join(root, ...p.split('/'));
    if (fss.existsSync(f)) { const b = path.join(backup, 'files', ...p.split('/')); await fs.mkdir(path.dirname(b), { recursive: true }); await fs.copyFile(f, b); keep.push(p); }
    else if (manifest.files[p]) added.push(p);
  }
  await writeJson(path.join(backup, 'backup.json'), { version: cur.version, files: cur.files, kept: keep, added, at: Date.now() });
  try {
    for (const p of Object.keys(manifest.files)) { const f = path.join(root, ...p.split('/')), tmp = f + '.silo-new'; await fs.mkdir(path.dirname(f), { recursive: true }); await fs.copyFile(path.join(dir, 'files', ...p.split('/')), tmp); await fs.rename(tmp, f); }
    for (const p of gone) await fs.rm(path.join(root, ...p.split('/')), { force: true });
  } catch (e) { await restore(root, dataDir); throw err('The update could not be written, so the old version was put back: ' + e.message, 500); }
  await writeJson(path.join(U(dataDir), 'installed.json'), { version: manifest.version, files: manifest.files });
  await writeJson(path.join(U(dataDir), 'pending.json'), { from: cur.version, to: manifest.version, at: Date.now(), crashes: 0 });
  await writeJson(path.join(U(dataDir), 'last.json'), { kind: 'updated', from: cur.version, to: manifest.version, at: Date.now() });
  await fs.rm(dir, { recursive: true, force: true });
  return { from: cur.version, to: manifest.version };
}
async function restore(root, dataDir) {
  const backup = path.join(U(dataDir), 'backup'), info = await readJson(path.join(backup, 'backup.json'));
  if (!info) throw err('There is no earlier version to go back to.', 409);
  for (const p of info.kept) { safeReleasePath(p); const f = path.join(root, ...p.split('/')); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.copyFile(path.join(backup, 'files', ...p.split('/')), f); }
  for (const p of info.added) { safeReleasePath(p); await fs.rm(path.join(root, ...p.split('/')), { force: true }); }
  return info;
}
// Goes back to the version before the last update.
export async function rollback({ root, dataDir, reason = 'by hand' }) {
  const cur = await currentFiles(root, dataDir), info = await restore(root, dataDir);
  await writeJson(path.join(U(dataDir), 'installed.json'), { version: info.version, files: info.files });
  await fs.rm(path.join(U(dataDir), 'pending.json'), { force: true });
  await fs.rm(path.join(U(dataDir), 'backup'), { recursive: true, force: true });
  await writeJson(path.join(U(dataDir), 'last.json'), { kind: 'rolled back', from: cur.version, to: info.version, reason, at: Date.now() });
  return { from: cur.version, to: info.version };
}
export async function updateInfo(dataDir) {
  const u = U(dataDir);
  return { staged: await stagedVersion(dataDir), backup: (await readJson(path.join(u, 'backup', 'backup.json')))?.version || null, pending: await readJson(path.join(u, 'pending.json')), last: await readJson(path.join(u, 'last.json')) };
}
// The supervisor calls these around a start after an update.
export async function confirmUpdate(dataDir) { await fs.rm(path.join(U(dataDir), 'pending.json'), { force: true }); }
export async function countCrash(dataDir) {
  const f = path.join(U(dataDir), 'pending.json'), p = await readJson(f); if (!p) return null;
  p.crashes = (p.crashes || 0) + 1; await writeJson(f, p); return p;
}
export async function markAnnounced(dataDir) { const f = path.join(U(dataDir), 'last.json'), l = await readJson(f); if (l && !l.announced) { l.announced = true; await writeJson(f, l); return l; } return null; }
