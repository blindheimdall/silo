// Deploying to the cloud: behind a hosting service's HTTPS proxy the page works (origin, Secure cookies), the visitor's
// address is the one the proxy saw, nobody passes as this computer through it, the health check answers before the
// first account, and the container start gives a root-owned disk to the node user.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs,statSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {userIds,cloudDirs,prepare} from '../container-start.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms,what)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(50);}};

async function start(t,port,env){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-deploy-test-'));
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:'',SILO_HOST:'',SILO_PROXY:'',SILO_PUBLIC_URL:'',RENDER_EXTERNAL_URL:'',FLY_APP_NAME:'',RAILWAY_PUBLIC_DOMAIN:'',...env},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let out='',errors='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await until(()=>out.includes('SILO is ready')||child.exitCode!==null,10000,'the test server');
  assert.ok(out.includes('SILO is ready'),'it started: '+errors);
  return ()=>out;
}

test('behind a trusted HTTPS proxy',async t=>{
  const port=14489,origin=`http://127.0.0.1:${port}`,https=`https://127.0.0.1:${port}`;
  await start(t,port,{SILO_PROXY:'1'});
  const proxy={'x-forwarded-proto':'https','x-forwarded-for':'198.51.100.7, 203.0.113.9'};
  const s=await fetch(origin+'/api/session',{headers:proxy});const {token}=await s.json(),setCookie=s.headers.get('set-cookie'),cookie=setCookie.split(';')[0];
  assert.match(setCookie,/; Secure/,'the session cookie is only sent over https');
  const post=(o,headers=proxy)=>fetch(origin+'/api/guardrails/check',{method:'POST',headers:{...headers,cookie,origin:o,'Content-Type':'application/json','x-silo-token':token},body:JSON.stringify({text:'Hello.'})});

  await t.test('the https page may act, an http one may not',async()=>{
    assert.equal((await post(https)).status,200);
    const r=await post(origin);assert.equal(r.status,403);assert.match((await r.json()).error,/Origin denied/);
  });
  await t.test('the visitor is the address the proxy added last, never this computer',async()=>{
    const records=async()=>(await (await fetch(origin+'/api/audit?q=guardrails&limit=50',{headers:{cookie,'x-silo-token':token}})).json()).records||[];
    const r=await until(async()=>(await records()).find(x=>x.ip==='203.0.113.9'),5000,'the audit record');
    assert.equal(r.via,'network');
    assert.equal((await post(https,{'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'})).status,200);
    await until(async()=>(await records()).find(x=>x.ip==='unknown'&&x.via==='network'),5000,'a forged local address recorded as unknown');
  });
  await t.test('straight to SILO, without the proxy, it is plain http as before',async()=>{
    const r=await fetch(origin+'/api/session');assert.doesNotMatch(r.headers.get('set-cookie'),/Secure/);
    assert.equal((await post(origin,{})).status,200);
    assert.equal((await post(https,{})).status,403,'https is only believed from the proxy');
  });
});

test('without SILO_PROXY the forwarding headers are not believed',async t=>{
  const port=14491,origin=`http://127.0.0.1:${port}`;
  await start(t,port,{});
  const s=await fetch(origin+'/api/session',{headers:{'x-forwarded-proto':'https'}});
  assert.doesNotMatch(s.headers.get('set-cookie'),/Secure/);
  const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const r=await fetch(origin+'/api/guardrails/check',{method:'POST',headers:{'x-forwarded-proto':'https',cookie,origin:`https://127.0.0.1:${port}`,'Content-Type':'application/json','x-silo-token':token},body:'{}'});
  assert.equal(r.status,403);
});

test('a new cloud SILO: health before the first account, and the setup code through the proxy',async t=>{
  const port=14493,origin=`http://127.0.0.1:${port}`;
  const log=await start(t,port,{SILO_HOST:'0.0.0.0',SILO_PROXY:'1',SILO_PUBLIC_URL:'https://silo.example.com/'});
  const code=await until(()=>/\/\?setup=([a-f0-9]{32})/.exec(log())?.[1],5000,'a setup code printed');assert.ok(log().includes('https://silo.example.com/?setup='+code),'with the public address');
  const proxy={'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1',host:'silo.example.com'};
  assert.equal((await fetch(origin+'/api/health',{headers:proxy})).status,200,'the hosting service sees it is up');
  assert.equal((await fetch(origin+'/api/session',{headers:proxy})).status,403,'through the proxy, nobody is this computer');
  const r=await fetch(origin+'/?setup='+code,{headers:proxy,redirect:'manual'});
  assert.equal(r.status,302);assert.match(r.headers.get('set-cookie'),/^silo_setup=[a-f0-9]{32};.*; Secure/);
  const kept=r.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin+'/api/session',{headers:{...proxy,cookie:kept}})).status,200,'the setup cookie lets the owner in');
  assert.equal((await fetch(origin+'/api/session')).status,200,'on the machine itself it works as before');
});

test('the container start',async t=>{
  await t.test('finds the node user, or uses the image ids',()=>{
    assert.deepEqual(userIds('root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\n'),{uid:1000,gid:1000,home:'/home/node'});
    assert.deepEqual(userIds('node:x:1001:1002::/srv/node:/bin/sh'),{uid:1001,gid:1002,home:'/srv/node'});
    assert.deepEqual(userIds(''),{uid:1000,gid:1000,home:'/home/node'});
  });
  await t.test('puts the data and the workspace on a Railway volume, unless they were set',()=>{
    assert.deepEqual(cloudDirs({RAILWAY_VOLUME_MOUNT_PATH:'/vol',SILO_DATA_DIR:'/data',SILO_WORK_DIR:'/workspace'}),{RAILWAY_VOLUME_MOUNT_PATH:'/vol',SILO_DATA_DIR:'/vol',SILO_WORK_DIR:'/vol/workspace'});
    assert.equal(cloudDirs({RAILWAY_VOLUME_MOUNT_PATH:'/vol',SILO_WORK_DIR:'/mine'}).SILO_WORK_DIR,'/mine');
    const said=[];cloudDirs({RAILWAY_ENVIRONMENT:'production'},m=>said.push(m));assert.match(said[0],/No volume is attached/);
    const quiet=[];cloudDirs({SILO_DATA_DIR:'/data'},m=>quiet.push(m));assert.equal(quiet.length,0,'elsewhere it says nothing');
  });
  await t.test('makes the folders, and leaves alone a disk the user already owns',async()=>{
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-start-test-'));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
    const st=statSync(temp),said=[],dirs=[path.join(temp,'data'),path.join(temp,'data','workspace')];
    prepare({dirs,ids:{uid:st.uid,gid:st.gid},log:m=>said.push(m)});
    for(const d of dirs)assert.ok(statSync(d).isDirectory());
    assert.equal(said.length,0,'nothing to give');
  });
});
