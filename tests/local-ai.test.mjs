// AI on this computer (the browser's Translator, LanguageDetector and Summarizer), against stand-ins.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeLocalAI,splitText,codeParts} from '../public/local-ai.js';

// A browser with the three APIs. Pairs and answers are made up so the result shows every step taken.
function fakeBrowser({pairs=['en>ro','ro>en','de>en','en>de'],hang=false,quota=400,state='available'}={}){
  const calls={translate:[],summarize:[],created:[],progress:0};
  const never=new Promise(()=>{});
  const g={
    Translator:{
      availability:({sourceLanguage:a,targetLanguage:b})=>hang?never:Promise.resolve(pairs.includes(a+'>'+b)?state:'unavailable'),
      create:async({sourceLanguage:a,targetLanguage:b,monitor})=>{
        calls.created.push('t:'+a+'>'+b);
        if(state!=='available'){const m=new EventTarget();monitor?.(m);const e=new Event('downloadprogress');e.loaded=.5;m.dispatchEvent(e);calls.progress++;}
        return {translate:async(text,{signal}={})=>{if(signal?.aborted)throw new DOMException('Stopped.','AbortError');calls.translate.push(a+'>'+b);return `[${b}]${text}`;}};
      }},
    LanguageDetector:{
      availability:()=>hang?never:Promise.resolve('available'),
      create:async()=>({detect:async text=>[{detectedLanguage:/\bund\b|\bder\b/.test(text)?'de':/ și /.test(text)?'ro':'en',confidence:.9}]})},
    Summarizer:{
      availability:()=>hang?never:Promise.resolve('available'),
      create:async({outputLanguage})=>{calls.created.push('s:'+outputLanguage);return {inputQuota:quota,measureInputUsage:async t=>t.length,summarize:async t=>{calls.summarize.push(t.length);return `* ${t.length} chars`;}};}}
  };
  return {g,calls};
}

test('text is cut at paragraphs and sentences, and comes back whole',()=>{
  const para='First sentence here. Second one follows! A third? '.repeat(20);
  for(const text of ['',`short`,para,para+'\n\n'+para+'\n'+para,'x'.repeat(5000),'word '.repeat(900)]){
    const parts=splitText(text,300);
    assert.equal(parts.join(''),text);
    assert.ok(parts.every(p=>p.length<=300),'every piece fits');
  }
  const parts=splitText('a. '.repeat(40)+'\n\n'+'b'.repeat(150),200);
  assert.ok(parts[0].endsWith('a. \n\n'),'a paragraph end is the first choice');assert.equal(parts[1],'b'.repeat(150));
});

test('translates piece by piece, finds the language, and goes through English when there is no direct pair',async()=>{
  const {g,calls}=fakeBrowser(),ai=makeLocalAI(g,{wait:200});
  assert.equal(ai.can('translate'),true);
  const seen=[];
  const long='Hello there. '.repeat(200)+'\n\nThe end.';
  const r=await ai.translate(long,{to:'ro',onChunk:t=>seen.push(t)});
  assert.equal(r.from,'en');assert.ok(seen.length>1,'the first lines show before the rest');assert.equal(seen.at(-1),r.text);
  assert.ok(r.text.startsWith('[ro]Hello there.'));assert.ok(r.text.endsWith('\n\nThe end.'),'line breaks stay where they were');
  assert.equal(r.text.split('[ro]').length-1,seen.length,'one call per piece');
  const same=await ai.translate('Sunt aici și lucrez.',{to:'ro'});assert.equal(same.same,true,'nothing to do in the same language');
  calls.translate.length=0;
  const via=await ai.translate('Das ist der Plan und so.',{to:'ro'});
  assert.equal(via.text,'[ro][en]Das ist der Plan und so.');assert.deepEqual(calls.translate,['de>en','en>ro']);
  // A translator is made once per pair.
  await ai.translate('Hello again.',{to:'ro'});assert.equal(calls.created.filter(x=>x==='t:en>ro').length,1);
  // Stopping.
  const stop=new AbortController();stop.abort();
  await assert.rejects(ai.translate('Hello.',{to:'ro',signal:stop.signal}),{name:'AbortError'});
  await assert.rejects(ai.translate('Hello.',{from:'en',to:'ja'}),/cannot translate from English to Japanese/);
});

