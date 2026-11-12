// SILO for outside programs: the MCP server, the A2A agent and its client, notebooks and Python tools, on an isolated
// test server with a fake provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {McpClient} from '../mcp-client.mjs';
import {handleMcp,checkArgs,uniqueNames,toolSlug} from '../mcp-server.mjs';
import {TaskStore,messageText,view,agentCard,checkAgentUrl,fetchCard,TERMINAL} from '../a2a.mjs';
import {localCommand} from '../sandbox.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const until=async(fn,ms,what)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await new Promise(r=>setTimeout(r,60));}};

test('MCP protocol: versions, notifications, scopes and argument checks',async()=>{
  const calls=[];
  const ctx={info:{name:'SILO',version:'1',instructions:'hi'},can:s=>s!=='approve',
    tools:()=>[{name:'ask_x',title:'Ask',description:'d',scope:'run',inputSchema:{type:'object',properties:{message:{type:'string',maxLength:5}},required:['message'],additionalProperties:false}},{name:'decide',description:'d',scope:'approve',inputSchema:{type:'object',properties:{}}}],
    call:async(t,a)=>{calls.push(a);if(a.message==='boom')throw Error('broke');return {text:'ok '+a.message,data:{n:1}};}};
  const init=await handleMcp({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}},ctx);
  assert.equal(init.body.result.protocolVersion,'2025-03-26');assert.equal(init.body.result.serverInfo.name,'silo');
  assert.equal((await handleMcp({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'1999-01-01'}},ctx)).body.result.protocolVersion,'2025-06-18');
  assert.deepEqual(await handleMcp({jsonrpc:'2.0',method:'notifications/initialized'},ctx),{status:202,body:null});
  const list=await handleMcp({jsonrpc:'2.0',id:2,method:'tools/list'},ctx);
  assert.deepEqual(list.body.result.tools.map(t=>t.name),['ask_x'],'tools the token cannot use are not listed');
  assert.ok(!('scope' in list.body.result.tools[0]));
  const call=(name,args)=>handleMcp({jsonrpc:'2.0',id:3,method:'tools/call',params:{name,arguments:args}},ctx).then(r=>r.body);
  assert.deepEqual((await call('ask_x',{message:'hi'})).result,{content:[{type:'text',text:'ok hi'}],structuredContent:{n:1}});
  assert.match((await call('ask_x',{message:'far too long'})).result.content[0].text,/longer than 5/);
  assert.match((await call('ask_x',{})).result.content[0].text,/required/);
  assert.match((await call('ask_x',{message:'hi',extra:1})).result.content[0].text,/not an argument/);
  assert.equal((await call('ask_x',{message:'boom'})).result.isError,true);
  assert.match((await call('decide',{})).result.content[0].text,/approve scope/);
  assert.equal((await call('nope',{})).error.code,-32602);
  assert.equal((await handleMcp({jsonrpc:'2.0',id:4,method:'sampling/x'},ctx)).body.error.code,-32601);
  assert.equal((await handleMcp({id:5},ctx)).body.error.code,-32600);
  const batch=await handleMcp([{jsonrpc:'2.0',id:6,method:'ping'},{jsonrpc:'2.0',method:'notifications/cancelled'}],ctx);
  assert.equal(batch.body.length,1);
  assert.equal(calls.length,2,'bad arguments never reach the tool');
  assert.deepEqual(uniqueNames([{name:'Ana Pop'},{name:'ana-pop'},{name:'Știri'}],'ask_'),['ask_ana_pop','ask_ana_pop_2','ask_stiri']);
  assert.equal(toolSlug('***'),'x');assert.equal(checkArgs({type:'object',properties:{n:{type:'integer',minimum:1,maximum:3}}},{n:4}),'"n" must be between 1 and 3.');
});

