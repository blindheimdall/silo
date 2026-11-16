// Workspaces: one server, separate teams. The host sends each address to its own SILO, which only answers requests
// that come through the host; a hosted workspace starts no programs and reaches nothing on the server's network; its
// budget holds for all providers together; and the main workspace makes, pauses, starts, renames and removes them.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promises as fs,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {routeHost,checkSlug,cleanRegistry,cleanBudget,visitorOf} from '../workspaces.mjs';
import {guardOptions,allowList} from '../tenant-guard.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms,what)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(100);}};
// No key of this computer reaches a test SILO.
const clean=()=>Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^(SILO_|OPENAI_|ANTHROPIC_|COMPATIBLE_)/.test(k)));

test('addresses, names and budgets',()=>{
  const d='silo.example.com';
  assert.equal(routeHost('silo.example.com',d),'');assert.equal(routeHost('SILO.example.com:443',d),'');assert.equal(routeHost('127.0.0.1:3000',d),'');assert.equal(routeHost('[::1]:3000',d),'');
  assert.equal(routeHost('acme.silo.example.com',d),'acme');assert.equal(routeHost('acme.silo.example.com.',d),'acme');assert.equal(routeHost('north-shop.localhost:3000',d),'north-shop');
  for(const bad of ['evil.com','a.b.silo.example.com','www.silo.example.com','-x.silo.example.com','silo.example.com.evil.com','x.example.com','acme.silo.example.com@evil','',undefined,'1.2.3.4:3000'])
    assert.equal(routeHost(bad,d),null,String(bad));
  assert.equal(checkSlug(' Acme '),'acme');
  for(const bad of ['','-a','a-','main','www','a_b','x'.repeat(33),'a.b'])assert.throws(()=>checkSlug(bad),undefined,bad);
  assert.equal(cleanBudget(''),0);assert.equal(cleanBudget('12.345'),12.35);assert.throws(()=>cleanBudget(-1));assert.throws(()=>cleanBudget('lots'));
  const r=cleanRegistry({workspaces:[{slug:'acme',name:' Acme\u0007 Ltd ',budget:5},{slug:'acme'},{slug:'main'},{slug:'../x'},{slug:'beta',budget:-3,paused:true},null]});
  assert.deepEqual(r.workspaces.map(w=>[w.slug,w.name,w.budget,w.paused]),[['acme','Acme Ltd',5,false],['beta','beta',0,true]]);
});

test('the visitor: this computer, or the address a trusted proxy gives',()=>{
  const req=(remote,headers={})=>({socket:{remoteAddress:remote},headers});
  assert.deepEqual(visitorOf(req('127.0.0.1')),{ip:'127.0.0.1',local:true,scheme:'http'});
  assert.equal(visitorOf(req('127.0.0.1',{'cf-ray':'x'})).local,false,'a tunnel on this computer is not this computer');
  assert.equal(visitorOf(req('127.0.0.1',{'x-forwarded-for':'203.0.113.9'})).local,true,'headers mean nothing without a trusted proxy');
  assert.deepEqual(visitorOf(req('10.0.0.2',{'x-forwarded-for':'1.1.1.1, 203.0.113.9','x-forwarded-proto':'https'}),{trustProxy:true}),{ip:'203.0.113.9',local:false,scheme:'https'});
  assert.deepEqual(visitorOf(req('127.0.0.1',{'x-forwarded-for':'127.0.0.1'}),{trustProxy:true}),{ip:'unknown',local:false,scheme:'http'},'a proxied visitor is never this computer');
});

