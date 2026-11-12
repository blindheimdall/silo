import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {TEMPLATES,materialize,matchResident,needName,hasNeed} from '../public/flow-templates.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('residents named in a procedure are matched by name, then role, then sector',()=>{
  const agents=[{id:'a',name:'Ana Pop',role:'Records clerk',floor:0},{id:'b',name:'Radu Ene',role:'Backend developer',floor:3},{id:'c',name:'Ion Dima',role:'Gardener',floor:4},{id:'d',name:'Eva Moga',role:'Records keeper',floor:0}];
  assert.equal(matchResident({name:'radu ene',role:'Cook',floor:1},agents).id,'b','the same name wins');
  assert.equal(matchResident({name:'Someone',role:'Senior backend developer',floor:0},agents).id,'b','then the role, anywhere');
  assert.equal(matchResident({name:'Someone',role:'Records clerk',floor:0},agents,new Set(['a'])).id,'d','a resident used once is not used twice');
  assert.equal(matchResident({name:'X',role:'Pilot',floor:4},agents).id,'c','then the sector');
  const w=materialize({shared:true,name:'P',description:'',start:{mode:'daily',at:'07:00',days:[1]},watch:'inbox',shape:{fields:[{name:'total',type:'number'}]},tests:[{name:'t',input:'i',checks:[{op:'contains',text:'x'}]}],judge:{name:'Eva Moga',role:'',floor:0},
    steps:[{type:'agent',prompt:'One',resident:{name:'Ana Pop',role:'Records clerk',floor:0}},{type:'approval',prompt:'Ok?'},{type:'review',target:1,rounds:2,prompt:'Check',resident:{name:'Nobody',role:'Records clerk',floor:0}}]},agents);
  assert.deepEqual(w.steps.map(s=>s.agentId),['a',undefined,'d']);
  assert.equal(w.enabled,false,'a procedure from a file never starts on its own');assert.equal(w.watch,null);assert.equal(w.mode,'daily');assert.equal(w.at,'07:00');
  assert.equal(w.shape.fields[0].name,'total');assert.equal(w.tests.length,1);assert.equal(w.judgeId,'d');
  assert.ok(!w.steps.some(s=>'resident' in s||'needs' in s),'only workflow fields are left');
  assert.equal(needName('google|microsoft'),'Google or Microsoft 365');assert.ok(hasNeed({tools:['microsoft']},'google|microsoft'));assert.ok(!hasNeed({tools:['web']},'github'));
});