test('A2A pieces: messages, tasks, owners and the card',async()=>{
  assert.equal(messageText({role:'user',parts:[{kind:'text',text:'a'},{kind:'data',data:{b:1}}]}),'a\n\n```json\n{"b":1}\n```');
  assert.throws(()=>messageText({role:'agent',parts:[{kind:'text',text:'a'}]}),/role "user"/);
  assert.throws(()=>messageText({role:'user',parts:[{kind:'file',file:{uri:'x'}}]}),e=>e.code===-32005);
  const store=new TaskStore({max:3}),events=[];
  const t=store.create({owner:'a',skill:'s',message:{kind:'message'}});store.on(t.id,e=>events.push(e));
  assert.throws(()=>store.get(t.id,'b'),e=>e.code===-32001,'another caller cannot see the task');
  store.status(t,'working');store.artifact(t,'answer','42');store.status(t,'completed','done');store.status(t,'failed');
  assert.equal(t.status.state,'completed','an ended task stays ended');
  assert.deepEqual(events.map(e=>e.kind+(e.final?'!':'')),['status-update','artifact-update','status-update!']);
  assert.equal(JSON.stringify(t).includes('"owner"'),false);
  assert.equal(view(t,0).history.length,0);assert.equal(view(t).history.length,2);
  for(let i=0;i<3;i++)store.create({owner:'a',skill:'s',message:{}});
  assert.throws(()=>store.get(t.id,'a'),e=>e.code===-32001,'an ended task makes room');
  assert.throws(()=>store.create({owner:'a',skill:'s',message:{}}),/Too many/,'running tasks are never dropped to make room');
  assert.ok(TERMINAL.has('canceled'));
  const card=agentCard({name:'SILO',description:'d',url:'http://x/api/serve/a2a',version:'1',skills:[]});
  assert.equal(card.preferredTransport,'JSONRPC');assert.equal(card.capabilities.streaming,true);
  assert.throws(()=>checkAgentUrl('http://example.com'),/https/);assert.throws(()=>checkAgentUrl('https://u:p@example.com'),/token/);
  const fake=card=>async()=>new Response(JSON.stringify(card),{status:200});
  await assert.rejects(fetchCard('https://good.example',{fetch:fake({name:'Evil',url:'https://evil.example/rpc'})}),/only sends the token/);
  assert.equal((await fetchCard('https://good.example',{fetch:fake({name:'Good',url:'/rpc',skills:[{id:'s1'}]})})).endpoint,'https://good.example/rpc');
});

