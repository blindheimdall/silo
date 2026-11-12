import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {bodyText,decodeWords} from '../mail-watch.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=8000,what='condition'){const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(60);}}

// A fake Telegram Bot API: the test puts updates in, and reads what the bot sent.
function fakeTelegram(){
  const queue=[],sent=[],edits=[],answers=[],files=new Map();let nextId=1,msgId=100;const waiters=[];
  const server=http.createServer(async(req,res)=>{
    const file=req.url.match(/^\/file\/bot[^/]+\/(.+)$/);
    if(file){const data=files.get(decodeURIComponent(file[1]));res.writeHead(data?200:404,{'Content-Type':'application/octet-stream'});return res.end(data||'');}
    let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};
    const [,token,method]=req.url.match(/^\/bot([^/]+)\/(\w+)$/)||[];
    const ok=result=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,result}));};
    if(decodeURIComponent(token||'').includes('bad')){res.writeHead(401,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,description:'Unauthorized'}));}
    if(method==='getMe')return ok({id:1,is_bot:true,username:'silo_test_bot'});
    if(method==='getUpdates'){
      if(body.offset===-1)return ok([]);
      const take=()=>{const out=queue.filter(u=>u.update_id>=(body.offset||0));queue.length=0;return out;};
      if(queue.length)return ok(take());
      const t=setTimeout(()=>{const i=waiters.indexOf(w);if(i>=0)waiters.splice(i,1);ok([]);},Math.min(400,(body.timeout||0)*1000));
      const w=()=>{clearTimeout(t);ok(take());};waiters.push(w);return;
    }
    if(method==='sendMessage'){const m={message_id:++msgId,chat:{id:body.chat_id},text:body.text,buttons:body.reply_markup?.inline_keyboard};sent.push(m);return ok(m);}
    if(method==='editMessageText'){edits.push(body);return ok(true);}
    if(method==='answerCallbackQuery'){answers.push(body);return ok(true);}
    if(method==='sendChatAction')return ok(true);
    if(method==='getFile'){const p='voice/'+body.file_id+'.oga';if(files.has(p))return ok({file_id:body.file_id,file_size:files.get(p).length,file_path:p});res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,description:'Bad Request: invalid file_id'}));}
    res.writeHead(404);res.end('{}');
  });
  const push=u=>{queue.push({update_id:nextId++,...u});const w=waiters.shift();w?.();};
  const say=(chatId,text,from={first_name:'Ana'})=>push({message:{message_id:nextId,chat:{id:chatId,type:'private'},from:{id:chatId,...from},text}});
  const tap=(chatId,data,messageId)=>push({callback_query:{id:'cb'+nextId,data,message:{message_id:messageId,chat:{id:chatId}}}});
  // A voice note: the sound is stored as text, which the fake speech to text gives back.
  const voice=(chatId,said)=>{const id='vn'+nextId;files.set('voice/'+id+'.oga',Buffer.from('FAKEAUDIO:'+said));push({message:{message_id:nextId,chat:{id:chatId,type:'private'},from:{id:chatId,first_name:'Ana'},voice:{file_id:id,file_unique_id:id,duration:3,mime_type:'audio/ogg'}}});};
  return {server,sent,edits,answers,say,tap,voice};
}

