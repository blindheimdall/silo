// A hosted workspace (SILO_TENANT=1, started by workspaces.mjs) belongs to a team that does not run the server.
// Two walls go up before anything else loads:
//  - No programs: every way of starting a program (child_process) refuses, so the team cannot reach the files,
//    processes or keys of the other workspaces through a connector, a tool or the code sandbox.
//  - No private network: every connection, from fetch, http, https or a plain socket, refuses addresses on this
//    computer, the local network and the cloud's metadata service, and local sockets and pipes. The check runs on the
//    address really connected to, after the name is looked up, so a name that points inside cannot slip through.
// SILO_TENANT_ALLOW_HOSTS lists names or addresses the teams may still reach, like a shared Ollama on the network.
import cp from 'node:child_process';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { privateAddress } from './web-reader.mjs';

export const TENANT = process.env.SILO_TENANT === '1';
export const NO_PROGRAMS = 'A hosted workspace does not run programs on the server.';
const NO_PRIVATE = 'A hosted workspace cannot reach this server or its private network.';
const fault = (message, code) => Object.assign(new Error(message), { code });

// Names (lower case, without a port) and addresses that stay reachable.
export function allowList(text = '') {
  return new Set(String(text).split(/[\s,]+/).map(h => h.trim().toLowerCase().replace(/^\[|\]$/g, '')).filter(Boolean));
}

// Wraps a socket's options so that it only connects to public addresses. Returns null when it may not connect at all.
export function guardOptions(o, allowed = new Set()) {
  if (o.path != null) return null;
  const host = String(o.host ?? 'localhost').toLowerCase().replace(/^\[|\]$/g, '');
  if (allowed.has(host)) return o;
  if (net.isIP(host)) return privateAddress(host) ? null : o;
  const lookup = o.lookup || dns.lookup;
  return { ...o, lookup(name, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    const all = typeof opts === 'object' && opts?.all;
    lookup(name, { ...(typeof opts === 'object' ? opts : { family: opts }), all: true }, (err, list) => {
      if (err) return cb(err);
      const ok = (list || []).filter(a => allowed.has(a.address) || !privateAddress(a.address));
      if (!ok.length) return cb(fault(NO_PRIVATE, 'EPRIVATE'));
      all ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
    });
  } };
}

function guardNetwork(allowed) {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // net.connect and tls.connect pass [options, callback] in one array; the rest of the forms are made into options.
    const packed = Array.isArray(args[0]);
    let o = packed ? args[0][0] : args[0];
    if (o === null || typeof o !== 'object') {
      const cb = args.find(a => typeof a === 'function');
      o = typeof o === 'string' && !/^\d+$/.test(o) ? { path: o } : { port: o, host: typeof args[1] === 'string' ? args[1] : undefined };
      args = cb ? [o, cb] : [o];
    }
    const safe = guardOptions(o, allowed);
    if (!safe) { process.nextTick(() => this.destroy(fault(NO_PRIVATE, 'EPRIVATE'))); return this; }
    if (packed) args[0][0] = safe; else args[0] = safe;
    return connect.apply(this, args);
  };
}

function blockPrograms() {
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
    cp[name] = () => { throw fault(NO_PROGRAMS, 'ETENANT'); };
  syncBuiltinESMExports();
}

// fetch says only "fetch failed"; a refused address says why, wherever SILO shows the error.
function explainFetch() {
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    try { return await fetch(...args); }
    catch (e) { if (e?.cause?.code === 'EPRIVATE') throw Object.assign(new TypeError(e.cause.message, { cause: e.cause }), { code: 'EPRIVATE' }); throw e; }
  };
}

if (TENANT) { blockPrograms(); guardNetwork(allowList(process.env.SILO_TENANT_ALLOW_HOSTS)); explainFetch(); }