test('outside programs: MCP server, A2A agent and client, notebooks and Python tools',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-serve-test-'));
  const port=14397,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{if(process.env.SHOW_ERRORS)console.error(errors);child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once("exit",r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  const st=async()=>(await request('/state')).data;
  await request('/connections',{provider:'compatible',key:'fixture-key-serve',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  const agent=async(name,model,tools=[])=>(await request('/agents',{name,role:'Fixture',floor:2,provider:'compatible',model,instructions:'Fixture.',tools})).data;
  const clerk=await agent('Clerk','fixture'),hidden=await agent('Hidden','fixture'),caller=await agent('Caller','tool-user',['delegate','run_code']);
  const flow=(await request('/workflows',{name:'Stand',steps:[{agentId:clerk.id,prompt:'Answer the customer.'}]})).data;
  const newToken=async scopes=>(await request('/tokens',{name:'T'+scopes.join(''),scopes,days:7})).data.secret;
  const full=await newToken(['read','run','approve']),readOnly=await newToken(['read']),other=await newToken(['read','run']);
  const rpc=async(route,body,tok,accept='application/json')=>fetch(origin+route,{method:'POST',headers:{authorization:'Bearer '+tok,'content-type':'application/json',accept},body:JSON.stringify(body)});
  const mcp=tok=>new McpClient({transport:'http',url:origin+'/api/serve/mcp',headers:{Authorization:'Bearer '+tok}});

  await t.test('nothing is exposed until an owner turns it on',async()=>{
    assert.equal((await rpc('/api/serve/mcp',{jsonrpc:'2.0',id:1,method:'ping'},full)).status,404);
    assert.equal((await fetch(origin+'/.well-known/agent-card.json')).status,404);
    assert.equal((await rpc('/api/expose',{mcp:true},full)).status,403,'a token without admin cannot expose anything');
    assert.equal((await request('/expose',{residents:['nope']})).status,400);
    assert.equal((await request('/expose',{residents:[clerk.id],front:hidden.id})).status,400,'the front resident must be exposed');
    const r=await request('/expose',{mcp:true,a2a:true,residents:[clerk.id],workflows:[flow.id],front:clerk.id});
    assert.equal(r.status,200);assert.deepEqual(r.data.expose.residents,[clerk.id]);
  });

  await t.test('MCP: a token sees and runs only what it may',async()=>{
    const c=mcp(full);t.after(()=>c.close());
    const tools=await c.listTools(),names=tools.map(x=>x.name);
    assert.deepEqual(names.filter(n=>/^(ask|run)_/.test(n)),['ask_clerk','run_stand'],'Hidden is not exposed');
    assert.ok(names.includes('silo_decide')&&names.includes('silo_run_tests'));
    assert.equal(c.server.name,'silo');
    const asked=await c.callTool('ask_clerk',{message:'What do you sell?'});
    assert.equal(asked.isError,undefined);assert.equal(asked.content[0].text,'Compatible fixture');
    const ran=await c.callTool('run_stand',{input:'Two apples'});
    assert.equal(ran.structuredContent.status,'completed',JSON.stringify(ran));assert.equal(ran.content[0].text,'Compatible fixture');
    const got=await c.callTool('silo_get_run',{runId:ran.structuredContent.runId});assert.equal(got.structuredContent.output,'Compatible fixture');
    assert.equal((await c.callTool('silo_pending',{})).content[0].text,'Nothing waits for approval.');
    assert.match((await c.callTool('silo_test_report',{target:'ask_clerk'})).content[0].text,/no test report/);
    assert.equal((await c.callTool('silo_get_run',{runId:'x'})).isError,true);
    const chats=(await st()).agents.find(a=>a.id===clerk.id).chats||[];
    assert.equal(chats.length,0,'an outside question does not change the resident chat');
    const ro=mcp(readOnly);t.after(()=>ro.close());
    const roNames=(await ro.listTools()).map(x=>x.name);
    assert.ok(!roNames.includes('ask_clerk')&&!roNames.includes('silo_decide')&&roNames.includes('silo_pending'));
    const denied=await ro.callTool('ask_clerk',{message:'hi'});assert.equal(denied.isError,true);assert.match(denied.content[0].text,/run scope/);
    assert.equal((await fetch(origin+'/api/serve/mcp',{headers:{authorization:'Bearer '+full}})).status,405,'no event stream to open');
    const audit=JSON.stringify((await request('/audit')).data);assert.match(audit,/POST \/api\/serve\/mcp/);
  });

  await t.test('A2A: the card, blocking and streaming tasks, owners and cancel',async()=>{
    const card=await (await fetch(origin+'/.well-known/agent-card.json')).json();
    assert.equal(card.url,origin+'/api/serve/a2a');assert.deepEqual(card.skills.map(s=>s.id),['ask_clerk','run_stand']);
    assert.deepEqual(await (await fetch(origin+'/.well-known/agent.json')).json(),card);
    const msg=(text,extra={})=>({jsonrpc:'2.0',id:7,method:'message/send',params:{message:{kind:'message',role:'user',messageId:'m1',parts:[{kind:'text',text}]},...extra}});
    let r=await (await rpc('/api/serve/a2a',msg('hi'),full)).json();
    assert.equal(r.result.status.state,'completed',JSON.stringify(r));assert.equal(r.result.metadata.skill,'ask_clerk','the front resident answers when no skill is named');
    assert.equal(r.result.artifacts[0].parts[0].text,'Compatible fixture');
    const id=r.result.id,ctxId=r.result.contextId;
    assert.equal((await (await rpc('/api/serve/a2a',{jsonrpc:'2.0',id:8,method:'tasks/get',params:{id}},full)).json()).result.id,id);
    assert.equal((await (await rpc('/api/serve/a2a',{jsonrpc:'2.0',id:8,method:'tasks/get',params:{id}},other)).json()).error.code,-32001,'another token cannot read the task');
    assert.equal((await (await rpc('/api/serve/a2a',{jsonrpc:'2.0',id:9,method:'tasks/cancel',params:{id}},full)).json()).error.code,-32002);
    assert.equal((await (await rpc('/api/serve/a2a',{jsonrpc:'2.0',id:9,method:'tasks/pushNotificationConfig/set',params:{}},full)).json()).error.code,-32003);
    assert.equal((await (await rpc('/api/serve/a2a',msg('hi',{metadata:{skill:'ask_hidden'}}),full)).json()).error.code,-32602);
    assert.equal((await rpc('/api/serve/a2a',msg('hi'),readOnly)).status,403);
    r=await (await rpc('/api/serve/a2a',msg('again',{metadata:{skill:'run_stand'},configuration:{blocking:false}}),full)).json();
    assert.ok(['submitted','working'].includes(r.result.status.state));
    const done=await until(async()=>{const x=await (await rpc('/api/serve/a2a',{jsonrpc:'2.0',id:1,method:'tasks/get',params:{id:r.result.id}},full)).json();return TERMINAL.has(x.result.status.state)&&x.result;},15000,'workflow task');
    assert.equal(done.status.state,'completed');assert.ok(done.metadata.runId);
    const sse=await rpc('/api/serve/a2a',{...msg('follow up'),method:'message/stream',params:{...msg('follow up').params,message:{...msg('follow up').params.message,contextId:ctxId}}},full,'text/event-stream');
    assert.match(sse.headers.get('content-type'),/text\/event-stream/);
    const events=(await sse.text()).split('\n\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)).result);
    assert.equal(events[0].kind,'task');assert.equal(events.at(-1).final,true);assert.equal(events.at(-1).status.state,'completed');
    assert.ok(events.some(e=>e.kind==='artifact-update'));assert.equal(events[0].contextId,ctxId);
  });

  await t.test('A2A client: a resident asks an outside agent after your OK, and the answer is marked untrusted',async()=>{
    assert.equal((await request('/a2a/peers',{address:'http://example.org'})).status,502);
    const add=await request('/a2a/peers',{address:origin,name:'Self',token:other});
    assert.equal(add.status,201,JSON.stringify(add.data));assert.equal(add.data.peer.endpoint,origin+'/api/serve/a2a');
    const state=await st();assert.equal(state.access.a2aKeys[add.data.peer.id],true);assert.ok(!JSON.stringify(state).includes(other),'the token never comes back');
    const pending=request('/agents/'+caller.id+'/chat',{message:'CALL '+JSON.stringify({tool:'ask_agent',agent:'Self',skill:'ask_clerk',message:'Prices?'})});
    const req=await until(async()=>(await st()).requests.find(x=>x.status==='pending'),15000,'approval');
    assert.equal(req.tool,'ask_agent:'+add.data.peer.id);assert.match(req.detail,/Prices\?/);
    await request('/requests/'+req.id,{allow:true});
    const r=await pending;assert.equal(r.status,200,JSON.stringify(r.data));
    const trace=JSON.stringify((await request('/traces/'+r.data.traceId)).data);
    assert.match(trace,/trust=\\"untrusted\\"/);assert.match(trace,/Compatible fixture/);
    assert.equal((await request('/a2a/peers/'+add.data.peer.id,undefined,'DELETE')).status,200);
    assert.equal((await st()).settings.a2aPeers.length,0);
  });

  const py=await localCommand('python');
  await t.test('notebooks: a kernel keeps variables between approved cells and the notebook is saved',{skip:!py&&'Python 3 is not installed'},async()=>{
    assert.equal((await request('/settings',{sandbox:'local'})).status,200);
    const cell=code=>request('/agents/'+caller.id+'/chat',{message:'CALL '+JSON.stringify({tool:'notebook_run',code})});
    let pending=cell('x = 21\nprint("set")');
    const req=await until(async()=>(await st()).requests.find(x=>x.status==='pending'),15000,'approval');
    assert.equal(req.tool,'notebook:local');assert.match(req.title,/notebook cell \[LOCAL/);
    await request('/requests/'+req.id,{allow:true,always:true});
    assert.equal((await pending).status,200);
    const r=await cell('open("result.txt","w").write(str(x*2))\nx * 2');
    assert.match(r.data.text,/Out\[2\]: 42/,JSON.stringify(r.data));
    const list=(await request('/notebooks')).data.notebooks;
    assert.equal(list.length,1);assert.equal(list[0].name,'main');assert.equal(list[0].running,true);
    const nb=(await request('/notebooks/'+caller.id+'/main')).data.notebook;
    assert.equal(nb.nbformat,4);assert.equal(nb.cells.length,2);assert.deepEqual(nb.cells[1].outputs.at(-1).data['text/plain'],['42']);
    assert.ok((await st()).proposals.some(p=>p.name==='result.txt'&&p.status==='pending'),'a written file becomes a proposal');
    assert.equal((await request('/notebooks/'+caller.id+'/main',{action:'restart'})).data.stopped,true);
    const again=await cell('print(x)');assert.match(again.data.text,/new kernel started[\s\S]*NameError/);
    const saved=await request('/notebooks/'+caller.id+'/main',{action:'archive'});assert.equal(saved.data.name,'notebooks/caller/main.ipynb');
    assert.ok(existsSync(path.join(temp,'workspace','notebooks','caller','main.ipynb')));
    assert.equal((await request('/notebooks/'+caller.id+'/main',undefined,'DELETE')).status,200);
    assert.equal((await request('/notebooks')).data.notebooks.length,0);
    assert.equal((await request('/notebooks/'+caller.id+'/..%2F..%2Fx')).status,404);
  });

  await t.test('a Python tool is written from the template and added as a connector',{skip:!py&&'Python 3 is not installed'},async()=>{
    const r=await request('/python-tools',{name:'Text Tools',description:'Counts words.'});
    assert.equal(r.status,201,JSON.stringify(r.data));assert.deepEqual(r.data.files,['tools/text_tools/server.py','tools/text_tools/requirements.txt','tools/text_tools/README.md']);
    const server=await fs.readFile(path.join(temp,'workspace','tools','text_tools','server.py'),'utf8');
    assert.match(server,/FastMCP\("Text Tools", instructions="Counts words."\)/);
    const c=(await st()).mcp.find(x=>x.name==='Text Tools');assert.equal(c.transport,'stdio');assert.equal(c.args.at(-1),'tools/text_tools/server.py');
    assert.equal((await request('/python-tools',{name:'Text Tools'})).status,409);
    // Without the mcp package the connector is added but not reachable; with it, its tools are listed.
    const hasMcp=await new Promise(res=>{const p=spawn(py.cmd,[...py.pre,'-c','import mcp.server.fastmcp'],{windowsHide:true});p.on('exit',code=>res(code===0));p.on('error',()=>res(false));});
    if(hasMcp)assert.equal(r.data.tools,2,r.data.error);else assert.ok(r.data.error);
  });
});