// A fake IMAP server with one inbox. Messages added later count as new mail.
function fakeImap(){
  const mail=[{uid:3,from:'Old <old@example.com>',subject:'Old mail',body:'Already here.'}];
  const server=net.createServer(sock=>{
    sock.write('* OK fake IMAP ready\r\n');let buf='';
    sock.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\r\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+2);handle(line);}});
    const handle=line=>{
      const [tag,cmd,...rest]=line.split(' ');const arg=rest.join(' ');
      if(cmd==='LOGIN'){return sock.write(arg.includes('"right-pass"')?`${tag} OK logged in\r\n`:`${tag} NO wrong password\r\n`);}
      if(cmd==='EXAMINE'){const top=Math.max(...mail.map(m=>m.uid));return sock.write(`* ${mail.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${top+1}] ok\r\n${tag} OK [READ-ONLY] done\r\n`);}
      if(cmd==='UID'&&rest[0]==='SEARCH'){const from=Number(rest[2].split(':')[0]);const hits=mail.filter(m=>m.uid>=from).map(m=>m.uid);const top=Math.max(...mail.map(m=>m.uid));return sock.write(`* SEARCH ${(hits.length?hits:[top]).join(' ')}\r\n${tag} OK done\r\n`);}
      if(cmd==='UID'&&rest[0]==='FETCH'){
        const m=mail.find(m=>m.uid===Number(rest[1]));
        const head=`From: ${m.from}\r\nSubject: ${m.subject}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n`,body=m.body;
        return sock.write(`* 1 FETCH (UID ${m.uid} BODY[HEADER.FIELDS (FROM SUBJECT)] {${Buffer.byteLength(head)}}\r\n${head} BODY[TEXT]<0> {${Buffer.byteLength(body)}}\r\n${body})\r\n${tag} OK done\r\n`);
      }
      if(cmd==='LOGOUT'){sock.write(`* BYE\r\n${tag} OK bye\r\n`);return sock.end();}
      sock.write(`${tag} BAD unknown\r\n`);
    };
    sock.on('error',()=>{});
  });
  return {server,mail};
}

test('mail text is decoded from headers, quoted-printable, base64 and multipart',()=>{
  assert.equal(decodeWords('=?UTF-8?B?w45uY8SDcmNhcmU=?= ok'),'Încărcare ok');
  assert.equal(decodeWords('=?utf-8?Q?Caf=C3=A9_now?='),'Café now');
  assert.equal(bodyText({'content-type':'text/plain; charset=utf-8','content-transfer-encoding':'quoted-printable'},Buffer.from('Line one=\r\n continues =C8=98i gata')),'Line one continues Și gata');
  const multi=['--b1','Content-Type: text/html','','<p>Html <b>only</b></p>','--b1','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',Buffer.from('Plain wins').toString('base64'),'--b1--',''].join('\r\n');
  assert.equal(bodyText({'content-type':'multipart/alternative; boundary="b1"'},Buffer.from(multi)),'Plain wins');
  assert.equal(bodyText({'content-type':'text/html'},Buffer.from('<div>Hi<br>there &amp; you</div>')),'Hi\nthere & you');
});

