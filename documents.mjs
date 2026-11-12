// Documents without extra packages: reads PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), OpenDocument text
// and plain text; writes Word, Excel and PDF. The PDF writer embeds a system font (Arial or DejaVu Sans) so letters
// like ă, ș and ț come out right; without one it falls back to Helvetica and plain Latin letters.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

export const READABLE = /\.(pdf|docx|xlsx|xlsm|pptx|odt|ods|odp)$/i;
const MAX_TEXT = 200000;

// ---------- ZIP ----------
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This is not a valid Office file (no zip directory).');
  const count = buf.readUInt16LE(eocd + 10), files = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    files.set(name, () => {
      if (usize > 60e6) throw new Error('A part of this file is too large.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), data = buf.subarray(start, start + csize);
      return method === 0 ? Buffer.from(data) : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 60e6 }) : (() => { throw new Error('Unsupported zip compression.'); })();
    });
    p += 46 + nlen + xlen + clen;
  }
  return { names: [...files.keys()], read: name => files.get(name)?.() ?? null, text: name => files.get(name)?.().toString('utf8') ?? null };
}
export function zip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), data = zlib.deflateRawSync(raw), nameBuf = Buffer.from(name, 'utf8'), crc = zlib.crc32(raw);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nameBuf.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, nameBuf, data); centrals.push(c, nameBuf); offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- XML helpers ----------
const unxml = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const xml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? unxml(m[1]) : ''; };

