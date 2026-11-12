import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {keyId, signRequest, signReply, checkRequest, checkReply, checkUrl, cleanPeer, pickResident, RadioGuard} from '../radio.mjs';
import {Vault} from '../vault.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('radio keys, signatures, addresses and routing',()=>{
  const k='a-shared-key-for-two-silos-0001';
  assert.equal(keyId(k),keyId(k));assert.match(keyId(k),/^[a-f0-9]{16}$/);assert.notEqual(keyId(k),keyId(k+'x'));
  const body='{"x":1}';
  assert.ok(checkRequest(k,body,signRequest(k,body)));assert.ok(!checkRequest(k,body+' ',signRequest(k,body)));
  assert.ok(!checkReply(k,body,signRequest(k,body)),'a signed question is not a signed answer');
  assert.ok(!checkRequest(k,body,signReply(k,body)),'a signed answer is not a signed question');
  assert.ok(!checkRequest(k,body,undefined));
  assert.equal(checkUrl('https://silo.example.com/radio/'),'https://silo.example.com');
  assert.equal(checkUrl('http://127.0.0.1:4000/'),'http://127.0.0.1:4000');
  for(const bad of ['http://silo.example.com','ftp://x','https://u:p@x.com','https://x.com/?a=1','nonsense','http://8.8.8.8','http://172.32.0.1','http://192.168.1.20.evil.com'])assert.throws(()=>checkUrl(bad),undefined,bad);
  // The local network may use plain http, and an address without http:// gets the right one.
  for(const [given,want] of [['http://192.168.1.20:3000/','http://192.168.1.20:3000'],['192.168.1.20:3000','http://192.168.1.20:3000'],['10.0.0.5','http://10.0.0.5'],['silo.local:3000','http://silo.local:3000'],['localhost:3000','http://localhost:3000'],['silo-7.example.com','https://silo-7.example.com']])assert.equal(checkUrl(given),want,given);
  const p=cleanPeer({name:'  Silo   17 ',url:'https://x.com',residents:'Atlas, IT ,,Atlas',perHour:'12'});
  assert.equal(p.name,'Silo 17');assert.deepEqual(p.residents,['Atlas','IT']);assert.equal(p.perHour,12);assert.ok(p.send&&p.receive);assert.match(p.id,/^[a-f0-9]{16}$/);
  assert.throws(()=>cleanPeer({name:'x',url:'https://x.com',perHour:0}),/1 and 600/);
  const agents=[{name:'Atlas',role:'Orchestrator'},{name:'Echo',role:'Research lead'}];
  assert.equal(pickResident(agents,'atlas').name,'Atlas');assert.equal(pickResident(agents,'research lead').name,'Echo');
  assert.equal(pickResident(agents,'Orchestr'),null,'no partial roles');assert.equal(pickResident(agents,''),null,'no fallback');
  assert.equal(pickResident(agents,'Echo',['Atlas']),null,'only the residents open to that silo');
  const g=new RadioGuard(),peer={id:'p',perHour:2};
  assert.equal(g.limited(peer,0),false);assert.equal(g.limited(peer,1),false);assert.equal(g.limited(peer,2),true);assert.equal(g.limited(peer,3_600_001),false);
  assert.equal(g.replay(peer,'n',0),false);assert.equal(g.replay(peer,'n',1),true);assert.equal(g.replay({id:'q'},'n',1),false,'nonces are per silo');
});

async function silo(t,port,prepare){
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-radio-test-')),data=path.join(temp,'data');
  await fs.mkdir(data,{recursive:true});if(prepare)await prepare(data);
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:data,SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start')),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});child.stderr.on('data',b=>{if(/SILO radio|SILO vault/.test(b))return;clearTimeout(timer);reject(Error(b.toString()));});});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${port}`;
  const s=await fetch(origin+'/api/session'),j=await s.json(),cookie=s.headers.get('set-cookie')?.split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':j.token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  return {origin,request};
}

