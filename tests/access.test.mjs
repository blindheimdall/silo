import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Vault,hashPassword,checkPassword,roleAllows} from '../vault.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('the vault encrypts, refuses a wrong passphrase and hashes passwords',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'silo-vault-test-'));
  try{
    const v=new Vault(dir);await v.save({openai:{key:'sk-very-secret'}});
    const raw=await fs.readFile(path.join(dir,'secrets.enc'),'utf8');assert.ok(!raw.includes('very-secret'));
    assert.deepEqual(await new Vault(dir).load(),{openai:{key:'sk-very-secret'}});
    await assert.rejects(new Vault(dir,'some passphrase').load(),/key file/);
    const p=new Vault(dir,'correct horse');await p.save({a:1});assert.deepEqual(await new Vault(dir,'correct horse').load(),{a:1});
    await assert.rejects(new Vault(dir,'wrong horse').load(),/does not open/);
    await assert.rejects(new Vault(dir).load(),/SILO_SECRET/);
    const h=await hashPassword('hunter22');assert.ok(await checkPassword('hunter22',h));assert.ok(!await checkPassword('hunter23',h));
    assert.ok(roleAllows('viewer','GET','/api/state'));assert.ok(!roleAllows('viewer','POST','/api/pause'));assert.ok(!roleAllows('viewer','GET','/api/export'));
    assert.ok(roleAllows('operator','POST','/api/workflows'));assert.ok(!roleAllows('operator','POST','/api/connections'));assert.ok(roleAllows('operator','POST','/api/password'));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('keys survive a restart and accounts guard the silo',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-access-test-'));
  const port=14319,origin=`http://127.0.0.1:${port}`;let child;
  const start=async()=>{
    child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start')),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>{clearTimeout(timer);reject(Error(b.toString()));});});
  };
  const stop=async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});};
  t.after(async()=>{await stop();await fs.rm(temp,{recursive:true,force:true});});
  const client=async()=>{
    const s=await fetch(origin+'/api/session');const c={...await s.json(),cookie:s.headers.get('set-cookie')?.split(';')[0]};
    c.request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie:c.cookie,origin,'Content-Type':'application/json','x-silo-token':c.token},body:body===undefined?undefined:JSON.stringify(body)});const set=r.headers.get('set-cookie');const data=await r.json().catch(()=>null);if(set&&data?.token){c.cookie=set.split(';')[0];c.token=data.token;}return {status:r.status,data};};
    return c;
  };
  await start();
  let a=await client();assert.equal(a.accounts,false);
  assert.equal((await a.request('/connections',{provider:'openai',key:'sk-keep-me-safe',model:'fixture-model'})).status,200);
  assert.equal((await a.request('/channels',{kind:'telegram',token:'123:good',chatId:'7',events:['failed']})).status,201);
  const enc=await fs.readFile(path.join(temp,'data','secrets.enc'),'utf8');assert.ok(!enc.includes('keep-me-safe')&&!enc.includes('123:good'));
  assert.ok(!(await fs.readFile(path.join(temp,'data','state.json'),'utf8')).includes('keep-me-safe'));
  assert.equal((await a.request('/settings',{network:true})).status,400,'network access needs an owner');
  // Accounts: the first one is the owner and signs this page in.
  assert.equal((await a.request('/users',{name:'Ana',password:'short'})).status,400);
  const first=await a.request('/users',{name:'Ana',password:'owner-pass-1',role:'viewer'});assert.equal(first.status,201);assert.equal(first.data.user.role,'owner');
  assert.equal((await a.request('/state')).status,200,'the page that made the owner stays signed in');
  assert.equal((await a.request('/users',{name:'Vic',password:'viewer-pass-1',role:'viewer'})).status,201);
  assert.equal((await a.request('/users',{name:'Oli',password:'operator-pass-1',role:'operator'})).status,201);
  await stop();await start();
  a=await client();assert.equal(a.accounts,true);assert.equal(a.me,null);
  assert.equal((await a.request('/state')).status,401,'a new page has to sign in');
  assert.equal((await a.request('/login',{name:'ana',password:'nope-nope'})).status,401);
  const ok=await a.request('/login',{name:'ana',password:'owner-pass-1'});assert.equal(ok.status,200);assert.equal(ok.data.me.name,'Ana');
  const st=(await a.request('/state')).data;assert.equal(st.connections.openai.configured,true,'the key came back from the vault');assert.equal(st.channels[0].has.token,true);
  assert.ok(!JSON.stringify(st.users).includes('scrypt'));assert.equal(st.users.length,3);
  const again=await a.request('/session');assert.equal(again.data.me.name,'Ana','a reload keeps the session');
  const v=await client();assert.equal((await v.request('/login',{name:'Vic',password:'viewer-pass-1'})).status,200);
  assert.equal((await v.request('/state')).status,200);assert.equal((await v.request('/pause',{paused:true})).status,403);
  const o=await client();assert.equal((await o.request('/login',{name:'Oli',password:'operator-pass-1'})).status,200);
  assert.equal((await o.request('/pause',{paused:false})).status,200);assert.equal((await o.request('/connections',{provider:'openai',disconnect:true})).status,403);
  assert.equal((await o.request('/password',{old:'operator-pass-1',password:'operator-pass-2'})).status,200);
  // App steps use the accounts directly: an operator runs them and changes the other steps, but cannot add or change one.
  const agentId=st.agents[0].id,post={type:'action',app:'svc:slack',op:'post',fields:{channel:'C0123',text:'Hello {{previous}}'}};
  const made=await a.request('/workflows',{name:'Post it',steps:[{agentId,prompt:'Write a hello.'},post]});assert.equal(made.status,201,JSON.stringify(made.data));
  const wf=made.data;
  assert.equal((await o.request('/workflows',{name:'Mine',steps:[{agentId,prompt:'Write.'},post]})).status,403);
  const changed=await o.request('/workflows/'+wf.id,{...wf,steps:[wf.steps[0],{...wf.steps[1],fields:{channel:'C0123',text:'Leak {{brief}}'}}]},'PUT');
  assert.equal(changed.status,403);assert.match(changed.data.error,/Step 2 is an app step\..*only an owner can add or change it/);
  assert.equal((await o.request('/workflows/'+wf.id,{...wf,steps:[wf.steps[1],wf.steps[0]]},'PUT')).status,403,'nor move it');
  const kept=await o.request('/workflows/'+wf.id,{...wf,steps:[{...wf.steps[0],prompt:'Write a warm hello.'},wf.steps[1]]},'PUT');
  assert.equal(kept.status,200,JSON.stringify(kept.data));
  assert.equal((await o.request('/workflows/'+wf.id,{...kept.data,steps:[kept.data.steps[0]]},'PUT')).status,200,'an operator may remove an app step');
  assert.equal((await o.request('/workflows/'+wf.id+'/restore',{version:1})).status,403,'nor bring it back from an older version');
  const ana=st.users.find(u=>u.name==='Ana');
  assert.equal((await a.request('/users/'+ana.id,{role:'viewer'})).status,400,'keep one owner');
  assert.equal((await a.request('/settings',{network:true})).status,200);
  assert.equal((await a.request('/logout',{})).status,200);assert.equal((await a.request('/state')).status,401);
  for(let i=0;i<10;i++)await v.request('/login',{name:'Vic',password:'wrong-'+i});
  assert.equal((await v.request('/login',{name:'Vic',password:'viewer-pass-1'})).status,429,'too many wrong passwords');
});
