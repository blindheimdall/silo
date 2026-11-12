// Capabilities that cross machines. Every silo has an Ed25519 key pair. A silo gives another silo rights over its own
// residents and files as a signed link: who gives, to whom, what, until when and how much. The holder may pass on less,
// never more, by signing a new link onto the chain. The silo that owns the data checks the whole chain itself: its own
// signature at the root, each link narrower than the one before, the last link made out to the key that signs the
// request. No central server, no shared secret. (The idea of UCAN and macaroons, in a compact format of its own.)
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash, randomBytes } from 'node:crypto';

export const CAP_PREFIX = 'silocap1.';
export const MAX_CHAIN = 5;
// Tools a capability may carry: reading and proposing files, and the web. Nothing that reaches other silos, accounts
// or this computer.
export const CAP_TOOLS = ['read_files', 'write_files', 'web'];
// File operations, as the tools name them.
export const CAP_OPS = { read: ['read_file'], write: ['write_file', 'patch_file'] };
const KEY_SHAPE = /^ed25519:[A-Za-z0-9_-]{43}$/;
const b64 = buf => Buffer.from(buf).toString('base64url');
const fail = (message, status = 403) => { throw Object.assign(new Error(message), { status }); };

// --- Keys ---
export function newIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: 'ed25519:' + publicKey.export({ format: 'jwk' }).x, privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}
export const isPublicKey = k => typeof k === 'string' && KEY_SHAPE.test(k);
export function checkPublicKey(raw) {
  const k = String(raw || '').trim();
  if (!isPublicKey(k)) fail('A silo key looks like ed25519: followed by 43 letters, digits, - or _.', 400);
  try { pubKey(k); } catch { fail('That is not a valid Ed25519 key.', 400); }
  return k;
}
// The fingerprint two owners read to each other: 16 hex digits in groups of four.
export const fingerprint = k => createHash('sha256').update(String(k)).digest('hex').slice(0, 16).match(/.{4}/g).join('-');
const pubKey = k => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.slice(8) }, format: 'jwk' });
const privCache = new Map();
const privKey = p => { let k = privCache.get(p); if (!k) { k = createPrivateKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'pkcs8' }); privCache.set(p, k); } return k; };
export const signText = (privateKey, text) => b64(sign(null, Buffer.from(text, 'utf8'), privKey(privateKey)));
export function verifyText(publicKey, text, sig) {
  if (!isPublicKey(publicKey) || typeof sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return false;
  try { return verify(null, Buffer.from(text, 'utf8'), pubKey(publicKey), Buffer.from(sig, 'base64url')); } catch { return false; }
}

// --- Rights ---
const list = (v, max, len) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim()).filter(Boolean))].slice(0, max).map(s => s.slice(0, len));
const cleanFolder = f => { const p = String(f).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); if (p.split('/').some(s => s === '..' || s === '.')) fail('A folder cannot use . or ..', 400); return p; };
// What a capability allows. Empty residents mean none; "*" means all. Folders: empty means none, "*" means the whole
// workspace.
export function cleanRights(r = {}) {
  const residents = list(r.residents, 50, 60), tools = list(r.tools, 10, 30), ops = list(r.ops, 2, 10), folders = list(r.folders, 20, 200).map(f => f === '*' ? '*' : cleanFolder(f)).filter(Boolean);
  if (!residents.length) fail('Name at least one resident, or * for all.', 400);
  for (const t of tools) if (!CAP_TOOLS.includes(t)) fail(`A capability can carry ${CAP_TOOLS.join(', ')} only.`, 400);
  for (const o of ops) if (!CAP_OPS[o]) fail('File operations are read and write.', 400);
  if ((tools.includes('read_files') || tools.includes('write_files')) && !folders.length) fail('Name the folders the files may come from, for example reports.', 400);
  if (tools.includes('write_files') && !ops.includes('write')) ops.push('write');
  if (tools.includes('read_files') && !ops.includes('read')) ops.push('read');
  return { residents, tools, ops, folders };
}
const inFolder = (f, parents) => parents.includes('*') || parents.some(p => f === p || f.startsWith(p + '/'));
// Whether child asks for no more than parent.
export function narrower(child, parent) {
  const sub = (c, p) => p.includes('*') || (!c.includes('*') && c.every(x => p.some(y => y.toLowerCase() === x.toLowerCase())));
  if (!sub(child.residents, parent.residents)) return 'residents';
  if (!child.tools.every(t => parent.tools.includes(t))) return 'tools';
  if (!child.ops.every(o => parent.ops.includes(o))) return 'file operations';
  if (child.folders.some(f => f === '*' ? !parent.folders.includes('*') : !inFolder(f, parent.folders))) return 'folders';
  return null;
}
const cleanBudget = b => {
  const n = (v, max) => { const x = Math.floor(Number(v)); if (!Number.isFinite(x) || x < 1 || x > max) fail(`A budget is a whole number from 1 to ${max.toLocaleString('en')}.`, 400); return x; };
  return { tokens: n(b?.tokens, 100_000_000), messages: n(b?.messages, 1_000_000) };
};

