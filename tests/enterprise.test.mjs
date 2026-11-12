// For companies: the audit log, OpenTelemetry export and single sign-on, against a fake OpenID provider and a
// fake OTLP collector on this computer. Temporary data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AuditLog,auditCsv,chainHash} from '../audit.mjs';
import {traceSpans,otlpUrl,checkEndpoint,parseHeaders,auditLogRecord} from '../otel.mjs';
import {roleFromClaims,domainAllowed,identity,checkIssuer} from '../sso.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('the audit chain shows a changed, removed or added record',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'silo-audit-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const seen=[],log=new AuditLog(dir,{key:()=>'k1',onRecord:r=>seen.push(r)});
  for(let i=0;i<5;i++)await log.record({action:'test',actor:'Ana',target:'item '+i,detail:'line\nbreak'});
  assert.equal(seen.length,5);assert.equal(seen[4].seq,5);assert.equal(seen[1].prev,seen[0].hash);assert.equal(seen[0].detail,'line break');
  let v=await log.verify();assert.equal(v.ok,true);assert.equal(v.records,5);
  // A new log object picks up the chain where it ended.
  const again=new AuditLog(dir,{key:()=>'k1'});const r6=await again.record({action:'after restart'});assert.equal(r6.seq,6);assert.equal(r6.prev,seen[4].hash);
  const file=path.join(dir,(await fs.readdir(dir)).find(n=>n.endsWith('.jsonl'))),lines=(await fs.readFile(file,'utf8')).trim().split('\n');
  await fs.writeFile(file,lines.map((l,i)=>i===2?l.replace('item 2','item X'):l).join('\n')+'\n');
  v=await again.verify();assert.equal(v.ok,false);assert.equal(v.broken.seq,3);assert.match(v.broken.reason,/changed/);
  await fs.writeFile(file,lines.filter((_,i)=>i!==2).join('\n')+'\n');
  v=await again.verify();assert.equal(v.ok,false);assert.match(v.broken.reason,/missing/);
  // A record made up later, even with a correct-looking hash, needs the key.
  const fake={...JSON.parse(lines[1]),detail:'forged'};fake.hash=chainHash('wrong key',fake.prev,(({hash,...b})=>b)(fake));
  await fs.writeFile(file,lines.map((l,i)=>i===1?JSON.stringify(fake):l).join('\n')+'\n');
  assert.equal((await again.verify()).ok,false);
  await fs.writeFile(file,lines.join('\n')+'\n');assert.equal((await new AuditLog(dir,{key:()=>'k2'}).verify()).ok,false,'another key does not check out');
  // A spreadsheet never runs a cell as a formula.
  const csv=auditCsv([{seq:1,time:'2026-01-01T00:00:00.000Z',action:'x',outcome:'ok',actor:'=HYPERLINK("http://x")',detail:'a, "b"'}]);
  assert.match(csv,/"'=HYPERLINK\(""http:\/\/x""\)"/);assert.match(csv,/"a, ""b"""/);
  assert.equal((await again.read({filter:'item 4'})).length,1);
});

test('traces become OTLP spans in the GenAI conventions, without prompts',()=>{
  const t={id:'11111111-2222-3333-4444-555555555555',kind:'chat',name:'Chat with Ana',started:1000,ended:5000,status:'ok',totals:{input:10,output:20,cost:0.01},spans:[
    {id:'aaaaaaaa-0000-0000-0000-000000000001',parent:null,kind:'model',name:'openai:gpt-x',provider:'openai',model:'gpt-x',input:10,output:20,start:1100,end:2000,status:'ok',agent:'Ana'},
    {id:'aaaaaaaa-0000-0000-0000-000000000002',parent:'aaaaaaaa-0000-0000-0000-000000000001',kind:'tool',name:'read_file',args:'{"path":"a.txt"}',start:2100,end:2200,status:'failed',error:'No such file'}]};
  const [root,model,tool]=traceSpans(t);
  assert.equal(root.traceId,'11111111222233334444555555555555');assert.equal(model.parentSpanId,root.spanId);assert.equal(tool.parentSpanId,model.spanId);
  assert.equal(model.name,'chat gpt-x');assert.equal(model.kind,3);assert.equal(model.startTimeUnixNano,'1100000000');
  const a=Object.fromEntries(model.attributes.map(x=>[x.key,Object.values(x.value)[0]]));
  assert.equal(a['gen_ai.operation.name'],'chat');assert.equal(a['gen_ai.request.model'],'gpt-x');assert.equal(a['gen_ai.usage.output_tokens'],'20');
  assert.equal(tool.name,'execute_tool read_file');assert.equal(tool.status.code,2);
  assert.ok(!JSON.stringify(tool).includes('a.txt'),'arguments only when asked for');
  assert.ok(JSON.stringify(traceSpans(t,{content:true})).includes('a.txt'));
  assert.equal(otlpUrl('http://localhost:4318','traces'),'http://localhost:4318/v1/traces');
  assert.equal(otlpUrl('https://o.example.com/otlp/v1/traces','logs'),'https://o.example.com/otlp/v1/logs');
  for(const ok of ['http://localhost:4318','http://otel-collector:4318','http://192.168.1.5:4318','https://api.honeycomb.io'])assert.ok(checkEndpoint(ok));
  for(const bad of ['http://collector.example.com:4318','ftp://x','https://user:pw@x.example.com','nonsense'])assert.throws(()=>checkEndpoint(bad),undefined,bad);
  assert.deepEqual(parseHeaders('x-honeycomb-team=abc, Authorization=Basic%20eDp5'),{'x-honeycomb-team':'abc',Authorization:'Basic eDp5'});
  assert.throws(()=>parseHeaders('bad header=1'));
  assert.equal(auditLogRecord({time:'2026-01-01T00:00:00.000Z',action:'sign-in',actor:'Ana',outcome:'denied'}).severityText,'WARN');
});

