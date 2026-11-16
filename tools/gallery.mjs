// Writes gallery/index.json from the procedure files in gallery/: names, steps and the fingerprint of each file.
// Authors and tags written in the index stay. With --check it only says whether the index is up to date.
//   node tools/gallery.mjs           after adding or changing a procedure file
//   node tools/gallery.mjs --check   in the tests
//   node tools/gallery.mjs --dir my-catalog   the same for a catalog of your own
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_NAME, makeIndex } from '../gallery.mjs';

const at = process.argv.indexOf('--dir');
const DIR = at > 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'gallery'), INDEX = path.join(DIR, 'index.json');
const shown = path.relative(process.cwd(), INDEX) || INDEX, files = new Map();
for (const name of (await fs.readdir(DIR)).filter(n => n.endsWith('.silo.json')).sort()) {
  if (!FILE_NAME.test(name)) { console.error(`${name}: use lower-case letters, digits and dashes, like customer-reply.silo.json.`); process.exit(1); }
  files.set(name, await fs.readFile(path.join(DIR, name), 'utf8'));
}
let was = {}; try { was = JSON.parse(await fs.readFile(INDEX, 'utf8')); } catch {}
let index; try { index = makeIndex(files, was); } catch (e) { console.error(e.message); process.exit(1); }
const out = JSON.stringify(index, null, 2) + '\n';
if (process.argv.includes('--check')) {
  const now = JSON.stringify(was, null, 2) + '\n';
  if (now !== out) { console.error(`${shown} is not up to date. Run: node tools/gallery.mjs${at > 0 ? ' --dir ' + path.dirname(shown) : ''}`); process.exit(1); }
  console.log(`${shown} is up to date: ${index.procedures.length} procedures.`);
} else {
  await fs.writeFile(INDEX, out);
  for (const e of index.procedures) if (!e.author || !e.tags.length) console.log(`Add an author and tags for ${e.file} in ${shown}, then run this again.`);
  console.log(`Wrote ${shown}: ${index.procedures.length} procedures.`);
}
