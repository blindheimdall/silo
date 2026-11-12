import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {TokenStore, bearerFrom, scopeFor, publicToken} from '../api-tokens.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('token scopes, shapes and limits',()=>{
  assert.equal(scopeFor('GET','/api/state'),'read');
  assert.equal(scopeFor('POST','/api/pause'),'run');
  assert.equal(scopeFor('POST','/api/agents/x/chat'),'run');
  assert.equal(scopeFor('POST','/api/requests/x'),'approve');
  assert.equal(scopeFor('POST','/api/runs/x/approve'),'approve');
  assert.equal(scopeFor('POST','/api/runs/x/stop'),'run');
  assert.equal(scopeFor('POST','/api/connections'),'admin');
  assert.equal(scopeFor('GET','/api/audit'),'admin');
  for(const [m,r] of [['POST','/api/login'],['POST','/api/logout'],['POST','/api/password'],['GET','/api/tokens'],['DELETE','/api/tokens/abc'],['POST','/api/users'],['DELETE','/api/users/x'],['POST','/api/sso'],['POST','/api/vault/reset']])assert.equal(scopeFor(m,r),null,r);
  assert.equal(bearerFrom(undefined),undefined);
  assert.equal(bearerFrom('Basic abc'),null);
  assert.equal(bearerFrom('Bearer silo_pat_short'),null);
  const list=[],store=new TokenStore(()=>list);
  assert.throws(()=>store.create({name:'x',role:'viewer',scopes:['run'],days:30}),/cannot give a token run/);
  assert.throws(()=>store.create({name:'x',role:'owner',scopes:['nope'],days:30}),/Choose at least one/);
  assert.throws(()=>store.create({name:'x',role:'owner',scopes:['read'],days:3}),/7, 30, 90 or 365/);
  assert.throws(()=>store.create({name:' ',role:'owner',scopes:['read'],days:30}),/name/);
  const {token,secret}=store.create({name:'  CI   job ',userId:'u1',role:'operator',scopes:['run','read','run'],days:0});
  assert.match(secret,/^silo_pat_[A-Za-z0-9_-]{43}$/);assert.equal(bearerFrom('Bearer '+secret),secret);
  assert.equal(token.name,'CI job');assert.deepEqual(token.scopes,['read','run']);assert.equal(token.expiresAt,null);
  assert.ok(!JSON.stringify(list).includes(secret.slice(9)),'only a hash is kept');
  assert.ok(!('hash' in publicToken(token)));
  assert.equal(store.find(secret),token);assert.equal(store.find(secret+'x'),null);
  token.expiresAt=Date.now()-1;assert.equal(store.find(secret),null,'expired');
  for(let i=0;i<300;i++)assert.equal(store.limited(token,1000),false);
  assert.equal(store.limited(token,1000),true);assert.equal(store.limited(token,70_000),false,'a new minute');
  assert.equal(store.prune([{id:'u2'}]),1);assert.equal(list.length,0,'a token whose person is gone');
  store.create({name:'local',userId:null,role:'owner',scopes:['read'],days:7});
  assert.equal(store.prune([]),0);assert.equal(store.prune([{id:'u1'}]),1,'a token from before accounts');
});