test('roles from groups, domains and names from the provider',()=>{
  const rules={claim:'groups',groups:{owner:['admins'],operator:['ops','Team-Ops'],viewer:[]}};
  assert.equal(roleFromClaims({groups:['ops','admins']},rules),'owner');assert.equal(roleFromClaims({groups:['team-ops']},rules),'operator');
  assert.equal(roleFromClaims({groups:[]},rules),null);assert.equal(roleFromClaims({realm_access:{roles:['ops']}},{...rules,claim:'realm_access.roles'}),'operator');
  assert.ok(domainAllowed('a@example.com',['@Example.com']));assert.ok(!domainAllowed('a@evil.com',['example.com']));assert.ok(domainAllowed('a@x.com',[]));
  assert.deepEqual(identity({sub:'1',preferred_username:'Ana@Example.com'}),{sub:'1',email:'ana@example.com',verified:true,name:'ana'});
  assert.equal(identity({sub:'1',email:'a@b.co',email_verified:false}).verified,false);
  assert.throws(()=>checkIssuer('http://idp.example.com'),/https/);assert.equal(checkIssuer('http://127.0.0.1:9/realm/'),'http://127.0.0.1:9/realm');
});

// A provider that signs id_tokens with its own key, checks the client secret and PKCE, and remembers what it was asked.
function fakeIdp(port){
  const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048}),other=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey;
  const issuer=`http://127.0.0.1:${port}`,codes=new Map(),seen={tokenAuth:[]};
  const jwk={...publicKey.export({format:'jwk'}),kid:'k1',alg:'RS256',use:'sig'};
  const sign=(claims,key=privateKey)=>{const h=Buffer.from(JSON.stringify({alg:'RS256',kid:'k1',typ:'JWT'})).toString('base64url'),p=Buffer.from(JSON.stringify(claims)).toString('base64url');return `${h}.${p}.${crypto.sign('sha256',Buffer.from(h+'.'+p),key).toString('base64url')}`;};
  const server=http.createServer(async(req,res)=>{
    const json=(s,o)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(o));};
    if(req.url==='/.well-known/openid-configuration')return json(200,{issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',response_types_supported:['code'],token_endpoint_auth_methods_supported:['client_secret_basic']});
    if(req.url==='/jwks')return json(200,{keys:[jwk]});
    if(req.url==='/token'&&req.method==='POST'){
      let body='';for await(const c of req)body+=c;const f=new URLSearchParams(body);seen.tokenAuth.push(req.headers.authorization||'');
      if(req.headers.authorization!=='Basic '+Buffer.from('silo-test:s3cret').toString('base64'))return json(401,{error:'invalid_client'});
      const c=codes.get(f.get('code'));codes.delete(f.get('code'));
      if(!c)return json(400,{error:'invalid_grant',error_description:'Unknown code'});
      if(crypto.createHash('sha256').update(f.get('code_verifier')||'').digest('base64url')!==c.challenge)return json(400,{error:'invalid_grant',error_description:'PKCE failed'});
      const now=Math.floor(Date.now()/1000);
      return json(200,{access_token:'at',token_type:'Bearer',id_token:sign({iss:issuer,aud:'silo-test',iat:now,exp:now+300,...c.claims},c.key)});
    }
    json(404,{});
  });
  return {issuer,codes,seen,other,listen:()=>new Promise(r=>server.listen(port,'127.0.0.1',r)),close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);})};
}
function fakeCollector(port){
  const got=[];
  const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;got.push({path:req.url,headers:req.headers,body:JSON.parse(body||'{}')});res.writeHead(200,{'Content-Type':'application/json'});res.end('{}');});
  return {got,listen:()=>new Promise(r=>server.listen(port,'127.0.0.1',r)),close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);})};
}
const wait=async(fn,ms=12000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,200));}return null;};