test('code is never translated: blocks stay as they are, inline code keeps its place',async()=>{
  const text='Run this first:\n\n```bash\nnpm test --the-flag\n```\nThen open `the config` and look.\n~~~\nnot closed, the end';
  const parts=codeParts(text);
  assert.equal(parts.map(p=>p.text).join(''),text);
  assert.deepEqual(parts.map(p=>p.code),[false,true,false,true]);
  assert.equal(parts[1].text,'```bash\nnpm test --the-flag\n```\n');
  assert.deepEqual(codeParts('````\na ```\n````\nb').map(p=>p.code),[true,false],'a longer fence is closed only by one as long');
  // The stand-in translates every "the", so anything left alone is easy to see.
  const g={
    Translator:{availability:async()=>'available',create:async()=>({translate:async t=>t.replace(/\bthe\b/g,'ze')})},
    LanguageDetector:{availability:async()=>'available',create:async()=>({detect:async()=>[{detectedLanguage:'en',confidence:.9}]})}};
  const r=await makeLocalAI(g).translate(text,{to:'ro'});
  assert.match(r.text,/npm test --the-flag/,'the code block is untouched');
  assert.match(r.text,/open `the config` and look/,'inline code is untouched');
  assert.match(r.text,/not closed, the end$/,'an open block runs to the end');
  assert.match(r.text,/^Run this first/);
  // A translator that eats the markers: the sentence is translated again without them.
  const eats={...g,Translator:{availability:async()=>'available',create:async()=>({translate:async t=>t.replace(/⟦\d+⟧/g,'').replace(/\bthe\b/g,'ze')})}};
  const r2=await makeLocalAI(eats).translate('Open `the config` now.',{to:'ro'});
  assert.equal(r2.text,'Open `ze config` now.','nothing is lost, even if the code is then changed');
  assert.equal((await makeLocalAI(g).translate('```\nonly code\n```',{to:'ro'})).same,true,'only code: nothing to translate');
});

test('key points of long text are made in parts, and in another language through translation',async()=>{
  const {g,calls}=fakeBrowser({quota:400}),ai=makeLocalAI(g,{wait:200});
  const short=await ai.summarize('A short report. '.repeat(10),{to:'en'});
  assert.equal(short.text,'* 160 chars');assert.equal(short.lang,'en');
  calls.summarize.length=0;
  const long=await ai.summarize('Line of work done today. '.repeat(1000),{to:'en'});
  assert.ok(calls.summarize.length>=4,'summed up in parts, then together');
  assert.ok(calls.summarize.slice(0,-1).every(n=>n<=8000));assert.ok(long.text.startsWith('* '));
  const ro=await ai.summarize('A short report. '.repeat(10),{to:'ro'});
  assert.equal(ro.lang,'ro');assert.equal(ro.text,'[ro]* 160 chars');assert.ok(calls.created.includes('s:en'),'Romanian key points start in English');
  const es=await ai.summarize('A short report. '.repeat(10),{to:'es'});assert.equal(es.lang,'es');assert.ok(calls.created.includes('s:es'));
});

test('a browser that never answers is given up on quickly, and the buttons go away',async()=>{
  const {g}=fakeBrowser({hang:true}),ai=makeLocalAI(g,{wait:60});
  const t0=Date.now();
  assert.deepEqual(await ai.check('ro'),{translate:'no answer',detect:'no answer',summarize:'no answer'});
  assert.ok(Date.now()-t0<1000);
  assert.equal(ai.can('translate'),false);assert.equal(ai.can('summarize'),false);
  const t1=Date.now();await assert.rejects(ai.summarize('x'.repeat(700),{to:'en'}),/cannot make summaries/);assert.ok(Date.now()-t1<50,'not asked again');
  const none=makeLocalAI({});
  assert.equal(none.can('translate'),false);
  assert.deepEqual(await none.check('ro'),{translate:'missing',detect:'missing',summarize:'missing'});
  assert.equal((await none.translate('Hello.',{to:'ro'}).catch(e=>e)).message.includes('cannot translate'),true);
});

test('a model that still has to be downloaded reports its progress',async()=>{
  const {g,calls}=fakeBrowser({state:'downloadable'}),ai=makeLocalAI(g,{wait:200});
  assert.equal((await ai.check('ro')).translate,'downloadable');
  // The large summary model is never fetched by a click on Key points, only from the button in System.
  const summaryState={...g,Summarizer:{...g.Summarizer,availability:async()=>'downloadable'}},lazy=makeLocalAI(summaryState,{wait:200});
  await assert.rejects(lazy.summarize('x'.repeat(700),{to:'en'}),/not on this computer yet\. Download it in System/);
  assert.ok(!calls.created.some(x=>x.startsWith('s:')),'no download started');
  assert.equal((await lazy.prepare('en',()=>{})).summarize,'available','the button in System does download it');
  const seen=[];const got=await ai.prepare('ro',(kind,p)=>seen.push([kind,p]));
  assert.equal(got.translate,'available');assert.equal(got.summarize,'available');
  assert.ok(calls.progress>=1);assert.ok(seen.some(([k,p])=>k==='translate'&&p===.5));
});