test('silos talk to each other with their own keys and rights',async t=>{
  const A=await silo(t,14383),B=await silo(t,14385);
  const kAB='key-between-silo-a-and-b-0000001',kOther='key-of-some-other-silo-00000002';
  assert.equal((await A.request('/settings',{radio:{enabled:true,siloId:'Silo A'}})).status,200);
  assert.equal((await B.request('/settings',{radio:{enabled:true,siloId:'Silo B'}})).status,200);
  assert.equal((await A.request('/radio/peers',{name:'B',url:B.origin,key:'short'})).status,400,'keys must be long');
  const toB=(await A.request('/radio/peers',{name:'B',url:B.origin,key:kAB})).data.peer;
  const atB=(await B.request('/radio/peers',{name:'A',url:A.origin,key:kAB,perHour:4})).data.peer;
  assert.equal((await B.request('/radio/peers',{name:'Copy',url:A.origin,key:kAB})).status,409,'every silo its own key');
  const other=(await B.request('/radio/peers',{name:'Other',url:'https://other.example.com',key:kOther})).data.peer;
  const st=(await A.request('/state')).data;assert.equal(st.access.radioKeys[toB.id],true);assert.ok(!JSON.stringify(st).includes(kAB),'keys never reach the page');

  const res=await A.request('/radio/send',{peer:'B',toAgent:'Atlas',message:'Status check'});
  assert.equal(res.status,200,JSON.stringify(res.data));assert.equal(res.data.silo,'B');assert.equal(res.data.remoteName,'Silo B');assert.equal(res.data.agent.name,'Atlas');assert.ok(res.data.reply);
  assert.equal((await A.request('/radio/send',{peer:'B',toAgent:'Orchestr',message:'x'})).status,502,'no partial match on the other side');
  assert.equal((await A.request('/radio/send',{peer:'Nobody',toAgent:'Atlas',message:'x'})).status,400);

  // The sender is who the key says, whatever the message claims.
  const post=(key,body,extra={})=>fetch(B.origin+'/radio',{method:'POST',headers:{'content-type':'application/json','x-silo-radio-v':'2','x-silo-radio-key':keyId(key),'x-silo-radio-sig':signRequest(key,body),...extra},body});
  const msg=(nonce,extra={})=>JSON.stringify({v:'2',fromSilo:'Silo A',fromAgent:'Spy',toAgent:'Atlas',message:'I am Silo A',time:Date.now(),nonce,...extra});
  const forged=await post(kOther,msg('1'.repeat(32)));assert.equal(forged.status,200);
  const events=(await B.request('/state')).data.events;
  assert.ok(events.some(e=>e.title==='Inbound radio from Other'),'named by its key');assert.ok(!events.some(e=>/from Silo A/.test(e.title)));
  assert.equal((await post('a-key-nobody-here-knows-0000003',msg('2'.repeat(32)))).status,403,'unknown key');
  assert.equal((await fetch(B.origin+'/radio',{method:'POST',headers:{'content-type':'application/json'},body:msg('4'.repeat(32))})).status,426,'old radio gets told to update');
  assert.equal((await post(kOther,msg('5'.repeat(32),{time:Date.now()-10*60_000}))).status,403,'too old');
  assert.equal((await post(kOther,msg('1'.repeat(32)))).status,403,'replay');

  // Rights per silo: what it may reach, whether it may send at all, and how often.
  assert.equal((await B.request('/radio/peers/'+other.id,{residents:'Echo'})).status,200);
  const closed=await post(kOther,msg('6'.repeat(32)));assert.equal(closed.status,404);assert.match((await closed.json()).error,/Open to you: Echo/);
  assert.equal((await B.request('/radio/peers/'+other.id,{receive:false})).status,200);
  assert.equal((await post(kOther,msg('7'.repeat(32),{toAgent:'Echo'}))).status,403,'a silo that may not send');
  assert.equal((await A.request('/radio/send',{peer:'B',toAgent:'Atlas',message:'two'})).status,200);
  const third=await A.request('/radio/send',{peer:'B',toAgent:'Atlas',message:'three'});assert.equal(third.status,200,JSON.stringify(third.data));
  const fourth=await A.request('/radio/send',{peer:'B',toAgent:'Atlas',message:'four'});assert.equal(fourth.status,429,'a rate limit stays a rate limit');assert.match(fourth.data.error,/4 an hour/);

  // Removing a silo deletes its key: it can no longer reach this one.
  assert.equal((await B.request('/radio/peers/'+atB.id,undefined,'DELETE')).status,200);
  assert.equal((await A.request('/radio/send',{peer:'B',toAgent:'Atlas',message:'still there?'})).status,502);
});

test('answers that are not signed by the right silo are thrown away',async t=>{
  const key='key-for-the-fake-silo-000000004';
  let mode='unsigned';
  const fake=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const q=JSON.parse(raw);
    const out=JSON.stringify({ok:true,silo:'Fake',agent:{name:'Atlas',level:1},reply:'Trust me',nonce:mode==='nonce'?'f'.repeat(32):q.nonce,time:Date.now()});
    const sig=mode==='unsigned'?'':mode==='wrongkey'?signReply('another-key-entirely-0000000005',out):signReply(key,out);
    res.writeHead(200,{'content-type':'application/json',...(sig&&{'x-silo-radio-sig':sig})});res.end(out);
  });
  await new Promise(r=>fake.listen(14389,'127.0.0.1',r));t.after(()=>fake.close());
  const A=await silo(t,14387);
  await A.request('/settings',{radio:{enabled:true,siloId:'Silo A'}});
  await A.request('/radio/peers',{name:'Fake',url:'http://127.0.0.1:14389',key});
  for(const [m,why] of [['unsigned',/not signed/],['wrongkey',/not signed/],['nonce',/does not belong/]]){
    mode=m;const r=await A.request('/radio/send',{toAgent:'Atlas',message:'hello'});
    assert.equal(r.status,502,m);assert.match(r.data.error,why);
  }
  mode='good';const ok=await A.request('/radio/send',{toAgent:'Atlas',message:'hello'});
  assert.equal(ok.status,200);assert.equal(ok.data.reply,'Trust me');assert.equal(ok.data.silo,'Fake');
});

test('the old single radio becomes the first silo in the list',async t=>{
  const A=await silo(t,14391,async data=>{
    await fs.writeFile(path.join(data,'state.json'),JSON.stringify({version:4,agents:[],workflows:[],runs:[],events:[],floors:[],connections:{},users:[],channels:[],settings:{radio:{enabled:true,siloId:'Silo 9',url:'http://127.0.0.1:14000'}}}));
    await new Vault(data).save({radio:{key:'old-shared-key'}});
  });
  const st=(await A.request('/state')).data,peers=st.settings.radio.peers;
  assert.equal(peers.length,1);assert.equal(peers[0].url,'http://127.0.0.1:14000');assert.equal(st.settings.radio.url,undefined);
  assert.equal(st.access.radioKeys[peers[0].id],true,'the old key moved with it');assert.equal(st.settings.radio.enabled,true);
});