function docxText(z) {
  const doc = z.text('word/document.xml'); if (!doc) throw new Error('This Word file has no document part.');
  const para = p => unxml((p.match(/<w:t[^>]*>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g) || []).map(x => x === '<w:tab/>' ? '\t' : x.startsWith('<w:br') || x.startsWith('<w:cr') ? '\n' : x.replace(/<[^>]+>/g, '')).join(''));
  const table = t => (t.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []).map(r => '| ' + (r.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(c => (c.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map(para).join(' ').trim()).join(' | ') + ' |').join('\n');
  const paragraph = p => { const style = attr(p.match(/<w:pStyle [^>]*>/)?.[0] || '', 'w:val'); const t = para(p); const lvl = style.match(/^Heading(\d)/i)?.[1]; return lvl ? '#'.repeat(+lvl) + ' ' + t : /^Title$/i.test(style) ? '# ' + t : t; };
  return [...doc.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g)].map(m => m[0].startsWith('<w:tbl') ? table(m[0]) : paragraph(m[0])).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const colIndex = ref => { let n = 0; for (const ch of String(ref).replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
function xlsxText(z, { maxRows = 2000 } = {}) {
  const shared = (z.text('xl/sharedStrings.xml') || '').match(/<si>[\s\S]*?<\/si>/g)?.map(si => unxml((si.match(/<t[^>]*>[^<]*<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''))) || [];
  const wb = z.text('xl/workbook.xml') || '', rels = z.text('xl/_rels/workbook.xml.rels') || '';
  const target = id => { const r = (rels.match(/<Relationship [^>]*>/g) || []).find(x => attr(x, 'Id') === id); const t = r ? attr(r, 'Target') : ''; return t.startsWith('/') ? t.slice(1) : 'xl/' + t; };
  const sheets = (wb.match(/<sheet [^>]*>/g) || []).map(s => ({ name: attr(s, 'name'), file: target(attr(s, 'r:id')) }));
  const out = [];
  for (const sh of sheets) {
    const x = z.text(sh.file); if (!x) continue;
    const rows = []; let n = 0;
    for (const row of x.match(/<row[ >][\s\S]*?<\/row>/g) || []) {
      if (++n > maxRows) { rows.push(`[${(x.match(/<row[ >]/g) || []).length - maxRows} more rows]`); break; }
      const cells = [];
      for (const c of row.match(/<c [^>]*\/>|<c [^>]*>[\s\S]*?<\/c>/g) || []) {
        const open = c.match(/<c [^>]*>/)[0], t = attr(open, 't'), v = c.match(/<v>([^<]*)<\/v>/)?.[1], f = c.match(/<f[^>]*>([^<]*)<\/f>/)?.[1];
        let val = t === 's' ? shared[+v] ?? '' : t === 'inlineStr' ? unxml((c.match(/<t[^>]*>[^<]*<\/t>/g) || []).map(q => q.replace(/<[^>]+>/g, '')).join('')) : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : unxml(v ?? '');
        if (f && !val) val = '=' + unxml(f);
        cells[colIndex(attr(open, 'r'))] = val;
      }
      rows.push(Array.from(cells, v => /[",\n]/.test(v ?? '') ? `"${String(v).replace(/"/g, '""')}"` : v ?? '').join(','));
    }
    out.push(`## Sheet: ${sh.name}\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}
function pptxText(z) {
  const slides = z.names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/\d+/g).pop() - +b.match(/\d+/g).pop());
  return slides.map((s, i) => `## Slide ${i + 1}\n` + (z.text(s).match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map(p => unxml((p.match(/<a:t>[^<]*<\/a:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''))).filter(Boolean).join('\n')).join('\n\n');
}
function odfText(z) {
  const c = z.text('content.xml') || '';
  return unxml(c.replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n').replace(/<\/text:(p|h)>/g, '\n').replace(/<table:table-cell[^>]*>/g, ' | ').replace(/<\/table:table-row>/g, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- PDF reading ----------
function pdfObjects(buf) {
  const s = buf.toString('latin1'), objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length, end = s.indexOf('endobj', start); if (end < 0) break;
    let body = s.slice(start, end), stream = null;
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)[0].length;
      const dict = body.slice(0, si), len = +(dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)?.[1] ?? -1);
      let dataEnd = len >= 0 && s.slice(dataStart + len, dataStart + len + 20).includes('endstream') ? dataStart + len : s.indexOf('endstream', dataStart);
      stream = buf.subarray(dataStart, dataEnd); body = dict;
    }
    objs.set(+m[1], { dict: body, stream });
    re.lastIndex = end;
  }
  // Objects packed in object streams (PDF 1.5 and later).
  for (const o of [...objs.values()]) if (/\/Type\s*\/ObjStm/.test(o.dict)) {
    try {
      const data = pdfDecode(o).toString('latin1'), first = +o.dict.match(/\/First\s+(\d+)/)[1], head = data.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < head.length; i += 2) { const from = first + head[i + 1], to = i + 3 < head.length ? first + head[i + 3] : data.length; if (!objs.has(head[i])) objs.set(head[i], { dict: data.slice(from, to), stream: null }); }
    } catch {}
  }
  return objs;
}
function pdfDecode(o) {
  let data = o.stream; const f = o.dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/)?.[1] || '';
  for (const name of f.match(/\/\w+/g) || []) {
    if (name === '/FlateDecode') { try { data = zlib.inflateSync(data, { maxOutputLength: 80e6 }); } catch { data = zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: 80e6 }); } }
    else if (name === '/ASCIIHexDecode') data = Buffer.from(data.toString('latin1').replace(/[^0-9a-f]/gi, ''), 'hex');
    else throw new Error('unsupported filter ' + name);
  }
  return data;
}
const ref = (dict, key) => { const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`)); return m ? +m[1] : null; };
function inlineDict(dict, key, objs) {
  const r = ref(dict, key); if (r !== null) return objs.get(r)?.dict || '';
  const i = dict.indexOf('/' + key); if (i < 0) return '';
  let j = dict.indexOf('<<', i), depth = 0, k = j;
  if (j < 0) return '';
  for (; k < dict.length; k++) { if (dict.startsWith('<<', k)) { depth++; k++; } else if (dict.startsWith('>>', k)) { depth--; k++; if (!depth) break; } }
  return dict.slice(j, k + 1);
}
function parseCmap(text) {
  const map = new Map(); let bytes = 1;
  const cs = text.match(/begincodespacerange\s*<([0-9a-f]+)>/i); if (cs) bytes = cs[1].length / 2;
  const uni = h => { let s = ''; for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return s; };
  for (const block of text.match(/beginbfchar[\s\S]*?endbfchar/g) || []) for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) map.set(parseInt(m[1], 16), uni(m[2]));
  for (const block of text.match(/beginbfrange[\s\S]*?endbfrange/g) || []) {
    for (const m of block.matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]+)>|\[([^\]]*)\])/gi)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (m[4] !== undefined) { const base = parseInt(m[4], 16); for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCodePoint(base + c - lo)); }
      else { const list = [...m[5].matchAll(/<([0-9a-f]+)>/gi)]; list.forEach((x, i) => map.set(lo + i, uni(x[1]))); }
    }
  }
  return { map, bytes };
}
const WIN = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x8a: 'Š', 0x8c: 'Œ', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '-', 0x97: '-', 0x99: '™', 0x9a: 'š', 0x9c: 'œ', 0x9f: 'Ÿ' };
function pdfText(buf) {
  const head = buf.subarray(0, 1024).toString('latin1'); if (!head.includes('%PDF')) throw new Error('This is not a PDF file.');
  const objs = pdfObjects(buf);
  if ([...objs.values()].some(o => /\/Filter\s*\/Standard/.test(o.dict)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(buf.toString('latin1', Math.max(0, buf.length - 4096)))) throw new Error('This PDF is password protected or encrypted.');
  const fontCache = new Map();
  const fontOf = num => {
    if (fontCache.has(num)) return fontCache.get(num);
    const d = objs.get(num)?.dict || ''; let f = { map: null, bytes: 1 };
    const tu = ref(d, 'ToUnicode'); if (tu !== null && objs.get(tu)?.stream) { try { f = parseCmap(pdfDecode(objs.get(tu)).toString('latin1')); } catch {} }
    else if (/\/Encoding\s*\/Identity-H/.test(d)) f.bytes = 2;
    fontCache.set(num, f); return f;
  };
  // Pages in order, with inherited resources.
  const pages = [];
  const walk = (num, inherited, seen = new Set()) => {
    if (seen.has(num) || seen.size > 5000) return; seen.add(num);
    const d = objs.get(num)?.dict || ''; const res = inlineDict(d, 'Resources', objs) || inherited;
    if (/\/Type\s*\/Pages\b/.test(d)) { for (const k of (d.match(/\/Kids\s*\[([^\]]*)\]/)?.[1] || '').matchAll(/(\d+)\s+\d+\s+R/g)) walk(+k[1], res, seen); }
    else if (/\/Type\s*\/Page\b/.test(d)) pages.push({ d, res });
  };
  const root = ref(buf.toString('latin1', Math.max(0, buf.length - 2048)), 'Root') ?? [...objs].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict))?.[0];
  if (root != null) { const pg = ref(objs.get(root)?.dict || '', 'Pages'); if (pg != null) walk(pg, ''); }
  if (!pages.length) for (const [, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push({ d: o.dict, res: inlineDict(o.dict, 'Resources', objs) });
  const out = [];
  for (const [i, pg] of pages.entries()) {
    const fonts = {}; const fd = inlineDict(pg.res, 'Font', objs);
    for (const m of fd.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts[m[1]] = +m[2];
    const cRef = pg.d.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/)?.[1] || '';
    let content = '';
    for (const m of cRef.matchAll(/(\d+)\s+\d+\s+R/g)) { const o = objs.get(+m[1]); if (o?.stream) { try { content += pdfDecode(o).toString('latin1') + '\n'; } catch {} } }
    // Form XObjects drawn on the page often hold the text.
    const xd = inlineDict(pg.res, 'XObject', objs);
    for (const m of xd.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) { const o = objs.get(+m[2]); if (o?.stream && /\/Subtype\s*\/Form/.test(o.dict)) { const r2 = inlineDict(o.dict, 'Resources', objs); for (const f of inlineDict(r2, 'Font', objs).matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts[f[1]] ??= +f[2]; try { content += pdfDecode(o).toString('latin1') + '\n'; } catch {} } }
    const pageText = pdfOps(content, name => fonts[name] != null ? fontOf(fonts[name]) : { map: null, bytes: 1 }).trim();
    out.push(pageText ? `## Page ${i + 1}\n${pageText}` : '');
    if (out.join('').length > MAX_TEXT) break;
  }
  const text = out.filter(Boolean).join('\n\n');
  if (!text.trim()) return '[This PDF has no text layer. It is probably a scan; use a screenshot and a model that can see.]';
  return text;
}
function pdfOps(c, fontFor) {
  let font = { map: null, bytes: 1 }, line = '', out = [];
  // Where text is drawn decides the lines: a new line when the baseline moves, a space when there is a gap.
  let tm = [1, 0, 0, 1, 0, 0], tlm = tm, lead = 0, size = 10, lastY = null, lastEnd = -1e9;
  const moveTo = (tx, ty) => { tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx * tlm[0] + ty * tlm[2], tlm[5] + tx * tlm[1] + ty * tlm[3]]; tm = tlm; };
  const show = text => {
    if (!text) return;
    const scale = Math.hypot(tm[0], tm[1]) || 1, h = size * scale, x = tm[4], y = tm[5];
    if (lastY === null || Math.abs(y - lastY) > h * 0.5) { flush(); }
    else if (x > lastEnd + h * 0.15 && line && !line.endsWith(' ') && !text.startsWith(' ')) line += ' ';
    line += text; lastY = y; lastEnd = x + text.length * h * 0.48;
    tm = [tm[0], tm[1], tm[2], tm[3], lastEnd, tm[5]];
  };
  const decode = bytes => {
    if (font.map) { let s = ''; for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) { const code = font.bytes === 2 ? bytes[i] * 256 + bytes[i + 1] : bytes[i]; s += font.map.get(code) ?? (font.bytes === 1 ? String.fromCharCode(code) : ''); } return s; }
    if (font.bytes === 2) return '';
    return Array.from(bytes, b => WIN[b] || String.fromCharCode(b)).join('');
  };
  const lit = (s, i) => { const bytes = []; let depth = 1; for (i++; i < s.length && depth; i++) { const ch = s[i];
      if (ch === '\\') { const n = s[++i]; const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 }[n]; if (esc !== undefined) bytes.push(esc); else if (/[0-7]/.test(n)) { let o = n; while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i]; bytes.push(parseInt(o, 8) & 255); } else if (n === '\r') { if (s[i + 1] === '\n') i++; } else if (n !== '\n') bytes.push(n.charCodeAt(0)); continue; }
      if (ch === '(') depth++; else if (ch === ')') { depth--; if (!depth) break; } bytes.push(ch.charCodeAt(0) & 255); }
    return [Buffer.from(bytes), i + 1]; };
  const stack = []; let i = 0;
  const flush = () => { if (line.trim()) out.push(line.replace(/\s+$/, '')); line = ''; };
  while (i < c.length) {
    const ch = c[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < c.length && c[i] !== '\n' && c[i] !== '\r') i++; continue; }
    if (ch === '(') { const [b, j] = lit(c, i); stack.push(b); i = j; continue; }
    if (ch === '<' && c[i + 1] !== '<') { const j = c.indexOf('>', i); const h = c.slice(i + 1, j).replace(/\s/g, ''); stack.push(Buffer.from(h.length % 2 ? h + '0' : h, 'hex')); i = j + 1; continue; }
    if (ch === '[') { stack.push('['); i++; continue; }
    if (ch === ']') { const arr = []; while (stack.length && stack[stack.length - 1] !== '[') arr.unshift(stack.pop()); stack.pop(); stack.push(arr); i++; continue; }
    if (ch === '<' || ch === '>') { i += 2; continue; }
    if (ch === '/') { let j = i + 1; while (j < c.length && !/[\s/\[\]()<>{}%]/.test(c[j])) j++; stack.push({ name: c.slice(i + 1, j) }); i = j; continue; }
    let j = i; while (j < c.length && !/[\s/\[\]()<>{}%]/.test(c[j])) j++;
    const tok = c.slice(i, j || i + 1); i = j > i ? j : i + 1;
    if (/^[-+.\d]+$/.test(tok)) { stack.push(+tok); continue; }
    const n = k => stack[stack.length - k];
    switch (tok) {
      case 'BT': tm = tlm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': { const name = n(2)?.name; if (name) font = fontFor(name); if (typeof n(1) === 'number') size = Math.abs(n(1)) || size; break; }
      case 'TL': if (typeof n(1) === 'number') lead = n(1); break;
      case 'Td': if (typeof n(1) === 'number') moveTo(n(2), n(1)); break;
      case 'TD': if (typeof n(1) === 'number') { lead = -n(1); moveTo(n(2), n(1)); } break;
      case 'Tm': if (stack.length >= 6) { tm = tlm = stack.slice(-6).map(Number); } break;
      case 'T*': moveTo(0, -lead); break;
      case 'Tj': { const b = n(1); if (Buffer.isBuffer(b)) show(decode(b)); break; }
      case "'": case '"': { moveTo(0, -lead); const b = n(1); if (Buffer.isBuffer(b)) show(decode(b)); break; }
      case 'TJ': { const arr = n(1); if (Array.isArray(arr)) { let s = ''; for (const x of arr) { if (Buffer.isBuffer(x)) s += decode(x); else if (typeof x === 'number' && x < -180 && !s.endsWith(' ')) s += ' '; } show(s); } break; }
      case 'BI': { const e = c.indexOf('EI', i); i = e < 0 ? c.length : e + 2; break; }
    }
    if (!/^(BT|q|Q)$/.test(tok)) stack.length = 0;
  }
  flush();
  return out.join('\n');
}

// Text of any supported file. mime is a hint for files without a known extension.
export function extractText(buf, name = '', mime = '') {
  const ext = (path.extname(name).toLowerCase() || '').slice(1);
  const kind = ext || ({ 'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx' })[mime.split(';')[0]] || '';
  let text;
  if (kind === 'pdf' || buf.subarray(0, 5).toString('latin1') === '%PDF-') text = pdfText(buf);
  else if (['docx', 'xlsx', 'xlsm', 'pptx', 'odt', 'ods', 'odp'].includes(kind) || buf.readUInt32LE(0) === 0x04034b50) {
    const z = unzip(buf);
    text = z.names.includes('word/document.xml') ? docxText(z) : z.names.includes('xl/workbook.xml') ? xlsxText(z) : z.names.includes('ppt/presentation.xml') ? pptxText(z) : z.names.includes('content.xml') ? odfText(z) : (() => { throw new Error('This zip file is not a document SILO can read.'); })();
  } else {
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`${name || 'This file'} is not text and not a PDF or Office document.`);
    text = buf.toString('utf8');
  }
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + `\n[cut: ${text.length - MAX_TEXT} more characters]` : text;
}