test('the phone bot pairs, talks, runs workflows and takes approvals; email starts workflows',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-phone-test-'));
  const tg=fakeTelegram(),imap=fakeImap();
  await new Promise(r=>tg.server.listen(0,'127.0.0.1',r));await new Promise(r=>imap.server.listen(0,'127.0.0.1',r));
  const tgPort=tg.server.address().port,imapPort=imap.server.address().port;
  const port=14321,origin=`http://127.0.0.1:${port}`,toastLog=path.join(temp,'toasts.log');
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:'',SILO_TELEGRAM_API:`http://127.0.0.1:${tgPort}`,SILO_MAIL_INTERVAL:'700',SILO_TOAST_LOG:toastLog,SILO_SANDBOX_TIMEOUT:'20000'},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});tg.server.close();tg.server.closeAllConnections?.();imap.server.close();await fs.rm(temp,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  const sentTo=(chat,re)=>tg.sent.find(m=>String(m.chat.id)===String(chat)&&re.test(m.text));
  const ME=5551,STRANGER=6662;

  await t.test('checks the token with Telegram and keeps it',async()=>{
    assert.equal((await request('/phone',{token:'not a token'})).status,400);
    assert.equal((await request('/phone',{token:'123456:bad-token-aaaaaaaaaaaaaaaaaaaa'})).status,502);
    const r=await request('/phone',{token:'123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAA'});assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.botName,'silo_test_bot');
    const p=(await request('/phone')).data;assert.ok(p.hasToken);assert.equal(p.chats.length,0);assert.ok(!JSON.stringify(p).includes('AAAAAAAA'));
    await until(async()=>(await request('/phone')).data.running,4000,'bot running');
  });
  await t.test('obeys only paired chats, and the code works once',async()=>{
    tg.say(STRANGER,'/status');await until(()=>sentTo(STRANGER,/not paired/),4000,'not paired reply');
    assert.ok(!sentTo(STRANGER,/silo is running/i));
    tg.say(ME,'/pair 123456');await until(()=>sentTo(ME,/no pairing code waiting/),4000,'no code reply');
    const {code}=(await request('/phone/pair',{})).data;assert.match(code,/^\d{6}$/);
    tg.say(ME,'/pair '+(code==='000000'?'111111':'000000'));await until(()=>sentTo(ME,/code is wrong/),4000,'wrong code');
    tg.say(ME,'/pair '+code);await until(()=>sentTo(ME,/Paired with SILO 18\. Hello, Ana/),4000,'paired');
    tg.say(STRANGER,'/pair '+code);await until(()=>tg.sent.filter(m=>m.chat.id===STRANGER).length>=1);await wait(300);
    assert.equal((await request('/phone')).data.chats.length,1,'the code works once');
    tg.say(ME,'/status');await until(()=>sentTo(ME,/The silo is running\.[\s\S]*Spent today: \$0\.00/),4000,'status');
  });
  let resident;
  await t.test('talks to a resident and the answer comes back',async()=>{
    resident=(await request('/state')).data.agents[0];
    tg.say(ME,'Hello?');await until(()=>sentTo(ME,/Pick a resident first/),4000);
    tg.say(ME,'/talk '+resident.name.toLowerCase());await until(()=>sentTo(ME,/Now talking to/),4000,'talk');
    tg.say(ME,'How is the generator?');
    const m=await until(()=>sentTo(ME,new RegExp('^'+resident.name+':\\n')),8000,'resident answer');assert.ok(m.text.length>resident.name.length+5);
    const chats=(await request('/state')).data.agents.find(a=>a.id===resident.id).chats;assert.equal(chats.at(-2).content,'How is the generator?');
  });
  await t.test('starts a workflow, approves it with a button and sends the result',async()=>{
    const w=(await request('/workflows',{name:'Phone flow',steps:[{agentId:resident.id,prompt:'Plan {{brief}}'},{type:'approval',prompt:'Check the plan'},{agentId:resident.id,prompt:'Finish'}]})).data;
    tg.say(ME,'/flows');const list=await until(()=>sentTo(ME,/\d+\. Phone flow/),4000,'flows');
    tg.say(ME,'/run '+list.text.match(/(\d+)\. Phone flow/)[1]+' the water pumps');await until(()=>sentTo(ME,/Started Phone flow/),4000,'started');
    const ask=await until(()=>tg.sent.find(m=>m.chat.id===ME&&/Approval needed\nPhone flow waits at step 2/.test(m.text)&&m.buttons),8000,'approval message');
    const run=(await request('/state')).data.runs.find(r=>r.workflowId===w.id);assert.equal(run.input,'the water pumps');assert.equal(run.trigger,'phone');
    tg.tap(STRANGER,ask.buttons[0][0].callback_data,ask.message_id);await until(()=>tg.answers.some(a=>/not paired/.test(a.text)),4000);
    tg.tap(ME,ask.buttons[0][0].callback_data,ask.message_id);
    await until(()=>sentTo(ME,/Phone flow finished\./),8000,'result');
    assert.ok(tg.edits.some(e=>e.message_id===ask.message_id&&/Approved by phone \(Ana\)/.test(e.text)),'the button message shows the outcome');
    tg.tap(ME,ask.buttons[0][1].callback_data,ask.message_id);await until(()=>tg.answers.some(a=>/not waiting/.test(a.text)),4000,'second tap refused');
  });
  await t.test('allows or denies a tool request from the phone',async()=>{
    await request('/connections',{provider:'compatible',key:'fixture-key',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
    const coder=(await request('/agents',{name:'Phone Coder',role:'Fixture',floor:3,provider:'compatible',model:'tool-user',instructions:'Fixture.',tools:['run_code']})).data;
    const pending=request('/agents/'+coder.id+'/chat',{message:'CALL '+JSON.stringify({tool:'run_code',language:'javascript',code:'console.log(6*7)'})});
    const ask=await until(()=>tg.sent.find(m=>m.chat.id===ME&&/Phone Coder asks to/.test(m.text)&&m.buttons),8000,'request message');
    assert.deepEqual(ask.buttons[0].map(b=>b.text),['Allow once','Always','Deny']);
    tg.tap(ME,ask.buttons[0][2].callback_data,ask.message_id);
    const r=await pending;assert.equal(r.status,200);
    const req=(await request('/state')).data.requests.find(x=>x.agentName==='Phone Coder');assert.equal(req.status,'denied');assert.equal(req.by,'phone (Ana)');
    await until(()=>tg.edits.some(e=>e.message_id===ask.message_id&&/Denied by phone/.test(e.text)),4000,'edited');
  });
  await t.test('an unknown decision link changes nothing, and /pending sends the buttons again',async()=>{
    // Real decision links come from Windows notifications, which the test does not show on this screen.
    const coder=(await request('/state')).data.agents.find(a=>a.name==='Phone Coder');
    const pending=request('/agents/'+coder.id+'/chat',{message:'CALL '+JSON.stringify({tool:'run_code',language:'javascript',code:'console.log(1)'})});
    await until(()=>tg.sent.find(m=>/Phone Coder asks to/.test(m.text)&&m.buttons&&!tg.edits.some(e=>e.message_id===m.message_id)),8000);
    assert.equal((await fetch(origin+'/decide/'+'a'.repeat(36))).status,200);
    assert.match(await (await fetch(origin+'/decide/'+'a'.repeat(36))).text(),/used up or expired/);
    tg.say(ME,'/pending');await until(()=>tg.sent.filter(m=>/Phone Coder asks to/.test(m.text)).length>=3,4000,'pending resent');
    const again=tg.sent.filter(m=>/Phone Coder asks to/.test(m.text)).at(-1);tg.tap(ME,again.buttons[0][0].callback_data,again.message_id);
    assert.equal((await pending).status,200);
    const req=(await request('/state')).data.requests.find(x=>x.agentName==='Phone Coder'&&x.status==='allowed');assert.ok(req,'allowed once');
  });
  await t.test('pause and resume from the phone, and unpair',async()=>{
    tg.say(ME,'/pause');await until(()=>sentTo(ME,/^Paused\./),4000);assert.equal((await request('/state')).data.paused,true);
    tg.say(ME,'/resume');await until(()=>sentTo(ME,/^Resumed\./),4000);assert.equal((await request('/state')).data.paused,false);
  });
  await t.test('voice notes become text for the resident, never commands',async()=>{
    tg.voice(ME,'How is the generator?');await until(()=>sentTo(ME,/runs in the browser/),4000,'needs a server service');
    assert.equal((await request('/settings',{voice:{stt:'compatible',sttModel:'whisper-large-v3',language:'ro'}})).status,200);
    tg.voice(ME,'How are the pumps?');await until(()=>sentTo(ME,/^Heard: How are the pumps\? \(ro\)$/),6000,'heard');
    await until(async()=>(await request('/state')).data.agents.find(a=>a.id===resident.id).chats.some(m=>m.role==='user'&&m.content==='How are the pumps? (ro)'),8000,'the resident got it');
    tg.voice(ME,'/pause now');await until(()=>sentTo(ME,/^Heard: pause now/),6000,'heard pause');await wait(300);
    assert.equal((await request('/state')).data.paused,false,'a spoken command is only text');
    tg.voice(STRANGER,'/status');await wait(500);assert.ok(!tg.sent.some(m=>m.chat.id===STRANGER&&/Heard/.test(m.text)),'unpaired voice notes are not heard');
    await request('/settings',{voice:{stt:'auto',language:''}});
  });
  await t.test('an email that arrives starts the workflow, old mail and other senders do not',async()=>{
    const agentId=resident.id,base={host:'127.0.0.1',port:imapPort,user:'me@example.com',folder:'INBOX'};
    assert.equal((await request('/mail/test',{mail:{...base,pass:'wrong'}})).status,502);
    assert.equal((await request('/mail/test',{mail:{...base,pass:'right-pass'}})).status,200);
    assert.equal((await request('/workflows',{name:'Mail flow',steps:[{agentId,prompt:'Read it'}],mail:{...base}})).status,400,'needs a password');
    const w=(await request('/workflows',{name:'Mail flow',steps:[{agentId,prompt:'Read it'}],mail:{...base,pass:'right-pass',from:'boss@'}})).data;
    assert.equal(w.mail.from,'boss@');assert.ok(!JSON.stringify((await request('/state')).data).includes('right-pass'),'the password stays in the vault');
    await until(async()=>(await request('/state')).data.workflows.find(x=>x.id===w.id).mailSeen?.lastUid===3,5000,'inbox learned');
    imap.mail.push({uid:4,from:'Someone <x@example.com>',subject:'Not from the boss',body:'Ignore'});
    imap.mail.push({uid:5,from:'Boss <boss@example.com>',subject:'Pumps',body:'Check pump =C8=98ase today.'});
    const run=await until(async()=>(await request('/state')).data.runs.find(r=>r.workflowId===w.id),6000,'email run');
    assert.equal(run.trigger,'email');assert.match(run.input,/Subject: Pumps/);assert.match(run.input,/Check pump Șase today\./);assert.ok(!/Already here|Ignore/.test(run.input));
    await wait(1600);assert.equal((await request('/state')).data.runs.filter(r=>r.workflowId===w.id).length,1,'one run only');
    const keep=(await request('/workflows/'+w.id,{...w,mail:{...base,from:'boss@'}},'PUT'));assert.equal(keep.status,200,'saving again keeps the saved password');
    assert.equal((await request('/workflows/'+w.id,{...w,mail:null},'PUT')).status,200);
  });
  await t.test('Windows notifications carry one-time links that need a confirm',async()=>{
    assert.equal((await request('/settings',{desktop:{enabled:true,events:['request','failed','nonsense']}})).status,200);
    assert.deepEqual((await request('/state')).data.settings.desktop,{enabled:true,events:['request','failed']});
    assert.equal((await request('/desktop/test',{})).status,200);
    const w=(await request('/workflows',{name:'Desk flow',steps:[{agentId:resident.id,prompt:'Go'},{type:'approval',prompt:'Look first'}]})).data;
    const run=(await request('/workflows/'+w.id+'/run',{input:'x'})).data;
    const toast=await until(async()=>(await fs.readFile(toastLog,'utf8').catch(()=>'')).split('\n').filter(Boolean).map(l=>JSON.parse(l)).find(t=>/Desk flow waits at step 2/.test(t.title)),8000,'toast');
    assert.deepEqual(toast.buttons.map(b=>b.label),['Approve','Reject']);
    const approve=new URL(toast.buttons[0].url),reject=new URL(toast.buttons[1].url);assert.equal(approve.port,String(port));
    const page=await fetch(origin+approve.pathname);assert.match(await page.text(),/Desk flow waits for your approval[\s\S]*<form method="post"><button type="submit">Approve/);
    assert.equal((await request('/state')).data.runs.find(r=>r.id===run.id).waiting,true,'opening the link changes nothing');
    assert.match(await (await fetch(origin+approve.pathname,{method:'POST'})).text(),/Done: Approve\./);
    const done=await until(async()=>{const r=(await request('/state')).data.runs.find(r=>r.id===run.id);return r.status==='completed'&&r;},8000,'run done');
    assert.equal(done.steps[1].verdict,'approved');
    assert.match(await (await fetch(origin+reject.pathname,{method:'POST'})).text(),/used up or expired/,'the other button dies with the decision');
    assert.match(await (await fetch(origin+approve.pathname,{method:'POST'})).text(),/used up or expired/,'a link works once');
    await request('/settings',{desktop:{enabled:false,events:['failed']}});
  });
  await t.test('unpair and remove the bot',async()=>{
    tg.say(ME,'/unpair');await until(()=>sentTo(ME,/no longer paired/),4000);
    assert.equal((await request('/phone')).data.chats.length,0);
    assert.equal((await request('/phone',undefined,'DELETE')).status,200);assert.ok(!(await request('/phone')).data.hasToken);
  });
});
