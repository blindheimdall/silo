import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseJudge,scoreAttempt,summarizeCase,wilson,suiteScore,compareCase,compareReports,significantDrop,lineDiff,judgeTrust,repeatOf} from '../evals.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('scores, repeated attempts, comparisons and judge trust',()=>{
  assert.deepEqual([parseJudge('PASS 9\nGood.').pass,parseJudge('PASS 9\nGood.').score],[true,.9]);
  assert.equal(parseJudge('PASS 5\nHalf.').pass,false,'a PASS below the bar is a FAIL');
  assert.deepEqual([parseJudge('FAIL\nNo.').pass,parseJudge('FAIL\nNo.').score],[false,0]);
  assert.deepEqual([parseJudge('PASS\nYes.').pass,parseJudge('PASS\nYes.').score],[true,1]);
  assert.equal(parseJudge('8/10 because').score,.8);assert.equal(parseJudge('8/10 because').pass,true);
  assert.equal(parseJudge('PASS: the 2026 invoice is named').score,1,'a year is not a score');
  assert.equal(parseJudge('I cannot tell').understood,false);
  assert.equal(scoreAttempt([{pass:true,weight:3},{pass:false}]),.75);
  assert.equal(scoreAttempt([{pass:false,score:.6,weight:2},{pass:true}]),(1.2+1)/3);
  const s=summarizeCase([{ok:true,score:1},{ok:false,score:.5},{ok:true,score:1}]);
  assert.equal(s.ok,false);assert.equal(s.flaky,true);assert.equal(s.passes,2);assert.ok(Math.abs(s.rate-2/3)<1e-9);
  const [lo,hi]=wilson(9,10);assert.ok(lo>.55&&lo<.6&&hi>.98&&hi<=1);assert.deepEqual(wilson(0,0),[0,1]);
  assert.equal(suiteScore([{score:1},{score:.5},{ok:true}]),83.3);
  assert.equal(compareCase(null,{rate:1}),'new');
  assert.equal(compareCase({rate:1},{rate:0}),'broke');assert.equal(compareCase({rate:0},{rate:1}),'fixed');
  assert.equal(compareCase({rate:1,score:1},{rate:2/3,score:2/3}),'flaky','one unlucky run out of three is not a break');
  assert.equal(compareCase({rate:1,score:1},{rate:1,score:.7}),'worse','passing as often with a clearly lower score');
  assert.equal(compareCase({ok:true},{rate:1,score:1}),'same','older reports compare by pass');
  assert.equal(significantDrop(2,3,1,3),false);assert.equal(significantDrop(27,30,18,30),true);assert.equal(significantDrop(5,10,8,10),false);
  const prev={id:'p',score:100,results:[{testId:'a',rate:1,score:1,passes:3,attempts:3},{testId:'b',rate:1,score:1,passes:3,attempts:3}]};
  const noisy={score:83.3,results:[{testId:'a',rate:2/3,score:2/3,passes:2,attempts:3},{testId:'b',rate:1,score:1,passes:3,attempts:3},{testId:'c',rate:1,score:1,passes:1,attempts:1}]};
  const c=compareReports(prev,noisy);assert.equal(c.worse,false,'noise is not a regression');assert.deepEqual(c.cases,{a:'flaky',b:'same',c:'new'});assert.equal(c.baseline,'p');
  const bad=compareReports(prev,{score:50,results:[{testId:'a',rate:0,score:0,passes:0,attempts:3},{testId:'b',rate:1,score:1,passes:3,attempts:3}]});
  assert.equal(bad.worse,true);assert.equal(bad.count.broke,1);assert.equal(bad.scoreDelta,-50);
  assert.equal(compareReports(null,noisy).worse,false,'nothing to be worse than');
  assert.deepEqual(lineDiff('a\nb\nc','a\nx\nc'),[[' ','a'],['-','b'],['+','x'],[' ','c']]);
  assert.deepEqual(judgeTrust({agree:4,disagree:0}),{agree:4,total:4,rate:1,reliable:null});
  assert.equal(judgeTrust({agree:3,disagree:2}).reliable,false);assert.equal(judgeTrust({agree:8,disagree:1}).reliable,true);
  assert.equal(repeatOf(undefined),3);assert.equal(repeatOf(9),3);assert.equal(repeatOf(1),1);
});

