// Growing without slowing down or losing track: saves that only serialize what can have changed, checkpoints that do not
// copy the tool results, live pages that fall behind, changes outside SILO whose result is unknown, events that wait
// for their workflow, and the numbers the 3D profiler reports.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import {Writable} from 'node:stream';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {StateStore} from '../storage.mjs';
import {liveChannel} from '../live-stream.mjs';
import {enqueueTrigger,queueInfo,countLost,QUEUE_MAX} from '../trigger-queue.mjs';
import {frameStats,spread} from '../public/profile-3d.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=30000,what='condition'){const end=Date.now()+ms;for(;;){const v=await check();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(100);}}

test('a save serializes only rows that can have changed, and still writes every change',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'silo-scale-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const read=()=>{const r=new StateStore(dir);try{return r.reconstructFromTables();}finally{r.db.close();r.db=null;r.closed=true;}};
  const st=new StateStore(dir,{settled:(c,x)=>c==='runs'&&x.status==='completed',settleMs:40,verifyEvery:3600000});
  const s=st.load(()=>({agents:[],events:[],runs:[{id:'done',status:'completed',n:1},{id:'live',status:'running',n:1}]}));
  await st.save(s);
  await st.save(s);assert.equal(st.stats.skipped,0,'a finished row is not skipped before it has been quiet for a while');
  await wait(60);await st.save(s);await st.save(s);
  assert.equal(st.stats.skipped,1,'then it is skipped');assert.equal(st.stats.serialized,st.stats.rows-1);
  s.runs[1].n=2;await st.save(s);assert.equal(read().runs[1].n,2,'rows still going are always compared');
  s.runs[0].n=5;await st.save(s);assert.equal(read().runs[0].n,1,'a change to a quiet row nobody named waits');
  await st.save(s,[s.runs[0]]);assert.equal(read().runs[0].n,5,'a named row is written');
  s.runs[0].status='failed';await st.save(s);assert.equal(read().runs[0].status,'failed','a row that is no longer finished is compared again');
  s.runs[0].status='completed';await st.save(s);await wait(60);await st.save(s);await st.save(s);
  s.runs[0].n=6;await st.save(s);assert.equal(read().runs[0].n,5);
  st.verifyEvery=0;await st.save(s);assert.equal(read().runs[0].n,6,'the regular full comparison catches it');assert.ok(st.stats.verifies>=2);
  st.verifyEvery=3600000;await wait(60);await st.save(s);s.runs[0].n=7;await st.save(s);assert.equal(read().runs[0].n,6);
  st.close();assert.equal(read().runs[0].n,7,'and closing compares every row');
  assert.ok(st.stats.saves>10&&st.stats.maxMs>=st.stats.lastMs&&st.stats.bytes>0);
});

test('a live page that does not keep up gets merged updates, and is closed when it stays behind',async()=>{
  let now=0;const res={writableLength:0,writableNeedDrain:false,writes:[],ended:false,write(t){this.writes.push(t);return true;},end(){this.ended=true;}};
  let closed=0;const c=liveChannel(res,'',{limits:{behind:100,cut:1000,stall:50},now:()=>now,onClose:()=>closed++});
  c.send('patch',{a:1});c.send('live',{b:2});c.flush();
  assert.equal(res.writes.length,1,'one write a tick');assert.match(res.writes[0],/event: patch[^]*event: live/);
  res.writableLength=500;assert.equal(c.behind(),true);assert.equal(c.closed,false,'a moment behind is fine');
  now+=30;res.writableLength=0;assert.equal(c.behind(),false,'and it catches up');assert.equal(c.behindSince,0);
  res.writableNeedDrain=true;assert.equal(c.behind(),true);now+=60;c.behind();assert.equal(c.closed,true,'too long behind: closed');assert.equal(closed,1);
  c.send('patch',{late:true});c.flush();assert.equal(res.writes.length,1,'nothing more is written');
  const res2={writableLength:5000,writableNeedDrain:false,write(){return true;},end(){}},c2=liveChannel(res2,'',{limits:{behind:100,cut:1000,stall:5000},now:()=>now});
  assert.equal(c2.behind(),true);assert.equal(c2.closed,true,'too much unsent: closed at once');
  const end=liveChannel({writableLength:0,write(t){this.last=t;},end(){}},'');end.send('end',{reason:'signed out'});end.close();
  // Compressed: the joined messages are one block the page can read as soon as it comes.
  const chunks=[];const sink=new Writable({write(ch,_,cb){chunks.push(ch);cb();}});
  const z=liveChannel(sink,'gzip');z.send('full',{tag:'t1'});z.send('live',{id:'x',text:'hi'});z.flush();await wait(20);
  const text=zlib.gunzipSync(Buffer.concat(chunks),{finishFlush:zlib.constants.Z_SYNC_FLUSH}).toString();
  assert.match(text,/event: full\ndata: \{"tag":"t1"\}[^]*event: live/);z.close();
});

