// Integrations: signing in to a remote MCP server (discovery, client registration, PKCE, renewal), addresses with
// a secret in them, and web APIs from an OpenAPI description.
// A fake MCP server and sign-in server run on this computer. Temporary data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {handle} from './mcp-fixture.mjs';
import {authParam,safeUrl,discoverMcpAuth,signInUrl} from '../mcp-auth.mjs';
import {parseSpec,compileSpec,OpenApiClient} from '../openapi-tools.mjs';
const ZAP='zapSecretPart_0123456789abcdef';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// A service that keeps its tools behind a sign-in, the way the MCP authorization spec describes it.
function fakeService({legacy=false}={}){
  const seen={register:[],authorize:[],token:[]},tokens=new Set();let base='',n=0;
  const server=http.createServer(async(req,res)=>{
    const u=new URL(req.url,base);let body='';for await(const c of req)body+=c;
    const json=(code,v,h={})=>{res.writeHead(code,{'Content-Type':'application/json',...h});res.end(JSON.stringify(v));};
    if(u.pathname==='/mcp'&&req.method==='POST'){
      const auth=req.headers.authorization||'';
      if(!tokens.has(auth.replace(/^Bearer /,'')))return json(401,{error:'invalid_token'},{'WWW-Authenticate':legacy?'Bearer':`Bearer realm="fake", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="tools.read tools.write"`});
      const r=handle(JSON.parse(body));if(!r){res.writeHead(202);return res.end();}return json(200,r);
    }
    if(u.pathname==='/mcp'&&req.method==='DELETE'){res.writeHead(204);return res.end();}
    // A gateway address that is its own key, the way Zapier's are.
    if(u.pathname===`/zap/${ZAP}/mcp`){if(req.method!=='POST'){res.writeHead(204);return res.end();}const r=handle(JSON.parse(body));if(!r){res.writeHead(202);return res.end();}return json(200,r);}
    // A small web API.
    if(u.pathname.startsWith('/api/')){
      if(u.pathname==='/api/openapi.json')return json(200,API_SPEC(base));
      if(u.searchParams.get('key')!=='k-123456'&&req.headers['x-api-key']!=='k-123456')return json(401,{error:'no key'});
      if(u.pathname==='/api/old'){res.writeHead(302,{Location:'/api/items/moved?key=k-123456'});return res.end();}
      if(u.pathname==='/api/away'){res.writeHead(302,{Location:'https://elsewhere.example/x'});return res.end();}
      if(u.pathname==='/api/big')return json(200,{text:'x'.repeat(150000)});
      if(u.pathname==='/api/echo-key')return json(200,{seen:'k-123456'});
      return json(200,{method:req.method,path:u.pathname,tags:u.searchParams.getAll('tag'),body:body?JSON.parse(body):null});
    }
    if(!legacy&&u.pathname==='/.well-known/oauth-protected-resource/mcp')return json(200,{resource:base+'/mcp',authorization_servers:[base+'/auth']});
    const issuer=legacy?base:base+'/auth';
    if(u.pathname===(legacy?'/.well-known/oauth-authorization-server':'/.well-known/oauth-authorization-server/auth'))return json(200,{issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',registration_endpoint:issuer+'/register',code_challenge_methods_supported:['S256']});
    if(u.pathname===new URL(issuer).pathname.replace(/\/$/,'')+'/register'&&req.method==='POST'){const b=JSON.parse(body);seen.register.push(b);return json(201,{client_id:'client-'+seen.register.length,redirect_uris:b.redirect_uris});}
    if(u.pathname.endsWith('/authorize')){
      const q=Object.fromEntries(u.searchParams);seen.authorize.push(q);
      const back=new URL(q.redirect_uri);back.searchParams.set('code','code-'+seen.authorize.length);back.searchParams.set('state',q.state);
      res.writeHead(302,{Location:back.href});return res.end();
    }
    if(u.pathname.endsWith('/token')&&req.method==='POST'){
      const q=Object.fromEntries(new URLSearchParams(body));seen.token.push(q);
      if(q.grant_type==='authorization_code'){
        const asked=seen.authorize.find((a,i)=>q.code==='code-'+(i+1));
        if(!asked||createHash('sha256').update(q.code_verifier).digest('base64url')!==asked.code_challenge||q.client_id!==asked.client_id)return json(400,{error:'invalid_grant'});
        // A short first token, so SILO has to renew it before it uses it.
        const t='token-'+(++n);tokens.add(t);return json(200,{access_token:t,token_type:'Bearer',expires_in:30,refresh_token:'renew-'+n});
      }
      if(q.grant_type==='refresh_token'){if(!/^renew-/.test(q.refresh_token))return json(400,{error:'invalid_grant'});const t='token-'+(++n);tokens.add(t);return json(200,{access_token:t,token_type:'Bearer',expires_in:3600});}
      return json(400,{error:'unsupported_grant_type'});
    }
    json(404,{error:'not found'});
  });
  return new Promise(r=>server.listen(0,'127.0.0.1',()=>{base=`http://127.0.0.1:${server.address().port}`;r({server,seen,tokens,get base(){return base;}});}));
}

const API_SPEC=()=>({openapi:'3.0.3',info:{title:'Items',version:'1'},servers:[{url:'/api'}],
  components:{schemas:{Item:{type:'object',properties:{name:{type:'string'},parent:{$ref:'#/components/schemas/Item'}}}},parameters:{Id:{name:'id',in:'path',required:true,schema:{type:'string'}}}},
  paths:{
    '/items':{get:{operationId:'listItems',summary:'List items',parameters:[{name:'tag',in:'query',schema:{type:'array',items:{type:'string'}}},{name:'Authorization',in:'header',schema:{type:'string'}}]},
              post:{operationId:'createItem',summary:'Create an item',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Item'}}}}}},
    '/items/{id}':{parameters:[{$ref:'#/components/parameters/Id'}],get:{operationId:'getItem'},delete:{operationId:'deleteItem'}},
    '/old':{get:{operationId:'old'}},'/away':{get:{operationId:'away'}},'/big':{get:{operationId:'big'}},'/echo-key':{get:{operationId:'echoKey'}}
  }});

test('an OpenAPI description becomes tools that call the API',async()=>{
  assert.throws(()=>parseSpec('{"info":{},"paths":{"/a":{}}}'),/OpenAPI 3 or Swagger 2/);
  assert.throws(()=>parseSpec('openapi: 3.0.0'),/not JSON/);
  const svc=await fakeService();
  try{
    const {base,ops}=compileSpec(API_SPEC(),{specUrl:svc.base+'/api/openapi.json'});
    assert.equal(base,svc.base+'/api');
    const by=Object.fromEntries(ops.map(o=>[o.name,o]));
    assert.deepEqual(Object.keys(by).sort(),['away','big','createItem','deleteItem','echoKey','getItem','listItems','old']);
    assert.equal(by.listItems.readOnly,true);assert.equal(by.deleteItem.readOnly,false);
    assert.ok(!('Authorization' in by.listItems.tool.inputSchema.properties),'no auth header from the description');
    assert.deepEqual(by.getItem.tool.inputSchema.required,['id']);
    assert.equal(by.createItem.tool.inputSchema.properties.body.properties.parent.description,'(nested)','a loop is cut');
    const api=new OpenApiClient({spec:svc.base+'/api/openapi.json',auth:{kind:'query',name:'key',value:'k-123456'}});
    assert.equal((await api.listTools()).length,8);
    const call=async(n,a)=>{const r=await api.callTool(n,a);return {ok:!r.isError,text:r.content[0].text,json:(()=>{try{return JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf(String.fromCharCode(10))+1));}catch{return null;}})()};};
    let r=await call('getItem',{id:'a/b c'});assert.ok(r.ok);assert.equal(r.json.path,'/api/items/a%2Fb%20c');
    r=await call('listItems',{tag:['x','y']});assert.deepEqual(r.json.tags,['x','y']);
    r=await call('createItem',{body:{name:'Lamp'}});assert.equal(r.json.method,'POST');assert.deepEqual(r.json.body,{name:'Lamp'});
    r=await call('getItem',{});assert.equal(r.ok,false);assert.match(r.text,/Missing a value for id/);
    r=await call('old',{});assert.ok(r.ok,r.text);assert.equal(r.json.path,'/api/items/moved');
    r=await call('away',{});assert.equal(r.ok,false);assert.match(r.text,/another host/);
    r=await call('big',{});assert.match(r.text,/cut at 100 KB/);assert.ok(r.text.length<110*1024);
    r=await call('echoKey',{});assert.ok(!r.text.includes('k-123456'));assert.match(r.text,/[secret]/);
    const header=new OpenApiClient({spec:svc.base+'/api/openapi.json',auth:{kind:'header',name:'X-API-Key',value:'k-123456'}});
    assert.ok(!(await header.callTool('listItems',{})).isError);
    const none=new OpenApiClient({spec:svc.base+'/api/openapi.json'});assert.match((await none.callTool('listItems',{})).content[0].text,/^401/);
  }finally{svc.server.close();}
});

test('reads WWW-Authenticate and refuses unsafe addresses',()=>{
  const h='Bearer realm="x", resource_metadata="https://a.example/.well-known/oauth-protected-resource", scope="read write", error=invalid_token';
  assert.equal(authParam(h,'resource_metadata'),'https://a.example/.well-known/oauth-protected-resource');
  assert.equal(authParam(h,'scope'),'read write');
  assert.equal(authParam(h,'error'),'invalid_token');
  assert.equal(authParam(h,'missing'),'');
  assert.throws(()=>safeUrl('http://example.com/x'),/https/);
  assert.throws(()=>safeUrl('https://user:pw@example.com/'),/name or password/);
  assert.equal(safeUrl('http://127.0.0.1:9/x').hostname,'127.0.0.1');
});

test('finds the sign-in server from the 401 answer, and the old way when there is no metadata',async()=>{
  const now=await fakeService();
  try{
    const meta=await discoverMcpAuth(now.base+'/mcp');
    assert.equal(meta.resource,now.base+'/mcp');assert.equal(meta.issuer,now.base+'/auth');
    assert.equal(meta.tokenEndpoint,now.base+'/auth/token');assert.deepEqual(meta.scopes,['tools.read','tools.write']);
    const u=new URL(signInUrl(meta,{clientId:'c',redirectUri:'http://127.0.0.1:1/mcp/callback',state:'s',challenge:'ch',scopes:meta.scopes}));
    assert.equal(u.searchParams.get('resource'),now.base+'/mcp');assert.equal(u.searchParams.get('code_challenge_method'),'S256');
  }finally{now.server.close();}
  const old=await fakeService({legacy:true});
  try{const meta=await discoverMcpAuth(old.base+'/mcp');assert.equal(meta.issuer,old.base);assert.equal(meta.registrationEndpoint,old.base+'/register');}
  finally{old.server.close();}
});

test('a connector signs in, renews its token and signs out',async t=>{
  const svc=await fakeService();t.after(()=>svc.server.close());
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-integrations-test-'));
  const port=14365,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('silo-integrations-test-'));await fs.rm(resolved,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start')),15000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>{clearTimeout(timer);reject(Error(b.toString()));});});
  const session=await fetch(origin+'/api/session');const {token}=await session.json();const cookie=session.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>null)};};
  const card=async id=>(await request('/state')).data.mcp.find(c=>c.id===id);

  const added=await request('/mcp',{name:'Fake service',transport:'http',url:svc.base+'/mcp',ask:'auto'});
  assert.equal(added.status,201);assert.match(added.data.error,/sign in/i);
  const id=added.data.id;
  let c=await card(id);assert.equal(c.needsSignIn,true);assert.equal(c.signedIn,false);

  const start=await request('/mcp/'+id+'/signin',{});assert.equal(start.status,200);
  assert.equal(svc.seen.register.length,1);
  assert.deepEqual(svc.seen.register[0].redirect_uris,[origin+'/mcp/callback']);assert.equal(svc.seen.register[0].token_endpoint_auth_method,'none');
  // The browser follows the sign-in page back to SILO.
  const back=await fetch(start.data.url,{redirect:'manual'});assert.equal(back.status,302);
  const asked=svc.seen.authorize[0];assert.equal(asked.resource,svc.base+'/mcp');assert.equal(asked.scope,'tools.read tools.write');assert.equal(asked.client_id,'client-1');
  const done=await fetch(back.headers.get('location'));const html=await done.text();
  assert.match(html,/Fake service is signed in/);assert.match(html,/3 tools/);
  assert.match(done.headers.get('content-security-policy'),/default-src 'none'/);
  // The first token was short, so it was renewed before the tools were listed, for the same resource.
  const renew=svc.seen.token.find(x=>x.grant_type==='refresh_token');assert.ok(renew);assert.equal(renew.resource,svc.base+'/mcp');assert.equal(renew.refresh_token,'renew-1');
  assert.equal(svc.seen.token.find(x=>x.grant_type==='authorization_code').resource,svc.base+'/mcp');
  c=await card(id);assert.equal(c.signedIn,true);assert.equal(c.needsSignIn,false);assert.equal(c.tools.length,3);
  const all=JSON.stringify((await request('/state')).data);for(const secret of [...svc.tokens,'renew-1'])assert.ok(!all.includes(secret),'no token in the state');

  // The same answer again is refused, and so is an unknown state.
  assert.match(await (await fetch(back.headers.get('location'))).text(),/expired/);
  assert.match(await (await fetch(origin+'/mcp/callback?error=access_denied&error_description=No%20thanks')).text(),/No thanks/);

  // A second sign-in reuses the registered client.
  assert.equal((await request('/mcp/'+id+'/signin',{})).status,200);assert.equal(svc.seen.register.length,1);

  assert.equal((await request('/mcp/'+id+'/signout',{})).status,200);
  c=await card(id);assert.equal(c.signedIn,false);
  const test=await request('/mcp/'+id+'/test',{});assert.equal(test.status,502);c=await card(id);assert.equal(c.needsSignIn,true);

  // An address that is its own key: the secret part stays in the vault and the page sees it masked.
  const zap=await request('/mcp',{name:'Gateway',transport:'http',url:`${svc.base}/zap/${ZAP}/mcp`});
  assert.equal(zap.status,201);assert.equal(zap.data.tools,3);
  c=await card(zap.data.id);assert.equal(c.url,svc.base+'/zap/****/mcp');assert.equal(c.secretUrl,true);
  assert.ok(!JSON.stringify((await request('/state')).data).includes(ZAP));
  const again=await request('/mcp',{id:zap.data.id,name:'Gateway',transport:'http',url:c.url});assert.equal(again.data.tools,3,'the masked address keeps the secret');

  // A web API from a pasted description, with its key in the vault.
  const spec=JSON.stringify({...API_SPEC(),servers:[{url:svc.base+'/api'}]});
  const bad=await request('/mcp',{name:'Bad',transport:'openapi',spec:'{"swagger":"1.2"}'});assert.equal(bad.status,400);assert.match(bad.data.error,/OpenAPI 3 or Swagger 2/);
  const api=await request('/mcp',{name:'Items',transport:'openapi',spec,authKind:'query',authName:'key',authValue:'k-123456'});
  assert.equal(api.status,201);assert.equal(api.data.tools,8);assert.equal(api.data.error,'');
  c=await card(api.data.id);assert.equal(c.ask,'auto');assert.equal(c.specFile,true);assert.equal(c.keySaved,true);
  assert.equal(c.tools.find(t=>t.name==='listItems').readOnly,true);assert.equal(c.tools.find(t=>t.name==='deleteItem').readOnly,false);
  assert.ok(!JSON.stringify((await request('/state')).data).includes('k-123456'));
  const kept=await request('/mcp',{id:api.data.id,name:'Items',transport:'openapi',spec:'',authKind:'query',authName:'key',authValue:''});
  assert.equal(kept.data.tools,8,'pasted description and key are kept');
  assert.equal((await request('/mcp/'+api.data.id,undefined,'DELETE')).status,200);

  // Only address connectors sign in.
  const prog=await request('/mcp',{name:'Program',transport:'stdio',command:'node',args:'tests/mcp-fixture.mjs',enabled:false});
  assert.equal((await request('/mcp/'+prog.data.id+'/signin',{})).status,400);
});