const until=async(fn,ms,what)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await new Promise(r=>setTimeout(r,60));}};

test('residents and workflows: suites, held changes, regressions, real cases and judge votes',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-evals-test-'));
  const port=14393,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  const st=async()=>(await request('/state')).data;
  await request('/connections',{provider:'compatible',key:'fixture-key-evals',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  const agent=async(name,model,instructions='Fixture.')=>(await request('/agents',{name,role:'Fixture',floor:2,provider:'compatible',model,instructions})).data;
  const fruit=await agent('Fruit Clerk','banana','Always mention BANANA.'),judge=await agent('Judge','judge'),coin=await agent('Coin','coin');
  const put=(a,patch)=>request('/agents/'+a.id,{name:a.name,role:a.role,floor:a.floor,level:a.level,provider:a.provider,model:a.model,instructions:a.instructions,...patch},'PUT');
  const suiteDone=async(kind,id,n=1)=>until(async()=>{const o=(await st())[kind==='agent'?'agents':'workflows'].find(x=>x.id===id),e=o.evals||[];return e.length>=n&&e.slice(0,n).every(x=>x.status==='done'||x.status==='interrupted')&&!o.candidate?.status?.startsWith('testing')&&o;},20000,kind+' tests');

  await t.test('a resident has its own tests, run a few times each, without touching its conversation',async()=>{
    assert.equal((await request('/agents/'+fruit.id+'/tests',{tests:[{name:'x',input:'i',checks:[{op:'field',text:'a=1'}]}]})).status,400,'no result shape for a resident');
    assert.equal((await request('/agents/'+fruit.id+'/tests',{judgeId:fruit.id,tests:[{name:'x',input:'i',checks:[{op:'contains',text:'x'}]}]})).status,400,'no judging itself');
    assert.equal((await request('/agents/'+fruit.id+'/tests',{repeat:9,tests:[{name:'x',input:'i',checks:[{op:'contains',text:'x'}]}]})).status,400);
    assert.equal((await request('/agents/'+fruit.id+'/tests',{tests:[{name:'x',input:'i',checks:[{op:'maxcost',text:'free'}]}]})).status,400,'limits are numbers');
    const saved=await request('/agents/'+fruit.id+'/tests',{repeat:2,gate:'hold',judgeId:judge.id,tests:[{name:'Says it',input:'What do you sell?',checks:[{op:'contains',text:'banana',weight:3},{op:'maxtokens',text:'100000'},{op:'missing',text:'TODO'}]}]});
    assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.tests[0].checks[0].weight,3);
    const r=await request('/agents/'+fruit.id+'/evaluate',{});assert.equal(r.status,202);
    const a=await suiteDone('agent',fruit.id),e=a.evals[0];
    assert.equal(e.status,'done');assert.equal(e.repeat,2);assert.equal(e.passed,1);assert.equal(e.score,100);
    assert.equal(e.results[0].attempts,2);assert.equal(e.results[0].rate,1);assert.equal(e.results[0].output,undefined,'answers stay off the page state');
    assert.equal((a.chats||[]).length,0,'the conversation is untouched');assert.equal(a.evalDefs,undefined);
    const full=(await request('/evals/'+e.id)).data;assert.equal(full.kind,'agent');assert.match(full.report.results[0].output,/BANANA/);
  });

  await t.test('a change that makes it worse is held, shown and can be dropped',async()=>{
    const res=await put(fruit,{instructions:'Be brief.'});assert.equal(res.status,200);
    assert.equal(res.data.instructions,'Always mention BANANA.','the tested part waits');assert.equal(res.data.candidate.status,'testing');assert.deepEqual(res.data.candidate.changed,['instructions']);
    const a=await until(async()=>{const x=(await st()).agents.find(x=>x.id===fruit.id);return x.candidate?.status!=='testing'&&x;},20000,'held change tested');
    assert.equal(a.candidate.status,'worse');assert.equal(a.instructions,'Always mention BANANA.');assert.equal(a.evalWorse,undefined,'what is in use did not get worse');
    const rep=a.evals.find(e=>e.id===a.candidate.reportId);assert.equal(rep.candidate,'held');assert.equal(rep.compare.count.broke,1);assert.deepEqual(rep.worse,{from:1,version:1});
    const diff=(await request('/agents/'+fruit.id+'/candidate')).data;
    assert.ok(diff.diff.some(([k,l])=>k==='-'&&l.includes('BANANA'))&&diff.diff.some(([k,l])=>k==='+'&&l==='Be brief.'));
    const out=(await request('/evals/'+rep.id+'/diff?test='+rep.results[0].testId)).data;
    assert.match(out.before,/BANANA/);assert.ok(out.output.some(([k])=>k==='+'));assert.ok(out.def.some(([k,l])=>k==='+'&&l==='Be brief.'),'the prompt difference is shown');
    assert.ok((await st()).events.some(x=>/The held change to Fruit Clerk got worse/.test(x.title)));
    assert.equal((await request('/agents/'+fruit.id+'/candidate',{action:'reject'})).status,200);
    const after=(await st()).agents.find(x=>x.id===fruit.id);assert.equal(after.candidate,undefined);assert.equal(after.evals.find(e=>e.id===rep.id).candidate,'rejected');
  });

  await t.test('a change that holds goes in by itself',async()=>{
    assert.equal((await put(fruit,{instructions:'Mention BANANA twice.'})).status,200);
    const a=await until(async()=>{const x=(await st()).agents.find(x=>x.id===fruit.id);return !x.candidate&&x;},20000,'change applied');
    assert.equal(a.instructions,'Mention BANANA twice.');assert.equal(a.evals[0].candidate,'applied');
    assert.ok((await st()).events.some(x=>/Change applied: Fruit Clerk/.test(x.title)));
    const nothing=await put(a,{role:'Grocer'});assert.equal(nothing.data.candidate,undefined,'a change outside the tests is not held');assert.equal(nothing.data.role,'Grocer');
  });

  let flow;
  await t.test('a resident change tests the workflows that use it and marks it when they get worse',async()=>{
    flow=(await request('/workflows',{name:'Fruit stand',steps:[{agentId:fruit.id,prompt:'Answer the customer.'}]})).data;
    await request('/workflows/'+flow.id+'/tests',{repeat:1,gate:'test',learn:true,tests:[{name:'Mentions it',input:'Hello',checks:[{op:'contains',text:'BANANA'}]}]});
    await request('/workflows/'+flow.id+'/evaluate',{});await suiteDone('workflow',flow.id);
    await request('/agents/'+fruit.id+'/tests',{gate:'off',tests:(await st()).agents.find(x=>x.id===fruit.id).tests});
    const now=(await st()).agents.find(x=>x.id===fruit.id);
    assert.equal((await put(now,{instructions:'Say little.'})).data.instructions,'Say little.','gate off: the change goes in');
    const w=await until(async()=>{const x=(await st()).workflows.find(x=>x.id===flow.id);return x.evals.length>=2&&x.evals[0].status==='done'&&x;},20000,'workflow tested after the change');
    assert.equal(w.evals[0].trigger,'change');assert.equal(w.evals[0].cause.name,'Fruit Clerk');assert.ok(w.evals[0].worse);
    const s1=await st();assert.equal(s1.agents.find(x=>x.id===fruit.id).evalWorse.subject,'Fruit stand');
    assert.equal(s1.activity[fruit.id].state,'regressed');assert.match(s1.activity[fruit.id].detail,/Tests got worse: Fruit stand, 1 case broke/);
    await put(s1.agents.find(x=>x.id===fruit.id),{instructions:'Mention BANANA again.'});
    await until(async()=>{const x=(await st()).workflows.find(x=>x.id===flow.id);return x.evals.length>=3&&x.evals[0].status==='done'&&x;},20000,'tested again');
    const s2=await st();assert.equal(s2.agents.find(x=>x.id===fruit.id).evalWorse,undefined,'the mark goes when it is fixed');
    assert.equal(s2.workflows.find(x=>x.id===flow.id).evals[0].compare.cases[s2.workflows.find(x=>x.id===flow.id).tests[0].id],'fixed');
  });

  await t.test('real runs, conversations and rejections become cases',async()=>{
    const run=(await request('/workflows/'+flow.id+'/run',{input:'A customer asks for fruit'})).data;
    await until(async()=>(await st()).runs.find(r=>r.id===run.id)?.status==='completed',10000,'run');
    const added=await request('/workflows/'+flow.id+'/tests/from-run',{runId:run.id});
    assert.equal(added.status,201);assert.equal(added.data.test.input,'A customer asks for fruit');assert.match(added.data.test.reference,/BANANA/);assert.equal(added.data.test.checks[0].op,'judge');
    assert.equal((await request('/workflows/'+flow.id+'/tests/from-run',{runId:'nope'})).status,404);
    assert.equal((await request('/agents/'+coin.id+'/tests/from-chat',{})).status,404,'no answer yet');
    await request('/agents/'+coin.id+'/chat',{message:'Who is the supplier?'});
    const fromChat=await request('/agents/'+coin.id+'/tests/from-chat',{});
    assert.equal(fromChat.status,201);assert.equal(fromChat.data.test.input,'Who is the supplier?');
    // A rejection with a note teaches the workflow.
    const gated=(await request('/workflows',{name:'Approved fruit',steps:[{agentId:fruit.id,prompt:'Offer.'},{type:'approval',prompt:'Check it'}]})).data;
    await request('/workflows/'+gated.id+'/tests',{learn:true,tests:[{name:'Base',input:'x',checks:[{op:'contains',text:'BANANA'}]}]});
    const r2=(await request('/workflows/'+gated.id+'/run',{input:'Sell to a child'})).data;
    await until(async()=>(await st()).runs.find(r=>r.id===r2.id)?.waiting,10000,'waiting');
    assert.equal((await request('/runs/'+r2.id+'/approve',{approve:false,note:'Never sell to children without a parent.'})).status,200);
    const learned=await until(async()=>{const w=(await st()).workflows.find(x=>x.id===gated.id);return w.tests.length===2&&w;},5000,'learned');
    assert.equal(learned.tests[1].learned,true);assert.equal(learned.tests[1].input,'Sell to a child');assert.match(learned.tests[1].checks[0].text,/Never sell to children/);
  });

  await t.test('cases that pass only sometimes are flaky, not broken, and you can check the judge',async()=>{
    await request('/agents/'+coin.id+'/tests',{repeat:3,judgeId:judge.id,tests:[{name:'Supplier',input:'Who supplies us?',checks:[{op:'judge',text:'Names the supplier.'}]}]});
    await request('/agents/'+coin.id+'/evaluate',{});const a1=await suiteDone('agent',coin.id);
    const r1=a1.evals[0].results[0];assert.equal(r1.flaky,true);assert.ok(r1.passes>0&&r1.passes<3);assert.equal(r1.judged.length,3);
    assert.ok(a1.evals[0].interval[0]<a1.evals[0].interval[1]);
    await request('/agents/'+coin.id+'/evaluate',{});const a2=await suiteDone('agent',coin.id);
    assert.equal(a2.evals[0].worse,undefined,'one run more or less is noise');assert.equal(a2.evals[0].compare.cases[r1.testId],'flaky');
    const rid=a2.evals[0].id;
    for(let i=0;i<3;i++){const v=await request('/evals/'+rid+'/vote',{testId:r1.testId,index:i,agree:i!==0});assert.equal(v.status,200);}
    let j=(await st()).agents.find(x=>x.id===judge.id);assert.deepEqual(j.judgeCal,{agree:2,disagree:1});
    await request('/evals/'+rid+'/vote',{testId:r1.testId,index:0,agree:true});
    j=(await st()).agents.find(x=>x.id===judge.id);assert.deepEqual(j.judgeCal,{agree:3,disagree:0},'a changed vote moves, not adds');
    await request('/evals/'+rid+'/vote',{testId:r1.testId,index:0,agree:null});
    j=(await st()).agents.find(x=>x.id===judge.id);assert.deepEqual(j.judgeCal,{agree:2,disagree:0});
    assert.equal((await request('/evals/'+rid+'/vote',{testId:r1.testId,index:9,agree:true})).status,404);
  });

  await t.test('tokens can run tests and read reports; applying a held change needs approve',async()=>{
    const tok=(await request('/tokens',{name:'CI',scopes:['read','run'],days:7})).data;assert.ok(tok.secret);tok.token=tok.secret;
    const bearer=(route,body,method=body===undefined?'GET':'POST')=>fetch(origin+'/api'+route,{method,headers:{authorization:'Bearer '+tok.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const started=await bearer('/agents/'+coin.id+'/evaluate',{trigger:'ci',repeat:1});assert.equal(started.status,202);
    const rep=await started.json();assert.equal(rep.trigger,'ci');assert.equal(rep.repeat,1);
    await suiteDone('agent',coin.id);
    assert.equal((await bearer('/evals/'+rep.id)).status,200);
    assert.equal((await bearer('/agents/'+coin.id+'/candidate',{action:'apply'})).status,403,'run scope cannot apply a held change');
    const cli=(...a)=>new Promise(r=>{const p=spawn(process.execPath,['tools/eval.mjs',...a,'--url',origin],{cwd:root,env:{...process.env,SILO_TOKEN:tok.token},windowsHide:true});let out='';p.stdout.on('data',b=>{out+=b;});p.stderr.on('data',b=>{out+=b;});p.on('exit',code=>r({code,out}));});
    const good=await cli('Fruit Clerk','--repeat','1');assert.equal(good.code,0,good.out);assert.match(good.out,/resident\s+Fruit Clerk\s+1\/1 passed\s+score 100/);assert.match(good.out,/All 1 passed/);
    const json=await cli('Fruit Clerk','--repeat','1','--json');assert.equal(json.code,0);const parsed=JSON.parse(json.out);assert.equal(parsed.ok,true);assert.equal(parsed.reports[0].report.trigger,'ci');
    assert.equal((await cli('Fruit Clerk','--min-score','101')).code,2,'bad options');
    assert.equal((await cli('Nobody here')).code,2);
    const strict=await cli('Approved fruit','--repeat','1','--strict');assert.equal(strict.code,1,'the learned case fails without a live judge');assert.match(strict.out,/did not pass/);
    const spec=await (await fetch(origin+'/api/openapi.json')).json();
    assert.equal(spec.paths['/api/agents/{id}/evaluate'].post['x-silo-scope'],'run');assert.equal(spec.paths['/api/workflows/{id}/candidate'].post['x-silo-scope'],'approve');assert.equal(spec.paths['/api/evals/{id}'].get['x-silo-scope'],'read');
  });
  assert.ok(!errors.includes('TypeError'),errors);
});

test('after a restart, tests that were running are marked stopped and a held change can be tested again',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-evals-restart-')),data=path.join(temp,'data');await fs.mkdir(data,{recursive:true});
  const evals=[{id:'r2',status:'running',total:1,passed:0,results:[],candidate:'held',time:Date.now()},{id:'r1',status:'waiting',total:1,passed:0,results:[],time:Date.now()}];
  await fs.writeFile(path.join(data,'state.json'),JSON.stringify({version:4,agents:[{id:'a1',name:'Restarted',role:'Fixture',floor:2,level:3,provider:'demo',model:'',instructions:'x',chats:[],tests:[{id:'t1',name:'T',input:'x',checks:[{op:'contains',text:'x'}]}],evals,candidate:{def:{instructions:'y'},changed:['instructions'],by:'you',time:Date.now(),status:'testing',reportId:'r2'}}],workflows:[],runs:[],events:[],floors:[],connections:{},users:[],channels:[],settings:{}}));
  const port=14395,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:data,SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start')),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session'),{token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const a=(await (await fetch(origin+'/api/state',{headers:{cookie}})).json()).agents.find(x=>x.id==='a1');
  assert.deepEqual(a.evals.map(e=>e.status),['interrupted','interrupted']);assert.equal(a.candidate.status,'error');assert.match(a.candidate.error,/restarted/);
  assert.equal(a.instructions,'x','the held change is still not in use');
  const r=await fetch(origin+'/api/agents/a1/candidate',{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-silo-token':token},body:JSON.stringify({action:'retest'})});
  assert.equal(r.status,202);
});
