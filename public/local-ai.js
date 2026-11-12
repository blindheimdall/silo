// AI that runs inside the browser, on this computer: translation, language detection and summaries through the
// Translator, LanguageDetector and Summarizer APIs (Chrome 138 and newer). Nothing leaves the computer, it costs
// nothing and needs no key. Where the browser does not have them, or does not answer, the buttons stay hidden.

export const AI_LANGS=[['ro','Romanian'],['en','English'],['de','German'],['fr','French'],['es','Spanish'],['it','Italian'],['pt','Portuguese'],['nl','Dutch'],['pl','Polish'],['hu','Hungarian'],['cs','Czech'],['uk','Ukrainian'],['ru','Russian'],['tr','Turkish'],['sv','Swedish'],['ja','Japanese'],['ko','Korean'],['zh','Chinese'],['hi','Hindi'],['ar','Arabic']];
export const langName=code=>AI_LANGS.find(([c])=>c===code)?.[1]||code;
// Languages the built-in summarizer writes in. Other languages get an English summary that is then translated.
const SUMMARY_LANGS=['en','es','ja'];
const NOT_READY=new Set(['unavailable','no answer','missing']);

// Splits text at paragraph, then line, then sentence ends into pieces of at most max characters, keeping every
// separator, so joining the pieces gives the text back exactly.
export function splitText(text,max=1500){
  const out=[];let rest=String(text||'');
  while(rest.length>max){
    const window=rest.slice(0,max);
    // cut is the last character that stays in this piece.
    let cut=window.lastIndexOf('\n\n');if(cut>=0)cut++;
    if(cut<max*.3)cut=window.lastIndexOf('\n');
    if(cut<max*.3){const m=[...window.matchAll(/[.!?]\s/g)].at(-1);cut=m?m.index+1:-1;}
    if(cut<max*.3)cut=window.lastIndexOf(' ');
    if(cut<max*.3)cut=max-1;
    out.push(rest.slice(0,cut+1));rest=rest.slice(cut+1);
  }
  if(rest)out.push(rest);
  return out;
}

// Splits text into prose and fenced code blocks (``` or ~~~). Joining the parts gives the text back exactly.
// A block that is never closed runs to the end, the way Markdown shows it.
export function codeParts(text){
  const out=[];let cur='',fence=null;
  const push=code=>{if(cur)out.push({code,text:cur});cur='';};
  for(const line of String(text||'').split(/(?<=\n)/)){
    const m=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(!fence&&m){push(false);fence=m[1];cur=line;continue;}
    cur+=line;
    if(fence&&m&&m[1][0]===fence[0]&&m[1].length>=fence.length&&!line.trim().slice(m[1].length).trim()){push(true);fence=null;}
  }
  push(!!fence);
  return out;
}

