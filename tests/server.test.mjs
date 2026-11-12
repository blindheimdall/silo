import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('SILO local runtime integration',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-runtime-test-'));
  const port=14317,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('silo-runtime-test-'));await fs.rm(resolved,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start')),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>{clearTimeout(timer);reject(Error(b.toString()));});});
  const session=await fetch(origin+'/api/session');const {token}=await session.json();const cookie=session.headers.get('set-cookie').split(';')[0];
  async function request(route,body,method=body===undefined?'GET':'POST',extra={}){const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token,...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>null)};}
  let initial,agent,workflow;
  await t.test('serves immersive world and creates three demo residents on each of the 144 levels',async()=>{const r=await fetch(origin);assert.equal(r.status,200);const html=await r.text();assert.ok(html.includes('world-stage'));assert.ok(!html.includes('class="sidebar"'));initial=(await request('/state')).data;assert.equal(initial.agents.length,432);assert.equal(initial.floors.length,6);assert.equal(initial.floors[5].name,'Mechanical');assert.equal(new Set(initial.agents.map(a=>a.level)).size,144);for(let level=1;level<=144;level++)assert.equal(initial.agents.filter(a=>a.level===level).length,3);assert.equal(new Set(initial.agents.map(a=>a.name.toLowerCase())).size,432);assert.ok(initial.agents.every(a=>!/[\u2013\u2014]/.test(a.instructions+a.role+a.name)));for(let f=0;f<6;f++)assert.ok(initial.agents.some(a=>a.floor===f));});
  await t.test('requires a session, same origin and CSRF token',async()=>{assert.equal((await fetch(origin+'/api/state')).status,401);assert.equal((await request('/pause',{paused:true},'POST',{origin:'https://evil.example'})).status,403);assert.equal((await request('/pause',{paused:true},'POST',{'x-silo-token':'x'.repeat(64)})).status,403);});
  await t.test('creates, validates and edits residents',async()=>{const bad=await request('/agents',{name:'Broken',floor:99});assert.equal(bad.status,400);const good=await request('/agents',{name:'Test resident',role:'QA',floor:3,instructions:'Test carefully.',provider:'demo',tools:['read_files','arbitrary_shell']});assert.equal(good.status,201);agent=good.data;assert.deepEqual(agent.tools,['read_files']);const updated=await request('/agents/'+agent.id,{...agent,name:'Test engineer'},'PUT');assert.equal(updated.data.name,'Test engineer');agent=updated.data;});
  await t.test('runs a labeled demo mission and blocks overlapping requests',async()=>{const first=request('/agents/'+agent.id+'/chat',{message:'Investigate the generator.'});await new Promise(r=>setTimeout(r,120));assert.equal((await request('/agents/'+agent.id+'/chat',{message:'Overlap'})).status,409);const r=await first;assert.equal(r.status,200);assert.match(r.data.text,/DEMO/);const a=(await request('/state')).data.agents.find(a=>a.id===agent.id);assert.equal(a.status,'idle');assert.equal(a.chats.length,2);});
  await t.test('pause blocks new missions and resume restores execution',async()=>{await request('/pause',{paused:true});assert.equal((await request('/agents/'+agent.id+'/chat',{message:'Paused'})).status,409);await request('/pause',{paused:false});});
  await t.test('saves exact file content and rejects workspace escapes, ADS and reserved names',async()=>{const content='  Keep indentation.\n\n';assert.equal((await request('/file',{name:'notes/context.md',content})).status,200);assert.equal((await request('/file?name=notes/context.md')).data.content,content);for(const name of ['../state.json','C:/outside.txt','notes/file:secret','CON.txt','.env','notes/../escape.txt'])assert.equal((await request('/file',{name,content:'no'})).status,400,name);assert.equal((await request('/files')).data.length,1);});
  await t.test('all four provider adapters use correct request and response contracts',async()=>{for(const provider of ['openai','anthropic','ollama','compatible']){const key='test-secret-'+provider;assert.equal((await request('/connections',{provider,key,model:'fixture-model',endpoint:'https://example.com/v1/chat/completions'})).status,200);const updated=await request('/agents/'+agent.id,{...agent,provider},'PUT');const result=await request('/agents/'+agent.id+'/chat',{message:'Check provider '+provider});assert.equal(result.status,200,JSON.stringify(result.data));assert.ok(result.data.tokens>0);if(provider==='openai'){const parsed=JSON.parse(result.data.text);assert.match(parsed.system,/Workspace files you can read:\n- notes\/context\.md/);assert.ok(!parsed.system.includes('Keep indentation'),'file contents are no longer pasted in');assert.equal(parsed.input.at(-1).content,'Check provider openai');}assert.ok(!JSON.stringify((await request('/state')).data).includes(key));}const persisted=await fs.readFile(path.join(temp,'data','state.json'),'utf8');assert.ok(!persisted.includes('test-secret-'));});
  await t.test('redacts provider credentials in failures',async()=>{await request('/connections',{provider:'openai',key:'redact-this-secret',model:'failure'});await request('/agents/'+agent.id,{...agent,provider:'openai',model:'failure'},'PUT');const r=await request('/agents/'+agent.id+'/chat',{message:'Fail test'});assert.equal(r.status,502);assert.ok(!r.data.error.includes('redact-this-secret'));assert.match(r.data.error,/redacted/);await request('/agents/'+agent.id,{...agent,provider:'demo',model:''},'PUT');});
  await t.test('chains actual step output and retains a complete run trace',async()=>{workflow=(await request('/workflows',{name:'Integration pipeline',description:'Fixture',interval:60,enabled:false,steps:[{agentId:agent.id,prompt:'First step'},{agentId:initial.agents[1].id,prompt:'Second step'}]})).data;const r=await request('/workflows/'+workflow.id+'/run',{input:'Original brief'});assert.equal(r.status,202);let run;for(let i=0;i<60;i++){run=(await request('/state')).data.runs.find(x=>x.id===r.data.id);if(run.status!=='running')break;await new Promise(r=>setTimeout(r,100));}assert.equal(run.status,'completed');assert.equal(run.steps.length,2);assert.ok(run.steps[1].output.includes('[DEMO'));assert.match(run.steps[1].output,/Second step/);assert.ok(run.steps[1].output.includes('Previous step output'));const second=(await request('/state')).data.agents.find(a=>a.id===initial.agents[1].id);assert.ok(!second.chats.some(m=>m.content.includes('Second step')),'workflow steps stay out of the chat history');assert.equal(run.plan,undefined);});
  await t.test('keeps a valid Anthropic history after many messages and a failed mission',async()=>{const created=(await request('/agents',{name:'History check',role:'QA',floor:2,provider:'anthropic',model:'failure'})).data;assert.equal((await request('/agents/'+created.id+'/chat',{message:'This one fails'})).status,502);await request('/agents/'+created.id,{...created,model:''},'PUT');for(let i=0;i<12;i++){const r=await request('/agents/'+created.id+'/chat',{message:'Message '+i});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.text,'Anthropic fixture: Message '+i);}assert.equal((await request('/agents/'+created.id,{},'DELETE')).status,200);});
  await t.test('rejects a connection test without a real provider',async()=>{assert.equal((await request('/connections/test',{provider:'demo'})).status,400);assert.equal((await request('/connections/test',{})).status,400);});
  await t.test('stops a running workflow on request and saves the brief',async()=>{const w=(await request('/workflows',{name:'Stoppable',brief:'Saved brief text',steps:[{agentId:initial.agents[4].id,prompt:'One'},{agentId:initial.agents[5].id,prompt:'Two'},{agentId:initial.agents[6].id,prompt:'Three'}]})).data;assert.equal(w.brief,'Saved brief text');const started=(await request('/workflows/'+w.id+'/run',{input:'Go'})).data;assert.equal(started.total,3);await new Promise(r=>setTimeout(r,300));assert.equal((await request('/runs/'+started.id+'/stop',{})).status,200);let run;for(let i=0;i<40;i++){run=(await request('/state')).data.runs.find(x=>x.id===started.id);if(run.status!=='running')break;await new Promise(r=>setTimeout(r,100));}assert.equal(run.status,'stopped');assert.ok(run.steps.length<3);assert.equal((await request('/runs/'+started.id+'/stop',{})).status,409);await request('/workflows/'+w.id,{},'DELETE');});
  await t.test('a workflow step waits for a busy resident instead of failing',async()=>{const busyAgent=initial.agents[7];const w=(await request('/workflows',{name:'Waits',steps:[{agentId:busyAgent.id,prompt:'Use the brief'}]})).data;const direct=request('/agents/'+busyAgent.id+'/chat',{message:'Direct mission'});await new Promise(r=>setTimeout(r,100));const started=(await request('/workflows/'+w.id+'/run',{input:'Queued brief'})).data;assert.equal((await direct).status,200);let run;for(let i=0;i<60;i++){run=(await request('/state')).data.runs.find(x=>x.id===started.id);if(run.status!=='running')break;await new Promise(r=>setTimeout(r,100));}assert.equal(run.status,'completed',run.error);await request('/workflows/'+w.id,{},'DELETE');});
  const finish=async id=>{let run;for(let i=0;i<150;i++){run=(await request('/state')).data.runs.find(x=>x.id===id);if(run.status!=='running'||run.waiting)break;await new Promise(r=>setTimeout(r,100));}return run;};
  const resident=async (name,provider,model)=>(await request('/agents',{name,role:'Fixture',floor:1,provider,model,instructions:'Fixture.'})).data;
  const flow=async (name,steps)=>(await request('/workflows',{name,steps})).data;
  await t.test('streams workflow steps from every provider, finishes cut answers and retries rate limits',async()=>{
    for(const provider of ['openai','anthropic','ollama','compatible']){
      assert.equal((await request('/connections',{provider,key:'fixture-key-'+provider,model:'fixture-model',endpoint:'https://example.com/v1/chat/completions'})).status,200);
      const cut=await resident('Cut '+provider,provider,'cut'),flaky=await resident('Flaky '+provider,provider,'flaky');
      const w=await flow('Stream '+provider,[{agentId:cut.id,prompt:'Write'},{agentId:flaky.id,prompt:'Check'}]);
      const run=await finish((await request('/workflows/'+w.id+'/run',{input:'Brief'})).data.id);
      assert.equal(run.status,'completed',provider+': '+run.error);
      assert.equal(run.steps[0].output,'First half, second half.',provider);assert.ok(!run.steps[0].truncated);assert.ok(run.steps[0].tokens>0,provider+' tokens');
      assert.equal(run.steps[1].retries,1,provider+' retried once');assert.ok(run.steps[1].output.length>0);
      const direct=await request('/agents/'+cut.id+'/chat',{message:'Talk'});assert.equal(direct.data.text,'First half, second half.');
    }
    const demo=initial.agents[10],w=await flow('Live',[{agentId:demo.id,prompt:'Speak slowly'}]);const started=(await request('/workflows/'+w.id+'/run',{input:'Live brief'})).data;
    let seen='';for(let i=0;i<40&&!seen;i++){seen=Object.values((await request('/runs/'+started.id+'/live')).data.feeds||{})[0]?.text||'';await new Promise(r=>setTimeout(r,50));}
    assert.match(seen,/DEMO/);assert.equal((await finish(started.id)).status,'completed');
  });
  await t.test('fills variables, loops through a review, waits for approval and passes the operator note',async()=>{
    await request('/connections',{provider:'openai',key:'fixture-key-openai',model:'fixture-model'});
    const writer=await resident('Writer','openai','echo'),reviewer=await resident('Reviewer','openai','review-once');
    assert.equal((await request('/workflows',{name:'Bad',steps:[{type:'review',agentId:reviewer.id,prompt:'x'}]})).status,400);
    assert.equal((await request('/workflows',{name:'Bad',steps:[{type:'approval'},{type:'review',agentId:reviewer.id,prompt:'x',target:1}]})).status,400);
    const w=await flow('Reviewed',[{type:'agent',agentId:writer.id,prompt:'Plan for {{brief}}'},{type:'review',agentId:reviewer.id,prompt:'Must contain a number.',target:1,rounds:2},{type:'approval',prompt:'Check it'},{type:'agent',agentId:writer.id,prompt:'Final using {{step 1}}'}]);
    assert.equal(w.steps[1].rounds,2);
    const id=(await request('/workflows/'+w.id+'/run',{input:'the farm'})).data.id;let run=await finish(id);
    assert.ok(run.waiting,'waits at the approval step');assert.equal(run.current.type,'approval');
    assert.deepEqual(run.steps.map(x=>x.type+':'+(x.verdict||'')),['agent:','review:revise','agent:','review:approved']);
    assert.match(run.steps[0].output,/^Plan for the farm/);assert.ok(!run.steps[0].output.includes('Original brief'));
    assert.ok(run.steps[2].revision);assert.match(run.steps[2].output,/Reviewer notes:\nREVISE\nAdd a number/);
    assert.equal((await request('/runs/'+id+'/approve',{approve:true,note:'Keep it short.'})).status,200);
    run=await finish(id);assert.equal(run.status,'completed',run.error);
    const last=run.steps.at(-1).output;assert.match(last,/^Final using Plan for the farm/);assert.match(last,/Note from the operator:\nKeep it short\./);assert.equal(run.output,last);
    assert.equal((await request('/runs/'+id+'/approve',{approve:true})).status,409);
    const again=(await request('/workflows/'+w.id+'/run',{input:'the mill'})).data.id;run=await finish(again);assert.ok(run.waiting);
    await request('/runs/'+again+'/approve',{approve:false});run=await finish(again);assert.equal(run.status,'stopped');assert.match(run.error,/Rejected/);
    assert.equal((await request('/runs/'+again+'/resume',{})).status,202);run=await finish(again);assert.ok(run.waiting,'asks again after resume');
    await request('/runs/'+again+'/approve',{approve:true});run=await finish(again);assert.equal(run.status,'completed');
    const state=(await request('/state')).data;assert.equal(state.agents.find(a=>a.id===writer.id).chats.length,0);
  });
  await t.test('resumes a failed run from the step that failed',async()=>{
    const first=await resident('Steady','openai','echo'),broken=await resident('Broken','openai','failure');
    const w=await flow('Resumable',[{agentId:first.id,prompt:'One'},{agentId:broken.id,prompt:'Two'}]);
    const id=(await request('/workflows/'+w.id+'/run',{input:'Go'})).data.id;let run=await finish(id);
    assert.equal(run.status,'failed');assert.equal(run.steps.length,1);const kept=run.steps[0].time;
    await request('/agents/'+broken.id,{...broken,model:'echo'},'PUT');
    assert.equal((await request('/runs/'+id+'/resume',{})).status,202);run=await finish(id);
    assert.equal(run.status,'completed',run.error);assert.equal(run.steps.length,2);assert.equal(run.steps[0].time,kept);assert.match(run.steps[1].output,/^Two/);
    assert.equal((await request('/runs/'+id+'/resume',{})).status,409);
  });
  await t.test('runs parallel steps together, hands their outputs on together and skips steps on conditions',async()=>{
    const [a,b,c,d]=[await resident('Left','openai','echo'),await resident('Right','openai','echo'),await resident('Merger','openai','echo'),await resident('Router','openai','echo')];
    assert.equal((await request('/workflows',{name:'Bad',steps:[{agentId:a.id,prompt:'x',parallel:true}]})).status,400);
    assert.equal((await request('/workflows',{name:'Bad',steps:[{agentId:a.id,prompt:'x'},{agentId:b.id,prompt:'y',when:{step:3,text:'z'}}]})).status,400);
    const w=await flow('Fan out',[{agentId:a.id,prompt:'Idea one'},{agentId:b.id,prompt:'Idea two',parallel:true},{agentId:c.id,prompt:'Merge'},{agentId:d.id,prompt:'Only urgent',when:{step:0,op:'contains',text:'URGENT'}},{agentId:d.id,prompt:'Only calm',when:{step:0,op:'missing',text:'urgent'}}]);
    assert.equal(w.steps[1].parallel,true);assert.deepEqual(w.steps[3].when,{step:0,op:'contains',text:'URGENT'});
    const run=await finish((await request('/workflows/'+w.id+'/run',{input:'all calm'})).data.id);
    assert.equal(run.status,'completed',run.error);
    const by=i=>run.steps.find(x=>x.index===i);
    assert.match(by(0).output,/^Idea one/);assert.match(by(1).output,/^Idea two/);assert.ok(!by(1).output.includes('Previous step output'),'parallel steps share the input of the group');
    assert.match(by(2).output,/Output of step 1 \(Left\):\nIdea one[\s\S]*Output of step 2 \(Right\):\nIdea two/);
    assert.ok(by(3).skipped);assert.match(by(4).output,/^Only calm[\s\S]*Previous step output:\nMerge/);assert.match(run.output,/^Only calm/);
  });
  await t.test('daily schedules, a local webhook and a token budget',async()=>{
    const echo=await resident('Hooked','openai','echo');
    const w=(await request('/workflows',{name:'Hooked',hook:true,mode:'daily',at:'09:00',days:[1],enabled:true,steps:[{agentId:echo.id,prompt:'Handle'}]})).data;
    const next=new Date(w.nextRun);assert.equal(next.getDay(),1);assert.equal(next.getHours(),9);assert.equal(next.getMinutes(),0);assert.ok(w.nextRun>Date.now());
    assert.match(w.hook,/^[a-f0-9]{32}$/);
    assert.equal((await request('/workflows',{name:'Bad',mode:'daily',days:[],enabled:true,steps:[{agentId:echo.id,prompt:'x'}]})).status,400);
    assert.equal((await fetch(origin+'/hook/'+'0'.repeat(32),{method:'POST',body:'x'})).status,404);
    assert.equal((await fetch(origin+'/hook/'+w.hook)).status,405);
    const started=await fetch(origin+'/hook/'+w.hook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'from a script'})});
    assert.equal(started.status,202);const {id,check}=await started.json();
    let result;for(let i=0;i<50;i++){result=await (await fetch(origin+check)).json();if(result.status!=='running')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(result.status,'completed');assert.match(result.output,/from a script/);
    assert.equal((await request('/state')).data.runs.find(r=>r.id===id).trigger,'webhook');
    const plain=await fetch(origin+'/hook/'+w.hook,{method:'POST',headers:{'Content-Type':'text/plain'},body:'plain text brief'});assert.equal(plain.status,202);await finish((await plain.json()).id);
    const off=(await request('/workflows/'+w.id,{...w,hook:false},'PUT')).data;assert.equal(off.hook,null);assert.equal((await fetch(origin+'/hook/'+w.hook,{method:'POST',body:'x'})).status,404);
    const capped=(await request('/workflows',{name:'Capped',budget:10,steps:[{agentId:echo.id,prompt:'One'},{agentId:echo.id,prompt:'Two'}]})).data;
    const runId=(await request('/workflows/'+capped.id+'/run',{input:'Go'})).data.id;let run=await finish(runId);
    assert.equal(run.status,'failed');assert.match(run.error,/budget/);assert.equal(run.steps.length,1);
    await request('/workflows/'+capped.id,{...capped,budget:1000},'PUT');assert.equal((await request('/runs/'+runId+'/resume',{})).status,202);
    run=await finish(runId);assert.equal(run.status,'completed',run.error);assert.equal(run.steps.length,2);
  });
  await t.test('starts a workflow when a file arrives in a watched folder',async()=>{
    assert.equal((await request('/file',{name:'inbox/old.md',content:'Already here'})).status,200);
    const echo=await resident('Inbox reader','openai','echo');
    assert.equal((await request('/workflows',{name:'Bad',watch:'../up',steps:[{agentId:echo.id,prompt:'x'}]})).status,400);
    const w=(await request('/workflows',{name:'Inbox',watch:'inbox',steps:[{agentId:echo.id,prompt:'Summarize'}]})).data;assert.equal(w.watch,'inbox');
    assert.equal((await request('/file',{name:'inbox/report.md',content:'Rain on level 40'})).status,200);
    let run;for(let i=0;i<60&&!run;i++){await new Promise(r=>setTimeout(r,200));run=(await request('/state')).data.runs.find(r=>r.workflowId===w.id);}
    assert.ok(run,'a run started');run=await finish(run.id);
    assert.equal(run.trigger,'file');assert.equal(run.status,'completed');assert.match(run.steps[0].output,/inbox\/report\.md[\s\S]*Rain on level 40/);
    const runs=(await request('/state')).data.runs.filter(r=>r.workflowId===w.id);assert.equal(runs.length,1,'the file that was already there did not start a run');
    await request('/workflows/'+w.id,{},'DELETE');
  });
  await t.test('residents search and read files, propose files, keep notes and cannot read local pages',async()=>{
    await request('/connections',{provider:'openai',key:'fixture-key-openai',model:'fixture-model'});
    assert.equal((await request('/file',{name:'notes/silo.md',content:'The generator needs oil on Tuesdays.'})).status,200);
    const worker=(await request('/agents',{name:'Toolsmith',role:'Fixture',floor:3,provider:'openai',model:'tool-user',instructions:'Fixture.',tools:['read_files','write_files','memory','web','shell']})).data;
    assert.deepEqual(worker.tools,['read_files','write_files','memory','web']);
    const calls=['{"tool":"search_files","query":"generator oil"}','{"tool":"read_file","name":"notes/silo.md"}','{"tool":"write_file","name":"notes/oil.md","content":"Oil plan"}','{"tool":"remember","note":"Oil goes in on Tuesdays"}','{"tool":"read_page","url":"'+origin+'/"}'];
    const r=await request('/agents/'+worker.id+'/chat',{message:calls.map(c=>'CALL '+c).join('\n')});
    assert.equal(r.status,200,JSON.stringify(r.data));assert.match(r.data.text,/^Done\. [\s\S]*cannot be read/);
    let state=(await request('/state')).data;const me=state.agents.find(a=>a.id===worker.id),reply=me.chats.at(-1);
    assert.deepEqual(reply.tools.map(x=>x.tool+':'+x.ok),['search_files:true','read_file:true','write_file:true','remember:true','read_page:false']);
    assert.match(reply.tools[0].summary,/1 found/);assert.equal(me.memory[0].text,'Oil goes in on Tuesdays');
    const p=state.proposals.find(p=>p.name==='notes/oil.md');assert.equal(p.status,'pending');assert.equal(p.content,undefined);assert.equal(p.preview,'Oil plan');
    assert.equal((await request('/file?name=notes/oil.md')).status,404,'nothing is written before you save');
    assert.equal((await request('/proposals/'+p.id)).data.content,'Oil plan');
    assert.equal((await request('/proposals/'+p.id,{action:'save'})).status,200);assert.equal((await request('/file?name=notes/oil.md')).data.content,'Oil plan');
    assert.equal((await request('/proposals/'+p.id,{action:'save'})).status,409);
    await request('/agents/'+worker.id+'/chat',{message:'CALL {"tool":"write_file","name":"notes/oil.md","content":"Second plan"}'});
    state=(await request('/state')).data;const second=state.proposals.find(x=>x.status==='pending'&&x.name==='notes/oil.md');assert.ok(second.exists);
    assert.equal((await request('/proposals/'+second.id)).data.current,'Oil plan');
    await request('/proposals/'+second.id,{action:'discard'});assert.equal((await request('/file?name=notes/oil.md')).data.content,'Oil plan');
    const reader=(await request('/agents',{name:'Reader only',role:'Fixture',floor:3,provider:'openai',model:'no-tools',instructions:'Fixture.',tools:['read_files']})).data;
    await request('/agents/'+reader.id+'/chat',{message:'CALL {"tool":"write_file","name":"x.md","content":"x"}\nCALL {"tool":"nonsense"}'});
    const denied=(await request('/state')).data.agents.find(a=>a.id===reader.id).chats.at(-1);
    assert.deepEqual(denied.tools.map(x=>x.ok),[false,false]);assert.match(denied.content,/no tool called nonsense/);
  });
  await t.test('native tool calls work with every provider, streamed and whole, and old models fall back to text',async()=>{
    for(const provider of ['openai','anthropic','ollama','compatible']){
      await request('/connections',{provider,key:'fixture-key-'+provider,model:'fixture-model',endpoint:'https://example.com/v1/chat/completions'});
      const a=(await request('/agents',{name:'Native '+provider,role:'Fixture',floor:3,provider,model:'tool-user',instructions:'Fixture.',tools:['memory','read_files']})).data;
      const chat=await request('/agents/'+a.id+'/chat',{message:'CALL {"tool":"remember","note":"note from '+provider+'"}\nCALL {"tool":"read_file","name":"notes/silo.md"}'});
      assert.equal(chat.status,200,provider+': '+JSON.stringify(chat.data));assert.match(chat.data.text,/^Done\. [\s\S]*oil on Tuesdays/,provider);
      const me=(await request('/state')).data.agents.find(x=>x.id===a.id);assert.equal(me.memory[0].text,'note from '+provider);assert.deepEqual(me.chats.at(-1).tools.map(x=>x.tool),['remember','read_file']);
      const w=(await request('/workflows',{name:'Native stream '+provider,steps:[{agentId:a.id,prompt:'CALL {"tool":"read_file","name":"notes/silo.md"}'}]})).data;
      const run=await finish((await request('/workflows/'+w.id+'/run',{input:'Brief'})).data.id);
      assert.equal(run.status,'completed',provider+': '+run.error);assert.match(run.steps[0].output,/oil on Tuesdays/);assert.equal(run.steps[0].tools[0].tool,'read_file');
    }
    const fixture=path.join(root,'tests','mcp-fixture.mjs');
    const added=await request('/mcp',{name:'Fixture',transport:'stdio',command:process.execPath,args:[fixture],env:{FIXTURE_TOKEN:'secret-env-value'},ask:'auto'});
    assert.equal(added.status,201,JSON.stringify(added.data));assert.equal(added.data.tools,3);
    let st=(await request('/state')).data;const conn=st.mcp.find(c=>c.id===added.data.id);
    assert.deepEqual(conn.envNames,['FIXTURE_TOKEN']);assert.ok(!JSON.stringify(st).includes('secret-env-value'),'secrets stay out of the state');
    const user=(await request('/agents',{name:'Connector user',role:'Fixture',floor:3,provider:'anthropic',model:'tool-user',instructions:'Fixture.',tools:['mcp:'+conn.id]})).data;
    assert.deepEqual(user.tools,['mcp:'+conn.id]);
    const read=await request('/agents/'+user.id+'/chat',{message:'CALL {"tool":"fixture__echo","text":"from level 3"}'});
    assert.equal(read.status,200,JSON.stringify(read.data));assert.match(read.data.text,/echo: from level 3/);
    // add_note changes something, so it waits for the operator.
    const waitFor=async()=>{for(let i=0;i<100;i++){const r=(await request('/state')).data.requests.find(r=>r.status==='pending'&&r.agentId===user.id);if(r)return r;await new Promise(r=>setTimeout(r,50));}throw Error('no request');};
    let pendingChat=request('/agents/'+user.id+'/chat',{message:'CALL {"tool":"fixture__add_note","note":"oil"}'});
    let rq=await waitFor();assert.match(rq.title,/add_note on Fixture/);assert.match(rq.detail,/oil/);
    assert.equal((await request('/requests/'+rq.id,{allow:true})).status,200);
    let done=await pendingChat;assert.match(done.data.text,/The notebook has 1 notes/);
    pendingChat=request('/agents/'+user.id+'/chat',{message:'CALL {"tool":"fixture__add_note","note":"no"}'});
    rq=await waitFor();await request('/requests/'+rq.id,{allow:false});done=await pendingChat;assert.match(done.data.text,/did not allow/);
    assert.equal((await request('/requests/'+rq.id,{allow:true})).status,409);
    pendingChat=request('/agents/'+user.id+'/chat',{message:'CALL {"tool":"fixture__add_note","note":"trusted"}'});
    rq=await waitFor();await request('/requests/'+rq.id,{allow:true,always:true});await pendingChat;
    done=await request('/agents/'+user.id+'/chat',{message:'CALL {"tool":"fixture__add_note","note":"no question"}'});assert.match(done.data.text,/has 3 notes/);
    pendingChat=request('/agents/'+user.id+'/chat',{message:'CALL {"tool":"fixture__fail"}'});rq=await waitFor();await request('/requests/'+rq.id,{allow:true});
    assert.match((await pendingChat).data.text,/failed on purpose/);
    assert.equal((await request('/mcp/'+conn.id+'/test',{})).data.tools.length,3);
    assert.equal((await request('/mcp/'+conn.id,undefined,'DELETE')).status,200);
    assert.deepEqual((await request('/state')).data.agents.find(a=>a.id===user.id).tools,[]);
    assert.equal((await request('/mcp',{name:'Bad',transport:'http',url:'http://example.com/mcp'})).status,400);
    // The sandbox runs code on a copy of the workspace after an OK, and turns written files into proposals.
    assert.equal((await request('/settings',{sandbox:'local'})).status,200);
    assert.equal((await request('/settings',{sandbox:'everywhere'})).status,400);
    const coder=(await request('/agents',{name:'Coder',role:'Fixture',floor:3,provider:'compatible',model:'tool-user',instructions:'Fixture.',tools:['run_code']})).data;
    const code='const fs=require("fs");fs.mkdirSync("out",{recursive:true});fs.writeFileSync("out/sum.txt",String(2+40));fs.writeFileSync("notes/silo.md","changed in the copy only");console.log("sum is",2+40)';
    pendingChat=request('/agents/'+coder.id+'/chat',{message:'CALL '+JSON.stringify({tool:'run_code',language:'javascript',code:code.replace('const fs=require("fs");','import fs from "node:fs";')})});
    for(let i=0;i<100&&!(rq=(await request('/state')).data.requests.find(r=>r.status==='pending'&&r.agentId===coder.id));i++)await new Promise(r=>setTimeout(r,50));
    assert.match(rq.title,/run javascript code/);assert.match(rq.detail,/sum\.txt/);
    await request('/requests/'+rq.id,{allow:true});done=await pendingChat;
    assert.equal(done.status,200,JSON.stringify(done.data));assert.match(done.data.text,/Exit code: 0[\s\S]*sum is 42[\s\S]*out\/sum\.txt/);
    st=(await request('/state')).data;assert.ok(st.proposals.some(p=>p.name==='out/sum.txt'&&p.preview==='42'&&p.status==='pending'));
    assert.equal((await request('/file?name=notes/silo.md')).data.content,'The generator needs oil on Tuesdays.','the workspace itself is untouched');
    assert.equal((await request('/sandbox')).data.using,'local');
    // Web search and meaning search over the Archive.
    assert.equal((await request('/file',{name:'notes/power.md',content:'The engine room is on level 140.\n\nBring grease for the bearings.'})).status,200);
    const scout=(await request('/agents',{name:'Scout',role:'Fixture',floor:1,provider:'openai',model:'tool-user',instructions:'Fixture.',tools:['web','read_files']})).data;
    let r2=await request('/agents/'+scout.id+'/chat',{message:'CALL {"tool":"web_search","query":"deep silo"}'});
    assert.match(r2.data.text,/1\. Silo news\n\s+https:\/\/example\.org\/silo\n\s+The deepest silo has 144 levels\./);
    assert.equal((await request('/settings',{embeddings:{provider:'openai',model:'fixture-embed'}})).status,200);
    const stats=(await request('/archive')).data;assert.ok(stats.withMeaning>0&&stats.withMeaning===stats.pieces,JSON.stringify(stats));
    r2=await request('/agents/'+scout.id+'/chat',{message:'CALL {"tool":"search_archive","query":"lubricant"}'});
    assert.match(r2.data.text,/file="notes\/(silo|power)\.md"/);
    const hits=(await request('/archive/search',{query:'lubricant for the engine'})).data.hits;assert.ok(hits[0].meaning);assert.ok(['notes/power.md','notes/silo.md'].includes(hits[0].name));
    assert.equal((await request('/settings',{search:{engine:'searxng',url:'not a url'}})).status,400);
    assert.equal((await request('/settings',{embeddings:{provider:'off'}})).status,200);
    // Delegation: a resident asks another one, who cannot ask back up the chain.
    const chair=(await request('/agents',{name:'Chair Ada',role:'Coordinator',floor:0,provider:'anthropic',model:'tool-user',instructions:'Fixture.',tools:['delegate']})).data;
    const echo=(await request('/agents',{name:'Echo Bo',role:'Analyst',floor:1,provider:'openai',model:'echo',instructions:'Fixture.'})).data;
    const relay=(await request('/agents',{name:'Relay Cy',role:'Clerk',floor:2,provider:'compatible',model:'tool-user',instructions:'Fixture.',tools:['delegate']})).data;
    r2=await request('/agents/'+chair.id+'/chat',{message:'CALL {"tool":"ask_resident","name":"echo bo","task":"How many levels?"}'});
    assert.match(r2.data.text,/answer from="Echo Bo"[\s\S]*Chair Ada \(Coordinator, level \d+\) asks you:[\s\S]*How many levels\?/);
    r2=await request('/agents/'+chair.id+'/chat',{message:'CALL {"tool":"ask_resident","name":"Relay Cy","task":"CALL {\\"tool\\":\\"ask_resident\\",\\"name\\":\\"Chair Ada\\",\\"task\\":\\"loop\\"}"}'});
    assert.match(r2.data.text,/Chair Ada is already waiting for your answer/);
    r2=await request('/agents/'+chair.id+'/chat',{message:'CALL {"tool":"ask_resident","name":"Nobody Here","task":"x"}'});assert.match(r2.data.text,/No resident is called Nobody Here/);
    st=(await request('/state')).data;assert.deepEqual(st.meetings,[]);assert.ok(st.events.some(e=>e.title==='Chair Ada called a council'));
    assert.equal(typeof st.pulse.tpm,'number');assert.ok(st.pulse.tpm>0,'tokens of the last minute are counted');
    const old=(await request('/agents',{name:'Old local model',role:'Fixture',floor:3,provider:'ollama',model:'no-tools',instructions:'Fixture.',tools:['memory']})).data;
    const r=await request('/agents/'+old.id+'/chat',{message:'CALL {"tool":"remember","note":"text protocol works"}'});
    assert.equal(r.status,200,JSON.stringify(r.data));assert.equal((await request('/state')).data.agents.find(x=>x.id===old.id).memory[0].text,'text protocol works');
  });
  await t.test('sends notifications, counts money, enforces limits, keeps workflow versions, replays runs and tests workflows',async()=>{
    const http=await import('node:http'),net=await import('node:net'),{createHmac}=await import('node:crypto');
    // A webhook receiver and a mail server on this computer.
    const hooks=[];const hookServer=http.createServer((q,s)=>{let body='';q.on('data',d=>body+=d);q.on('end',()=>{hooks.push({body:JSON.parse(body),sig:q.headers['x-silo-signature'],raw:body});s.end('ok');});});
    await new Promise(r=>hookServer.listen(0,'127.0.0.1',r));
    const mails=[];const smtp=net.createServer(sock=>{
      let data=false,buf='',msg='';sock.write('220 fixture ready\r\n');
      sock.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\r\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+2);
        if(data){if(line==='.'){data=false;mails.push(msg);msg='';sock.write('250 queued\r\n');}else msg+=line+'\n';continue;}
        if(/^EHLO/.test(line))sock.write('250-fixture\r\n250 AUTH PLAIN\r\n');
        else if(/^AUTH PLAIN /.test(line))sock.write(Buffer.from(line.slice(11),'base64').toString()==='\0mailer\0secret-pass'?'235 ok\r\n':'535 no\r\n');
        else if(/^(MAIL|RCPT)/.test(line))sock.write('250 ok\r\n');else if(line==='DATA'){data=true;sock.write('354 go\r\n');}else if(line==='QUIT'){sock.write('221 bye\r\n');sock.end();}}});
    });
    await new Promise(r=>smtp.listen(0,'127.0.0.1',r));
    t.after(()=>{hookServer.close();smtp.close();});
    const hookUrl=`http://127.0.0.1:${hookServer.address().port}/in`;
    assert.equal((await request('/channels',{kind:'slack',url:'http://example.com/x'})).status,400,'remote addresses need https');
    assert.equal((await request('/channels',{kind:'telegram',token:'123:abc',chatId:'not a chat'})).status,400);
    const hook=(await request('/channels',{kind:'webhook',name:'Ops hook',url:hookUrl,secret:'shh',events:['failed','completed','tests','limit']})).data;
    const mail=(await request('/channels',{kind:'email',name:'Mail',email:{host:'127.0.0.1',port:smtp.address().port,user:'mailer',pass:'secret-pass',from:'SILO <silo@example.com>',to:'me@example.com, ops@example.com'},events:['failed']})).data;
    const tgGood=(await request('/channels',{kind:'telegram',token:'123:good',chatId:'-100200',events:['failed']})).data;
    const tgBad=(await request('/channels',{kind:'telegram',token:'123:bad',chatId:'42',events:[]})).status;assert.equal(tgBad,400,'a channel needs an event');
    assert.equal((await request('/channels/'+hook.id+'/test',{})).status,200);
    const got=hooks.at(-1);assert.equal(got.body.event,'test');assert.equal(got.sig,'sha256='+createHmac('sha256','shh').update(got.raw).digest('hex'));
    assert.equal((await request('/channels/'+mail.id+'/test',{})).status,200,'mail is sent');
    assert.match(mails.at(-1),/To: me@example\.com, ops@example\.com/);assert.match(Buffer.from(mails.at(-1).split('\n\n')[1].replace(/\n/g,''),'base64').toString(),/SILO 18 can reach you/);
    assert.equal((await request('/channels/'+tgGood.id+'/test',{})).status,200);
    const tgB=(await request('/channels',{kind:'telegram',token:'123:bad',chatId:'42',events:['failed']})).data;
    const refused=await request('/channels/'+tgB.id+'/test',{});assert.equal(refused.status,502);assert.match(refused.data.error,/401/);
    let st=(await request('/state')).data;const shown=JSON.stringify(st.channels);
    assert.ok(!shown.includes('secret-pass')&&!shown.includes('123:good')&&!shown.includes(hookUrl),'secrets stay on the server');
    assert.equal(st.channels.find(c=>c.id===hook.id).has.url,true);assert.equal(st.channels.find(c=>c.id===tgB.id).last.ok,false);
    assert.equal((await request('/channels/'+tgB.id,{},'DELETE')).status,200);
    // A failed workflow sends to every channel that wants failures.
    await request('/connections',{provider:'openai',key:'k',model:'fixture-model'});
    const broken=await resident('Broken pump','openai','failure');
    const fw=await flow('Pump check',[{agentId:broken.id,prompt:'Check'}]);
    const failed=await finish((await request('/workflows/'+fw.id+'/run',{input:'Go'})).data.id);assert.equal(failed.status,'failed');
    for(let i=0;i<50&&!(hooks.some(h=>h.body.event==='failed')&&mails.length>=2);i++)await new Promise(r=>setTimeout(r,50));
    assert.ok(hooks.some(h=>h.body.event==='failed'&&/Pump check failed/.test(h.body.title)));assert.equal(mails.length,2);
    st=(await request('/state')).data;assert.match(st.pulse.alarm.title,/Pump check/);
    // Money: a price per million tokens, a daily limit that warns, then blocks.
    await request('/connections',{provider:'anthropic',key:'k',model:'fixture-model'});
    assert.equal((await request('/spending',{prices:{'anthropic:*':{input:1000,output:1000}},limits:{anthropic:{daily:0.02}}})).status,200);
    assert.equal((await request('/spending',{prices:{'nobody:x':{input:1,output:1}}})).status,400);
    const buyer=await resident('Buyer','anthropic','');
    for(let i=0;i<3;i++){const r=await request('/agents/'+buyer.id+'/chat',{message:'Spend '+i});if(r.status===402){assert.match(r.data.error,/daily limit for anthropic is reached/);break;}assert.equal(r.status,200,JSON.stringify(r.data));}
    st=(await request('/state')).data;const today=new Date().toISOString().slice(0,10);
    assert.ok(st.usage.days[today].anthropic.cost>=0.02,JSON.stringify(st.usage.days[today].anthropic));assert.ok(st.pulse.budget>=1);
    assert.ok(st.events.some(e=>e.title==='anthropic daily limit reached'));
    assert.equal((await request('/agents/'+buyer.id+'/chat',{message:'Again'})).status,402);
    for(let i=0;i<50&&!hooks.some(h=>h.body.event==='limit');i++)await new Promise(r=>setTimeout(r,50));assert.ok(hooks.some(h=>h.body.event==='limit'));
    assert.equal((await request('/spending',{limits:{anthropic:null}})).status,200);assert.equal((await request('/agents/'+buyer.id+'/chat',{message:'Free again'})).status,200);
    // Versions: every saved change keeps the one before, and an old one can come back.
    const d1=initial.agents[20],d2=initial.agents[21];
    let vw=await flow('Versioned',[{agentId:d1.id,prompt:'Draft'},{agentId:d2.id,prompt:'Polish'}]);
    vw=(await request('/workflows/'+vw.id,{...vw,name:'Versioned two'},'PUT')).data;assert.equal(vw.version,2);assert.equal(vw.versions.length,1);
    vw=(await request('/workflows/'+vw.id,{...vw,name:'Versioned two'},'PUT')).data;assert.equal(vw.version,2,'saving the same thing keeps the version');
    vw=(await request('/workflows/'+vw.id+'/restore',{version:1})).data;assert.equal(vw.name,'Versioned');assert.equal(vw.version,3);assert.equal(vw.versions[0].name,'Versioned two');
    // Replay: from the start, or from step 2 with the old output of step 1.
    const first=await finish((await request('/workflows/'+vw.id+'/run',{input:'Replay brief'})).data.id);assert.equal(first.status,'completed');assert.equal(first.version,3);
    assert.equal((await request('/runs/'+first.id+'/replay',{from:9})).status,400);
    const again=await finish((await request('/runs/'+first.id+'/replay',{from:2})).data.id);
    assert.equal(again.status,'completed',again.error);assert.equal(again.trigger,'replay');assert.equal(again.replayOf,first.id);
    assert.ok(again.steps[0].reused);assert.equal(again.steps[0].output,first.steps[0].output);assert.equal(again.steps.length,2);assert.ok(again.steps[1].output.includes(first.steps[0].output.slice(0,40)));
    const whole=await finish((await request('/runs/'+again.id+'/replay',{})).data.id);assert.equal(whole.status,'completed');assert.ok(!whole.steps.some(s=>s.reused));
    // Tests: checks on the final answer. Approval steps pass on their own in a test run.
    const tw=await flow('Tested',[{agentId:d1.id,prompt:'Answer'},{type:'approval',prompt:'Look'}]);
    assert.equal((await request('/workflows/'+tw.id+'/tests',{tests:[{name:'Bad',input:'x',checks:[{op:'regex',text:'('}]}]})).status,400);
    const saved=(await request('/workflows/'+tw.id+'/tests',{tests:[{name:'Labeled',input:'First brief',checks:[{op:'contains',text:'demo'},{op:'regex',text:'first\\s+brief'}]},{name:'Strict',input:'Second brief',checks:[{op:'missing',text:'DEMO'}]}]})).data;
    assert.equal(saved.tests.length,2);assert.equal((await request('/workflows/'+fw.id+'/evaluate',{})).status,400,'no tests yet');
    assert.equal((await request('/workflows/'+tw.id+'/evaluate',{})).status,202);
    let report;for(let i=0;i<150;i++){report=(await request('/state')).data.workflows.find(w=>w.id===tw.id).evals[0];if(report.status!=='running')break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(report.status,'done');assert.equal(report.passed,1);assert.equal(report.total,2);
    assert.deepEqual(report.results.map(r=>r.ok),[true,false]);assert.match(report.results[1].failures[0],/contains "DEMO"/);
    st=(await request('/state')).data;assert.ok(st.runs.filter(r=>r.trigger==='test').every(r=>r.status==='completed'&&r.steps.some(s=>s.agentName==='Test')));
    for(let i=0;i<50&&!hooks.some(h=>h.body.event==='tests');i++)await new Promise(r=>setTimeout(r,50));assert.match(hooks.find(h=>h.body.event==='tests').body.title,/1 of 2 tests passed/);
  });
  await t.test('notes are kept per resident and given to them with every mission',async()=>{
    const a=(await request('/agents',{name:'Note keeper',role:'Fixture',floor:5,provider:'openai',instructions:'Fixture.'})).data;
    const neighbor=(await request('/agents',{name:'Gallery neighbor',role:'Fixture',floor:5,level:143,provider:'openai',instructions:'Fixture.'})).data;
    assert.equal((await request('/agents/'+a.id+'/memory',{text:'Prefers short answers'})).data.memory.length,1);
    assert.equal((await request('/agents/'+a.id+'/memory',{text:'Works nights'})).data.memory.length,2);
    assert.equal((await request('/agents/'+a.id+'/memory',{remove:0})).data.memory[0].text,'Works nights');
    assert.equal((await request('/agents/'+a.id+'/memory',{remove:5})).status,404);
    const parsed=JSON.parse((await request('/agents/'+a.id+'/chat',{message:'Hello'})).data.text);
    assert.match(parsed.system,/THE PACT \(Silo law for every level\):/);
    assert.match(parsed.system,/Your notes from earlier missions[\s\S]*1\. Works nights/);assert.ok(!parsed.system.includes('silo-tool'),'no tools without permissions');
    assert.equal((await request('/settings',{pact:{enabled:true,rules:'Article 99: Keep turbine pressure steady.',maxChars:0},cafeteria:'green'})).status,200);
    const st=(await request('/state')).data;assert.equal(st.pulse.weather.mode,'green');assert.equal(st.pulse.weather.clarity,1);
    const np=JSON.parse((await request('/agents/'+neighbor.id+'/chat',{message:'Hello neighbor'})).data.text);
    assert.match(np.system,/Article 99: Keep turbine pressure steady\./);
    assert.match(np.system,/Heard on the gallery from nearby residents:[\s\S]*Note keeper \(L144\): Works nights/);
    await request('/settings',{pact:{enabled:true,rules:'Article 99: Keep turbine pressure steady.',maxChars:120}});
    const capped=(await request('/agents/'+a.id+'/chat',{message:'Check pact'})).data.text;
    assert.match(capped,/\[Truncated by The Pact \(120 characters max\)\]/);
    await request('/settings',{pact:{enabled:true,rules:'1. Never invent file contents.',maxChars:0},cafeteria:'auto'});
    const cleaned=(await request('/agents/'+neighbor.id+'/clean',{})).data;
    assert.equal(cleaned.stats.cleaned,1);assert.equal(cleaned.whispers.length,0);
    const disp=(await request('/dispatch',{fromId:a.id,toId:neighbor.id,text:'Bring spare valves to L143'})).data;
    assert.equal(disp.toId,neighbor.id);assert.equal((await request('/state')).data.agents.find(x=>x.id===neighbor.id).whispers[0].text,'[Letter] Bring spare valves to L143');
    assert.equal((await request('/settings',{power:[1,1,1,1,0,1]})).status,200);
    assert.deepEqual((await request('/state')).data.pulse.power,[1,1,1,1,0,1]);
    await request('/settings',{power:[1,1,1,1,1,1]});
    await request('/file',{name:'notes/relic-test.txt',content:'Leaked key sk-proj_1234567890abcdefghijklmno'});
    const relics=(await request('/relics')).data;
    assert.ok(relics.relics.some(r=>r.name==='notes/relic-test.txt'&&r.kinds.includes('OpenAI API key')));
    const report=(await request('/shift-report',{})).data;
    assert.match(report.name,/^reports\/shift-\d{4}-\d{2}-\d{2}\.md$/);assert.match(report.content,/# SILO 18: Shift Report/);
    const drill=(await request('/agents/'+neighbor.id+'/drill',{})).data;
    assert.equal(drill.drill.ok,true,JSON.stringify(drill.drill));
    const mentor=(await request('/agents',{name:'Mentor Chief',role:'Fixture',floor:5,level:142,provider:'openai',model:'failure',shadowId:neighbor.id,instructions:'Primary mentor.'})).data;
    const shadowChat=(await request('/agents/'+mentor.id+'/chat',{message:'Emergency shift takeover'})).data;
    assert.equal(shadowChat.shadowId,neighbor.id);assert.match(shadowChat.text,/\[Shadow Gallery neighbor \(L143\) stepped in for Mentor Chief\]/);
    const shadowWf=(await request('/workflows',{name:'Shadow failover',steps:[{agentId:mentor.id,prompt:'Keep the turbine online.'}]})).data;
    const shadowRun=await finish((await request('/workflows/'+shadowWf.id+'/run',{input:'Go'})).data.id);
    assert.equal(shadowRun.status,'completed',shadowRun.error);assert.equal(shadowRun.steps[0].shadowFor,'Mentor Chief');assert.equal(shadowRun.steps[0].agentId,neighbor.id);
    assert.equal((await request('/settings',{radio:{enabled:true,siloId:'Silo 18'}})).status,200);
    assert.equal((await request('/radio/peers',{name:'Mirror',url:origin,key:'radio-secret-18-long-enough-key'})).status,201);
    const radioRes=(await request('/radio/send',{peer:'Mirror',toAgent:'Gallery neighbor',message:'Greetings from Silo 17'})).data;
    assert.equal(radioRes.silo,'Mirror');assert.equal(radioRes.remoteName,'Silo 18');assert.equal(radioRes.agent.name,'Gallery neighbor');assert.ok(radioRes.reply.length>0);
    const worker=(await request('/agents',{name:'Flow tools',role:'Fixture',floor:3,provider:'openai',model:'tool-user',instructions:'Fixture.',tools:['read_files','write_files']})).data;
    const w=(await request('/workflows',{name:'Tooling',steps:[{agentId:worker.id,prompt:'CALL {"tool":"read_file","name":"notes/silo.md"}'}]})).data;
    const run=await finish((await request('/workflows/'+w.id+'/run',{input:'Go'})).data.id);
    assert.equal(run.status,'completed',run.error);assert.equal(run.steps[0].tools[0].summary,'read notes/silo.md (1 KB)');assert.match(run.output,/oil on Tuesdays/);
    const pw=(await request('/workflows',{name:'Patching',steps:[{agentId:worker.id,prompt:'CALL {"tool":"patch_file","name":"notes/silo.md","find":"Tuesdays","replace":"Wednesdays"}'}]})).data;
    const prun=await finish((await request('/workflows/'+pw.id+'/run',{input:'Patch'})).data.id);
    assert.equal(prun.status,'completed',prun.error);
    const prop=(await request('/state')).data.proposals.find(p=>p.name==='notes/silo.md'&&p.status==='pending');
    assert.ok(prop,'patch proposal created');assert.ok(prop.patch,'marked as surgical patch');
    await request('/proposals/'+prop.id,{action:'save'});
    assert.equal((await request('/file?name=notes/silo.md')).data.content,'The generator needs oil on Wednesdays.');
    await request('/proposals/'+prop.id,{action:'revert'});
    assert.equal((await request('/file?name=notes/silo.md')).data.content,'The generator needs oil on Tuesdays.');
  });
  await t.test('enforces P1 security, concurrency, budget, review and integrity guarantees',async()=>{
    const {Vault}=await import('../vault.mjs');
    const {McpClient}=await import('../mcp-client.mjs');
    const {createHmac}=await import('node:crypto');
    // 1. Concurrent Vault saves do not race on a shared temp file
    const vDir=path.join(temp,'vault-race');await fs.mkdir(vDir,{recursive:true});
    const v=new Vault(vDir);await v.load();
    await Promise.all(Array.from({length:8},(_,i)=>v.save({[`k${i}`]:`v${i}`,last:i})));
    const loaded=await v.load();assert.equal(typeof loaded.last,'number');
    // 2. MCP pre-aborted signal rejects before starting transport or calling tool
    let mcpCalled=false;
    const mc=new McpClient({transport:'http',url:'http://127.0.0.1:9/mcp'});
    mc.post=async()=>{mcpCalled=true;return {};};
    await assert.rejects(()=>mc.callTool('danger',{},AbortSignal.abort()),/Stop|aborted/i);
    assert.equal(mcpCalled,false,'aborted signal never invokes MCP HTTP post');
    // 3. Concurrent workflow steps claiming the same resident serialize atomically
    const shared=await resident('Shared worker','demo','');
    const cw=await flow('Concurrent claim',[{type:'agent',agentId:shared.id,prompt:'Task A'},{type:'agent',agentId:shared.id,prompt:'Task B',parallel:true}]);
    const crun=await finish((await request('/workflows/'+cw.id+'/run',{input:'Race'})).data.id);
    assert.equal(crun.status,'completed',crun.error);assert.equal(crun.steps.length,2);
    // 4. Unapproved review (gave-up / unclear) fails workflow by default unless onExhausted='accept'
    const writer=await resident('Strict writer','openai','echo');
    const unclearRev=await resident('Unclear reviewer','openai','echo');
    const rwFail=await flow('Strict review fail',[{type:'agent',agentId:writer.id,prompt:'Draft'},{type:'review',agentId:unclearRev.id,prompt:'Maybe ok',target:1,rounds:1}]);
    const rFail=await finish((await request('/workflows/'+rwFail.id+'/run',{input:'Check'})).data.id);
    assert.equal(rFail.status,'failed');assert.match(rFail.error,/did not approve|unclear verdict/);
    const rwAccept=await flow('Explicit accept review',[{type:'agent',agentId:writer.id,prompt:'Draft'},{type:'review',agentId:unclearRev.id,prompt:'Maybe ok',target:1,rounds:1,onExhausted:'accept'}]);
    const rAccept=await finish((await request('/workflows/'+rwAccept.id+'/run',{input:'Check'})).data.id);
    assert.equal(rAccept.status,'completed');assert.ok(rAccept.steps[1].warning);
    // 5. File proposal baseHash and savedHash prevent overwriting newer edits
    await request('/file',{name:'notes/hash-guard.md',content:'Line 1 original'});
    const proposer=(await request('/agents',{name:'Hash proposer',role:'Fixture',floor:3,provider:'openai',model:'tool-user',instructions:'Fixture.',tools:['read_files','write_files']})).data;
    const hw=await flow('Propose edit',[{agentId:proposer.id,prompt:'CALL {"tool":"patch_file","name":"notes/hash-guard.md","find":"original","replace":"proposed"}'}]);
    await finish((await request('/workflows/'+hw.id+'/run',{input:'Go'})).data.id);
    const hp=(await request('/state')).data.proposals.find(p=>p.name==='notes/hash-guard.md'&&p.status==='pending');
    assert.ok(hp.baseHash,'proposal records baseHash');
    await request('/file',{name:'notes/hash-guard.md',content:'Concurrent newer edit'});
    assert.equal((await request('/proposals/'+hp.id,{action:'save'})).status,409,'blocks overwriting newer file without force');
    assert.equal((await request('/proposals/'+hp.id,{action:'save',force:true})).status,200,'allows explicit force save');
    await request('/file',{name:'notes/hash-guard.md',content:'Edit after save'});
    assert.equal((await request('/proposals/'+hp.id,{action:'revert'})).status,409,'blocks reverting when file changed after save');
    // 6. Radio replay protection (nonce + timestamp window)
    const radio=await import('../radio.mjs'),rKey='radio-secret-18-long-enough-key';
    const rBody=JSON.stringify({v:'2',fromSilo:'Silo 17',toAgent:'Gallery neighbor',message:'Ping once',time:Date.now(),nonce:'0123456789abcdef0123456789abcdef'});
    const rHead={'Content-Type':'application/json','x-silo-radio-v':'2','x-silo-radio-key':radio.keyId(rKey),'x-silo-radio-sig':radio.signRequest(rKey,rBody)};
    const r1=await fetch(origin+'/radio',{method:'POST',headers:rHead,body:rBody});
    assert.equal(r1.status,200);
    const r2=await fetch(origin+'/radio',{method:'POST',headers:rHead,body:rBody});
    assert.equal(r2.status,403,'replayed radio nonce is rejected');
  });
  await t.test('enforces P2 reproducibility, schema validation, unique identity, ReDoS isolation, whisper purge and SQLite recovery',async()=>{
    const {StateStore}=await import('../storage.mjs');
    // 1. Unique resident names (409 on duplicate custom resident) & stable ID delegation
    const u1=await request('/agents',{name:'Unique Alpha',role:'Fixture',floor:2,level:50,provider:'openai',model:'echo',instructions:'Alpha v1.'});
    assert.equal(u1.status,201);
    const uDup=await request('/agents',{name:'unique alpha',role:'Clone',floor:2,level:50,provider:'openai',model:'echo',instructions:'Dup.'});
    assert.equal(uDup.status,409,'forbids duplicate resident names');
    // 2. Central JSON Schema validation for tool calls (rejects wrong types or unexpected properties)
    const schemaTester=(await request('/agents',{name:'Schema tester',role:'Fixture',floor:2,level:51,provider:'openai',model:'tool-user',instructions:'Fixture.',tools:['read_files','delegate']})).data;
    const badToolWf=await flow('Schema check',[{agentId:schemaTester.id,prompt:'CALL {"tool":"read_file","name":12345}'}]);
    const badToolRun=await finish((await request('/workflows/'+badToolWf.id+'/run',{input:'Test schema'})).data.id);
    assert.equal(badToolRun.status,'completed');
    assert.equal(badToolRun.steps[0].tools[0].ok,false);
    assert.match(badToolRun.steps[0].tools[0].summary,/invalid arguments for read_file/);
    // Delegate by stable ID
    const delWf=await flow('ID Delegation',[{agentId:schemaTester.id,prompt:`CALL {"tool":"ask_resident","id":"${u1.data.id}","task":"Status report"}`}]);
    const delRun=await finish((await request('/workflows/'+delWf.id+'/run',{input:'Delegate by ID'})).data.id);
    assert.equal(delRun.status,'completed');
    assert.equal(delRun.steps[0].tools[0].ok,true);
    // 3. Reproducibility: stepHashes freeze agent config & replayRun rejects (409) if earlier step agent instructions changed
    const repB=await resident('Replay Step 2','openai','echo');
    const repWf=await flow('Frozen replay',[{agentId:u1.data.id,prompt:'Step one'},{agentId:repB.id,prompt:'Step two'}]);
    const repRun1=await finish((await request('/workflows/'+repWf.id+'/run',{input:'Freeze test'})).data.id);
    assert.equal(repRun1.status,'completed');
    assert.equal(repRun1.stepHashes.length,2);
    await request('/agents/'+u1.data.id,{...u1.data,instructions:'Alpha v2 modified instructions!'},'PUT');
    const repRejected=await request('/runs/'+repRun1.id+'/replay',{from:2});
    assert.equal(repRejected.status,409,'blocks partial replay when earlier step resident instructions changed');
    // 4. Propagated whisper purge on note removal & lifetime reliability stats across cleanResident
    const wSender=(await request('/agents',{name:'Whisper sender',role:'Fixture',floor:4,level:110,provider:'openai',model:'failure',instructions:'Fixture.'})).data;
    const wPeer=(await request('/agents',{name:'Whisper peer',role:'Fixture',floor:4,level:111,provider:'openai',model:'echo',instructions:'Fixture.'})).data;
    await request('/agents/'+wSender.id+'/memory',{text:'Secret turbine calibration 77'});
    let stNow=(await request('/state')).data;
    assert.ok(stNow.agents.find(x=>x.id===wPeer.id).whispers.some(w=>w.text.includes('Secret turbine calibration 77')),'whisper propagated to nearby peer');
    await request('/agents/'+wSender.id+'/memory',{remove:0});
    stNow=(await request('/state')).data;
    assert.ok(!stNow.agents.find(x=>x.id===wPeer.id).whispers.some(w=>w.text.includes('Secret turbine calibration 77')),'forget purges propagated whisper from colleagues');
    await request('/agents/'+wSender.id+'/chat',{message:'Trigger failure stat'});
    const cleanedSender=(await request('/agents/'+wSender.id+'/clean',{})).data;
    assert.equal(cleanedSender.stats.fail,0,'shift fail counter reset');
    assert.ok(cleanedSender.stats.totalFail>=1,'lifetime totalFail preserved after cleaning');
    // 5. Worker-isolated regex evaluation survives catastrophic backtracking (ReDoS)
    await request('/workflows/'+repWf.id+'/tests',{tests:[{name:'ReDoS guard',input:' Short brief ',checks:[{op:'regex',text:'^(a+)+$'}]}]});
    const evalStart=await request('/workflows/'+repWf.id+'/evaluate',{});
    assert.equal(evalStart.status,202);
    for(let i=0;i<40;i++){const cur=(await request('/state')).data.workflows.find(x=>x.id===repWf.id);if(cur.evals?.[0]?.status==='done')break;await new Promise(r=>setTimeout(r,80));}
    // 6. SQLite StateStore transactional persistence and corruption recovery
    const storeDir=path.join(temp,'sqlite-recovery-test');
    const store=new StateStore(storeDir);
    let store2=null;
    try{
      const sampleState={version:4,agents:[{id:'a1',name:'Judge Sims',level:12}],workflows:[],runs:[],jobs:[],goals:[],events:[],proposals:[],requests:[],users:[],channels:[],mcp:[],settings:{}};
      store.load(()=>sampleState);
      await store.save(sampleState);
      const backupId=store.createBackup(sampleState);
      assert.ok(store.verifyBackup(backupId),'SQLite backup checksum verified');
      store.close();
      await fs.writeFile(path.join(storeDir,'state.json'),'{corrupted-json','utf8');
      store2=new StateStore(storeDir);
      const recovered=store2.load(()=>({agents:[]}));
      assert.equal(recovered.agents[0].name,'Judge Sims','recovers intact state from SQLite when state.json is corrupted');
    }finally{
      store.close();store2?.close();
    }
  });
  await t.test('enforces P3 durable job queue, backoff retry, checkpoints, compensation and verifiable autonomy loop',async()=>{
    // 1. Durable Job Queue: priority, checkpoints, and automatic backoff retry from last checkpoint
    const step1Agent=await resident('Job Step 1','openai','echo');
    const step2Once=await resident('Job Step 2 FailOnce','openai','fail-once');
    const jobWf=await flow('Durable Retry Flow',[{agentId:step1Agent.id,prompt:'Checkpoint step 1'},{agentId:step2Once.id,prompt:'Step 2 transient'}]);
    const queued=(await request('/jobs',{workflowId:jobWf.id,input:'Durable payload',priority:9,maxAttempts:2,backoffMs:60})).data;
    assert.equal(queued.priority,9);
    let doneJob;
    for(let i=0;i<80;i++){
      const jl=(await request('/jobs')).data.jobs;
      doneJob=jl.find(j=>j.id===queued.id);
      if(doneJob?.status==='completed'||doneJob?.status==='failed')break;
      await new Promise(r=>setTimeout(r,60));
    }
    assert.equal(doneJob.status,'completed',doneJob.error);
    assert.equal(doneJob.attempts,2,'retried automatically after transient failure on attempt 1');
    assert.ok(doneJob.checkpoints.length>=2,'recorded durable checkpoints per step');
    // 2. Saga Compensation on Failure: rolls back proposals & notes created before a later step fails
    const compProposer=(await request('/agents',{name:'Comp Proposer',role:'Fixture',floor:3,provider:'openai',model:'tool-user',instructions:'Fixture.',tools:['write_files','memory']})).data;
    const compFailing=await resident('Comp Failing','openai','failure');
    const compWf=await flow('Saga Compensation Flow',[
      {agentId:compProposer.id,prompt:'CALL {"tool":"write_file","name":"notes/compensate-me.md","content":"Temporary uncompensated data"}'},
      {agentId:compFailing.id,prompt:'Will fail and trigger compensation'}
    ]);
    const compJob=(await request('/jobs',{workflowId:compWf.id,input:'Run saga',priority:8,maxAttempts:1,compensateOnFailure:true})).data;
    let finishedCompJob;
    for(let i=0;i<60;i++){
      finishedCompJob=(await request('/jobs')).data.jobs.find(j=>j.id===compJob.id);
      if(finishedCompJob?.status==='compensated'||finishedCompJob?.status==='failed')break;
      await new Promise(r=>setTimeout(r,60));
    }
    assert.equal(finishedCompJob.status,'compensated','job automatically compensated external actions on failure');
    const compProp=(await request('/state')).data.proposals.find(p=>p.name==='notes/compensate-me.md');
    assert.equal(compProp.status,'discarded','compensation automatically discarded pending file proposal');
    // 3. Verifiable Autonomy Loop: rejects unverified "I finished" claim, replans on verification failure, and verifies real artifacts
    const falseClaimer=await resident('False Claimer','openai','echo');
    const unverifiedGoal=(await request('/goals',{
      title:'Unverified Claim Test',
      objective:'Say you are done without writing the required file.',
      plannerId:falseClaimer.id,
      executorIds:[falseClaimer.id],
      maxIterations:1,
      criteria:[{type:'file_exists',file:'notes/never-created.md',label:'File must exist on disk'}]
    })).data;
    let g1;
    for(let i=0;i<60;i++){
      g1=(await request('/goals')).data.goals.find(g=>g.id===unverifiedGoal.id);
      if(g1?.status!=='running')break;
      await new Promise(r=>setTimeout(r,60));
    }
    assert.equal(g1.status,'failed','agent claiming completion without passing verification criteria is rejected');
    assert.equal(g1.verification.passed,false);
    // Now test full Objective -> Plan -> Execute -> Verify Failure -> Replan -> Execute -> Verified Completed!
    const replanExec=(await request('/agents',{name:'Autonomous Builder',role:'Fixture',floor:3,provider:'openai',model:'tool-user',instructions:'Fixture.',tools:['write_files']})).data;
    const autoGoal=(await request('/goals',{
      title:'Verified Spec Delivery',
      objective:'Write the verified turbine specification. CALL {"tool":"write_file","name":"notes/verified-spec.md","content":"# Turbine Spec\\nStatus: TURBINE_VERIFIED_OK"}',
      plannerId:falseClaimer.id,
      executorIds:[replanExec.id],
      maxIterations:2,
      autoApproveProposals:true,
      criteria:[
        {type:'file_exists',file:'notes/verified-spec.md',minBytes:10,label:'Spec file exists'},
        {type:'file_contains',file:'notes/verified-spec.md',text:'TURBINE_VERIFIED_OK',label:'Contains verification token'},
        {type:'api_check',path:'/api/files',expectStatus:200,expectText:'verified-spec.md',label:'Confirmed via /api/files'}
      ]
    })).data;
    let g2;
    for(let i=0;i<60;i++){
      g2=(await request('/goals')).data.goals.find(g=>g.id===autoGoal.id);
      if(g2?.status!=='running')break;
      await new Promise(r=>setTimeout(r,60));
    }
    assert.equal(g2.status,'completed',g2.error);
    assert.equal(g2.verification.passed,true);
    assert.equal(g2.verification.passedCount,3);
  });
  await t.test('P3 permissions: granular folder/operation scopes, expiring/revocable grants, delegation attenuation, and OAuth PKCE',async()=>{
    assert.equal((await request('/file',{name:'notes/allowed/safe.md',content:'# Safe Folder File\nAllowed content.'})).status,200);
    const scopedAgent=(await request('/agents',{
      name:'Scoped Worker',role:'Fixture',floor:2,provider:'openai',model:'no-tools',
      instructions:'Scoped.',tools:['read_files','write_files','delegate'],
      scopes:{folders:['notes/allowed'],operations:['read_file','ask_resident']}
    })).data;
    // 1. Folder scope blocks reading outside notes/allowed
    const blockedRead=await request('/agents/'+scopedAgent.id+'/chat',{message:'CALL {"tool":"read_file","name":"notes/context.md"}'});
    assert.equal(blockedRead.status,200);
    assert.match(blockedRead.data.text,/outside the allowed folder scope/i);
    // Allowed inside notes/allowed
    const allowedRead=await request('/agents/'+scopedAgent.id+'/chat',{message:'CALL {"tool":"read_file","name":"notes/allowed/safe.md"}'});
    assert.equal(allowedRead.status,200);
    assert.match(allowedRead.data.text,/Safe Folder File/);
    // Operation scope blocks write_file even though 'write_files' is in tools
    const blockedOp=await request('/agents/'+scopedAgent.id+'/chat',{message:'CALL {"tool":"write_file","name":"notes/allowed/new.md","content":"blocked"}'});
    assert.equal(blockedOp.status,200);
    assert.match(blockedOp.data.text,/You do not have permission to use write_file/i);
    // 2. Temporary capability grant unlocks notes/context.md and revocation immediately re-blocks it
    const grant=(await request('/grants',{
      subjectId:scopedAgent.id,
      folders:['notes/context.md'],
      operations:['read_file'],
      ttlMinutes:10,
      reason:'Temporary audit access'
    })).data;
    assert.ok(grant.id);
    const grantedRead=await request('/agents/'+scopedAgent.id+'/chat',{message:'CALL {"tool":"read_file","name":"notes/context.md"}'});
    assert.equal(grantedRead.status,200);
    assert.doesNotMatch(grantedRead.data.text,/outside the allowed folder scope/i);
    const revoked=await request(`/grants/${grant.id}/revoke`,{});
    assert.equal(revoked.status,200);
    assert.equal(revoked.data.grant.revoked,true);
    const reblockedRead=await request('/agents/'+scopedAgent.id+'/chat',{message:'CALL {"tool":"read_file","name":"notes/context.md"}'});
    assert.match(reblockedRead.data.text,/outside the allowed folder scope/i);
    // 3. Delegation without implicit privilege escalation: privileged helper cannot read outside caller's folder scope
    const privilegedHelper=(await request('/agents',{
      name:'Privileged Helper',role:'Fixture',floor:2,provider:'openai',model:'no-tools',
      instructions:'Helper.',tools:['read_files','write_files']
    })).data;
    const escAttempt=await request('/agents/'+scopedAgent.id+'/chat',{
      message:`CALL {"tool":"ask_resident","id":"${privilegedHelper.id}","task":"CALL {\\"tool\\":\\"read_file\\",\\"name\\":\\"notes/context.md\\"}"}`
    });
    assert.equal(escAttempt.status,200);
    assert.match(escAttempt.data.text,/outside the allowed folder scope/i);
    // 4. OAuth 2.0 with PKCE flow (start -> exchange -> status -> refresh)
    const oauthStart=await request('/oauth/start',{
      targetId:'compatible',
      authUrl:'https://oauth.example.com/authorize',
      tokenUrl:'https://oauth.example.com/token',
      clientId:'silo-client',
      scopes:['repo:read','workflow']
    });
    assert.equal(oauthStart.status,200);
    assert.match(oauthStart.data.authorizationUrl,/code_challenge_method=S256/);
    const oauthEx=await request('/oauth/exchange',{state:oauthStart.data.state,code:'auth-code-123'});
    assert.equal(oauthEx.status,200);
    assert.equal(oauthEx.data.ok,true);
    const oauthSt=await request('/oauth/status');
    assert.ok(oauthSt.data.targets.some(tk=>tk.targetId==='compatible'&&tk.connected&&tk.hasRefreshToken));
    const oauthRef=await request('/oauth/refresh',{targetId:'compatible'});
    assert.equal(oauthRef.status,200);
    assert.equal(oauthRef.data.ok,true);
  });
  await t.test('P3 context and models: controlled compaction, provenance/TTL/contradiction detection, cost/quality routing, and policy-preserving fallback',async()=>{
    // 1. Controlled context compaction under tight token budget
    const compactAgent=(await request('/agents',{
      name:'Compact Resident',role:'Fixture',floor:3,provider:'openai',model:'echo',
      instructions:'Compact.',tools:[],contextBudget:45
    })).data;
    await request('/agents/'+compactAgent.id+'/chat',{message:'First long message about Silo turbine diagnostics and mechanical telemetry across sector alpha.'});
    await request('/agents/'+compactAgent.id+'/chat',{message:'Second long message about hydro-ponic nutrient balances and atmospheric scrubbers in sector beta.'});
    await request('/agents/'+compactAgent.id+'/chat',{message:'Third message checking compaction summary status.'});
    const afterCompact=(await request('/state')).data.agents.find(a=>a.id===compactAgent.id);
    assert.ok(afterCompact.stats.compactions>=1,'compacted conversation when exceeding token budget');
    assert.ok(afterCompact.lastCompaction?.savedTokens>0);
    // 2. Memory provenance, TTL expiration, and contradiction detection + supersede
    const mem1=await request(`/agents/${compactAgent.id}/memory`,{
      text:'Turbine pressure is 120 psi',
      source:'mission',
      origin:'turbine-bay-1',
      trust:'trusted',
      ttlHours:24
    });
    assert.equal(mem1.status,200);
    assert.equal(mem1.data.memory.at(-1).source,'mission');
    assert.equal(mem1.data.conflicts.length,0);
    // Add already-expired note and verify pruning
    await request(`/agents/${compactAgent.id}/memory`,{
      text:'Temporary calibration value is 10',
      expiresAt:Date.now()-5000
    });
    const memList1=await request(`/agents/${compactAgent.id}/memory`);
    assert.ok(!memList1.data.memory.some(m=>m.text.includes('Temporary calibration')),'expired TTL memory was automatically pruned');
    // Add contradicting note on same subject ("turbine pressure")
    const memConflict=await request(`/agents/${compactAgent.id}/memory`,{
      text:'Turbine pressure is 65 psi',
      source:'operator',
      origin:'operator'
    });
    assert.equal(memConflict.status,200);
    assert.equal(memConflict.data.conflicts.length,1,'detected value conflict on Turbine pressure');
    assert.match(memConflict.data.conflicts[0].reason,/value_conflict/);
    // Supersede old contradicted note
    const memSupersede=await request(`/agents/${compactAgent.id}/memory`,{
      text:'Turbine pressure is 95 psi',
      source:'operator',
      supersede:true
    });
    assert.equal(memSupersede.data.conflicts.length,2);
    assert.equal(memSupersede.data.memory.filter(m=>m.text.startsWith('Turbine pressure')).length,1,'supersede replaced older contradicting notes');
    // 3. Cost vs Quality model routing
    const costRouter=(await request('/agents',{
      name:'Cost Router',role:'Fixture',floor:4,provider:'openai',model:'echo',
      instructions:'Route by cost.',tools:[],
      routing:{
        mode:'cost',
        requiredCapabilities:['reasoning'],
        candidates:[
          {provider:'openai',model:'expensive-echo',costPer1M:15,quality:10,capabilities:['reasoning','coding']},
          {provider:'openai',model:'cheap-echo',costPer1M:0.5,quality:7,capabilities:['reasoning']}
        ]
      }
    })).data;
    await request('/agents/'+costRouter.id+'/chat',{message:'Route me cheaply.'});
    const routedCost=(await request('/state')).data.agents.find(a=>a.id===costRouter.id);
    assert.equal(routedCost.lastRoute?.model,'cheap-echo','cost mode selected lowest cost candidate meeting required capabilities');
    await request('/agents/'+costRouter.id,{...routedCost,routing:{...routedCost.routing,mode:'quality'}},'PUT');
    await request('/agents/'+costRouter.id+'/chat',{message:'Route me by highest quality.'});
    const routedQuality=(await request('/state')).data.agents.find(a=>a.id===costRouter.id);
    assert.equal(routedQuality.lastRoute?.model,'expensive-echo','quality mode selected highest quality candidate');
    // 4. Policy-preserving fallback: primary restricted to notes/allowed fails over to unrestricted shadow, but shadow inherits primary's folder & tool restrictions
    const unrestrictedShadow=(await request('/agents',{
      name:'Unrestricted Shadow',role:'Fixture',floor:4,provider:'openai',model:'no-tools',
      instructions:'Shadow.',tools:['read_files','write_files']
    })).data;
    const restrictedPrimary=(await request('/agents',{
      name:'Restricted Primary',role:'Fixture',floor:4,provider:'openai',model:'failure',
      instructions:'Primary.',tools:['read_files'],
      shadowId:unrestrictedShadow.id,
      scopes:{folders:['notes/allowed'],operations:['read_file']}
    })).data;
    const fallbackBlocked=await request('/agents/'+restrictedPrimary.id+'/chat',{
      message:'CALL {"tool":"read_file","name":"notes/context.md"}'
    });
    assert.equal(fallbackBlocked.status,200);
    assert.equal(fallbackBlocked.data.shadowId,unrestrictedShadow.id,'shadow agent handled the failed primary call');
    assert.equal(fallbackBlocked.data.policyPreserved,true);
    assert.match(fallbackBlocked.data.text,/outside the allowed folder scope/i,'shadow agent preserved primary resident folder scope');
  });
  await t.test('answers an unchanged state with an empty 204 and a changed one in full',async()=>{const first=(await request('/state')).data;assert.ok(first.tag);assert.equal((await request('/state',undefined,'GET',{'x-silo-since':first.tag})).status,204);await request('/pause',{paused:true});const changed=await request('/state',undefined,'GET',{'x-silo-since':first.tag});assert.equal(changed.status,200);assert.notEqual(changed.data.tag,first.tag);assert.equal(changed.data.paused,true);await request('/pause',{paused:false});});
  await t.test('persists scheduling and prevents deleting referenced residents',async()=>{const w=await request('/workflows/'+workflow.id,{...workflow,enabled:true,interval:30},'PUT');assert.ok(w.data.nextRun>Date.now());assert.equal(w.data.interval,30);assert.equal((await request('/agents/'+agent.id,{},'DELETE')).status,400);await request('/workflows/'+workflow.id,{},'DELETE');assert.equal((await request('/agents/'+agent.id,{},'DELETE')).status,200);const {StateStore}=await import('../storage.mjs');const reader=new StateStore(path.join(temp,'data'));const saved=reader.reconstructFromTables();reader.close();assert.ok(!saved.agents.some(a=>a.id===agent.id));assert.ok(saved.agents.length>=432);assert.equal(saved.version,4);assert.ok(saved.events.some(e=>e.title==='Workspace file saved'));});
});
