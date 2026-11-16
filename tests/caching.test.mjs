// Caching: Anthropic and OpenAI are asked to cache what repeats, what was read from their cache is priced as such and
// shows as saved, and the same question can get the same answer again without a call.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms,what)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(50);}};
const near=(a,b,what)=>assert.ok(Math.abs(a-b)<1e-9,`${what}: ${a} is not ${b}`);

test('prompt caching, cached prices, savings and answers given again',async t=>{
  const port=14487,temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-cache-test-')),origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  const state=async()=>(await request('/state')).data;
  const today=new Date().toISOString().slice(0,10),usage=async p=>(await state()).usage.days[today]?.[p]||{};
  for(const provider of ['anthropic','openai'])await request('/connections',{provider,key:'fixture-key-'+provider,model:'cache-probe'});
  await request('/spending',{prices:{'anthropic:cache-probe':{input:10,output:20},'openai:cache-probe':{input:2,output:8,cached:0.5}}});
  const claude=(await request('/agents',{name:'Cacher',role:'Fixture',floor:3,provider:'anthropic',model:'cache-probe',instructions:'Fixture.'})).data;
  const gpt=(await request('/agents',{name:'Keyed',role:'Fixture',floor:3,provider:'openai',model:'cache-probe',instructions:'Fixture.'})).data;
  const ask=async(a,message)=>{const r=await request('/agents/'+a.id+'/chat',{message});assert.equal(r.status,200,JSON.stringify(r.data));return JSON.parse(r.data.text);};

  await t.test('Anthropic: the instructions are marked, and the conversation once it goes on',async()=>{
    const first=await ask(claude,'Hello.');
    assert.ok(Array.isArray(first.system),'the instructions as a block');assert.deepEqual(first.system.at(-1).cache_control,{type:'ephemeral'});
    assert.equal(first.top,null,'a first question alone is not written to the cache');
    const second=await ask(claude,'And again.');
    assert.deepEqual(second.top,{type:'ephemeral'},'the conversation so far is cached once it goes on');
    const u=await usage('anthropic');
    assert.equal(u.cached,1600);assert.equal(u.written,400);assert.equal(u.input,2020,'input counts what was read and written, not only the rest');
    // Per call: 10 plain at $10, 800 read at a tenth, 200 written at 1.25 times, 7 out at $20.
    near(u.cost,2*(10*10+800*1+200*12.5+7*20)/1e6,'cost');near(u.saved,2*(800*9-200*2.5)/1e6,'saved');
  });
  await t.test('OpenAI: a cache key per resident, and cached input at its own price',async()=>{
    const r=await ask(gpt,'Hello.');
    assert.equal(r.key,'silo-'+gpt.id);
    const u=await usage('openai');
    assert.equal(u.cached,800);assert.equal(u.input,1000);
    near(u.cost,(200*2+800*0.5+7*8)/1e6,'cost');near(u.saved,800*1.5/1e6,'saved');
    const trace=(await request('/traces')).data.traces[0];
    assert.ok(trace,'a trace');
  });
  await t.test('turned off, nothing is marked or keyed; a wrong cached price changes nothing',async()=>{
    assert.equal((await request('/spending',{caching:{prompt:false}})).status,200);
    assert.equal(typeof (await ask(claude,'Plain.')).system,'string');
    assert.equal((await ask(gpt,'Plain.')).key,null);
    assert.equal((await request('/spending',{prices:{'openai:cache-probe':{input:2,output:8,cached:-1}}})).status,400);
    assert.equal((await state()).prices['openai:cache-probe'].cached,0.5);
    assert.equal((await request('/spending',{caching:{answers:{minutes:0}}})).status,400);
    await request('/spending',{caching:{prompt:true}});
  });
  await t.test('the same question to the same resident gets the same answer again, without a call',async()=>{
    await request('/connections',{provider:'compatible',key:'fixture-key-coin',model:'coin',endpoint:'https://example.com/v1/chat/completions'});
    await request('/spending',{prices:{'compatible:coin':{input:1,output:1}}});
    const coin=(await request('/agents',{name:'Coin',role:'Fixture',floor:3,provider:'compatible',model:'coin',instructions:'Fixture.'})).data;
    const flow=(await request('/workflows',{name:'Supplier',steps:[{agentId:coin.id,prompt:'Name the supplier.'}]})).data;
    const run=async()=>{const id=(await request('/workflows/'+flow.id+'/run',{input:'invoice 7'})).data.id;const r=await until(async()=>{const r=(await state()).runs.find(x=>x.id===id);return r&&!['running','queued'].includes(r.status)&&r;},30000,'the run');assert.equal(r.status,'completed',JSON.stringify(r).slice(0,400));return r.steps.at(-1).output;};
    const calls=async()=>(await request('/audit?q=model.call&limit=500')).data.records.filter(x=>x.actor==='Coin').length;
    const a=await run(),b=await run();
    assert.notEqual(a,b,'without reuse the coin model answers differently each time');
    assert.equal((await request('/spending',{caching:{answers:{enabled:true,minutes:30}}})).status,200);
    // A record written while the log is read can fall just after the end of the read, so wait for the three calls.
    const c=await run();await until(async()=>await calls()===3,5000,'three model calls in the audit log');
    const d=await run();await wait(300);
    assert.equal(d,c,'the answer is given again');
    assert.equal(await calls(),3,'no model call was made, and none is in the audit log');
    const u=await usage('compatible');assert.equal(u.reused,1);assert.ok(u.saved>0,'what it would have cost is saved');
    const e=(await request('/workflows/'+flow.id+'/run',{input:'invoice 8'})).data.id;
    await until(async()=>{const r=(await state()).runs.find(x=>x.id===e);return r&&r.status==='completed';},30000,'the other run');
    assert.equal((await usage('compatible')).reused,1,'another brief asks the model');
    await request('/spending',{caching:{answers:{enabled:false}}});
    const f=await run();assert.equal((await usage('compatible')).reused,1,'turned off, it asks again');assert.ok(typeof f==='string');
  });
});