export function makeLocalAI(g=globalThis,{wait=4000,createWait=30000}={}){
  const status={},translators=new Map(),summarizers=new Map();let detector=null;
  const has=name=>typeof g[name]?.create==='function';
  const within=(promise,ms,what)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Object.assign(new Error(`The browser did not answer about ${what}.`),{noAnswer:true})),ms);
    promise.then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
  });
  async function availability(name,options,key=name){
    const kind=key.split(':')[0];
    // A browser that did not answer once is not asked again: the next try would hang just as long.
    if(status[kind]==='no answer')return status[key]='no answer';
    if(!has(name))return status[key]=status[kind]='missing';
    try{status[key]=await within(Promise.resolve(g[name].availability(options)),wait,name);}
    catch(e){status[key]=e.noAnswer?'no answer':'unavailable';}
    if(status[key]==='no answer')status[kind]='no answer';
    return status[key];
  }
  // Makes a model. A model that still has to be downloaded shows its progress; that needs a click to start.
  // download false: a model that is not on the computer yet is not fetched (used for the large summary model,
  // which is only downloaded from the button in System).
  async function create(name,options,onProgress,key,download=true){
    const state=await availability(name,name==='Translator'?{sourceLanguage:options.sourceLanguage,targetLanguage:options.targetLanguage}:name==='Summarizer'?{type:options.type,format:options.format,length:options.length,outputLanguage:options.outputLanguage}:undefined,key);
    if(NOT_READY.has(state))throw Object.assign(new Error(name==='Translator'?`This browser cannot translate from ${langName(options.sourceLanguage)} to ${langName(options.targetLanguage)} on this computer.`:name==='Summarizer'?'This browser cannot make summaries on this computer.':'This browser cannot tell languages apart on this computer.'),{state});
    if(!download&&(state==='downloadable'||state==='downloading'))throw Object.assign(new Error(state==='downloading'?'The summary model is still downloading. Try again in a while.':'The summary model is not on this computer yet. Download it in System, AI on this computer.'),{state});
    const monitor=m=>m.addEventListener?.('downloadprogress',e=>onProgress?.(e.loaded));
    const made=g[name].create({...options,monitor});
    const model=state==='available'?await within(made,createWait,name):await made;
    status[key]='available';return model;
  }
  async function detect(text,{signal}={}){
    if(!has('LanguageDetector'))return null;
    detector||=await create('LanguageDetector',{},null,'detect');
    const found=(await detector.detect(String(text).slice(0,2000),{signal}))?.[0];
    return found&&found.detectedLanguage!=='und'&&found.confidence>=.5?found.detectedLanguage.split('-')[0]:null;
  }
  async function translator(from,to,onProgress){
    const key=from+'>'+to;
    if(!translators.has(key))translators.set(key,create('Translator',{sourceLanguage:from,targetLanguage:to},onProgress,'translate:'+key).catch(e=>{translators.delete(key);throw e;}));
    return translators.get(key);
  }
  // Translates piece by piece, so long answers fit and the first lines show at once.
  // Inline code such as `npm test` is swapped for a marker while the sentence is translated. When the translator
  // loses or repeats a marker, the piece is translated again as it was.
  async function translatePiece(core,steps,signal){
    const codes=[],masked=core.replace(/`[^`\n]+`/g,m=>{codes.push(m);return `⟦${codes.length-1}⟧`;});
    let out=masked;for(const t of steps)if(out)out=await t.translate(out,{signal});
    if(!codes.length)return out;
    if(codes.every((_,i)=>out.split(`⟦${i}⟧`).length===2))return out.replace(/⟦(\d+)⟧/g,(_,i)=>codes[Number(i)]);
    let plain=core;for(const t of steps)if(plain)plain=await t.translate(plain,{signal});return plain;
  }
  // Code blocks are never translated: names, commands and paths must stay exactly as they were.
  async function translate(text,{to,from,onChunk,onProgress,signal}={}){
    const parts=codeParts(text),prose=parts.filter(p=>!p.code).map(p=>p.text.replace(/`[^`\n]+`/g,' ')).join('\n');
    if(!prose.trim())return {text,from:from||null,to,same:true};
    from||=await detect(prose,{signal}).catch(()=>null)||'en';
    if(from===to)return {text,from,to,same:true};
    let steps;
    try{steps=[await translator(from,to,onProgress)];}
    catch(e){
      // No direct pair: go through English.
      if(from==='en'||to==='en')throw e;
      steps=[await translator(from,'en',onProgress),await translator('en',to,onProgress)];
    }
    let done='';
    for(const part of parts){
      if(part.code){done+=part.text;onChunk?.(done);continue;}
      for(const piece of splitText(part.text)){
        if(signal?.aborted)throw new DOMException('Stopped.','AbortError');
        const lead=piece.match(/^\s*/)[0],core=piece.trim(),tail=core?piece.match(/\s*$/)[0]:'';
        done+=lead+(core?await translatePiece(core,steps,signal):'')+tail;onChunk?.(done);
      }
    }
    return {text:done,from,to};
  }
  async function summarizer(lang,onProgress,download=false){
    const key=lang;
    if(!summarizers.has(key))summarizers.set(key,create('Summarizer',{type:'key-points',format:'plain-text',length:'medium',outputLanguage:lang,sharedContext:'Work done by an AI agent in SILO, a workspace where AI residents do tasks for one person or a small team.'},onProgress,'summarize',download).catch(e=>{summarizers.delete(key);throw e;}));
    return summarizers.get(key);
  }
  async function fits(s,text){
    if(typeof s.measureInputUsage!=='function'||!Number.isFinite(s.inputQuota))return text.length<=12000;
    try{return await s.measureInputUsage(text)<=s.inputQuota;}catch{return text.length<=12000;}
  }
  // Key points of a text. Text longer than the model takes is summed up in parts, then the parts together.
  async function summarize(text,{to='en',context='',onProgress,signal}={}){
    const lang=SUMMARY_LANGS.includes(to)?to:'en',s=await summarizer(lang,onProgress);
    let summary;
    if(await fits(s,text))summary=await s.summarize(text,{context,signal});
    else{
      const parts=[];for(const piece of splitText(text,8000)){if(signal?.aborted)throw new DOMException('Stopped.','AbortError');parts.push(await s.summarize(piece,{context,signal}));}
      const joined=parts.join('\n');
      summary=await fits(s,joined)?await s.summarize(joined,{context:(context+' These are key points of consecutive parts of one longer text.').trim(),signal}):joined;
    }
    summary=String(summary||'').trim();
    if(lang!==to&&has('Translator')){
      try{return {text:(await translate(summary,{from:lang,to,onProgress,signal})).text,lang:to};}catch(e){if(e.name==='AbortError')throw e;}
    }
    return {text:summary,lang};
  }
  // What this browser can do now. Each check gives up after a few seconds, some browsers never answer.
  async function check(to){
    const [t,d,s]=await Promise.all([
      availability('Translator',{sourceLanguage:'en',targetLanguage:to==='en'?'es':to},'translate'),
      availability('LanguageDetector',undefined,'detect'),
      availability('Summarizer',{type:'key-points',format:'plain-text',length:'medium',outputLanguage:SUMMARY_LANGS.includes(to)?to:'en'},'summarize')]);
    return {translate:t,detect:d,summarize:s};
  }
  // Downloads what is missing. Must run from a click.
  async function prepare(to,onProgress){
    const got={};
    for(const [kind,run] of [['detect',()=>detect('Hello')],['translate',()=>translator('en',to==='en'?'es':to,p=>onProgress?.('translate',p))],['summarize',()=>summarizer(SUMMARY_LANGS.includes(to)?to:'en',p=>onProgress?.('summarize',p),true)]]){
      try{await run();got[kind]='available';}catch(e){got[kind]=e.state||status[kind]||'unavailable';}
    }
    return got;
  }
  // Whether a button for this is worth showing: the browser has it and has not said no.
  const can=kind=>has({translate:'Translator',summarize:'Summarizer',detect:'LanguageDetector'}[kind])&&!NOT_READY.has(status[kind]);
  return {can,check,prepare,detect,translate,summarize,status};
}

export const localAI=makeLocalAI();
