// Things that must not be lost or done twice: app triggers that find more than they hand on at once, notebook kernels
// still running a cell, MCP requests that time out, spending limits on the first call, test runs that must change
// nothing, and actions already done when a job is tried again.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {TRIGGERS} from '../app-triggers.mjs';
import {Kernels} from '../notebook.mjs';
import {McpClient} from '../mcp-client.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=30000,what='condition'){const end=Date.now()+ms;for(;;){const v=await check();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(150);}}

test('a trigger that finds more than it hands on keeps the rest for the next check',async()=>{
  const real=globalThis.fetch,mail=['m1','m2','m3'],rows=[['Client','Amount'],['Ana','1']];
  globalThis.fetch=async url=>{
    const u=new URL(url);
    if(u.pathname.endsWith('/users/me/messages'))return Response.json({messages:[...mail].reverse().map(id=>({id}))});
    if(u.pathname.includes('/users/me/messages/')){const id=u.pathname.split('/').pop();return Response.json({id,payload:{headers:[{name:'Subject',value:'Mail '+id}],mimeType:'text/plain',body:{data:Buffer.from('hi').toString('base64url')}}});}
    if(u.pathname.includes('/values/'))return Response.json({values:rows});
    return new Response('{}',{status:404});
  };
  try{
    const ctx={token:async()=>'t'},gmail=TRIGGERS['google.mail'],sheet=TRIGGERS['google.sheet_row'];
    let r=await gmail.check(ctx,{},null);assert.equal(r.items.length,0,'what was there before is left alone');
    for(let i=4;i<=15;i++)mail.push('m'+i);
    r=await gmail.check(ctx,{},r.seen);
    assert.deepEqual(r.items.map(i=>i.id),['m4','m5','m6','m7','m8','m9','m10','m11','m12','m13'],'ten a check, the oldest first');
    r=await gmail.check(ctx,{},r.seen);assert.deepEqual(r.items.map(i=>i.id),['m14','m15'],'the two left over come next');
    r=await gmail.check(ctx,{},r.seen);assert.equal(r.items.length,0,'nothing twice');

    let s=await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345'},null);
    for(let i=0;i<30;i++)rows.push(['Row '+i,String(i)]);
    s=await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345'},s.seen);
    assert.equal(s.items.length,20);assert.match(s.items[0].id,/^row3:/);assert.match(s.items.at(-1).id,/^row22:/);
    s=await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345'},s.seen);
    assert.deepEqual([s.items.length,s.items[0].id.split(':')[0],s.items.at(-1).id.split(':')[0]],[10,'row23','row32']);
    s=await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345'},s.seen);assert.equal(s.items.length,0);
    // A row deleted and a new one added at the end: it takes the old number, but not the old id.
    const before=(await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345'},{rows:rows.length-1})).items[0].id;
    rows.splice(3,1);rows.push(['Brand new','99']);
    const after=await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345'},{rows:rows.length-1});
    assert.equal(after.items[0].id.split(':')[0],before.split(':')[0]);assert.notEqual(after.items[0].id,before,'a new row is not taken for the deleted one');
    // With an id column, a row is known by its id wherever it is.
    rows.length=0;rows.push(['Order id','Client'],['A1','Ana'],['A2','Bob']);
    let k=await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345',idColumn:'order ID'},null);assert.equal(k.items.length,0);
    rows.splice(1,1);rows.splice(1,0,['A3','Cid']);rows.push(['','not ready']);
    k=await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345',idColumn:'order ID'},k.seen);
    assert.deepEqual(k.items.map(i=>i.id),['key:A3'],'inserted anywhere, a deleted one and an empty id do not count');
    rows[3][0]='A4';k=await sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345',idColumn:'order ID'},k.seen);assert.deepEqual(k.items.map(i=>i.id),['key:A4']);
    await assert.rejects(sheet.check(ctx,{sheet:'1AbCdEfGhIjKlMnOpQrStUvWxYz012345',idColumn:'Nope'},k.seen),/no column called "Nope"/);

    const posts=['p0'],feedCtx={fetch:async()=>new Response('<rss><channel>'+[...posts].reverse().map(id=>`<item><title>${id}</title><guid>${id}</guid><description>${id.startsWith('x')?'other':'release'} ${id}</description></item>`).join('')+'</channel></rss>')};
    const feed=TRIGGERS['web.feed'],cfg={url:'https://feed.example/rss',contains:'release'};
    let f=await feed.check(feedCtx,cfg,null);
    for(let i=1;i<=12;i++)posts.push('p'+i);posts.splice(3,0,'x1');
    f=await feed.check(feedCtx,cfg,f.seen);assert.deepEqual(f.items.map(i=>i.id),['p1','p2','p3','p4','p5','p6','p7','p8','p9','p10']);
    f=await feed.check(feedCtx,cfg,f.seen);assert.deepEqual(f.items.map(i=>i.id),['p11','p12'],'the rest of the matching items, and the other one never');
    f=await feed.check(feedCtx,cfg,f.seen);assert.equal(f.items.length,0);
  }finally{globalThis.fetch=real;}
});

test('a new notebook kernel never stops one that is still running a cell',async()=>{
  const fake=(busy,used)=>({busy,used,starting:false,dead:false,stopped:false,async start(){},stop(){this.stopped=true;this.dead=true;}});
  const k=new Kernels({work:os.tmpdir(),max:2,wait:400,make:()=>fake(false,Date.now())});
  const a=fake(true,1),b=fake(true,2);k.list.set('a',a);k.list.set('b',b);
  await assert.rejects(k.get('c','local'),/All 2 notebook kernels are busy/);
  assert.equal(a.stopped||b.stopped,false,'busy kernels are left alone');
  // When one finishes, the waiting request takes its place.
  const later=k.get('c','local').catch(e=>e);
  await wait(100);b.busy=false;k.wake();
  await later;assert.equal(b.stopped,true,'the idle one makes room');assert.equal(a.stopped,false,'the busy one keeps running');
  // The sweep leaves a long cell alone too.
  a.used=0;k.sweep();assert.equal(a.stopped,false);
  k.close();
});

test('an MCP request that times out or is stopped ends its HTTP request and tells the server',async t=>{
  const seen=[];let open=0,closed=0;
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;const m=JSON.parse(body);seen.push(m.method);
    if(m.method==='initialize'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',serverInfo:{name:'slow'}}}));}
    if(!m.id){res.writeHead(202);return res.end();}
    open++;res.on('close',()=>{closed++;});// tools/call never answers
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const c=new McpClient({transport:'http',url:`http://127.0.0.1:${server.address().port}/mcp`},{timeout:400});
  await assert.rejects(c.callTool('slow',{}),/did not answer tools\/call within/);
  await until(()=>closed===1&&seen.includes('notifications/cancelled'),5000,'the aborted request');
  const stop=new AbortController(),call=c.callTool('slow',{},stop.signal);await until(()=>open===2,5000,'second call');
  stop.abort(new Error('Stopped by you.'));await assert.rejects(call,/Stopped by you/);
  await until(()=>closed===2,5000,'the stopped request');
  const left=c.callTool('slow',{});await until(()=>open===3,5000,'third call');
  c.close();await assert.rejects(left,/closed/);await until(()=>closed===3,5000,'the request of a closed connector');
  assert.equal(c.pending.size,0);
});

async function startSilo(t,port){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-reliable-')),origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),15000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  return {request,state:async()=>(await request('/state')).data};
}

test('limits on every call, test runs that change nothing, and actions not done twice',async t=>{
  const {request,state}=await startSilo(t,14421);
  await request('/connections',{provider:'compatible',key:'fixture-key-reliable',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  const agent=async(name,model,tools=[])=>(await request('/agents',{name,role:'Fixture',floor:2,provider:'compatible',model,instructions:'Fixture.',tools})).data;
  const CALL=o=>'CALL '+JSON.stringify(o);
  const reply=async a=>(await state()).agents.find(x=>x.id===a.id).chats.at(-1)?.content||'';

  await t.test('a token limit holds on the first call and sets how long the answer may be',async()=>{
    const meter=await agent('Meter','max-echo');
    assert.equal((await request('/spending',{limits:{compatible:{tokens:100}}})).status,200);
    const r=await request('/agents/'+meter.id+'/chat',{message:'Hello'});
    assert.equal(r.status,402,'no room for a question and an answer: refused before the call');assert.match(r.data.error,/token limit/);
    await request('/spending',{limits:{compatible:{tokens:3000}}});
    assert.equal((await request('/agents/'+meter.id+'/chat',{message:'Hello'})).status,200);
    const max=Number((await reply(meter)).match(/max=(\d+)/)?.[1]);
    assert.ok(max>=256&&max<4096,`the answer is asked to fit what is left (${max})`);
    await request('/spending',{limits:{compatible:null}});
    await request('/agents/'+meter.id+'/chat',{message:'Hello'});assert.match(await reply(meter),/max=4096/);
  });

  await t.test('in a test run a resident reads, but writes nothing, whatever its tools allow',async()=>{
    const writer=await agent('Writer','tool-user',['write_files','read_files']);
    await request('/file',{name:'notes/in.md',content:'Inside'});
    const flow=(await request('/workflows',{name:'Writes',steps:[{agentId:writer.id,prompt:CALL({tool:'read_file',name:'notes/in.md'})+'\n'+CALL({tool:'write_file',name:'notes/out.md',content:'changed'})}]})).data;
    await request('/workflows/'+flow.id+'/tests',{repeat:1,tests:[{name:'Runs',input:'Go',checks:[{op:'contains',text:'Done'}]}]});
    assert.equal((await request('/workflows/'+flow.id+'/evaluate',{})).status,202);
    const run=await until(async()=>(await state()).runs.find(r=>r.workflowId===flow.id&&r.test&&r.status!=='running'),30000,'the test run');
    assert.equal(run.status,'completed',JSON.stringify(run.error||''));
    assert.match(run.output,/Test run: write_file was not run/);
    assert.equal((await state()).proposals.filter(p=>p.name==='notes/out.md').length,0,'no file proposed');
  });

  await t.test('a retry keeps the resident as the run began; resuming by hand takes it as it is now, and says so',async()=>{
    const ok=await agent('Opener','echo'),shaky=await agent('Shaky','failure');
    const flow=(await request('/workflows',{name:'Kept',steps:[{agentId:ok.id,prompt:'One'},{agentId:shaky.id,prompt:'Two'}]})).data;
    const job=(await request('/jobs',{workflowId:flow.id,maxAttempts:2,backoffMs:3000})).data;
    await until(async()=>(await state()).jobs.find(j=>j.id===job.id)?.status==='retrying',30000,'the first try to fail');
    const fixed=(await state()).agents.find(a=>a.id===shaky.id);
    assert.equal((await request('/agents/'+shaky.id,{name:fixed.name,role:fixed.role,floor:fixed.floor,level:fixed.level,provider:'compatible',model:'echo',instructions:fixed.instructions},'PUT')).status,200);
    await until(async()=>(await state()).jobs.find(j=>j.id===job.id)?.status==='failed',30000,'the second try');
    let st=await state();
    assert.ok(st.events.some(e=>e.title==='Shaky changed since Kept started'),'the change is said, and the retry kept the model it began with');
    const runId=st.jobs.find(j=>j.id===job.id).runId;
    assert.equal((await request('/runs/'+runId+'/resume',{})).status,202);
    const run=await until(async()=>{const r=(await state()).runs.find(x=>x.id===runId);return r?.status!=='running'&&r;},30000,'the resumed run');
    assert.equal(run.status,'completed',run.error);assert.match(run.output,/Two/);
    st=await state();assert.ok(st.events.some(e=>e.title==='Kept resumes with changed residents'));
  });

  await t.test('a job tried again does not repeat an action done before it failed',async()=>{
    const first=await agent('Greeter','echo'),doer=await agent('Doer','tool-user',['write_files']);
    // Step 2 writes a file and then fails (it asks for a tool it does not have), after the checkpoint of step 1.
    const flow=(await request('/workflows',{name:'Retry',steps:[{agentId:first.id,prompt:'Hello'},{agentId:doer.id,prompt:CALL({tool:'write_file',name:'notes/once.md',content:'one'})+'\n'+CALL({tool:'no_such_tool'})}]})).data;
    const job=await request('/jobs',{workflowId:flow.id,maxAttempts:2,backoffMs:50});assert.equal(job.status,202);
    await until(async()=>['failed','completed'].includes((await state()).jobs.find(j=>j.id===job.data.id)?.status),120000,'the job to end');
    const st=await state(),j=st.jobs.find(x=>x.id===job.data.id);
    assert.equal(j.attempts,2,'it was tried twice');
    assert.equal(st.proposals.filter(p=>p.name==='notes/once.md').length,1,'the file was proposed once, not once a try');
  });
});