test('the wall around a hosted workspace: no programs, no private addresses',async()=>{
  assert.equal(guardOptions({path:'/var/run/docker.sock'}),null);
  for(const host of ['127.0.0.1','10.1.2.3','169.254.169.254','::1','::ffff:192.168.1.1'])assert.equal(guardOptions({host,port:80}),null,host);
  assert.ok(guardOptions({host:'8.8.8.8',port:53}));assert.ok(guardOptions({host:'10.1.2.3',port:80},allowList('10.1.2.3, Ollama.lan')));
  const g=guardOptions({host:'inside.test',port:80,lookup:(n,o,cb)=>cb(null,[{address:'192.168.0.5',family:4}])});
  const err=await new Promise(r=>g.lookup('inside.test',{},e=>r(e)));assert.equal(err.code,'EPRIVATE','a public name that points inside is refused');
  const mixed=guardOptions({host:'mixed.test',port:80,lookup:(n,o,cb)=>cb(null,[{address:'10.0.0.1',family:4},{address:'93.184.216.34',family:4}])});
  assert.deepEqual(await new Promise(r=>mixed.lookup('mixed.test',{},(e,a,f)=>r([a,f]))),['93.184.216.34',4],'only the public address is used');
  // In a process of its own, as a workspace is.
  const probe=`import './tenant-guard.mjs';import {spawn} from 'node:child_process';import http from 'node:http';
const s=http.createServer((q,r)=>r.end('inside')).listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));const p=s.address().port,out={};
try{spawn(process.execPath,['-v']);out.spawn='ran';}catch(e){out.spawn=e.code;}
for(const [k,u] of [['ip','http://127.0.0.1:'+p],['name','http://localhost:'+p]])try{await fetch(u);out[k]='reached';}catch(e){out[k]=e.cause?.code||e.code;}
await new Promise(r=>http.get('http://127.0.0.1:'+p,()=>{out.http='reached';r();}).on('error',e=>{out.http=e.code;r();}));
s.close();console.log(JSON.stringify(out));`;
  const run=env=>new Promise((resolve,reject)=>execFile(process.execPath,['--input-type=module','-e',probe],{cwd:root,env:{...clean(),...env},timeout:15000},(e,o)=>e?reject(e):resolve(JSON.parse(o))));
  assert.deepEqual(await run({SILO_TENANT:'1'}),{spawn:'ETENANT',ip:'EPRIVATE',name:'EPRIVATE',http:'EPRIVATE'});
  assert.deepEqual(await run({}),{spawn:'ran',ip:'reached',name:'reached',http:'reached'},'outside a hosted workspace nothing changes');
});

