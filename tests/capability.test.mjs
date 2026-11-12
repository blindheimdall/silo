// Capabilities across machines: Ed25519 keys per silo, signed chains that only narrow, budgets counted where the data
// lives, revocation, and three real silos where the third is unknown to the first and still gets exactly what was
// passed on to it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {newIdentity,fingerprint,signText,verifyText,issue,readChain,verifyChain,narrower,cleanRights,attenuation,linkHash,revocationText,CAP_PREFIX} from '../capability.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rights={residents:['Archivist'],tools:['read_files'],folders:['reports']};

test('keys, signed links and chains that only narrow',()=>{
  const a=newIdentity(),b=newIdentity(),c=newIdentity(),d=newIdentity();
  assert.match(a.publicKey,/^ed25519:[A-Za-z0-9_-]{43}$/);assert.match(fingerprint(a.publicKey),/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  const sig=signText(a.privateKey,'hello');assert.equal(verifyText(a.publicKey,'hello',sig),true);
  assert.equal(verifyText(b.publicKey,'hello',sig),false);assert.equal(verifyText(a.publicKey,'hellO',sig),false);
  const ab=issue({privateKey:a.privateKey,iss:a.publicKey,aud:b.publicKey,rights,budget:{tokens:50000,messages:10},hours:2,site:'https://a.example',siloName:'Silo 18'});
  assert.ok(ab.token.startsWith(CAP_PREFIX));
  const c1=verifyChain(ab.token,{root:a.publicKey,presenter:b.publicKey});
  assert.deepEqual(c1.rights,{residents:['Archivist'],tools:['read_files'],ops:['read'],folders:['reports']});assert.equal(c1.site,'https://a.example');
  assert.throws(()=>verifyChain(ab.token,{root:a.publicKey,presenter:c.publicKey}),/belongs to another silo/);
  assert.throws(()=>verifyChain(ab.token,{root:b.publicKey,presenter:b.publicKey}),/not given by this silo/);
  assert.throws(()=>verifyChain(ab.token,{root:a.publicKey,presenter:b.publicKey,now:Date.now()+3*3600e3}),/expired/);
  assert.throws(()=>verifyChain(ab.token,{root:a.publicKey,presenter:b.publicKey,revoked:new Set([ab.hash])}),/revoked/);
  // A changed link no longer matches its signature.
  const [body,s]=ab.token.slice(CAP_PREFIX.length).split('.');
  const p=JSON.parse(Buffer.from(body,'base64url'));p.att.folders=['*'];
  assert.throws(()=>readChain(CAP_PREFIX+Buffer.from(JSON.stringify(p)).toString('base64url')+'.'+s),/not signed/);
  // Passing on: less is fine, more is refused at issue and, if forged by hand, when read.
  const parent=readChain(ab.token);
  const bc=issue({privateKey:b.privateKey,iss:b.publicKey,aud:c.publicKey,rights:{...rights,folders:['reports/q1']},budget:{tokens:1000,messages:2},hours:1,parent});
  const c2=verifyChain(bc.token,{root:a.publicKey,presenter:c.publicKey});
  assert.equal(c2.links.length,2);assert.deepEqual(c2.rights.folders,['reports/q1']);assert.equal(c2.budget.tokens,1000);
  for(const [wider,why] of [[{...rights,folders:['*']},/folders/],[{...rights,folders:['secret']},/folders/],[{...rights,residents:['*']},/residents/],[{...rights,tools:['read_files','web']},/tools/],[{residents:['Archivist'],tools:['write_files'],folders:['reports']},/tools/]])
    assert.throws(()=>issue({privateKey:b.privateKey,iss:b.publicKey,aud:c.publicKey,rights:wider,budget:{tokens:10,messages:1},hours:1,parent}),why);
  assert.throws(()=>issue({privateKey:b.privateKey,iss:b.publicKey,aud:c.publicKey,rights,budget:{tokens:60000,messages:1},hours:1,parent}),/budget/);
  assert.throws(()=>issue({privateKey:c.privateKey,iss:c.publicKey,aud:d.publicKey,rights,budget:{tokens:1,messages:1},hours:1,parent}),/not given to this silo/);
  const forged={v:1,iss:b.publicKey,aud:c.publicKey,att:{...rights,folders:['*']},budget:{tokens:1000,messages:2},nbf:parent.nbf,exp:parent.exp,nonce:'x',prf:parent.hashes[0]};
  const fb=Buffer.from(JSON.stringify(forged)).toString('base64url'),fl=fb+'.'+signText(b.privateKey,'silocap\n'+fb);
  assert.throws(()=>readChain(ab.token+'~'+fl),/gives more folders/,'a hand-made wider link is refused even with a good signature');
  const longer={...forged,att:rights,exp:parent.exp+3600e3},lb=Buffer.from(JSON.stringify(longer)).toString('base64url');
  assert.throws(()=>readChain(ab.token+'~'+lb+'.'+signText(b.privateKey,'silocap\n'+lb)),/lasts longer/);
  const stranger={...forged,att:rights,iss:d.publicKey},sb=Buffer.from(JSON.stringify(stranger)).toString('base64url');
  assert.throws(()=>readChain(ab.token+'~'+sb+'.'+signText(d.privateKey,'silocap\n'+sb)),/not given to/);
  // Revoking the middle link cuts what was passed on from it.
  assert.throws(()=>verifyChain(bc.token,{root:a.publicKey,presenter:c.publicKey,revoked:new Set([linkHash(ab.token.slice(CAP_PREFIX.length))])}),/revoked/);
  assert.equal(narrower(cleanRights({residents:['archivist'],tools:[],folders:[]}),cleanRights(rights)),null,'names compare without case');
  assert.throws(()=>cleanRights({residents:['x'],tools:['read_files'],folders:['../etc']}),/\./);
  assert.throws(()=>cleanRights({residents:['x'],tools:['delegate'],folders:[]}),/read_files/);
  assert.deepEqual(attenuation(c2.rights),{strict:true,tools:['read_files'],operations:['read_file'],connectors:[],folderChain:[['reports/q1']]});
});

async function startSilo(t,port){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-cap-test-')),origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  await request('/settings',{radio:{enabled:true,siloId:'Silo '+port,address:origin}});
  const st=(await request('/state')).data;
  return {origin,request,key:st.settings.radio.publicKey,state:async()=>(await request('/state')).data,temp};
}

test('three silos: rights given, passed on to a silo the owner never met, budgets, refusals and revocation',async t=>{
  const [A,B,C]=await Promise.all([startSilo(t,14401),startSilo(t,14402),startSilo(t,14403)]);
  // A holds the data: a resident that can read files, a report and a secret.
  await A.request('/connections',{provider:'compatible',key:'fixture-key-cap',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  await A.request('/agents',{name:'Archivist',role:'Records',floor:2,provider:'compatible',model:'tool-user',instructions:'Fixture.',tools:['read_files','write_files']});
  await A.request('/file',{name:'reports/q1.md',content:'Revenue 42'});await A.request('/file',{name:'secret/pay.md',content:'SALARY 9000'});
  const CALL=o=>'CALL '+JSON.stringify(o);
  const ask=(S,peer,message)=>S.request('/radio/send',{peer,toAgent:'Archivist',message});

  await t.test('radio settings save one field at a time; a wrong address changes nothing else',async()=>{
    assert.equal((await C.request('/settings',{radio:{enabled:false}})).status,200);
    assert.equal((await C.request('/settings',{radio:{siloId:'Silo Three'}})).status,200);
    let r=(await C.state()).settings.radio;assert.equal(r.enabled,false);assert.equal(r.siloId,'Silo Three');assert.equal(r.address,C.origin);
    const bad=await C.request('/settings',{radio:{enabled:true,siloId:'Renamed',address:'http://silo.example.com'}});
    assert.equal(bad.status,400);assert.match(bad.data.error,/address/);
    r=(await C.state()).settings.radio;assert.equal(r.enabled,false);assert.equal(r.siloId,'Silo Three','nothing half saved');
    assert.equal((await C.request('/settings',{radio:{address:'192.168.1.20:3000'}})).status,200);
    assert.equal((await C.state()).settings.radio.address,'http://192.168.1.20:3000');
    assert.equal((await C.request('/settings',{radio:{enabled:true,siloId:'Silo '+14403,address:C.origin}})).status,200);
  });
  await t.test('each silo has its own key; A and B add each other by key after reading it',async()=>{
    assert.notEqual(A.key,B.key);assert.match(A.key,/^ed25519:/);
    const look=await B.request('/radio/lookup',{url:A.origin});
    assert.equal(look.status,200);assert.equal(look.data.publicKey,A.key);assert.equal(look.data.fingerprint,(await A.state()).settings.radio.fingerprint);
    assert.equal((await B.request('/radio/peers',{name:'Silo A',url:A.origin,publicKey:look.data.publicKey})).status,201);
    assert.equal((await A.request('/radio/peers',{name:'Silo B',url:B.origin,publicKey:B.key})).status,201);
    assert.equal((await A.request('/radio/peers',{name:'Me',url:A.origin,publicKey:A.key})).status,400,'not its own key');
    assert.ok(!JSON.stringify(await A.state()).includes('privateKey'),'the private key never reaches the page');
  });

  await t.test('without a capability the resident answers with no tools',async()=>{
    const r=await ask(B,'Silo A',CALL({tool:'read_file',name:'reports/q1.md'}));
    assert.equal(r.status,200,JSON.stringify(r.data));assert.doesNotMatch(r.data.reply,/Revenue 42/);
  });

  let given;
  await t.test('A gives B: read reports/ for two hours, 50,000 tokens, 5 messages; B reads, but not outside reports/',async()=>{
    assert.equal((await A.request('/radio/caps',{peerId:'nope',rights,budget:{tokens:50000,messages:4},hours:2})).status,404);
    assert.equal((await A.request('/radio/caps',{publicKey:B.key,rights:{...rights,tools:['delegate']},budget:{tokens:5,messages:1},hours:2})).status,400);
    const peerB=(await A.state()).settings.radio.peers.find(p=>p.name==='Silo B');
    given=await A.request('/radio/caps',{peerId:peerB.id,rights,budget:{tokens:50000,messages:5},hours:2});
    assert.equal(given.status,201,JSON.stringify(given.data));
    assert.equal((await C.request('/radio/held',{token:given.data.token})).status,403,'C cannot use what was given to B');
    const held=await B.request('/radio/held',{token:given.data.token});assert.equal(held.status,201,JSON.stringify(held.data));
    let r=await ask(B,'Silo A',CALL({tool:'read_file',name:'reports/q1.md'}));
    assert.equal(r.status,200,JSON.stringify(r.data));assert.match(r.data.reply,/Revenue 42/);
    // A local grant that allows escalation and opens secret/ does not widen what came over the radio.
    const arch=(await A.state()).agents.find(a=>a.name==='Archivist');
    const grant=await A.request('/grants',{subjectId:arch.id,permissions:['read_files'],folders:['secret'],allowEscalation:true});assert.equal(grant.status,201);
    r=await ask(B,'Silo A',CALL({tool:'read_file',name:'secret/pay.md'}));
    assert.doesNotMatch(r.data.reply,/SALARY/);assert.match(r.data.reply,/outside the allowed folder/);
    assert.equal((await A.request(`/grants/${grant.data.id}/revoke`,{})).status,200);
    r=await ask(B,'Silo A',CALL({tool:'write_file',name:'reports/x.md',content:'x'}));
    assert.match(r.data.reply,/write_file was not offered/,'the model is never offered a tool beyond the capability');
    assert.equal((await A.state()).proposals.length,0);
    const use=(await A.state()).settings.radio.capUse[given.data.hash];
    assert.equal(use.messages,3);assert.ok(use.tokens>0);
  });

  let passed;
  await t.test('B passes on less to C, which A has never met; C uses it until the messages run out',async()=>{
    const h=(await B.state()).settings.radio.held[0];
    assert.equal((await B.request(`/radio/held/${h.id}/delegate`,{publicKey:C.key,name:'Silo C',rights:{...rights,folders:['*']},budget:{tokens:100,messages:1},hours:1})).status,400);
    assert.equal((await B.request(`/radio/held/${h.id}/delegate`,{publicKey:C.key,rights,budget:{tokens:999999,messages:1},hours:1})).status,400);
    passed=await B.request(`/radio/held/${h.id}/delegate`,{publicKey:C.key,name:'Silo C',rights,budget:{tokens:40000,messages:2},hours:1});
    assert.equal(passed.status,201,JSON.stringify(passed.data));assert.equal(passed.data.links,2);
    const imp=await C.request('/radio/held',{token:passed.data.token});assert.equal(imp.status,201,JSON.stringify(imp.data));
    const peerA=(await C.state()).settings.radio.peers.find(p=>p.publicKey===A.key);assert.equal(peerA.url,A.origin,'found by the address in the capability');
    assert.ok(!(await A.state()).settings.radio.peers.some(p=>p.publicKey===C.key),'A does not know C');
    let r=await ask(C,peerA.name,CALL({tool:'read_file',name:'reports/q1.md'}));
    assert.equal(r.status,200,JSON.stringify(r.data));assert.match(r.data.reply,/Revenue 42/);
    r=await ask(C,peerA.name,'Hello');assert.equal(r.status,200);
    r=await ask(C,peerA.name,'Once more');assert.equal(r.status,429);assert.match(r.data.error,/message budget/);
    // B's use and C's use both count against B's link: 3 + 2 of 5 means B has nothing left either.
    r=await ask(B,'Silo A','Hello');assert.equal(r.status,429,'a holder pays for what it passed on');
    const log=(await A.state()).radioLog;assert.ok(log.some(x=>x.dir==='in'&&x.ok===false&&/budget/.test(x.why)));assert.ok(log.every(x=>!('message' in x)),'the log keeps no message text');
  });

  await t.test('revocation: B takes back what it gave C, A takes back what it gave B',async()=>{
    const peerB=(await A.state()).settings.radio.peers.find(p=>p.name==='Silo B');
    const fresh=await A.request('/radio/caps',{peerId:peerB.id,rights,budget:{tokens:50000,messages:20},hours:2});
    await B.request('/radio/held',{token:fresh.data.token});
    const h=(await B.state()).settings.radio.held.find(x=>x.hash===fresh.data.hash);
    const toC=await B.request(`/radio/held/${h.id}/delegate`,{publicKey:C.key,name:'Silo C',rights,budget:{tokens:1000,messages:5},hours:1});
    await C.request('/radio/held',{token:toC.data.token});
    const peerA=(await C.state()).settings.radio.peers.find(p=>p.publicKey===A.key);
    assert.equal((await ask(C,peerA.name,'Hi')).status,200);
    const rv=await B.request(`/radio/caps/${toC.data.hash}/revoke`,{});assert.equal(rv.status,200,JSON.stringify(rv.data));
    assert.ok((await A.state()).settings.radio.revoked.includes(toC.data.hash),'A was told');
    let r=await ask(C,peerA.name,'Hi');assert.equal(r.status,502);assert.match(r.data.error,/revoked/);
    assert.equal((await ask(B,'Silo A','Hi')).status,200,'B still has its own');
    assert.equal((await A.request(`/radio/caps/${fresh.data.hash}/revoke`,{})).status,200);
    r=await ask(B,'Silo A','Hi');assert.equal(r.status,502);assert.match(r.data.error,/revoked/);
    // Revocations A does not take: signed by a silo that did not sign the link, or for a chain A never started.
    const revoke=(chain,privateKey)=>{const time=Date.now();return fetch(A.origin+'/radio/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain,time,sig:signText(privateKey,revocationText(readChain(chain).hashes.at(-1),time))})});};
    const live=await A.request('/radio/caps',{publicKey:B.key,name:'Silo B',rights,budget:{tokens:10,messages:1},hours:1});
    let bad=await revoke(live.data.token,newIdentity().privateKey);
    assert.equal(bad.status,403);assert.match((await bad.json()).error,/not signed by the silo that signed/);
    const D=newIdentity(),E=newIdentity(),own=issue({privateKey:D.privateKey,iss:D.publicKey,aud:E.publicKey,rights,budget:{tokens:1,messages:1},hours:1});
    bad=await revoke(own.token,D.privateKey);
    assert.equal(bad.status,403);assert.match((await bad.json()).error,/did not give/);
    assert.ok(!(await A.state()).settings.radio.revoked.includes(own.hash),'a stranger cannot fill the list of revocations');
    assert.ok(!(await A.state()).settings.radio.revoked.includes(live.data.hash));
  });

  await t.test('a silo not in the list and without a capability is refused; a token cannot give rights',async()=>{
    const D=newIdentity(),payload=JSON.stringify({v:'3',fromAgent:'x',toAgent:'Archivist',message:'hi',time:Date.now(),nonce:'a'.repeat(32),fromKey:D.publicKey,toKey:A.key});
    const r=await fetch(A.origin+'/radio',{method:'POST',headers:{'Content-Type':'application/json','x-silo-radio-v':'3','x-silo-radio-from':D.publicKey,'x-silo-radio-sig':signText(D.privateKey,'req\n'+payload)},body:payload});
    assert.equal(r.status,403);assert.match((await r.json()).error,/does not know your key/);
    const forged=await fetch(A.origin+'/radio',{method:'POST',headers:{'Content-Type':'application/json','x-silo-radio-v':'3','x-silo-radio-from':B.key,'x-silo-radio-sig':signText(D.privateKey,'req\n'+payload)},body:payload});
    assert.equal(forged.status,403,'a key that did not sign is refused');
    const tok=(await A.request('/tokens',{name:'T',scopes:['read','run','approve'],days:7})).data.secret;
    const viaToken=await fetch(A.origin+'/api/radio/caps',{method:'POST',headers:{authorization:'Bearer '+tok,'content-type':'application/json'},body:JSON.stringify({publicKey:B.key,rights,budget:{tokens:1,messages:1},hours:1})});
    assert.equal(viaToken.status,403);
  });
});
