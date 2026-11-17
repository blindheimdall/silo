// Code steps: a few lines of JavaScript that turn earlier answers into the next one, with no model and no app.
// The code runs in a worker thread, inside a fresh V8 context that holds only the data it is given (copied in as
// JSON, so no object of the server is reachable from it), with no require, no process, no network and no eval.
// A time limit stops it inside the context, and the worker is ended if it runs on past that. Only owners add code
// steps, so this keeps mistakes small; it is not meant for code from people you do not trust.
import { Worker } from 'node:worker_threads';

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { code, data, timeout } = workerData;
let out;
try {
  // The data goes in as one string and is read with JSON.parse inside the context: faster and smaller than making V8
  // parse it as source code, which matters when earlier steps answered with a lot of text.
  const ctx = vm.createContext({ __data: JSON.stringify(data ?? null) }, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  const src = '(function(){"use strict";const D=JSON.parse(globalThis.__data);delete globalThis.__data;' +
    'const json=t=>{if(typeof t!=="string")return t;try{return JSON.parse(t)}catch{const a=t.search(/[\\\\[{]/);if(a<0)return null;for(const e of [t.lastIndexOf("}"),t.lastIndexOf("]")].filter(e=>e>a).sort((x,y)=>y-x)){try{return JSON.parse(t.slice(a,e+1))}catch{}}return null}};' +
    'let r;try{r=(function(input,steps,previous,item,json){"use strict";\\n' + code + '\\n})(D.input,D.steps,D.previous,D.item,json);}' +
    'catch(e){return {error:String(e&&e.message||e)}}' +
    'if(r&&typeof r.then==="function")return {error:"A code step runs at once: await and promises are not available."};' +
    'return {text:r===undefined||r===null?"":typeof r==="string"?r:JSON.stringify(r,null,2)};})()';
  const r = vm.runInContext(src, ctx, { timeout, filename: 'code-step.js' });
  out = r && typeof r.error === 'string' ? { error: r.error } : { text: String(r && r.text || '') };
} catch (e) {
  out = { error: /timed out/i.test(String(e && e.message)) ? 'The code ran longer than ' + timeout / 1000 + ' seconds.' : String(e && e.message || e) };
}
parentPort.postMessage(out);
`;

export const CODE_MAX = 20000, CODE_OUT_MAX = 100000;

// data: { input, steps: {1: text, ...}, previous, item }. Resolves to the text the code returned; rejects with its error.
export function runCode(code, data, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const w = new Worker(WORKER, { eval: true, workerData: { code: String(code), data, timeout }, env: {}, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16, stackSizeMb: 4 } });
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(t); w.terminate().catch(() => {}); fn(v); };
    // The context's own limit stops a loop; this one catches whatever gets past it, like a huge JSON.stringify.
    const t = setTimeout(() => end(reject, new Error(`The code ran longer than ${timeout / 1000} seconds.`)), timeout + 3000);
    w.once('message', m => m?.error !== undefined ? end(reject, new Error(String(m.error).slice(0, 500))) : end(resolve, String(m?.text ?? '').slice(0, CODE_OUT_MAX)));
    w.once('error', e => end(reject, new Error(/memory/i.test(e.message) ? 'The code used too much memory.' : e.message)));
    w.once('exit', c => end(reject, new Error(c ? 'The code stopped before it gave an answer.' : 'The code gave no answer.')));
  });
}