test('programs use the API with personal tokens',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-token-test-'));
  const port=14381,origin=`http://127.0.0.1:${port}`;let child;
  child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start')),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>{clearTimeout(timer);reject(Error(b.toString()));});});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true});});
  const page=async()=>{
    const s=await fetch(origin+'/api/session');const c={...await s.json(),cookie:s.headers.get('set-cookie')?.split(';')[0]};
    c.request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie:c.cookie,origin,'Content-Type':'application/json','x-silo-token':c.token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
    return c;
  };
  const call=async(secret,route,body,{method=body===undefined?'GET':'POST',type='application/json'}={})=>{const r=await fetch(origin+'/api'+route,{method,headers:{authorization:'Bearer '+secret,...(body!==undefined&&{'content-type':type})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({})),headers:r.headers};};

  const spec=await fetch(origin+'/api/openapi.json').then(r=>r.json());
  assert.equal(spec.openapi,'3.1.0');assert.ok(spec.paths['/api/agents/{id}/chat'].post);assert.equal(spec.components.securitySchemes.token.scheme,'bearer');

  const a=await page();
  const made=await a.request('/tokens',{name:'Reader',scopes:['read'],days:30});assert.equal(made.status,201);
  const reader=made.data.secret;assert.match(reader,/^silo_pat_/);assert.ok(!('hash' in made.data.token));
  const st=await call(reader,'/state');assert.equal(st.status,200);assert.ok(Array.isArray(st.data.agents));
  assert.equal(st.data.apiTokens,undefined,'tokens are not part of the state');
  assert.equal((await call(reader,'/pause',{paused:true})).status,403,'read cannot change anything');
  assert.match((await call(reader,'/pause',{paused:true})).data.error,/run scope/);
  for(const [route,body,method] of [['/tokens',undefined,'GET'],['/tokens',{name:'x',scopes:['read'],days:7},'POST'],['/login',{name:'a',password:'b'},'POST'],['/users',{name:'b',password:'12345678'},'POST']])
    assert.equal((await call(reader,route,body,{method})).status,403,route+' is never for a token');
  assert.equal((await call('silo_pat_'+'A'.repeat(43),'/state')).status,401);
  assert.equal((await fetch(origin+'/api/state',{headers:{authorization:'Bearer nope'}})).status,401);
  assert.equal((await fetch(origin+'/api/state',{headers:{authorization:'Bearer '+reader,'x-forwarded-for':'1.2.3.4'}})).status,200);

  const runner=(await a.request('/tokens',{name:'Runner',scopes:['read','run','approve'],days:7})).data.secret;
  assert.equal((await call(runner,'/pause',{paused:true})).status,200,'no cookie, no CSRF token, no Origin needed');
  assert.equal((await call(runner,'/pause',{paused:false},{type:'text/plain'})).status,415);
  assert.equal((await call(runner,'/pause',{paused:false})).status,200);
  const agent=st.data.agents[0];
  const reply=await call(runner,`/agents/${agent.id}/chat`,{message:'Hello from a script'});assert.equal(reply.status,200);assert.ok(reply.data.text);assert.ok(reply.data.traceId);
  assert.equal((await call(runner,'/traces/'+reply.data.traceId)).status,200);
  assert.equal((await call(runner,'/connections',{provider:'openai',key:'sk-x'})).status,403,'admin needs the admin scope');

  // Nothing on disk or in exports can be used as the token.
  const exp=await call(runner,'/export');assert.equal(exp.status,200);assert.ok(!JSON.stringify(exp.data).includes(runner.slice(9)));assert.equal(exp.data.apiTokens,undefined);
  const listed=await a.request('/tokens');assert.equal(listed.data.tokens.length,2);assert.ok(listed.data.tokens.every(t=>!t.hash&&t.lastUsed));

  // Revoked tokens stop at once, live streams included.
  const ctl=new AbortController(),stream=await fetch(origin+'/api/stream',{headers:{authorization:'Bearer '+reader},signal:ctl.signal});
  assert.equal(stream.status,200);const rd=stream.body.getReader();await rd.read();
  const readerId=listed.data.tokens.find(t=>t.name==='Reader').id;
  assert.equal((await a.request('/tokens/'+readerId,undefined,'DELETE')).status,200);
  const ended=await Promise.race([(async()=>{for(;;){const {done}=await rd.read();if(done)return true;}})(),new Promise(r=>setTimeout(()=>r(false),3000))]);ctl.abort();
  assert.ok(ended,'the stream of a revoked token closes');
  assert.equal((await call(reader,'/state')).status,401);

  // At most 300 requests a minute per token.
  const limiter=(await a.request('/tokens',{name:'Busy',scopes:['read'],days:7})).data.secret;
  let last;for(let i=0;i<301;i++)last=await call(limiter,'/agents/'+agent.id+'/live');
  assert.equal(last.status,429);assert.equal(last.headers.get('retry-after'),'60');

  // Turning on accounts removes tokens that belonged to nobody. After that a token is someone's and has their rights.
  assert.equal((await a.request('/users',{name:'Ana',password:'owner-pass-1'})).status,201);
  assert.equal((await call(runner,'/state')).status,401,'tokens from before accounts stop');
  const ownerRun=(await a.request('/tokens',{name:'Owner CI',scopes:['read','run'],days:30})).data.secret;
  assert.equal((await call(ownerRun,'/pause',{paused:false})).status,200);
  assert.equal((await a.request('/users',{name:'Vik',password:'viewer-pass-1',role:'viewer'})).status,201);
  const viewer=await page();{const r=await fetch(origin+'/api/login',{method:'POST',headers:{cookie:viewer.cookie,origin,'content-type':'application/json','x-silo-token':viewer.token},body:JSON.stringify({name:'Vik',password:'viewer-pass-1'})});assert.equal(r.status,200);viewer.token=(await r.json()).token;viewer.cookie='silo_session='+viewer.token;}
  const vreq=(route,body)=>viewer.request(route,body);
  assert.equal((await vreq('/tokens',{name:'V run',scopes:['run'],days:7})).status,403,'a viewer cannot give a token run');
  const vtok=await vreq('/tokens',{name:'V read',scopes:['read'],days:7});assert.equal(vtok.status,201);
  assert.equal((await call(vtok.data.secret,'/state')).status,200);
  assert.equal((await call(vtok.data.secret,'/export')).status,403,'the role still applies');
  const users=(await a.request('/state')).data.users,vik=users.find(u=>u.name==='Vik');
  assert.equal((await a.request('/users/'+vik.id,undefined,'DELETE')).status,200);
  assert.equal((await call(vtok.data.secret,'/state')).status,401,'tokens leave with their person');

  // The audit log names the token.
  const audit=await a.request('/audit?limit=200');assert.ok(audit.data.records.some(e=>/\(token Owner CI\)/.test(e.actor)),'audit shows the token');
  const raw=await fs.readFile(path.join(temp,'data','state.db'));assert.ok(!raw.includes(Buffer.from(ownerRun.slice(9))),'the secret is not on disk');
});
