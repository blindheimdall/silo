import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=10000,what='condition'){const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(60);}}

// Fixed result shapes, field and judge checks, model comparison and getting worse.
test('workflow results have a fixed shape and evaluations compare models over time',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-shape-test-'));
  const port=14337,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  await request('/connections',{provider:'compatible',key:'fixture-key-shape',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  const agent=async(name,model)=>(await request('/agents',{name,role:'Fixture',floor:2,provider:'compatible',model,instructions:'Fixture.'})).data;
  const good=await agent('Clerk Good','json-good'),fixer=await agent('Clerk Fixer','json-fix'),bad=await agent('Clerk Bad','json-bad'),judge=await agent('Judge','judge');
  const shape={fields:[{name:'total',type:'number'},{name:'supplier',type:'text'},{name:'due',type:'date'},{name:'paid',type:'boolean'},{name:'note',type:'text',required:false}]};
  const runOf=async(w,input='invoice')=>{const run=(await request('/workflows/'+w.id+'/run',{input})).data;return until(async()=>{const r=(await request('/state')).data.runs.find(r=>r.id===run.id);return r&&r.status!=='running'&&r;},10000,'run end');};
  const evalDone=async(w,n=1)=>until(async()=>{const e=(await request('/state')).data.workflows.find(x=>x.id===w.id).evals||[];return e.length>=n&&e.slice(0,n).every(x=>x.status==='done')&&e;},15000,'evaluation');

  let goodFlow;
  await t.test('bad shapes are refused when saving',async()=>{
    assert.equal((await request('/workflows',{name:'Twice',steps:[{agentId:good.id}],shape:{fields:[{name:'a'},{name:'A'}]}})).status,400);
    assert.equal((await request('/workflows',{name:'Too many',steps:[{agentId:good.id}],shape:{fields:Array.from({length:31},(_,i)=>({name:'f'+i}))}})).status,400);
    assert.equal((await request('/workflows',{name:'Odd name',steps:[{agentId:good.id}],shape:{fields:[{name:'{x}'}]}})).status,400);
    const off=(await request('/workflows',{name:'No shape',steps:[{agentId:good.id}],shape:{fields:[]}})).data;assert.ok(!off.shape,'no fields means no shape');
  });
  await t.test('a fitting answer becomes data with numbers, dates and yes or no made uniform',async()=>{
    goodFlow=(await request('/workflows',{name:'Invoice reader',steps:[{agentId:good.id,prompt:'Read the invoice.'}],shape,hook:true})).data;
    assert.equal(goodFlow.shape.fields.length,5);assert.equal(goodFlow.shape.fields[4].required,false);
    const run=await runOf(goodFlow);
    assert.equal(run.status,'completed',run.error);
    assert.deepEqual(run.data,{total:1200.5,supplier:'Acme',due:'2026-11-20',paid:false,note:null});
    assert.deepEqual(JSON.parse(run.output),run.data,'the output is the clean JSON');
    assert.ok(run.checks.includes('shape'));
    const hook=await fetch(`${origin}/hook/${goodFlow.hook}/${run.id}`).then(r=>r.json());assert.deepEqual(hook.data,run.data,'webhook callers get the fields');
  });
  await t.test('a wrong answer goes back once for a fix',async()=>{
    const w=(await request('/workflows',{name:'Invoice fixer',steps:[{agentId:fixer.id,prompt:'Read the invoice.'}],shape})).data;
    const run=await runOf(w);
    assert.equal(run.status,'completed',run.error);assert.equal(run.shapeFixed,true);assert.equal(run.data.total,1200.5);
    const tr=(await request('/traces/'+run.traceId)).data;assert.ok(tr.spans.some(x=>x.kind==='step'&&/Result shape/.test(x.name)),'the fix shows in the trace');
  });
  await t.test('an answer that stays wrong fails the run and says why',async()=>{
    const w=(await request('/workflows',{name:'Invoice guesser',steps:[{agentId:bad.id,prompt:'Read the invoice.'}],shape})).data;
    const run=await runOf(w);
    assert.equal(run.status,'failed');assert.match(run.error,/agreed shape/);assert.match(run.error,/total is not a number/);assert.match(run.error,/due is missing/);
  });
  await t.test('field and judge checks',async()=>{
    assert.equal((await request('/workflows/'+goodFlow.id+'/tests',{tests:[{name:'x',input:'i',checks:[{op:'field',text:'no equals sign'}]}]})).status,400);
    const saved=await request('/workflows/'+goodFlow.id+'/tests',{judgeId:judge.id,tests:[
      {name:'Right total',input:'invoice',checks:[{op:'field',text:'total=1200.5'},{op:'field',text:'Supplier=acme'},{op:'judge',text:'Names the supplier.'}]},
      {name:'Wrong total',input:'invoice',checks:[{op:'field',text:'total=99'}]}]});
    assert.equal(saved.status,200);assert.equal((await request('/state')).data.workflows.find(w=>w.id===goodFlow.id).judgeId,judge.id);
    assert.equal((await request('/workflows/'+goodFlow.id+'/evaluate',{})).status,202);
    const [e]=await evalDone(goodFlow);
    assert.equal(e.model,'as set');assert.equal(e.passed,1);assert.equal(e.total,2);
    assert.equal(e.results[0].ok,true,JSON.stringify(e.results[0].failures));assert.ok(e.judgeTokens>0,'the judge call is counted');
    assert.match(e.results[1].failures[0],/total is "1200.5", not "99"/);
  });
  await t.test('the same tests run on other models side by side',async()=>{
    assert.equal((await request('/workflows/'+goodFlow.id+'/evaluate',{models:[{provider:'openai',model:'gpt-x'}]})).status,400,'a provider without a key is refused');
    assert.equal((await request('/workflows/'+goodFlow.id+'/evaluate',{models:[{provider:'compatible',model:''}]})).status,400);
    const r=await request('/workflows/'+goodFlow.id+'/evaluate',{models:[{provider:'compatible',model:'json-good'},{provider:'compatible',model:'json-bad'}]});
    assert.equal(r.status,202);assert.equal(r.data.reports.length,2);
    const list=await evalDone(goodFlow,2);
    const [badRep,goodRep]=list;assert.equal(goodRep.group,badRep.group);
    assert.equal(goodRep.model,'compatible / json-good');assert.equal(goodRep.passed,1);
    assert.equal(badRep.model,'compatible / json-bad');assert.equal(badRep.passed,0);assert.match(badRep.results[0].failures[0],/agreed shape/);
    assert.equal(goodRep.worse,undefined,'a first run on a model has nothing to be worse than');
  });
  await t.test('getting worse is flagged against the last run on the same model',async()=>{
    const put=await request('/workflows/'+goodFlow.id,{name:goodFlow.name,steps:[{agentId:bad.id,prompt:'Read the invoice.'}]},'PUT');
    assert.equal(put.status,200);assert.equal(put.data.shape.fields.length,5,'the shape stays when it is not sent');
    await request('/workflows/'+goodFlow.id+'/evaluate',{});
    const [e]=await evalDone(goodFlow);
    assert.equal(e.passed,0);assert.deepEqual(e.worse,{from:1,version:1});
    const st=(await request('/state')).data;assert.ok(st.events.some(x=>/Invoice reader got worse/.test(x.title)),'an event says it got worse');
  });
  assert.ok(!errors.includes('TypeError'),errors);
});
