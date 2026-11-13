// Runs the 3D frame profiler (public/profile-3d.js) in a real Edge or Chrome, without opening anything by hand. It starts
// its own SILO on a free port with a temporary folder (your data is never used), opens it with ?debug in a browser of
// its own and prints what siloProfile() measures in the three scenes, with the graphics card the browser used.
//
//   node tools/profile-3d.mjs                  the graphics card of this computer, in a hidden window
//   node tools/profile-3d.mjs --software       SwiftShader, drawing on the processor: a stand-in for a weak card
//   node tools/profile-3d.mjs --ms 10000       longer per scene, steadier numbers
//   node tools/profile-3d.mjs --show           a visible window instead of a hidden one
//
// A hidden window still draws with the graphics card, but some systems draw a hidden window less often; when the
// numbers look capped, run it again with --show.
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {findBrowser,browserName} from '../browser-agent.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const flag=k=>process.argv.includes('--'+k),arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>0?Number(process.argv[i+1]):d;};
const MS=arg('ms',5000),SOFTWARE=flag('software'),SHOW=flag('show');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});

async function bootSilo(port,dir){
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(dir,'data'),SILO_WORK_DIR:path.join(dir,'workspace'),SILO_SECRET:'profile-3d-secret',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let err='';child.stderr.on('data',b=>{err+=b;});
  await new Promise((ok,no)=>{const t=setTimeout(()=>no(Error('SILO did not start: '+err)),20000);child.stdout.on('data',b=>{if(String(b).includes('SILO is ready')){clearTimeout(t);ok();}});});
  return ()=>new Promise(r=>{child.once('exit',r);child.kill();setTimeout(r,3000);});
}

async function startBrowser(exe,dir){
  const args=['--remote-debugging-port=0','--user-data-dir='+dir,'--no-first-run','--no-default-browser-check','--disable-extensions','--disable-sync','--window-size=1440,900',
    ...(SHOW?[]:['--headless=new']),
    // A hidden window would otherwise be slowed down like a tab in the background.
    '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows',
    ...(SOFTWARE?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:['--ignore-gpu-blocklist','--enable-gpu-rasterization']),'about:blank'];
  const proc=spawn(exe,args,{stdio:'ignore',windowsHide:!SHOW});
  const portFile=path.join(dir,'DevToolsActivePort');let port=0;const end=Date.now()+20000;
  while(!port){if(Date.now()>end)throw new Error('The browser did not start.');try{port=Number((await fs.readFile(portFile,'utf8')).split('\n')[0])||0;}catch{}if(!port)await wait(100);}
  const pg=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');
  const ws=new WebSocket(pg.webSocketDebuggerUrl);await new Promise((ok,no)=>{ws.onopen=ok;ws.onerror=()=>no(new Error('Could not connect to the browser.'));});
  let seq=0;const pending=new Map();
  ws.onmessage=e=>{const m=JSON.parse(e.data);const p=m.id&&pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.no(new Error(m.error.message)):p.ok(m.result);};
  const send=(method,params={})=>new Promise((ok,no)=>{const id=++seq;pending.set(id,{ok,no});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async(expression,timeout=30000)=>{
    const r=await Promise.race([send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}),wait(timeout).then(()=>{throw new Error('The page did not answer in time.');})]);
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);
    return r.result.value;
  };
  return {send,evaluate,close:()=>{try{ws.close();}catch{}proc.kill();return new Promise(r=>{proc.once('exit',r);setTimeout(r,3000);});}};
}

const exe=findBrowser();
if(!exe){console.error('No Edge or Chrome found. Set SILO_BROWSER to the browser program.');process.exit(1);}
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'silo-profile-3d-'));
let stopSilo,browser;
try{
  const port=await freePort();stopSilo=await bootSilo(port,dir);
  browser=await startBrowser(exe,path.join(dir,'browser'));
  await browser.send('Page.enable');await browser.send('Page.navigate',{url:`http://127.0.0.1:${port}/?debug`});
  const end=Date.now()+60000;
  while(!(await browser.evaluate('!!window.siloDebug&&!!window.siloProfile').catch(()=>false))){if(Date.now()>end)throw new Error('The 3D silo did not start in the browser (no WebGL?).');await wait(500);}
  const gpu=await browser.evaluate(`(()=>{const g=document.createElement('canvas').getContext('webgl2')||document.createElement('canvas').getContext('webgl');const x=g&&g.getExtension('WEBGL_debug_renderer_info');return g?(x?g.getParameter(x.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)):'no WebGL';})()`);
  const info=await browser.evaluate(`({residents:window.siloDebug.agents?.length??null,size:[innerWidth,innerHeight],ratio:devicePixelRatio,startup:window.siloDebug.startup})`);
  console.log(`${browserName(exe)}${SHOW?'':' (hidden window)'}, ${SOFTWARE?'software drawing (SwiftShader)':'graphics card'}: ${gpu}`);
  console.log(`Window ${info.size.join('x')} at ${info.ratio}x, ${info.residents??'?'} residents. Start: build ${Math.round(info.startup?.build||0)} ms, shaders ${Math.round(info.startup?.shaders||0)} ms.`);
  const r=await browser.evaluate(`siloProfile({ms:${MS}})`,MS*3+60000);
  const row=(name,x)=>({scene:name,fps:x.fps,target:x.targetFps??'screen','cpu p50':x.cpu.p50,'gpu p50':x.gpu?.p50??'n/a',late:x.late,'gap p50':x.gap.p50,'gap p99':x.gap.p99,'tick p95':x.tick?.p95,'draw p95':x.draw?.p95,'feeds p95':x.feeds.p95,'work p50':x.work.p50,'work p95':x.work.p95,'work max':x.work.max,'card wait p50':x.waitGpu.p50,bound:x.bound,ratio:x.pixelRatio,'low quality':x.lowQualityFrames});
  console.table([row('whole silo',r.overview),row(`level ${r.busyLevel.level} (${r.busyLevel.residents} residents)`,r.busyLevel),row('security room, 9 cameras',r.surveillance)]);
  const after=await browser.evaluate('({ratio:siloDebug.renderer.getPixelRatio(),low:siloDebug.lowQuality,gpuSlow:!!siloDebug.gpuSlow,gap:Math.round(siloDebug.gapAvg),best:Math.round(siloDebug.gapBest),code:Math.round(siloDebug.frameAvgMs*10)/10})');
  console.log(`After: sharpness ${after.ratio}x, less detail ${after.low?'on':'off'}, waiting for the card ${after.gpuSlow?'yes':'no'} (frames ${after.gap} ms on average, best ${after.best} ms, code ${after.code} ms).`);
  for(const [name,x] of Object.entries(r))console.log(`Slowest in ${name}: ${(x.slowest||[]).slice(0,3).map(s=>`${s.work} ms (tick ${s.tick}, draw ${s.draw}, cameras ${s.feeds})`).join('; ')}`);
}finally{
  await browser?.close();await stopSilo?.();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300}).catch(()=>{});
}