// --- Links and chains ---
const encode = payload => b64(Buffer.from(JSON.stringify(payload), 'utf8'));
export const linkHash = encoded => createHash('sha256').update(encoded).digest('hex');
// Signs one link. parent: the decoded chain it extends (from verifyChain or readChain), or none for a root link.
export function issue({ privateKey, iss, aud, rights, budget, hours, site, siloName, parent, now = Date.now() }) {
  if (!isPublicKey(iss)) fail('No silo key.', 500);
  aud = checkPublicKey(aud);
  if (aud === iss) fail('A silo cannot give rights to itself.', 400);
  const att = cleanRights(rights), bud = cleanBudget(budget);
  const h = Number(hours); if (!(h > 0 && h <= 24 * 365)) fail('Give it from a few minutes to a year, in hours.', 400);
  let exp = now + Math.round(h * 3_600_000), nbf = now, prf = null;
  if (parent) {
    const last = parent.links.at(-1);
    if (last.aud !== iss) fail('This capability was not given to this silo, so it cannot pass it on.', 400);
    if (parent.links.length >= MAX_CHAIN) fail(`A capability can be passed on at most ${MAX_CHAIN - 1} times.`, 400);
    const wider = narrower(att, parent.rights); if (wider) fail(`You can pass on less, never more: the ${wider} go beyond what you hold.`, 400);
    if (bud.tokens > parent.budget.tokens || bud.messages > parent.budget.messages) fail(`The budget can be at most what you hold: ${parent.budget.tokens} tokens and ${parent.budget.messages} messages.`, 400);
    exp = Math.min(exp, parent.exp); nbf = Math.max(nbf, parent.nbf); prf = parent.hashes.at(-1);
    if (exp <= now) fail('The capability you hold has expired.', 400);
  }
  const payload = { v: 1, iss, aud, att, budget: bud, nbf, exp, nonce: randomBytes(9).toString('base64url'), prf, ...(siloName && { by: String(siloName).slice(0, 40) }), ...(site && !parent && { site: String(site).slice(0, 300) }) };
  const body = encode(payload), link = body + '.' + signText(privateKey, 'silocap\n' + body);
  const links = [...(parent?.encoded || []), link];
  return { token: CAP_PREFIX + links.join('~'), hash: linkHash(link), payload };
}
// Reads a chain without checking it against a root: for showing and passing on what this silo holds.
export function readChain(token) {
  const t = String(token || '').trim();
  if (!t.startsWith(CAP_PREFIX) || t.length > 20000) fail('That is not a SILO capability.', 400);
  const encoded = t.slice(CAP_PREFIX.length).split('~');
  if (!encoded.length || encoded.length > MAX_CHAIN) fail(`A capability has 1 to ${MAX_CHAIN} links.`, 400);
  const links = encoded.map(e => {
    const [body, sig] = e.split('.');
    let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { fail('A link of the capability cannot be read.', 400); }
    if (!p || p.v !== 1 || !isPublicKey(p.iss) || !isPublicKey(p.aud) || !Number.isFinite(p.exp) || !Number.isFinite(p.nbf)) fail('A link of the capability is malformed.', 400);
    if (!verifyText(p.iss, 'silocap\n' + body, sig)) fail('A link of the capability is not signed by the silo it names.', 403);
    return p;
  });
  const hashes = encoded.map(linkHash);
  for (let i = 1; i < links.length; i++) {
    const p = links[i], up = links[i - 1];
    if (p.iss !== up.aud) fail(`Link ${i + 1} is signed by a silo the capability was not given to.`);
    if (p.prf !== hashes[i - 1]) fail(`Link ${i + 1} does not extend the link before it.`);
    let r; try { r = cleanRights(p.att); } catch { fail(`Link ${i + 1} has rights that cannot be read.`); }
    const wider = narrower(r, cleanRights(up.att)); if (wider) fail(`Link ${i + 1} gives more ${wider} than it was given.`);
    if (p.budget?.tokens > up.budget.tokens || p.budget?.messages > up.budget.messages) fail(`Link ${i + 1} gives a bigger budget than it was given.`);
    if (p.exp > up.exp || p.nbf < up.nbf) fail(`Link ${i + 1} lasts longer than the link before it.`);
  }
  const last = links.at(-1);
  return { links, encoded, hashes, root: links[0].iss, holder: last.aud, rights: cleanRights(last.att), budget: cleanBudget(last.budget), exp: last.exp, nbf: last.nbf, site: links[0].site || '', rootName: links[0].by || '' };
}
// The full check by the silo that owns the data: rooted at its own key, made out to the key that signed the request,
// in its time window, no link revoked. Budgets are checked by the caller, which keeps the usage per link.
export function verifyChain(token, { root, presenter, revoked = new Set(), now = Date.now() }) {
  const c = readChain(token);
  if (c.root !== root) fail('This capability was not given by this silo.');
  if (c.holder !== presenter) fail('This capability belongs to another silo.');
  if (now < c.nbf - 60_000) fail('This capability is not valid yet.');
  if (now > c.exp) fail('This capability has expired.');
  const gone = c.hashes.find(h => revoked.has(h)); if (gone) fail('This capability was revoked.');
  return c;
}
// What a holder may do with a capability, as the attenuation the resident runs under: only these tools and file
// operations, only inside these folders, never widened by grants.
export function attenuation(rights) {
  return { strict: true, tools: rights.tools, operations: rights.ops.flatMap(o => CAP_OPS[o]), connectors: [], folderChain: rights.folders.includes('*') ? [] : [rights.folders] };
}
// One link on its own, its signature checked: for revocations, which name a single link.
export function readLink(encoded) {
  const [body, sig] = String(encoded || '').split('.');
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { fail('The link cannot be read.', 400); }
  if (!p || p.v !== 1 || !isPublicKey(p.iss) || !verifyText(p.iss, 'silocap\n' + body, sig)) fail('The link is not signed by the silo it names.');
  return { payload: p, hash: linkHash(encoded) };
}
// A revocation: the silo that signed a link says it no longer stands. Sent to the root silo, which keeps the hash.
export const revocationText = (hash, time) => `silocap-revoke\n${hash}\n${time}`;