test('events that wait for a workflow are counted, and none is lost without a trace',()=>{
  const w={missedPolicy:'queue'};
  for(let i=0;i<QUEUE_MAX;i++)assert.deepEqual(enqueueTrigger(w,'file','f'+i,{now:1000+i}).dropped,[]);
  const r=enqueueTrigger(w,'file','late',{now:5000});
  assert.equal(r.queued,true);assert.deepEqual(r.dropped.map(x=>x.input),['f0'],'the oldest goes');
  let q=queueInfo(w,'The sector has no power.');
  assert.deepEqual([q.waiting,q.oldest,q.why,q.dropped,q.lastLost.kind],[QUEUE_MAX,1001,'The sector has no power.',1,'dropped']);
  assert.match(q.lastLost.detail,/file change from 1970/);
  const c={missedPolicy:'coalesce'};enqueueTrigger(c,'schedule','same');enqueueTrigger(c,'schedule','same');
  assert.deepEqual([queueInfo(c).waiting,queueInfo(c).merged],[1,1],'the same event twice waits once, and that is counted');
  const s={missedPolicy:'skip'};assert.equal(enqueueTrigger(s,'email','x').queued,false);assert.equal(queueInfo(s).skipped,1);
  countLost(c,'gaveUp','The resident was removed.');assert.equal(queueInfo(c).gaveUp,1);
  assert.equal(queueInfo({}).why,'','nothing waits, so there is no reason');
});

test('the 3D profiler reports typical and slow frames',()=>{
  const r=frameStats({gap:[16,17,16,16,48],tick:[1,1,1,2,1],draw:[5,6,5,5,30],feeds:[0,0,0,0,9],lowFrames:1,ratio:1.5,size:[800,500]},1000);
  assert.deepEqual([r.frames,r.fps,r.late,r.gap.p50,r.work.max],[5,5,1,16,40]);
  assert.deepEqual(r.slowest[0],{work:40,tick:1,draw:30,feeds:9},'the slowest frame says what took the time');
  assert.deepEqual(spread([]),{p50:0,p95:0,p99:0,max:0});
  assert.equal(spread(Array.from({length:100},(_,i)=>i+1)).p99,99);
});

// A shop whose order endpoint can answer, break the connection after reading the order, or never answer.
function shop(){
  const s={mode:'ok',posts:[]};
  const spec={openapi:'3.0.0',info:{title:'Shop'},servers:[{url:'/'}],paths:{'/orders':{post:{operationId:'createOrder',requestBody:{content:{'application/json':{schema:{type:'object',required:['item'],properties:{item:{type:'string'}}}}}},responses:{}}}}};
  s.server=http.createServer((req,res)=>{let raw='';req.on('data',c=>{raw+=c;});req.on('end',()=>{
    if(req.url==='/spec.json'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(spec));}
    s.posts.push(JSON.parse(raw||'{}'));
    if(s.mode==='drop')return req.socket.destroy();
    if(s.mode==='hang')return;
    if(s.mode==='gateway'){res.writeHead(504,{'Content-Type':'text/plain'});return res.end('upstream timed out');}
    res.writeHead(201,{'Content-Type':'application/json'});res.end(JSON.stringify({order:s.posts.length}));
  });});
  return s;
}
async function boot(port,dataDir){
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(dataDir,'data'),SILO_WORK_DIR:path.join(dataDir,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:'scale-test-secret'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  const stop=async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,3000);});};
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),15000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  return {request,state:async()=>(await request('/state')).data,stop};
}