test('single sign-on, the audit log and telemetry through SILO',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-enterprise-test-'));
  const port=14351,origin=`http://127.0.0.1:${port}`,idp=fakeIdp(14353),col=fakeCollector(14355);
  await idp.listen();await col.listen();
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await idp.close();await col.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),15000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const session=async()=>{const s=await fetch(origin+'/api/session');return {token:(await s.json()).token,cookie:s.headers.get('set-cookie').split(';')[0]};};
  const as=({token,cookie})=>async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'x-silo-token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  const ownerSession=await session(),owner=as(ownerSession);
  assert.equal((await owner('/users',{name:'Owner',password:'owner-pass-1'})).status,201);

  await t.test('telemetry goes to the collector with its headers, and no prompt goes along',async()=>{
    assert.equal((await owner('/otel',{enabled:true,endpoint:'http://collector.example.com:4318'})).status,400,'plain http only nearby');
    const r=await owner('/otel',{enabled:true,endpoint:`http://127.0.0.1:14355`,service:'silo-test',headers:'x-api-key=collector-secret-123'});
    assert.equal(r.status,200);assert.deepEqual(r.data.headerNames,['x-api-key']);assert.ok(!JSON.stringify(r.data).includes('collector-secret-123'),'header values stay in the vault');
    assert.equal((await owner('/otel/test',{})).status,200);
    const testSpan=col.got.find(g=>g.path==='/v1/traces');assert.equal(testSpan.headers['x-api-key'],'collector-secret-123');
    const agent=(await owner('/state')).data.agents[0];
    assert.equal((await owner('/agents/'+agent.id+'/chat',{message:'Unique prompt zebra-42'})).status,200);
    const chat=await wait(()=>col.got.find(g=>g.path==='/v1/traces'&&JSON.stringify(g.body).includes('silo.trace.kind')));
    assert.ok(chat,'the trace of the conversation arrived');
    const body=JSON.stringify(chat.body);assert.match(body,/"service.name","value":\{"stringValue":"silo-test"/);assert.match(body,/gen_ai.operation.name/);
    assert.ok(!col.got.some(g=>JSON.stringify(g.body).includes('zebra-42')),'the prompt is never sent');
    assert.ok(await wait(()=>col.got.find(g=>g.path==='/v1/logs'&&JSON.stringify(g.body).includes('silo.audit'))),'the audit log arrives as logs');
    assert.equal((await owner('/otel',{enabled:false})).status,200);
  });

  await t.test('people sign in with the provider and get a role from their groups',async()=>{
    assert.equal((await owner('/sso',{enabled:true,issuer:'http://127.0.0.1:1',clientId:'x'})).status,502,'a provider that does not answer is not turned on');
    const on=await owner('/sso',{enabled:true,issuer:idp.issuer,clientId:'silo-test',clientSecret:'s3cret',label:'Test IdP',domains:['example.com'],defaultRole:'viewer',groups:{operator:['silo-ops']}});
    assert.equal(on.status,200,JSON.stringify(on.data));assert.equal(on.data.on,true);assert.equal(on.data.hasSecret,true);assert.ok(!JSON.stringify(on.data).includes('s3cret'));
    assert.deepEqual((await (await fetch(origin+'/api/session')).json()).sso,{label:'Test IdP',passwords:'on'});
  });
  const claims={sub:'u-ana',email:'ana@example.com',email_verified:true,name:'Ana Pop',groups:['silo-ops']};
  async function ssoLogin(c=claims,{nonce,key,keepCookie=true,replay}={}){
    const start=await fetch(origin+'/sso/start',{redirect:'manual'});assert.equal(start.status,302);
    const loc=new URL(start.headers.get('location')),cookie=start.headers.get('set-cookie').split(';')[0];
    assert.equal(loc.origin+loc.pathname,idp.issuer+'/authorize');assert.equal(loc.searchParams.get('code_challenge_method'),'S256');assert.match(loc.searchParams.get('scope'),/openid/);
    const code=crypto.randomUUID();idp.codes.set(code,{claims:{...c,nonce:nonce??loc.searchParams.get('nonce')},challenge:loc.searchParams.get('code_challenge'),key});
    const url=`${loc.searchParams.get('redirect_uri')}?code=${code}&state=${loc.searchParams.get('state')}`;
    const cb=await fetch(url,{headers:keepCookie?{cookie}:{}});const html=await cb.text();
    if(replay){idp.codes.set(code,{claims:{...c,nonce:loc.searchParams.get('nonce')},challenge:loc.searchParams.get('code_challenge')});const again=await fetch(url,{headers:{cookie}});return {html:await again.text(),session:null};}
    const s=cb.headers.getSetCookie().find(x=>x.startsWith('silo_session='));
    return {html,session:s?s.split(';')[0]:null};
  }
  const meWith=async cookie=>(await (await fetch(origin+'/api/session',{headers:{cookie}})).json()).me;
  let ana;
  await t.test('a good sign-in makes the account with the group role',async()=>{
    const r=await ssoLogin();assert.ok(r.session,r.html);assert.match(r.html,/Signed in as Ana Pop/);
    ana=await meWith(r.session);assert.equal(ana.name,'Ana Pop');assert.equal(ana.role,'operator');assert.equal(ana.sso.email,'ana@example.com');assert.equal(ana.password,false);
    assert.equal(idp.seen.tokenAuth.at(-1),'Basic '+Buffer.from('silo-test:s3cret').toString('base64'),'the secret goes in the Authorization header');
    const op=as({cookie:r.session,token:r.session.split('=')[1]});
    assert.equal((await op('/audit')).status,403,'only owners read the audit log');assert.equal((await op('/sso')).status,403);
    assert.equal((await op('/password',{old:'x',password:'whatever-123'})).status,409,'no SILO password to change');
  });
  await t.test('wrong sign-ins are refused and logged',async()=>{
    for(const [why,opts,c] of [
      ['another browser',{keepCookie:false}],['a wrong nonce',{nonce:'not-the-one'}],['a token from another key',{key:idp.other}],
      ['a domain that is not let in',{},{...claims,sub:'u-eve',email:'eve@evil.com'}],['an address that is not verified',{},{...claims,sub:'u-bob',email:'bob@example.com',email_verified:false}],
      ['a token for another app',{},{...claims,aud:'other-app'}],['an expired token',{},{...claims,exp:Math.floor(Date.now()/1000)-3600}],['the same answer twice',{replay:true}],
    ]){const r=await ssoLogin(c||claims,opts);assert.equal(r.session,null,why);assert.match(r.html,/not signed in/,why);}
  });
  await t.test('the role follows the groups, and removed people stay out',async()=>{
    const r=await ssoLogin({...claims,groups:[]});assert.equal((await meWith(r.session)).role,'viewer','no group: the default role');
    assert.equal((await owner('/users/'+ana.id,{},'DELETE')).status,200);
    const out=await ssoLogin();assert.equal(out.session,null);assert.match(out.html,/removed this account/);
    assert.equal((await owner('/sso')).data.blocked,1);
    await owner('/sso',{unblock:true});const back=await ssoLogin();assert.ok(back.session);assert.equal((await meWith(back.session)).role,'operator');
  });
  await t.test('the audit log holds it all, checks out and exports',async()=>{
    const a=(await owner('/audit?limit=500')).data.records,actions=new Set(a.map(r=>r.action));
    for(const x of ['sign-in.sso','POST /api/users','DELETE /api/users/:id','POST /api/sso','POST /api/otel','resident.tool'].slice(0,5))assert.ok(actions.has(x),x);
    assert.ok(a.some(r=>r.action==='sign-in.sso'&&r.outcome==='denied'&&/another browser|expired/.test(r.detail)));
    assert.ok(a.some(r=>r.action==='POST /api/otel'&&r.outcome==='failed'&&r.status===400));
    assert.ok(!JSON.stringify(a).includes('s3cret')&&!JSON.stringify(a).includes('owner-pass-1')&&!JSON.stringify(a).includes('collector-secret-123'),'no secrets in the log');
    const v=(await owner('/audit/verify')).data;assert.equal(v.ok,true);assert.ok(v.records>=a.length);
    const csv=await fetch(origin+'/api/audit/export?format=csv&q=sign-in',{headers:{cookie:ownerSession.cookie}});
    assert.equal(csv.status,200);assert.match(csv.headers.get('content-disposition'),/attachment; filename="silo-audit-.*\.csv"/);
    const raw=Buffer.from(await csv.arrayBuffer()),text=raw.toString('utf8');
    assert.deepEqual([...raw.subarray(0,3)],[0xef,0xbb,0xbf],'a BOM, so Excel reads the letters right');assert.ok(text.slice(1).startsWith('seq,time,action'));assert.match(text,/sign-in\.sso/);
    assert.ok(!text.includes('zebra-42'),'no message text in the log');
    const jl=await (await fetch(origin+'/api/audit/export?format=jsonl',{headers:{cookie:ownerSession.cookie}})).text();
    const recs=jl.trim().split('\n').map(l=>JSON.parse(l));assert.ok(recs.length>=a.length);assert.equal(recs[1].prev,recs[0].hash);
    assert.equal((await owner('/audit',{months:200})).status,400);assert.equal((await owner('/audit',{months:24})).data.months,24);
  });
});
