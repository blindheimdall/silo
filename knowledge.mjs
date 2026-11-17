// Knowledge: folders and pages elsewhere that SILO keeps a copy of in the workspace, so residents can search them and
// say where an answer comes from. Each source writes its documents as Markdown files into knowledge/<folder>/, each
// with where it came from at the top. A sync reads again only what changed since the last one, keeps the file names it
// gave before (so citations stay right), and removes the copies of what was removed at the source.
import { createHash } from 'node:crypto';

export const KNOWLEDGE_DIR = 'knowledge';
export const SOURCE_KINDS = {
  gdrive: { name: 'Google Drive folder', service: 'google', ref: 'The link of the folder, or its id' },
  onedrive: { name: 'OneDrive folder', service: 'microsoft', ref: 'The path of the folder, like /Documents/Policies' },
  notion: { name: 'Notion pages', service: 'notion', ref: 'The link of a page (with the pages under it) or a database' },
  web: { name: 'Web pages', service: '', ref: 'Addresses, one a line, or the address of a sitemap.xml' },
};
export const EVERY = [0, 60, 360, 1440];
// MAX_DEPTH: pages under pages. BLOCK_DEPTH: blocks inside blocks on one Notion page.
export const MAX_DOCS = 1000, MAX_DEPTH = 4, MAX_WEB = 200, DOC_MAX = 15e6, BLOCK_DEPTH = 4;
const TEXT = /\.(txt|md|markdown|csv|json|html?|xml|ya?ml)$/i, OFFICE = /\.(pdf|docx|xlsx|xlsm|pptx|odt|ods|odp)$/i;
const fault = (message, status = 400) => Object.assign(new Error(message), { status });
const one = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const slugOf = t => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 48).replace(/-+$/, '');
// A file name from a title: readable, safe on every system, and never the same as another one of the source.
// Windows keeps some names for devices, so a document called Con or Aux gets a mark in front. used holds whole paths
// under the source (lower case), so dir is the folder the name goes in, like "policies/" or "".
export function fileNameFor(title, used, max = 80, dir = '') {
  let base = String(title || 'untitled').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').slice(0, max).replace(/^[.\s]+|[.\s]+$/g, '') || 'untitled';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) base = '_' + base;
  const key = n => (dir + n).toLowerCase();
  let name = base + '.md', n = 2;
  while (used.has(key(name))) name = `${base} ${n++}.md`;
  used.add(key(name));
  return name;
}