test('a change outside SILO with an unknown result waits for you, and is never sent twice by itself',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-scale-')),sh=shop();let silo;
  // Stop SILO first, then the shop and the folder: on Windows an open database keeps the folder from being removed.
  t.after(async()=>{await silo?.stop();sh.server.closeAllConnections();sh.server.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:300});});
  await new Promise(r=>sh.server.listen(0,'127.0.0.1',r));
  silo=await boot(14441,temp);
  const added=await silo.request('/mcp',{name:'Shop',transport:'openapi',spec:`http://127.0.0.1:${sh.server.address().port}/spec.json`});assert.equal(added.status,201,JSON.stringify(added.data));
  const flow=(await silo.request('/workflows',{name:'Order',steps:[{type:'action',app:'mcp:'+added.data.id,op:'createOrder',fields:{'body.item':'{{brief}}'}}]})).data;
  const run=async(input)=>(await silo.request('/workflows/'+flow.id+'/run',{input})).data.id;
  const settled=async id=>until(async()=>{const r=(await silo.state()).runs.find(x=>x.id===id);return r&&!['running','queued'].includes(r.status)&&r;},30000,'the run');

  await t.test('the connection breaks after the order was sent: the run waits for a check',async()=>{
    sh.mode='drop';const id=await run('lamp');const r=await settled(id);
    assert.equal(r.status,'check',r.error);assert.equal(sh.posts.length,1,'sent once, not tried again');
    assert.deepEqual([r.check.app,r.check.op,r.check.step],['Shop','createOrder',0]);assert.match(r.check.input,/"item":"lamp"/);assert.match(r.check.error,/fetch failed|other side closed|UND_ERR/);
    const st=await silo.state();assert.ok(st.events.some(e=>e.title==='Check needed: Order'));
    assert.equal((await silo.request('/runs/'+id+'/resume',{})).status,202);
    assert.equal((await settled(id)).status,'check','a resume without an answer asks again and sends nothing');assert.equal(sh.posts.length,1);
    sh.mode='ok';
    assert.equal((await silo.request('/runs/'+id+'/check',{done:'yes'})).status,400);
    assert.equal((await silo.request('/runs/'+id+'/check',{done:true,result:'Order 41 is in the shop.'})).status,202);
    const done=await settled(id);
    assert.equal(done.status,'completed',done.error);assert.match(done.output,/Order 41 is in the shop\./);assert.equal(sh.posts.length,1,'it went through, so it is not sent again');
    assert.equal(done.checked[0].done,true);
    assert.equal((await silo.request('/runs/'+id+'/check',{done:true})).status,409);
  });

  await t.test('a gateway timeout is unknown too; "it did not go through" sends it again',async()=>{
    sh.mode='gateway';const before=sh.posts.length,id=await run('chair');const r=await settled(id);
    assert.equal(r.status,'check');assert.match(r.check.error,/504/);
    sh.mode='ok';assert.equal((await silo.request('/runs/'+id+'/check',{done:false})).status,202);
    const done=await settled(id);assert.equal(done.status,'completed',done.error);
    assert.equal(sh.posts.length,before+2);assert.match(done.output,/"order": ?\d+/);
  });

  await t.test('SILO stops while the order is on its way: after the restart it asks before sending again',async()=>{
    sh.mode='hang';const before=sh.posts.length,id=await run('desk');
    await until(()=>sh.posts.length>before,15000,'the order to reach the shop');
    await silo.stop();sh.mode='ok';
    silo=await boot(14441,temp);
    let r=(await silo.state()).runs.find(x=>x.id===id);assert.equal(r.status,'interrupted');
    assert.equal((await silo.request('/runs/'+id+'/resume',{})).status,202);
    r=await settled(id);assert.equal(r.status,'check');assert.match(r.error,/SILO stopped while it was being sent/);assert.equal(sh.posts.length,before+1);
  });
});

test('checkpoints point into the run journal instead of copying it, and the server reports its own speed',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-scale-'));let silo;
  t.after(async()=>{await silo?.stop();await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:300});});
  silo=await boot(14443,temp);const {request,state}=silo;
  await request('/connections',{provider:'compatible',key:'fixture-key-scale',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  const agent=async(name,model,tools=[])=>(await request('/agents',{name,role:'Fixture',floor:2,provider:'compatible',model,instructions:'Fixture.',tools})).data;
  const CALL=o=>'CALL '+JSON.stringify(o);
  const first=await agent('Reader','tool-user',['read_files']),doer=await agent('Writer','tool-user',['write_files']);
  await request('/file',{name:'notes/a.md',content:'A'});
  const flow=(await request('/workflows',{name:'Journal',steps:[{agentId:first.id,prompt:CALL({tool:'read_file',name:'notes/a.md'})},{agentId:doer.id,prompt:CALL({tool:'write_file',name:'notes/b.md',content:'B'})+'\n'+CALL({tool:'no_such_tool'})}]})).data;
  const job=(await request('/jobs',{workflowId:flow.id,maxAttempts:1})).data;
  const ended=await until(async()=>{const j=(await state()).jobs.find(x=>x.id===job.id);return ['failed','completed'].includes(j?.status)&&j;},60000,'the job');
  let run=(await state()).runs.find(r=>r.id===ended.runId);
  assert.equal(run.checkpoints.length,1);assert.equal(run.checkpoints[0].toolCache,undefined,'no copy of the results');assert.equal(run.checkpoints[0].toolSeq,1);
  const seqs=Object.values(run.toolCache).map(v=>v.seq).sort();assert.deepEqual(seqs,[1,2],'each result once, numbered');
  const back=await request('/jobs/'+job.id+'/rewind',{stepIndex:0});assert.equal(back.status,202);
  assert.deepEqual(Object.values(back.data.run.toolCache).map(v=>v.seq),[1],'going back drops what came after the checkpoint');

  await request('/workflows',{name:'Waiting',steps:[{agentId:first.id,prompt:'Hi'}],missedPolicy:'queue'});
  const w=(await state()).workflows.find(x=>x.name==='Waiting');
  assert.deepEqual([w.queue.waiting,w.queue.max,w.queue.dropped],[0,15,0],'the card can show the queue');

  const perf=(await request('/system/update')).data.perf;
  assert.ok(perf.storage.saves>0&&perf.storage.rows>0&&perf.storage.lastMs>=0,'saves are measured');
  assert.ok(perf.loop.p99>=0&&perf.loop.max>=perf.loop.p50,'so is how late the server answers');
  assert.equal(typeof perf.live.streams,'number');
});
