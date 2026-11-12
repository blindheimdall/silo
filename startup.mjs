// Start at sign-in: a shortcut in your own Startup folder that runs the supervisor in a minimized window.
// Per user, no administrator rights, and removing the shortcut turns it off. Windows only.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const startupDir = () => process.env.SILO_STARTUP_DIR || path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
export const startupLink = () => path.join(startupDir(), 'SILO.lnk');
export const startupSupported = () => process.platform === 'win32';

// Paths go through the environment, so no quoting can break the command.
function powershell(script, env) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ...env }, windowsHide: true, timeout: 20000 }, (e, out, errText) => e ? reject(new Error(String(errText || e.message).trim().split('\n')[0].slice(0, 200))) : resolve(String(out).trim())));
}
export async function makeShortcut(file, { target, args = '', cwd, minimized = false, description = '', icon = '' }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await powershell('$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SL_FILE);$s.TargetPath=$env:SL_TARGET;$s.Arguments=$env:SL_ARGS;$s.WorkingDirectory=$env:SL_CWD;$s.Description=$env:SL_DESC;if($env:SL_ICON){$s.IconLocation=$env:SL_ICON};if($env:SL_MIN -eq "1"){$s.WindowStyle=7};$s.Save()',
    { SL_FILE: file, SL_TARGET: target, SL_ARGS: args, SL_CWD: cwd || path.dirname(target), SL_DESC: description, SL_ICON: icon, SL_MIN: minimized ? '1' : '0' });
}
export async function readShortcut(file) {
  if (!fs.existsSync(file)) return null;
  const out = await powershell('$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SL_FILE);[pscustomobject]@{target=$s.TargetPath;args=$s.Arguments;cwd=$s.WorkingDirectory;style=$s.WindowStyle}|ConvertTo-Json -Compress', { SL_FILE: file });
  return JSON.parse(out);
}
export async function startupStatus(root) {
  if (!startupSupported()) return { supported: false, enabled: false };
  const link = startupLink(); if (!fs.existsSync(link)) return { supported: true, enabled: false, link };
  let s = null; try { s = await readShortcut(link); } catch {}
  // A shortcut that points at another SILO folder is shown, so it can be fixed.
  const here = !!s && path.resolve(s.cwd || '') === path.resolve(root);
  return { supported: true, enabled: true, link, here, target: s?.cwd || '' };
}
export async function setStartup(on, root) {
  if (!startupSupported()) throw Object.assign(new Error('Starting with Windows only works on Windows.'), { status: 400 });
  const link = startupLink();
  if (!on) { fs.rmSync(link, { force: true }); return startupStatus(root); }
  await makeShortcut(link, { target: process.execPath, args: '"supervisor.mjs"', cwd: root, minimized: true, description: 'Starts SILO when you sign in to Windows.', icon: fs.existsSync(path.join(root, 'public', 'silo.ico')) ? path.join(root, 'public', 'silo.ico') : '' });
  return startupStatus(root);
}