export function cleanSource(b, was = null) {
  const kind = was?.kind || String(b.kind || '');
  if (!Object.hasOwn(SOURCE_KINDS, kind)) throw fault('Choose a Google Drive folder, a OneDrive folder, Notion pages or web pages.');
  const name = one(b.name ?? was?.name, 60);
  if (!name) throw fault('Give the source a name.');
  const every = b.every === undefined ? was?.every ?? 360 : Number(b.every);
  if (!EVERY.includes(every)) throw fault('Sync every hour, every 6 hours, every day, or only when you ask.');
  const raw = String(b.ref ?? was?.ref ?? '').trim();
  let ref;
  if (kind === 'gdrive') {
    ref = raw.match(/\/folders\/([\w-]{10,})/)?.[1] || (/^[\w-]{10,}$/.test(raw) ? raw : '');
    if (!ref) throw fault('Give the link of the Drive folder, like https://drive.google.com/drive/folders/1AbC..., or its id.');
  } else if (kind === 'onedrive') {
    ref = ('/' + raw.replace(/\\/g, '/')).replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    if (ref.length > 400 || ref.split('/').some(p => p === '.' || p === '..')) throw fault('Give the path of the OneDrive folder, like /Documents/Policies.');
  } else if (kind === 'notion') {
    ref = raw.replace(/-/g, '').match(/([0-9a-f]{32})(?:[?#]|$)/i)?.[1]?.toLowerCase() || '';
    if (!ref) throw fault('Give the link of the Notion page or database, or its id.');
  } else {
    const urls = [...new Set(raw.split(/\s+/).filter(Boolean))];
    if (!urls.length) throw fault('Give one address or more, one a line, or the address of a sitemap.xml.');
    if (urls.length > MAX_WEB) throw fault(`Give at most ${MAX_WEB} addresses, or a sitemap.`);
    for (const u of urls) { let x; try { x = new URL(u); } catch { throw fault(`"${one(u, 80)}" is not a web address.`); } if (!/^https?:$/.test(x.protocol) || x.username || x.password) throw fault(`"${one(u, 80)}" is not an http or https address.`); }
    ref = urls.join('\n');
  }
  return { name, kind, ref, every };
}

// The top of every copy: where it came from, so a citation can lead back to it.
export function withHeader(doc, text) {
  const meta = [['title', doc.title], ['source', doc.url], ['modified', doc.modified]].filter(([, v]) => v).map(([k, v]) => `${k}: ${one(v, 500)}`);
  return `---\n${meta.join('\n')}\n---\n\n${String(text).replace(/\r\n/g, '\n').trim()}\n`;
}
export function readHeader(text) {
  const m = /^---\n([\s\S]{0,2000}?)\n---\n/.exec(String(text).replace(/\r\n/g, '\n'));
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { title: out.title || '', source: /^https?:\/\//.test(out.source || '') ? out.source : '', modified: out.modified || '' };
}

// The plain text of Notion blocks, with headings, lists, to-dos, quotes and code kept.
export function notionText(blocks) {
  const rich = v => (v?.rich_text || v?.text || []).map(r => r.plain_text || '').join('');
  return blocks.map(({ block: x, depth }) => {
    const v = x[x.type] || {}, t = rich(v), pad = '  '.repeat(depth);
    if (x.type.startsWith('heading_')) return '\n' + '#'.repeat(Number(x.type.slice(-1)) + 1) + ' ' + t;
    if (x.type === 'bulleted_list_item' || x.type === 'toggle') return pad + '- ' + t;
    if (x.type === 'numbered_list_item') return pad + '1. ' + t;
    if (x.type === 'to_do') return `${pad}- [${v.checked ? 'x' : ' '}] ${t}`;
    if (x.type === 'quote' || x.type === 'callout') return '> ' + t;
    if (x.type === 'code') return '```' + (v.language || '') + '\n' + t + '\n```';
    if (x.type === 'divider') return '---';
    if (x.type === 'table_row') return '| ' + (v.cells || []).map(c => c.map(r => r.plain_text || '').join('')).join(' | ') + ' |';
    if (x.type === 'child_page' || x.type === 'child_database') return '';
    return t ? pad + t : '';
  }).filter((l, i, a) => l !== '' || (i && a[i - 1] !== '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function sitemapUrls(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<url>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>(?:[\s\S]*?<lastmod>\s*([^<\s]+)\s*<\/lastmod>)?[\s\S]*?<\/url>/gi)) out.push({ url: m[1].replace(/&amp;/g, '&'), modified: m[2] || '' });
  if (!out.length) for (const m of String(xml).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) out.push({ url: m[1].replace(/&amp;/g, '&'), modified: '' });
  return out;
}

// The documents of a source, each { id, title, path (folders under the source), url, modified, read() }. deps:
// request(svc, url, { raw, method, body }) with the account's sign-in, base(key), extract(buf, name, mime), readPage.
export async function listDocs(src, deps) {
  const docs = [], add = d => { if (docs.length >= MAX_DOCS) return false; docs.push(d); return true; };
  if (src.kind === 'gdrive') {
    const D = deps.base('gdrive'), q = s => encodeURIComponent(s);
    const walk = async (folder, path, depth) => {
      let page = '';
      do {
        const d = await deps.request('google', `${D}/files?pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=${q('nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,size)')}&q=${q(`'${folder}' in parents and trashed = false`)}${page ? '&pageToken=' + q(page) : ''}`);
        for (const f of d.files || []) {
          if (f.mimeType === 'application/vnd.google-apps.folder') { if (depth < MAX_DEPTH) await walk(f.id, [...path, f.name], depth + 1); continue; }
          const exportAs = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }[f.mimeType];
          if (!exportAs && (f.mimeType?.startsWith('application/vnd.google-apps.') || !(TEXT.test(f.name) || OFFICE.test(f.name)) || Number(f.size) > DOC_MAX)) continue;
          if (!add({ id: f.id, title: f.name.replace(/\.[a-z0-9]{2,5}$/i, ''), path, url: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, modified: f.modifiedTime || '',
            read: async () => { const { buf, type } = await deps.request('google', exportAs ? `${D}/files/${q(f.id)}/export?mimeType=${q(exportAs)}` : `${D}/files/${q(f.id)}?alt=media`, { raw: true }); return deps.extract(buf, f.name, exportAs || type || f.mimeType); } })) return;
        }
        page = d.nextPageToken || '';
      } while (page && docs.length < MAX_DOCS);
    };
    await walk(src.ref, [], 0);
  } else if (src.kind === 'onedrive') {
    const G = deps.base('graph'), sel = '$top=200&$select=id,name,file,folder,lastModifiedDateTime,webUrl,size';
    const walk = async (first, path, depth) => {
      let next = first;
      while (next && docs.length < MAX_DOCS) {
        const d = await deps.request('microsoft', next);
        for (const f of d.value || []) {
          if (f.folder) { if (depth < MAX_DEPTH) await walk(`${G}/me/drive/items/${encodeURIComponent(f.id)}/children?${sel}`, [...path, f.name], depth + 1); continue; }
          if (!f.file || !(TEXT.test(f.name) || OFFICE.test(f.name)) || f.size > DOC_MAX) continue;
          if (!add({ id: f.id, title: f.name.replace(/\.[a-z0-9]{2,5}$/i, ''), path, url: f.webUrl || '', modified: f.lastModifiedDateTime || '',
            read: async () => { const { buf, type } = await deps.request('microsoft', `${G}/me/drive/items/${encodeURIComponent(f.id)}/content`, { raw: true }); return deps.extract(buf, f.name, f.file?.mimeType || type); } })) return;
        }
        next = d['@odata.nextLink'] || '';
      }
    };
    const at = src.ref === '/' ? `${G}/me/drive/root/children?${sel}` : `${G}/me/drive/root:${src.ref.split('/').map(encodeURIComponent).join('/')}:/children?${sel}`;
    await walk(at, [], 0);
  } else if (src.kind === 'notion') {
    const N = deps.base('notion'), seen = new Set();
    const titleOf = p => { for (const v of Object.values(p.properties || {})) if (v.type === 'title') return v.title.map(t => t.plain_text).join(''); return (p.title || []).map?.(t => t.plain_text).join('') || 'Untitled'; };
    const blocksOf = async (id, depth = 0, out = [], children = []) => {
      let cursor = '';
      do {
        const d = await deps.request('notion', `${N}/blocks/${id}/children?page_size=100${cursor ? '&start_cursor=' + encodeURIComponent(cursor) : ''}`);
        for (const x of d.results || []) {
          if (x.type === 'child_page') { children.push(x.id); continue; }
          out.push({ block: x, depth });
          // Five levels: a list inside a toggle inside a callout still comes in. Deeper is rare and costs a request a block.
          if (x.has_children && depth < BLOCK_DEPTH && x.type !== 'child_database') await blocksOf(x.id, depth + 1, out, children);
        }
        cursor = d.has_more ? d.next_cursor : '';
      } while (cursor && out.length < 5000);
      return { out, children };
    };
    // A page goes in with the pages under it. Notion only says which pages are under a page in its blocks, so every
    // page's blocks are read once while listing, and kept for its copy.
    const page = async (p, path, depth) => {
      if (seen.has(p.id) || docs.length >= MAX_DOCS) return;
      seen.add(p.id);
      const title = titleOf(p), r = await blocksOf(p.id);
      add({ id: p.id, title, path, url: p.url || '', modified: p.last_edited_time || '', read: async () => notionText(r.out) });
      if (depth < MAX_DEPTH) for (const id of r.children) { try { await page(await deps.request('notion', `${N}/pages/${id}`), [...path, title], depth + 1); } catch {} }
    };
    let root = null;
    try { root = await deps.request('notion', `${N}/pages/${src.ref}`); } catch (e) { if (!/400|404/.test(e.message)) throw e; }
    if (root) await page(root, [], 0);
    else {
      let cursor = '';
      do {
        const d = await deps.request('notion', `${N}/databases/${src.ref}/query`, { method: 'POST', body: { page_size: 100, ...(cursor && { start_cursor: cursor }) } });
        for (const p of d.results || []) await page(p, [], MAX_DEPTH);
        cursor = d.has_more ? d.next_cursor : '';
      } while (cursor && docs.length < MAX_DOCS);
    }
  } else {
    let list = src.ref.split('\n').map(url => ({ url, modified: '' }));
    // A sitemap is written by the site: an entry that is not an http or https address is left out, not a failed sync.
    const web = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !x.username && !x.password; } catch { return false; } };
    if (list.length === 1 && /\.xml(\?|$)/i.test(list[0].url)) list = sitemapUrls((await deps.readPage(list[0].url, { raw: true, maxChars: 2_000_000 })).text).filter(x => web(x.url)).slice(0, MAX_WEB);
    for (const { url, modified } of list) {
      // A web page has no reliable date, so what it says decides: read() is cheap to compare by its hash.
      let got = null;
      const fetchPage = async () => got ||= await deps.readPage(url, { maxChars: 400000 });
      const u = new URL(url);
      add({ id: url, title: '', path: [u.hostname], url, modified, web: true, fetchPage, read: async () => (await fetchPage()).text });
    }
  }
  return docs;
}

// Brings the copies of one source up to date. manifest: { [doc id]: { file, modified, hash } } from the last sync.
// deps also has write(path, text), remove(path), exists(path). Returns the new manifest and what changed.
export async function syncSource(src, manifest, deps) {
  const docs = await listDocs(src, deps), next = {}, used = new Set(), out = { added: 0, changed: 0, removed: 0, kept: 0, failed: 0, errors: [], docs: docs.length };
  const root = `${KNOWLEDGE_DIR}/${src.folder}`;
  // The names given before stay; a new document never takes one.
  for (const d of docs) if (manifest[d.id]) used.add(manifest[d.id].file.toLowerCase());
  for (const d of docs) {
    const was = manifest[d.id];
    try {
      if (was && !d.web && d.modified && was.modified === d.modified && await deps.exists(`${root}/${was.file}`)) { next[d.id] = was; out.kept++; continue; }
      let text = await d.read();
      const title = d.title || (d.web ? (await d.fetchPage()).title : '') || d.url;
      text = String(text ?? '').trim();
      if (!text) { out.failed++; if (was) next[d.id] = was; continue; }
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 32);
      // The folders under the source stay, as long as the whole path fits the 180 characters a workspace path may have.
      const sub = d.path.map(p => fileNameFor(p, new Set(), 40).slice(0, -3)).join('/'), room = 175 - root.length - 1;
      const file = was?.file || (sub && sub.length + 50 <= room ? sub + '/' + fileNameFor(title, used, Math.min(80, room - sub.length - 5), sub + '/') : fileNameFor(title, used, Math.min(80, room - 4)));
      if (was && was.hash === hash && await deps.exists(`${root}/${was.file}`)) { next[d.id] = { ...was, modified: d.modified || was.modified }; out.kept++; continue; }
      await deps.write(`${root}/${file}`, withHeader({ title, url: d.url, modified: d.modified }, text));
      next[d.id] = { file, modified: d.modified, hash };
      was ? out.changed++ : out.added++;
    } catch (e) {
      out.failed++; if (out.errors.length < 3) out.errors.push(`${one(d.title || d.url || d.id, 60)}: ${one(e.message, 160)}`);
      if (was) next[d.id] = was;
    }
  }
  for (const [id, was] of Object.entries(manifest)) if (!next[id]) { await deps.remove(`${root}/${was.file}`).catch(() => {}); out.removed++; }
  return { manifest: next, ...out };
}
