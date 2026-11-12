import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {speakable,sttProvider,ttsProvider,audioExt,audioUrl} from '../voice.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('voice choices, sound formats and what is read out',()=>{
  const has=p=>p==='openai';
  assert.equal(sttProvider({stt:'auto'},has),'openai');assert.equal(sttProvider({stt:'auto'},()=>false),'browser');
  assert.equal(sttProvider({stt:'compatible'},has),'missing');assert.equal(ttsProvider({tts:'openai'},()=>false),'missing');assert.equal(ttsProvider({tts:'browser'},has),'browser');
  assert.equal(audioExt('audio/webm;codecs=opus'),'webm');assert.equal(audioExt('audio/ogg'),'ogg');assert.equal(audioExt('text/html'),null);
  assert.equal(audioUrl('compatible',{endpoint:'https://x.example/v1/chat/completions'},'speech'),'https://x.example/v1/audio/speech');
  assert.throws(()=>audioUrl('compatible',{endpoint:'http://x.example/v1/chat/completions'},'speech'),/https/);
  const said=speakable('## Plan\n- **First** step, see [the docs](https://x.example/a)\n```js\nconsole.log(1)\n```\nDone at https://x.example/b.');
  assert.equal(said,'Plan\nFirst step, see the docs\n (code left out) \nDone at a link');
  assert.ok(speakable('One. '.repeat(2000),100).length<=100);
});

test('the microphone and spoken answers go through SILO only when you pick a service',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-voice-test-'));
  const port=14339,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const headers={cookie,origin,'x-silo-token':token};
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  const record=(said,mime='audio/webm;codecs=opus')=>fetch(origin+'/api/voice/transcribe?mime='+encodeURIComponent(mime),{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:Buffer.from('FAKEAUDIO:'+said)});

  await t.test('without a key, both stay in the browser',async()=>{
    const st=(await request('/state')).data;assert.deepEqual(st.voiceUse,{stt:'browser',tts:'browser'});assert.equal(st.settings.voice.autoSpeak,false);
    const r=await record('hello');assert.equal(r.status,409);assert.match((await r.json()).error,/runs in the browser/);
    assert.equal((await request('/voice/speak',{text:'hi'})).status,409);
  });
  await t.test('bad settings are refused',async()=>{
    assert.equal((await request('/settings',{voice:{stt:'telepathy'}})).status,400);
    assert.equal((await request('/settings',{voice:{language:'Romanian please'}})).status,400);
    assert.equal((await request('/settings',{voice:{tts:'openai'}})).status,200);
    assert.equal((await request('/state')).data.voiceUse.tts,'missing','OpenAI is picked but not connected');
  });
  await t.test('with OpenAI, a recording becomes text and an answer becomes sound, and both count in spending',async()=>{
    await request('/connections',{provider:'openai',key:'sk-fixture-voice-123456789012345',model:'gpt-x'});
    assert.equal((await request('/settings',{voice:{stt:'auto',language:'ro',autoSpeak:true}})).status,200);
    assert.deepEqual((await request('/state')).data.voiceUse,{stt:'openai',tts:'openai'});
    const r=await record('Check pump three');assert.equal(r.status,200);assert.deepEqual(await r.json(),{text:'Check pump three (ro)'});
    assert.equal((await record('x','text/html')).status,415,'only sound formats');
    const raw=await fetch(origin+'/api/voice/transcribe?mime=audio/webm',{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:'x'});assert.equal(raw.status,415);
    assert.equal((await fetch(origin+'/api/file',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:'x'})).status,415,'raw bodies stay limited to their routes');
    const sp=await fetch(origin+'/api/voice/speak',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({text:'**Done.** See https://x.example/a'})});
    assert.equal(sp.status,200);assert.equal(sp.headers.get('content-type'),'audio/mpeg');assert.equal(Buffer.from(await sp.arrayBuffer()).toString(),'ID3fake:alloy:Done. See a link');
    assert.equal((await request('/voice/speak',{text:'```\ncode only\n```'})).status,200,'code is replaced, not refused');
    assert.equal((await request('/voice/speak',{text:'   '})).status,400);
    const st=(await request('/state')).data,day=Object.values(st.usage.days).at(-1);
    assert.ok(day.openai.models['gpt-4o-mini-transcribe'].calls>=1);assert.ok(day.openai.models['gpt-4o-mini-tts'].calls>=1);
    assert.equal(st.settings.voice.autoSpeak,true);assert.ok(!JSON.stringify(st).includes('sk-fixture-voice'),'the key stays in the vault');
  });
  await t.test('turned off, nothing is sent',async()=>{
    assert.equal((await request('/settings',{voice:{stt:'off',tts:'off'}})).status,200);
    assert.deepEqual((await request('/state')).data.voiceUse,{stt:'off',tts:'off'});
    assert.equal((await record('hello')).status,409);
  });
  assert.ok(!errors.includes('TypeError'),errors);
});
