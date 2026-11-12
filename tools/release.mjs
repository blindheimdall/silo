// Makes a signed SILO release for the update feed.
//   node tools/release.mjs --init-key            makes your release key (once)
//   node tools/release.mjs 0.2.0 --notes "..."   sets the version, then writes dist/silo-0.2.0.zip and dist/latest.json
// Put both files in the feed (an https folder, or a folder on this computer or the network). Every SILO with the
// matching release-key.pub checks the signature before it installs anything.
// The private key stays outside the app folder (default: your user folder\.silo\release-key.pem). Keep it safe:
// whoever has it can send updates to your SILOs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildRelease, validVersion } from '../update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const keyFile = path.resolve(opt('--key') || path.join(os.homedir(), '.silo', 'release-key.pem'));
const pubFile = path.join(ROOT, 'release-key.pub');
const stop = msg => { console.error(msg); process.exit(1); };

if (args.includes('--init-key')) {
  if (fs.existsSync(keyFile)) stop(`A release key already exists at ${keyFile}. Remove it first if you really want a new one: SILOs with the old key will then refuse your updates.`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Private key: ${keyFile} (keep it, and keep it private)\nPublic key: ${pubFile} (goes out with every release)`);
  process.exit(0);
}
const version = args.find(a => validVersion(a));
if (!version) stop('Usage: node tools/release.mjs 1.2.3 [--notes "what changed"] [--key file] [--out folder]\n       node tools/release.mjs --init-key');
if (!fs.existsSync(keyFile)) stop(`No release key at ${keyFile}. Make one with: node tools/release.mjs --init-key`);
if (!fs.existsSync(pubFile)) stop('release-key.pub is missing next to server.mjs. It is made with --init-key.');
const privateKeyPem = fs.readFileSync(keyFile, 'utf8');
// The public key in the app has to match, or the SILOs that get this release could not check the next one.
const derived = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
if (derived.trim() !== fs.readFileSync(pubFile, 'utf8').trim()) stop('release-key.pub does not belong to this private key.');
const pkgFile = path.join(ROOT, 'package.json'), pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.version = version; fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
const out = path.resolve(opt('--out') || path.join(ROOT, 'dist'));
const { zip, zipName, manifest } = await buildRelease({ root: ROOT, version, notes: opt('--notes') || '', privateKeyPem, minNode: (pkg.engines?.node || '>=22').replace(/[^\d.]/g, '') || '22' });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, zipName), zip);
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`SILO ${version}: ${Object.keys(manifest.files).length} files, ${(zip.length / 1e6).toFixed(1)} MB\n${path.join(out, zipName)}\n${path.join(out, 'latest.json')}`);
