// Remote access through a Cloudflare Tunnel. SILO keeps listening only on 127.0.0.1; cloudflared makes an
// outgoing connection to Cloudflare and brings HTTPS requests back to this computer. No open port on the router,
// no firewall rule, and the address works from any network.
//   quick: a free random https://<words>.trycloudflare.com address, no account. It changes when the tunnel restarts.
//   token: your own tunnel from the Cloudflare dashboard, on your own domain. The address stays the same.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const exeName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const DOWNLOAD = {
  win32: { x64: 'cloudflared-windows-amd64.exe', ia32: 'cloudflared-windows-386.exe', arm64: 'cloudflared-windows-amd64.exe' },
  linux: { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm' },
};

export function tunnelCandidates(binDir) {
  const env = k => process.env[k] || '';
  const list = [path.join(binDir, exeName)];
  if (process.platform === 'win32') {
    list.push(path.join(env('ProgramFiles(x86)'), 'cloudflared', exeName), path.join(env('ProgramFiles'), 'cloudflared', exeName),
      path.join(env('LOCALAPPDATA'), 'Microsoft', 'WinGet', 'Links', exeName));
  } else list.push('/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared');
  for (const dir of env('PATH').split(path.delimiter)) if (dir) list.push(path.join(dir, exeName));
  return list;
}
export function findCloudflared(custom, binDir) {
  if (custom) return existsSync(custom) ? custom : '';
  return tunnelCandidates(binDir).find(p => { try { return existsSync(p); } catch { return false; } }) || '';
}
// A hostname someone types: no scheme, no path, no port.
export function cleanHostname(value) {
  let h = String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  if (!h) return '';
  if (h.length > 200 || !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) throw Object.assign(new Error('Give a hostname like silo.example.com.'), { status: 400 });
  return h;
}
// The tunnel token from the Cloudflare dashboard is base64 JSON with the account, tunnel and secret.
export function checkToken(value) {
  let t = String(value || '').trim();
  // People paste the whole install command; the token is the long part at the end.
  const m = t.match(/([A-Za-z0-9+/_=-]{60,})\s*$/); if (m) t = m[1];
  try { const j = JSON.parse(Buffer.from(t, 'base64').toString('utf8')); if (j.a && j.t && j.s) return t; } catch {}
  throw Object.assign(new Error('That does not look like a tunnel token. Copy it from the Cloudflare dashboard, under Networks, Tunnels, your tunnel, Install connector.'), { status: 400 });
}