test('a hosted SILO answers only through its host, and keeps its budget',async t=>{
  const port=14499,temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-hosted-test-')),origin=`http://127.0.0.1:${port}`,token='a'.repeat(48),control='b'.repeat(48);
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...clean(),PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),SILO_HOSTED_TOKEN:token,SILO_HOSTED_CONTROL:control,SILO_WORKSPACE_BUDGET:'0.01'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const hosted={'x-silo-hosted':token,'x-silo-local':'1'};
  assert.equal((await fetch(origin+'/api/session')).status,403,'not through the host');
  assert.equal((await fetch(origin+'/api/session',{headers:{'x-silo-hosted':'c'.repeat(48)}})).status,403,'a wrong token');
  assert.equal((await fetch(origin+'/api/health')).status,403);
  assert.equal((await fetch(origin+'/api/hosted/status',{headers:hosted})).status,404,'the status needs the control token too');
  const st=await (await fetch(origin+'/api/hosted/status',{headers:{...hosted,'x-silo-control':control}})).json();
  assert.equal(st.accounts,0);assert.equal(st.budget,0.01);assert.match(st.setup,/^[a-f0-9]{32}$/,'the setup code while there is no account');
  // A visitor from elsewhere needs the setup code; this computer does not.
  assert.equal((await fetch(origin+'/api/session',{headers:{'x-silo-hosted':token,'x-silo-local':'0','x-silo-client':'203.0.113.9','x-silo-proto':'https'}})).status,403);
  const s=await fetch(origin+'/api/session',{headers:hosted});assert.equal(s.status,200);
  const {token:csrf}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body)=>{const r=await fetch(origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{...hosted,cookie,origin,'Content-Type':'application/json','x-silo-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  assert.deepEqual((await request('/state')).data.hosted,{tenant:false,host:false,budget:0.01,month:0});
  assert.equal((await request('/settings',{network:true})).status,409,'the host decides who reaches it');

  await request('/connections',{provider:'compatible',key:'fixture-hosted-key',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  const a=(await request('/agents',{name:'Clerk',role:'Fixture',floor:3,provider:'compatible',model:'fixture',instructions:'Fixture.'})).data;
  const ask=()=>request('/agents/'+a.id+'/chat',{message:'Hello.'});
  await t.test('a model without a price cannot be held to the budget',async()=>{
    const r=await ask();assert.equal(r.status,402);assert.match(r.data.error,/monthly budget, but no price/);
  });
  await t.test('within the budget calls go; past it they stop, for every provider',async()=>{
    await request('/spending',{prices:{'compatible:fixture':{input:1,output:1}}});
    const ok=await ask();assert.equal(ok.status,200,JSON.stringify(ok.data));
    const month=(await request('/state')).data.hosted.month;assert.ok(month>0&&month<0.01,'what it cost counts: '+month);
    const plan=await fetch(origin+'/api/hosted/plan',{method:'POST',headers:{...hosted,'x-silo-control':control,'content-type':'application/json'},body:JSON.stringify({budget:month/2})});
    assert.equal(plan.status,200);
    const r=await ask();assert.equal(r.status,402);assert.match(r.data.error,/spent its budget for the month/);
    // The owner of the workspace cannot lift it: the limits they set are their own, under it.
    assert.equal((await request('/spending',{limits:{compatible:{monthly:1000}}})).status,200);
    assert.equal((await ask()).status,402);
    await fetch(origin+'/api/hosted/plan',{method:'POST',headers:{...hosted,'x-silo-control':control,'content-type':'application/json'},body:JSON.stringify({budget:0})});
    assert.equal((await ask()).status,200,'no budget, no stop');
  });
});

test('the workspace host',async t=>{
  const port=14497,temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-workspaces-test-')),data=path.join(temp,'data');
  const host=spawn(process.execPath,['workspaces.mjs'],{cwd:root,env:{...clean(),PORT:String(port),SILO_DATA_DIR:data,SILO_WORK_DIR:path.join(temp,'workspace'),SILO_PROXY:'1',SILO_SECRET:'host passphrase for tests'},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  let out='';host.stdout.on('data',b=>{out+=b;});host.stderr.on('data',b=>{out+=b;});
  t.after(async()=>{try{host.send('stop');}catch{}await new Promise(r=>{if(host.exitCode!==null)return r();host.once('exit',r);setTimeout(()=>{host.kill();r();},12000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await until(()=>out.includes('SILO is ready at http://127.0.0.1:'+port),20000,'the host: '+out);
  // Requests with the Host header a browser would send for each address.
  const call=(name,route,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const r=http.request({host:'127.0.0.1',port,method,path:route,headers:{host:name,...headers,...(body!==undefined&&{'content-type':'application/json'})}},res=>{let s='';res.setEncoding('utf8');res.on('data',d=>s+=d);res.on('end',()=>{let j=null;try{j=JSON.parse(s);}catch{}resolve({status:res.statusCode,headers:res.headers,text:s,data:j});});});
    r.on('error',reject);r.end(body===undefined?undefined:JSON.stringify(body));
  });
  const session=async(name,extra={})=>{
    const s=await call(name,'/api/session',{headers:extra});assert.equal(s.status,200,s.text);
    let cookie=s.headers['set-cookie'][0].split(';')[0],csrf=s.data.token;const origin=`http://${name}`;
    // Signing in gives a new session.
    const f=async(route,body)=>{const r=await call(name,'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin,'x-silo-token':csrf,...extra},body});const c=/silo_session=([a-f0-9]{64})/.exec(r.headers['set-cookie']?.[0]||'');if(c){cookie='silo_session='+c[1];csrf=c[1];}return r;};
    f.cookie=()=>cookie;return f;
  };
  let main=await session(`localhost:${port}`);
  const acmeHost=`acme.localhost:${port}`;let made;

  await t.test('the main workspace lists them; addresses that lead nowhere say so',async()=>{
    const l=await main('/workspaces');assert.equal(l.status,200,l.text);
    assert.equal(l.data.hosting,true);assert.equal(l.data.domain,'localhost');assert.deepEqual(l.data.workspaces.map(w=>[w.main,w.state]),[[true,'running']]);
    assert.equal((await main('/state')).data.hosted.host,true);
    assert.equal((await main('/remote')).status,409,'a tunnel would skip the host');
    for(const name of ['evil.example:'+port,'nobody.localhost:'+port])assert.equal((await call(name,'/')).status,404,name);
    assert.match((await call('evil.example','/')).text,/SILO \/\/ WORKSPACES/);
    assert.equal((await call(`localhost:${port}`,'/api/hosted/status')).status,404,'only the host asks for the status');
  });
  await t.test('make one: its own SILO at its own address, with a setup link',async()=>{
    assert.equal((await main('/workspaces',{slug:'main'})).status,400);
    const r=await main('/workspaces',{slug:'acme',name:'Acme Ltd',budget:25});assert.equal(r.status,201,r.text);made=r.data.workspace;
    assert.equal(made.url,`http://acme.localhost:${port}`);assert.equal(made.state,'running');assert.equal(made.budget,25);assert.equal(made.accounts,0);
    assert.match(made.setupUrl,new RegExp(`^http://acme\\.localhost:${port}/\\?setup=[a-f0-9]{32}$`));
    assert.equal((await main('/workspaces',{slug:'acme'})).status,409,'the same name twice');
    assert.ok(existsSync(path.join(data,'workspaces','acme','data')),'its data has a folder of its own');
    assert.match((await main('/state')).data.events.map(e=>e.title).join('|'),/Workspace made/);
  });
  await t.test('a visitor from outside needs the setup link, and then makes the owner account',async()=>{
    const outside={'x-forwarded-for':'203.0.113.9','x-forwarded-proto':'https'};
    assert.equal((await call(acmeHost,'/api/session',{headers:outside})).status,403);
    const code=made.setupUrl.split('setup=')[1],go=await call(acmeHost,'/?setup='+code,{headers:outside});
    assert.equal(go.status,302);assert.match(go.headers['set-cookie'][0],/silo_setup=.*Secure/,'the cookie is for https, as the visitor used');
    const kept=go.headers['set-cookie'][0].split(';')[0],s=await call(acmeHost,'/api/session',{headers:{...outside,cookie:kept}});assert.equal(s.status,200);
    const cookie=kept+'; '+s.headers['set-cookie'][0].split(';')[0];
    const u=await call(acmeHost,'/api/users',{method:'POST',headers:{...outside,cookie,origin:`https://${acmeHost}`,'x-silo-token':s.data.token},body:{name:'acme-owner',password:'correct horse battery staple',role:'owner'}});
    assert.equal(u.status,201,u.text);
    const l=(await main('/workspaces')).data.workspaces.find(w=>w.slug==='acme');
    await until(async()=>{const w=(await main('/workspaces')).data.workspaces.find(w=>w.slug==='acme');return w.accounts===1&&!w.setupUrl;},5000,'the account to show');
    assert.ok(l);
  });
  await t.test('it is apart from the main workspace, and hosted',async()=>{
    const acme=await session(acmeHost);
    assert.equal((await acme('/state')).status,401,'it has an account now, so a page must sign in');
    const login=await acme('/login',{name:'acme-owner',password:'correct horse battery staple'});assert.equal(login.status,200,login.text);
    const st=(await acme('/state')).data;assert.deepEqual(st.hosted,{tenant:true,host:false,budget:25,month:0},JSON.stringify(Object.keys(st)).slice(0,300));
    const wf=await acme('/workflows',{name:'Only at Acme',steps:[{type:'code',code:'return input;'}]});assert.equal(wf.status,201,wf.text);
    assert.ok((await acme('/state')).data.workflows.some(w=>w.name==='Only at Acme'));
    assert.ok(!(await main('/state')).data.workflows.some(w=>w.name==='Only at Acme'),'the main workspace does not see it');
    assert.equal((await acme('/workspaces')).data.hosting,false,'a workspace does not run others');
    assert.equal((await acme('/settings',{sandbox:'local'})).status,403,'no code on the server');
    assert.equal((await acme('/sandbox')).data.using,'off');
    assert.equal((await acme('/remote')).status,403);assert.equal((await acme('/sync')).status,403);
    // A feed on this computer is refused by the wall, whatever the address check allowed.
    await acme('/gallery/feed',{feed:'http://127.0.0.1:8099/index.json'});
    assert.match((await acme('/gallery?fresh=1')).data.error,/cannot reach this server or its private network/);
  });
  await t.test('budget, name, pause, start, restart',async()=>{
    const r=await main('/workspaces/acme',{action:'budget',budget:7.5});assert.equal(r.status,200,r.text);assert.equal(r.data.workspace.budget,7.5);
    const acme=await session(acmeHost);await acme('/login',{name:'acme-owner',password:'correct horse battery staple'});
    assert.equal((await acme('/state')).data.hosted.budget,7.5,'the running workspace has it at once');
    assert.equal((await main('/workspaces/acme',{action:'rename',name:'Acme Group'})).data.workspace.name,'Acme Group');
    assert.equal((await main('/workspaces/acme',{action:'budget',budget:-1})).status,400);
    assert.equal((await main('/workspaces/acme',{action:'pause'})).data.workspace.state,'paused');
    const p=await call(acmeHost,'/');assert.equal(p.status,503);assert.match(p.text,/paused/);
    assert.equal((await call(acmeHost,'/api/state')).data.error.includes('paused'),true,'JSON for the API');
    assert.equal((await main('/workspaces/acme',{action:'restart'})).status,409);
    assert.equal((await main('/workspaces/acme',{action:'resume'})).data.workspace.state,'running');
    assert.equal((await call(acmeHost,'/api/session')).status,200);
    assert.equal((await main('/workspaces/acme',{action:'restart'})).data.workspace.state,'running');
    const reg=JSON.parse(await fs.readFile(path.join(data,'workspaces.json'),'utf8'));
    assert.deepEqual(reg.workspaces.map(w=>[w.slug,w.name,w.budget,w.paused]),[['acme','Acme Group',7.5,false]]);
  });
  await t.test('live updates come through the host; a restart of one workspace leaves the others running',async()=>{
    const acme=await session(acmeHost);await acme('/login',{name:'acme-owner',password:'correct horse battery staple'});
    const live=await new Promise((resolve,reject)=>{
      const r=http.request({host:'127.0.0.1',port,path:'/api/stream',headers:{host:acmeHost,cookie:acme.cookie(),'accept-encoding':'identity'}},res=>{let s='';res.setEncoding('utf8');res.on('data',d=>{s+=d;if(/^data:/m.test(s)){r.destroy();resolve({status:res.statusCode,type:res.headers['content-type'],s});}});});
      r.on('error',e=>{if(r.destroyed)return;reject(e);});r.setTimeout(8000,()=>{r.destroy();reject(Error('no live data'));});r.end();
    });
    assert.equal(live.status,200);assert.match(live.type,/event-stream/);
    // The workspace asks to restart: the host starts it again; its sessions were in memory, so the page signs in again.
    assert.equal((await acme('/system/restart',{})).status,200);
    await until(async()=>(await acme('/state')).status===401,20000,'acme to restart');
    // The main workspace restarts on its own; Acme goes on.
    const again=await session(acmeHost);await again('/login',{name:'acme-owner',password:'correct horse battery staple'});
    assert.equal((await main('/system/restart',{})).status,200);
    await until(async()=>(await main('/state')).status===401,20000,'main to restart');
    main=await session(`localhost:${port}`);
    assert.equal((await again('/state')).status,200,'acme kept running');
    assert.match(out,/\[main\] Restarting\./);assert.doesNotMatch(out,/SILO was updated/);
  });
  await t.test('remove: the address is gone, the data is kept aside',async()=>{
    const r=await main('/workspaces/acme',{action:'remove'});assert.equal(r.status,200,r.text);
    assert.ok(existsSync(path.join(r.data.keptIn,'data')),'moved, not deleted');
    assert.ok(!existsSync(path.join(data,'workspaces','acme')));
    assert.equal((await call(acmeHost,'/')).status,404);
    assert.equal((await main('/workspaces/acme',{action:'pause'})).status,404);
    assert.deepEqual((await main('/workspaces')).data.workspaces.map(w=>w.slug),['']);
  });
});
