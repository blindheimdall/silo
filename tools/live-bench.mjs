// Measures how long a live page takes to get the whole state again over a slow connection, with a large history and
// several pages open at once. It starts its own SILO on a free port with a temporary folder (your data is never used),
// fills it with long runs, then opens the pages through a proxy that slows every connection down.
//
//   node tools/live-bench.mjs [--runs 150] [--active 10] [--pages 4] [--kbps 512] [--latency 150]
//
// active: runs not finished (they come back as interrupted after the start), with their plan, snapshot, journal and
// checkpoints, as a long job that stopped half way has them.
//
// Printed per page: the bytes of the whole state as sent (compressed) and as read, and the time until the page has it.
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {StateStore} from '../storage.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i>0?Number(process.argv[i+1]):d;};
const RUNS=arg('runs',150),ACTIVE=arg('active',10),PAGES=arg('pages',4),KBPS=arg('kbps',512),LATENCY=arg('latency',150);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});

async function boot(port,dir){
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(dir,'data'),SILO_WORK_DIR:path.join(dir,'workspace'),SILO_SECRET:'live-bench-secret',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let err='';child.stderr.on('data',b=>{err+=b;});
  await new Promise((ok,no)=>{const t=setTimeout(()=>no(Error('SILO did not start: '+err)),20000);child.stdout.on('data',b=>{if(String(b).includes('SILO is ready')){clearTimeout(t);ok();}});});
  return {stop:()=>new Promise(r=>{child.once('exit',r);child.kill();setTimeout(r,3000);})};
}

// A history like a busy silo after some weeks: long runs with several steps of output and a journal of tool results.
function fill(dir){
  const st=new StateStore(path.join(dir,'data')),s=st.load(()=>({}));
  // Words at random, some common and some made up, so the text compresses about as well as real answers do (about 3 to 1).
  const words='the of supplier invoice pump level resident report quarter total due order sector water pressure valve checked found missing late paid open closed review step result 12 48 3.5 2026 north east'.split(' ');
  const next=Math.random;
  const text=n=>{let out='';while(out.length<n)out+=(next()<.6?words[Math.floor(next()*words.length)]:Array.from({length:3+Math.floor(next()*7)},()=>String.fromCharCode(97+Math.floor(next()*26))).join(''))+(next()<.08?'. ':' ');return out.slice(0,n);};
  for(let i=0;i<RUNS;i++){
    const steps=Array.from({length:6},(_,k)=>({index:k,type:'agent',agentName:'Resident '+k,output:text(4000),tokens:900,time:Date.now()}));
    const toolCache=Object.fromEntries(Array.from({length:6},(_,k)=>[`${k}:0:0:0:read_file:x${k}`,{ok:true,summary:'read',text:text(3000),seq:k+1}]));
    s.runs.unshift({id:'bench'+i,workflowId:'w',name:'Bench '+i,input:text(600),trigger:'manual',status:'completed',started:Date.now()-i*60000,finished:Date.now()-i*60000+30000,total:6,steps,output:text(2000),tokens:5400,...(i%2&&{jobId:'job'+i,toolCache})});
  }
  for(let i=0;i<ACTIVE;i++){
    const plan=Array.from({length:8},(_,k)=>({type:'agent',agentId:'a'+k,prompt:text(800)}));
    const toolCache=Object.fromEntries(Array.from({length:30},(_,k)=>[`${k%8}:0:0:${k}:read_file:y${k}`,{ok:true,summary:'read',text:text(3000),seq:k+1}]));
    const steps=Array.from({length:4},(_,k)=>({index:k,type:'agent',agentId:'a'+k,agentName:'Resident '+k,output:text(4000),tokens:900,time:Date.now()}));
    s.runs.unshift({id:'active'+i,workflowId:'w'+i,name:'Long job '+i,input:text(600),trigger:'manual',status:'running',started:Date.now()-600000,total:8,at:4,steps,plan,snapshot:{version:1,steps:plan.map(p=>({...p,agent:{instructions:text(1500)}}))},outputs:steps.map(x=>x.output),toolCache,checkpoints:steps.map((x,k)=>({id:'cp'+k,stepIndex:k,nextAt:k+1,outputs:steps.slice(0,k+1).map(y=>y.output),toolSeq:k*7})),tokens:3600});
  }
  for(let i=0;i<300;i++)s.events.unshift({id:'e'+i,time:Date.now()-i*1000,title:'Event '+i,detail:text(120),type:'system'});
  return st.save(s).then(()=>st.close());
}