test('procedures are shared without secrets, checked on import and kept in the Order',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-templates-test-'));
  const port=14343,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  const agents=(await request('/state')).data.agents;

  await t.test('every procedure in the book becomes a valid workflow, with its shape and tests',async()=>{
    for(const tpl of TEMPLATES){
      const w=materialize(tpl,agents),{tests,judgeId,...body}=w;
      const r=await request('/workflows',body);assert.equal(r.status,201,tpl.key+': '+JSON.stringify(r.data));
      if(tpl.shape)assert.deepEqual(r.data.shape.fields.map(f=>f.name),tpl.shape.fields.map(f=>f.name));
      if(tests)assert.equal((await request('/workflows/'+r.data.id+'/tests',{tests})).status,200,tpl.key+' tests');
      for(const st of tpl.steps)for(const n of st.needs||[])assert.ok(n.split('|').every(k=>needName(k)!==k),tpl.key+' needs a known permission: '+n);
    }
  });
  let exported,source;
  await t.test('a shared workflow holds no ids, keys, addresses or mail settings',async()=>{
    const [a,b]=agents;
    source=(await request('/workflows',{name:'Pump check',description:'Looks at the pumps',brief:'Pump 3',hook:true,watch:'inbox',enabled:true,mode:'daily',at:'06:30',days:[1,3],budget:5000,shape:{fields:[{name:'status',type:'text'}]},
      steps:[{agentId:a.id,prompt:'Check {{brief}}'},{type:'approval',prompt:'Look'},{type:'review',agentId:b.id,target:1,rounds:2,prompt:'Strict',when:{step:1,op:'contains',text:'leak'}}]})).data;
    await request('/workflows/'+source.id+'/tests',{judgeId:b.id,tests:[{name:'Says status',input:'Pump 3',checks:[{op:'field',text:'status=ok'}]}]});
    exported=(await request('/workflows/'+source.id+'/template')).data;
    const text=JSON.stringify(exported);
    assert.equal(exported.silo,'procedure');assert.equal(exported.format,1);
    assert.ok(!text.includes(source.id)&&!text.includes(a.id)&&!text.includes(source.hook),'no ids and no webhook address');
    assert.ok(!/"(agentId|hook|mail|runs|versions|evals|nextRun|id)"/.test(text),'only procedure fields');
    assert.deepEqual(exported.start,{mode:'daily',at:'06:30',days:[1,3]});assert.equal(exported.watch,'inbox');assert.equal(exported.budget,5000);
    assert.deepEqual(exported.steps[0].resident,{name:a.name,role:a.role,floor:a.floor});assert.equal(exported.steps[1].resident,undefined);
    assert.deepEqual(exported.steps[2].when,{step:1,op:'contains',text:'leak'});
    assert.equal(exported.judge.name,b.name);assert.equal(exported.tests[0].checks[0].op,'field');assert.match(exported.made,/^\d{4}-\d{2}-\d{2}$/);
  });
  await t.test('a file is checked by the same rules as a workflow',async()=>{
    const ok=await request('/templates/check',{template:exported});assert.equal(ok.status,200,JSON.stringify(ok.data));assert.deepEqual(ok.data,exported,'a round trip changes nothing');
    const bad=async(change,re)=>{const r=await request('/templates/check',{template:{...structuredClone(exported),...change}});assert.equal(r.status,400,JSON.stringify(change).slice(0,80));if(re)assert.match(r.data.error,re);};
    await bad({silo:'something'},/not a SILO procedure/);
    await bad({format:2},/newer SILO/);
    await bad({steps:Array.from({length:13},()=>({prompt:'x',resident:{name:'a'}}))},/1 to 12 steps/);
    await bad({steps:[{type:'review',target:3,prompt:'x'}]},/send work back/);
    await bad({steps:[{prompt:'x'.repeat(10001)}]},/oversized/);
    await bad({shape:{fields:[{name:'a'},{name:'a'}]}},/twice/);
    await bad({tests:[{name:'t',input:'i',checks:[{op:'field',text:'nothing'}]}]},/field=value/);
    await bad({watch:'../outside'});
    const extra=await request('/templates/check',{template:{...exported,hook:'abc',mail:{host:'x',pass:'p'},steps:exported.steps.map(s=>({...s,agentId:'x',needs:['google','root_shell']}))}});
    assert.equal(extra.status,200);assert.ok(!/hook|mail|agentId|root_shell/.test(JSON.stringify(extra.data)),'fields a procedure may not hold are dropped');assert.deepEqual(extra.data.steps[0].needs,['google']);
    assert.equal((await request('/templates/check',{template:'text'})).status,400);
  });
  await t.test('procedures are kept in the Order and removed again',async()=>{
    const kept=await request('/templates',{workflowId:source.id});assert.equal(kept.status,201);assert.equal(kept.data.name,'Pump check');assert.ok(kept.data.id);
    const fromFile=await request('/templates',{template:{...exported,name:'From a file'}});assert.equal(fromFile.status,201);
    assert.equal((await request('/templates',{template:{silo:'nope'}})).status,400);
    let st=(await request('/state')).data;assert.deepEqual(st.templates.map(t=>t.name),['Pump check','From a file']);
    assert.equal((await request('/templates/'+kept.data.id,undefined,'DELETE')).status,200);
    assert.equal((await request('/templates/'+kept.data.id,undefined,'DELETE')).status,404);
    st=(await request('/state')).data;assert.deepEqual(st.templates.map(t=>t.name),['From a file']);
    assert.equal((await request('/workflows/nope/template')).status,404);
  });
  assert.ok(!errors.includes('TypeError'),errors);
});