// ---------- writing ----------
// Content is simple Markdown: # headings, - lists, 1. lists, | tables |, **bold**, blank lines between paragraphs.
export function parseMarkdown(md) {
  const blocks = [], lines = String(md || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const h = l.match(/^(#{1,3})\s+(.*)/); if (h) { blocks.push({ type: 'h', level: h[1].length, text: h[2].trim() }); continue; }
    if (/^\s*\|/.test(l)) { const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) { const r = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim()); if (!r.every(x => /^:?-{2,}:?$/.test(x))) rows.push(r); i++; } i--; blocks.push({ type: 'table', rows }); continue; }
    const li = l.match(/^\s*([-*]|\d+[.)])\s+(.*)/); if (li) { blocks.push({ type: 'li', ordered: /\d/.test(li[1]), mark: li[1], text: li[2] }); continue; }
    let p = l.trim(); while (i + 1 < lines.length && lines[i + 1].trim() && !/^(#{1,3}\s|\s*\||\s*([-*]|\d+[.)])\s)/.test(lines[i + 1])) p += ' ' + lines[++i].trim();
    blocks.push({ type: 'p', text: p });
  }
  return blocks;
}
const runs = text => String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map(t => t.startsWith('**') && t.endsWith('**') ? { b: true, t: t.slice(2, -2) } : { b: false, t });

export function makeDocx(title, markdown) {
  const blocks = parseMarkdown(markdown);
  const wr = (t, b) => `<w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs(text).map(r => wr(r.t, r.b)).join('')}</w:p>`;
  let n = 0;
  const body = (title ? p(title, 'Title') : '') + blocks.map(b => {
    if (b.type === 'h') return p(b.text, 'Heading' + b.level);
    if (b.type === 'li') return p((b.ordered ? `${b.mark.replace(')', '.')} ` : '• ') + b.text, 'ListParagraph');
    if (b.type === 'table') { n++; return `<w:tbl><w:tblPr><w:tblStyle w:val="Table"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:color="999999"/>`).join('')}</w:tblBorders></w:tblPr>` + b.rows.map((r, ri) => `<w:tr>${r.map(c => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${runs(c).map(x => wr(x.t, x.b || ri === 0)).join('')}</w:p></w:tc>`).join('')}</w:tr>`).join('') + '</w:tbl><w:p/>'; }
    return p(b.text);
  }).join('');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const style = (id, name, size, bold, after = 120) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="${after}"/><w:outlineLvl w:val="${id === 'Title' ? 0 : +id.slice(-1) - 1}"/></w:pPr><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="${size}"/></w:rPr></w:style>`;
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['word/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${style('Title', 'Title', 48, true, 240)}${style('Heading1', 'heading 1', 32, true)}${style('Heading2', 'heading 2', 28, true)}${style('Heading3', 'heading 3', 24, true)}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/><w:spacing w:after="40"/></w:pPr></w:style></w:styles>`],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`],
  ]);
}

// sheets: [{ name, rows: [[...], ...] }]. The first row is bold. Numbers stay numbers; text starting with = is a formula.
export function makeXlsx(sheets) {
  sheets = (sheets || []).slice(0, 20).map((s, i) => ({ name: String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`, rows: (s.rows || []).slice(0, 50000) }));
  if (!sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];
  const cell = (v, r, c) => {
    const at = colName(c) + (r + 1), st = r === 0 ? ' s="1"' : '';
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && v.trim().length < 16 && !/^0\d/.test(v.trim()))) return `<c r="${at}"${st}><v>${Number(v)}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${at}" t="b"${st}><v>${v ? 1 : 0}</v></c>`;
    if (typeof v === 'string' && v.startsWith('=') && v.length > 1) return `<c r="${at}"${st}><f>${xml(v.slice(1))}</f></c>`;
    return `<c r="${at}" t="inlineStr"${st}><is><t xml:space="preserve">${xml(String(v).slice(0, 32000))}</t></is></c>`;
  };
  const sheetXml = s => {
    const widths = []; for (const r of s.rows.slice(0, 200)) (r || []).forEach((v, c) => { widths[c] = Math.max(widths[c] || 8, Math.min(60, String(v ?? '').length + 2)); });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${s.rows.length ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : ''}${widths.length ? '<cols>' + Array.from(widths, (w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w || 8}" customWidth="1"/>`).join('') + '</cols>' : ''}<sheetData>${s.rows.map((r, ri) => `<row r="${ri + 1}">${(Array.isArray(r) ? r : [r]).map((v, ci) => cell(v, ri, ci)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  };
  return zip([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ]);
}
export function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false; const s = String(text || '');
  const sep = (s.split('\n')[0].match(/;/g) || []).length > (s.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  for (let i = 0; i < s.length; i++) { const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
    if (ch === '"') q = true; else if (ch === sep) { row.push(cur); cur = ''; } else if (ch === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += ch; }
  if (cur || row.length) { row.push(cur.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

// ---------- PDF writing ----------
function findFont(bold) {
  const win = process.env.WINDIR || 'C:\\Windows';
  const list = bold ? [path.join(win, 'Fonts', 'arialbd.ttf'), '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/Library/Fonts/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf']
    : [path.join(win, 'Fonts', 'arial.ttf'), '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf'];
  return list.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
function loadTtf(file) {
  const b = fs.readFileSync(file), n = b.readUInt16BE(4), tables = {};
  for (let i = 0; i < n; i++) { const o = 12 + i * 16; tables[b.toString('latin1', o, o + 4)] = { off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) }; }
  if (!tables.cmap || !tables.hmtx || !tables.head || !tables.hhea) throw new Error('font tables missing');
  const upm = b.readUInt16BE(tables.head.off + 18), nH = b.readUInt16BE(tables.hhea.off + 34);
  const asc = b.readInt16BE(tables.hhea.off + 4), desc = b.readInt16BE(tables.hhea.off + 6);
  const adv = g => b.readUInt16BE(tables.hmtx.off + 4 * Math.min(g, nH - 1));
  const cm = tables.cmap.off, map = new Map();
  for (let i = 0, cnt = b.readUInt16BE(cm + 2); i < cnt; i++) {
    const pid = b.readUInt16BE(cm + 4 + i * 8), eid = b.readUInt16BE(cm + 6 + i * 8), st = cm + b.readUInt32BE(cm + 8 + i * 8);
    if (pid !== 3 || (eid !== 1 && eid !== 10) || b.readUInt16BE(st) !== 4) continue;
    const seg = b.readUInt16BE(st + 6) / 2, ends = st + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
    for (let s = 0; s < seg; s++) {
      const end = b.readUInt16BE(ends + s * 2), start = b.readUInt16BE(starts + s * 2), delta = b.readInt16BE(deltas + s * 2), ro = b.readUInt16BE(ranges + s * 2);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g = ro ? b.readUInt16BE(ranges + s * 2 + ro + (c - start) * 2) : c; if (ro && g) g = (g + delta) & 0xffff; else if (!ro) g = (c + delta) & 0xffff;
        if (g) map.set(c, g);
      }
    }
    break;
  }
  if (!map.size) throw new Error('font has no Unicode map');
  if (!tables.glyf || !tables.loca || !tables.maxp) throw new Error('only TrueType outlines are supported');
  return { data: b, tables, upm, asc, desc, glyph: c => map.get(c) || 0, width: c => adv(map.get(c) || 0) * 1000 / upm, name: path.basename(file, '.ttf').replace(/[^A-Za-z0-9]/g, '') };
}
// Keeps only the outlines of the glyphs a document uses (and the parts of composite glyphs), so a PDF with
// Arial is tens of kilobytes instead of a megabyte. Glyph numbers stay the same.
function subsetTtf(t, used) {
  const b = t.data, T = t.tables, long = b.readInt16BE(T.head.off + 50) === 1, count = b.readUInt16BE(T.maxp.off + 4);
  const loca = g => long ? b.readUInt32BE(T.loca.off + g * 4) : b.readUInt16BE(T.loca.off + g * 2) * 2;
  const keep = new Set([0]), todo = [...used];
  while (todo.length) {
    const g = todo.pop(); if (g >= count || keep.has(g) && g !== 0) continue; keep.add(g);
    const s = T.glyf.off + loca(g), e = T.glyf.off + loca(g + 1);
    if (e - s < 10 || b.readInt16BE(s) >= 0) continue;
    let p = s + 10, flags;
    do { flags = b.readUInt16BE(p); todo.push(b.readUInt16BE(p + 2)); p += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0); } while (flags & 0x20 && p < e);
  }
  const parts = [], offs = new Uint32Array(count + 1); let pos = 0;
  for (let g = 0; g < count; g++) {
    offs[g] = pos;
    if (keep.has(g)) { const d = b.subarray(T.glyf.off + loca(g), T.glyf.off + loca(g + 1)); parts.push(d); pos += d.length; if (pos % 4) { const pad = 4 - pos % 4; parts.push(Buffer.alloc(pad)); pos += pad; } }
  }
  offs[count] = pos;
  const glyf = Buffer.concat(parts), locaBuf = Buffer.alloc((count + 1) * 4); offs.forEach((o, i) => locaBuf.writeUInt32BE(o, i * 4));
  const head = Buffer.from(b.subarray(T.head.off, T.head.off + T.head.len)); head.writeUInt32BE(0, 8); head.writeInt16BE(1, 50);
  const tables = { head, hhea: b.subarray(T.hhea.off, T.hhea.off + T.hhea.len), maxp: b.subarray(T.maxp.off, T.maxp.off + T.maxp.len), hmtx: b.subarray(T.hmtx.off, T.hmtx.off + T.hmtx.len), loca: locaBuf, glyf };
  for (const k of ['cvt ', 'fpgm', 'prep']) if (T[k]) tables[k] = b.subarray(T[k].off, T[k].off + T[k].len);
  const tags = Object.keys(tables).sort(), n = tags.length, dir = Buffer.alloc(12 + 16 * n);
  const es = Math.floor(Math.log2(n)); dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(n, 4); dir.writeUInt16BE(16 * 2 ** es, 6); dir.writeUInt16BE(es, 8); dir.writeUInt16BE(16 * n - 16 * 2 ** es, 10);
  const sum = d => { let s = 0; for (let i = 0; i < d.length; i += 4) s = (s + ((d[i] << 24) | ((d[i + 1] || 0) << 16) | ((d[i + 2] || 0) << 8) | (d[i + 3] || 0))) >>> 0; return s; };
  const body = []; let off = dir.length;
  tags.forEach((tag, i) => { const d = tables[tag]; dir.write(tag, 12 + i * 16, 'latin1'); dir.writeUInt32BE(sum(d), 16 + i * 16); dir.writeUInt32BE(off, 20 + i * 16); dir.writeUInt32BE(d.length, 24 + i * 16); const pad = (4 - d.length % 4) % 4; body.push(d, Buffer.alloc(pad)); off += d.length + pad; });
  return Buffer.concat([dir, ...body]);
}
const WINANSI = s => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[‘’]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
// Helvetica widths for plain ASCII, used only when no system font is found.
const HELV = '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'.split(',').map(Number);

export function makePdf(title, markdown) {
  let reg = null, bold = null;
  try { const r = findFont(false), b = findFont(true); if (r) { reg = loadTtf(r); bold = b ? loadTtf(b) : reg; } } catch { reg = bold = null; }
  const W = 595.28, H = 841.89, M = 56, maxW = W - 2 * M;
  const fonts = reg ? { F1: reg, F2: bold } : null;
  const used = { F1: new Set(), F2: new Set() };
  const width = (text, f, size) => { let w = 0; for (const ch of text) { const c = ch.codePointAt(0); w += fonts ? fonts[f].width(c) : (HELV[c - 32] ?? 556) * (f === 'F2' ? 1.05 : 1); } return w * size / 1000; };
  const enc = (text, f) => {
    if (!fonts) return '(' + WINANSI(text).replace(/[\\()]/g, '\\$&') + ')';
    let h = ''; for (const ch of text) { const c = ch.codePointAt(0); const g = c > 0xffff ? 0 : fonts[f].glyph(c); used[f].add(c); h += g.toString(16).padStart(4, '0'); } return '<' + h + '>';
  };
  const pages = []; let ops = [], y = H - M;
  const newPage = () => { if (ops.length) pages.push(ops.join('\n')); ops = []; y = H - M; };
  const line = (segments, size, gap, indent = 0) => {
    if (y - size < M) newPage();
    y -= size; let x = M + indent;
    for (const s of segments) { ops.push(`BT /${s.f} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td ${enc(s.t, s.f)} Tj ET`); x += width(s.t, s.f, size); }
    y -= gap;
  };
  const wrap = (text, size, f = 'F1', indent = 0, gap = size * 0.35) => {
    const words = runs(text).flatMap(r => r.t.split(/(\s+)/).filter(Boolean).map(t => ({ t, f: r.b ? 'F2' : f })));
    let cur = [], w = 0;
    const out = () => { while (cur.length && /^\s+$/.test(cur[cur.length - 1].t)) cur.pop(); if (cur.length) line(cur, size, gap, indent); cur = []; w = 0; };
    for (const word of words) {
      const ww = width(word.t, word.f, size);
      if (w + ww > maxW - indent && cur.length && !/^\s+$/.test(word.t)) out();
      if (!cur.length && /^\s+$/.test(word.t)) continue;
      if (ww > maxW - indent) { let part = ''; for (const ch of word.t) { if (width(part + ch, word.f, size) > maxW - indent) { cur.push({ t: part, f: word.f }); out(); part = ''; } part += ch; } cur.push({ t: part, f: word.f }); w = width(part, word.f, size); continue; }
      cur.push(word); w += ww;
    }
    out();
  };
  if (title) { wrap(title, 22, 'F2', 0, 14); }
  for (const b of parseMarkdown(markdown)) {
    if (b.type === 'h') { y -= 6; wrap(b.text, [17, 14, 12][b.level - 1], 'F2', 0, 6); }
    else if (b.type === 'li') wrap((b.ordered ? b.mark.replace(')', '.') : '•') + ' ' + b.text, 11, 'F1', 14, 3);
    else if (b.type === 'table') {
      const cols = Math.max(...b.rows.map(r => r.length)), cw = maxW / cols, size = 9.5;
      for (const [ri, r] of b.rows.entries()) {
        const cells = Array.from({ length: cols }, (_, c) => String(r[c] ?? '')), lines = cells.map(t => { const ls = []; let cur = ''; for (const w of t.split(/\s+/)) { if (cur && width(cur + ' ' + w, 'F1', size) > cw - 8) { ls.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; } ls.push(cur); return ls; });
        const hgt = Math.max(...lines.map(l => l.length)) * (size + 3) + 6;
        if (y - hgt < M) newPage();
        ops.push(`0.6 G 0.5 w ${M} ${(y - hgt).toFixed(2)} ${maxW.toFixed(2)} ${hgt.toFixed(2)} re S`);
        for (let c = 1; c < cols; c++) ops.push(`${(M + c * cw).toFixed(2)} ${y.toFixed(2)} m ${(M + c * cw).toFixed(2)} ${(y - hgt).toFixed(2)} l S`);
        lines.forEach((ls, c) => ls.forEach((t, k) => { if (t) ops.push(`BT /${ri === 0 ? 'F2' : 'F1'} ${size} Tf ${(M + c * cw + 4).toFixed(2)} ${(y - 3 - (k + 1) * (size + 3) + 3).toFixed(2)} Td ${enc(t, ri === 0 ? 'F2' : 'F1')} Tj ET`); }));
        y -= hgt;
      }
      y -= 8;
    } else wrap(b.text, 11, 'F1', 0, 7);
  }
  newPage(); if (!pages.length) pages.push('');
  // Objects: 1 catalog, 2 pages, then fonts, then page and content pairs.
  const objs = []; const add = s => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('');
  const fontRefs = {};
  if (fonts && fonts.F2 === fonts.F1) for (const c of used.F2) used.F1.add(c);
  for (const f of ['F1', 'F2']) {
    if (!fonts) { fontRefs[f] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f === 'F1' ? 'Helvetica' : 'Helvetica-Bold'} /Encoding /WinAnsiEncoding >>`); continue; }
    const t = fonts[f]; if (f === 'F2' && t === fonts.F1) { fontRefs.F2 = fontRefs.F1; continue; }
    let fontData; try { fontData = subsetTtf(t, [...used[f]].map(c => t.glyph(c)).filter(Boolean)); } catch { fontData = t.data; }
    const file = zlib.deflateSync(fontData);
    const fileRef = add({ dict: `<< /Length ${file.length} /Length1 ${fontData.length} /Filter /FlateDecode >>`, data: file });
    const desc = add(`<< /Type /FontDescriptor /FontName /${t.name} /Flags 32 /FontBBox [-600 -300 2000 1100] /ItalicAngle 0 /Ascent ${Math.round(t.asc * 1000 / t.upm)} /Descent ${Math.round(t.desc * 1000 / t.upm)} /CapHeight 716 /StemV 80 /FontFile2 ${fileRef} 0 R >>`);
    const chars = [...used[f]].filter(c => c <= 0xffff && t.glyph(c)).sort((a, b) => a - b);
    const glyphs = [...new Map(chars.map(c => [t.glyph(c), c]))].sort((a, b) => a[0] - b[0]);
    const widths = glyphs.map(([g, c]) => `${g} [${Math.round(t.width(c))}]`).join(' ');
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n` +
      glyphs.reduce((acc, x, i) => { if (i % 100 === 0) acc.push([]); acc[acc.length - 1].push(x); return acc; }, []).map(chunk => `${chunk.length} beginbfchar\n${chunk.map(([g, c]) => `<${g.toString(16).padStart(4, '0')}> <${c.toString(16).padStart(4, '0')}>`).join('\n')}\nendbfchar`).join('\n') + '\nendcmap CMapName currentdict /CMap defineresource pop end end';
    const cm = zlib.deflateSync(Buffer.from(cmap, 'latin1'));
    const toUni = add({ dict: `<< /Length ${cm.length} /Filter /FlateDecode >>`, data: cm });
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${t.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 500 /W [${widths}] >>`);
    fontRefs[f] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${t.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUni} 0 R >>`);
  }
  const kids = [];
  for (const p of pages) {
    const data = zlib.deflateSync(Buffer.from(p, 'latin1'));
    const c = add({ dict: `<< /Length ${data.length} /Filter /FlateDecode >>`, data });
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${fontRefs.F1} 0 R /F2 ${fontRefs.F2} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map(k => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title <FEFF${Buffer.from(String(title || 'Document'), 'utf16le').swap16().toString('hex')}> /Producer (SILO) >>`);
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = []; let pos = parts[0].length;
  objs.forEach((o, i) => {
    const chunk = typeof o === 'string' ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1') : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    offsets.push(pos); parts.push(chunk); pos += chunk.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
export const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8' };