// A TCP proxy that lets each connection through at KBPS kilobytes a second, after LATENCY milliseconds.
function slowProxy(target){
  const server=net.createServer(client=>{
    const up=net.connect(target,'127.0.0.1');client.pipe(up);
    let queue=Promise.resolve();
    up.on('data',chunk=>{up.pause();queue=queue.then(async()=>{
      for(let at=0;at<chunk.length;at+=4096){const part=chunk.subarray(at,at+4096);await wait(LATENCY/20+part.length/(KBPS*1024)*1000);if(!client.destroyed)client.write(part);}
      up.resume();
    });});
    const end=()=>{client.destroy();up.destroy();};client.on('error',end);up.on('error',end);client.on('close',end);up.on('close',end);
  });
  return new Promise(r=>server.listen(0,'127.0.0.1',()=>r(server)));
}

// One page (Host is SILO's own address, as through a tunnel): connects, reads until the whole state has come, and reports the size and time.
function page(port,cookie,token,host=port){
  return new Promise((resolve,reject)=>{
    const started=performance.now();
    const req=http.get({host:'127.0.0.1',port,path:'/api/stream',headers:{host:'127.0.0.1:'+host,cookie,'x-silo-token':token,'Accept-Encoding':'br'}},res=>{
      let wire=0,text='';const z=zlib.createBrotliDecompress();
      res.on('data',c=>{wire+=c.length;});res.pipe(z);
      z.on('data',c=>{text+=c;const at=text.indexOf('event: full\ndata: ');if(at<0)return;const end=text.indexOf('\n\n',at);if(end<0)return;
        const ms=performance.now()-started,size=end-at;req.destroy();resolve({ms:Math.round(ms),wire,size});});
      z.on('error',()=>{});
    });
    req.on('error',e=>{if(!req.destroyed)reject(e);});
  });
}

const dir=await fs.mkdtemp(path.join(os.tmpdir(),'silo-live-bench-'));
let silo,proxy;
try{
  const port=await freePort();
  silo=await boot(port,dir);await silo.stop();
  await fill(dir);
  silo=await boot(port,dir);
  const ses=await fetch(`http://127.0.0.1:${port}/api/session`),{token}=await ses.json(),cookie=ses.headers.get('set-cookie').split(';')[0];
  const state=await (await fetch(`http://127.0.0.1:${port}/api/state`,{headers:{cookie,'x-silo-token':token}})).text();
  proxy=await slowProxy(port);
  console.log(`State: ${(state.length/1024).toFixed(0)} KB as JSON (${RUNS} finished runs, ${ACTIVE} not finished). ${PAGES} pages at ${KBPS} KB/s, ${LATENCY} ms.`);
  const direct=await page(port,cookie,token);
  console.log(`Direct: ${direct.ms} ms, ${(direct.wire/1024).toFixed(0)} KB sent, ${(direct.size/1024).toFixed(0)} KB read`);
  const all=await Promise.all(Array.from({length:PAGES},()=>page(proxy.address().port,cookie,token,port)));
  all.forEach((r,i)=>console.log(`Page ${i+1}: ${r.ms} ms, ${(r.wire/1024).toFixed(0)} KB sent, ${(r.size/1024).toFixed(0)} KB read`));
}finally{
  proxy?.close();await silo?.stop();await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:300});
}