export class Tunnel {
  constructor({ port, binDir, onChange = () => {}, onAddress = () => {} }) {
    Object.assign(this, { port, binDir, onChange, onAddress });
    this.child = null; this.want = null; this.state = 'off'; this.url = ''; this.error = ''; this.since = 0;
    this.lines = []; this.connections = 0; this.retry = 0; this.timer = null;
  }
  set(fields) { Object.assign(this, fields); this.onChange(this.status()); }
  // The hostname requests arrive with, or '' while there is none.
  host() { if (this.state !== 'on' && this.state !== 'starting') return ''; try { return this.url ? new URL(this.url).hostname : ''; } catch { return ''; } }
  status() { return { state: this.state, mode: this.want?.mode || '', url: this.state === 'on' ? this.url : '', error: this.error, since: this.since, connections: this.connections }; }
  start(opts) {
    this.stop(true);
    if (!opts.exe) { this.set({ state: 'error', error: 'cloudflared is not installed.' }); return; }
    if (opts.mode === 'token' && (!opts.token || !opts.hostname)) { this.set({ state: 'error', error: 'Give the tunnel token and the hostname.' }); return; }
    this.want = opts; this.retry = 0; this.launch();
  }
  launch() {
    const o = this.want; if (!o) return;
    const args = ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0'];
    const env = { ...process.env };
    if (o.mode === 'token') { args.push('run'); env.TUNNEL_TOKEN = o.token; }
    else args.push('--url', `http://127.0.0.1:${this.port}`);
    const script = /\.(mjs|js)$/.test(o.exe);
    let child;
    try { child = spawn(script ? process.execPath : o.exe, script ? [o.exe, ...args] : args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { this.set({ state: 'error', error: e.message }); return; }
    this.child = child; this.lines = []; this.connections = 0;
    this.set({ state: 'starting', error: '', url: o.mode === 'token' ? 'https://' + o.hostname : '' });
    const read = buf => {
      for (const raw of String(buf).split(/\r?\n/)) {
        const line = raw.replace(/eyJ[A-Za-z0-9+/_=-]{20,}/g, '[token]').trim(); if (!line) continue;
        this.lines = [...this.lines, line].slice(-40);
        const found = line.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/);
        if (found && o.mode === 'quick' && !/api\.trycloudflare/.test(found[1])) this.url = 'https://' + found[1];
        if (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(line)) {
          this.connections++; this.retry = 0;
          if (this.state !== 'on' && this.url) { this.set({ state: 'on', since: Date.now() }); this.onAddress(this.url); }
          else this.onChange(this.status());
        }
        if (/ERR .*(Unauthorized|Invalid tunnel secret|token)/i.test(line)) this.error = 'Cloudflare refused the tunnel token.';
        else if (/ERR .*failed to request quick Tunnel|429 Too Many Requests/i.test(line)) this.error = 'Cloudflare did not give a quick address right now.';
      }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', e => { this.error = e.message; });
    child.on('exit', code => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.want) return;
      const wait = Math.min(60000, 3000 * 2 ** this.retry++);
      this.set({ state: 'error', error: this.error || `cloudflared stopped (code ${code}). Trying again in ${Math.round(wait / 1000)} seconds.`, url: '' });
      this.timer = setTimeout(() => this.launch(), wait); this.timer.unref?.();
    });
  }
  stop(quiet = false) {
    clearTimeout(this.timer); this.timer = null; this.want = null;
    const c = this.child; this.child = null;
    if (c) { try { c.kill(); } catch {} }
    if (!quiet || this.state !== 'off') this.set({ state: 'off', url: '', error: '', connections: 0 });
  }
  log() { return this.lines.slice(-15); }
}

// Downloads cloudflared from Cloudflare's GitHub releases into binDir. On Windows the file has to carry a valid
// Authenticode signature from Cloudflare, or it is deleted.
export async function downloadCloudflared(binDir, { fetchImpl = fetch } = {}) {
  const file = DOWNLOAD[process.platform]?.[process.arch];
  if (!file) throw new Error('There is no cloudflared download for this system. Install it yourself.');
  const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/' + file;
  await fs.mkdir(binDir, { recursive: true });
  const target = path.join(binDir, exeName), part = target + '.part';
  const r = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
  if (!r.ok) throw new Error(`The download answered ${r.status}.`);
  const host = new URL(r.url || url).hostname;
  if (!/(^|\.)github\.com$|(^|\.)githubusercontent\.com$/.test(host)) throw new Error('The download was sent to an unexpected address.');
  const data = Buffer.from(await r.arrayBuffer());
  if (data.length < 5e6 || data.length > 150e6) throw new Error('The downloaded file has an unexpected size.');
  await fs.writeFile(part, data);
  try {
    if (process.platform === 'win32') {
      const out = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$s=Get-AuthenticodeSignature -LiteralPath $args[0];"$($s.Status)|$($s.SignerCertificate.Subject)"', part],
        { windowsHide: true, timeout: 60000 }, (e, so) => e ? reject(e) : resolve(String(so).trim())));
      const [status, subject = ''] = out.split('|');
      if (status !== 'Valid' || !/O=Cloudflare/i.test(subject)) throw new Error('The downloaded file is not signed by Cloudflare, so it was deleted.');
    } else await fs.chmod(part, 0o755);
    await fs.rm(target, { force: true }); await fs.rename(part, target);
  } catch (e) { await fs.rm(part, { force: true }); throw e; }
  return target;
}
