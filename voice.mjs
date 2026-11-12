// Voice: speech to text and text to speech through OpenAI or an endpoint in the same format.
// The browser can also do both on its own (see public/app.js); this file is only the server side.
export const STT_CHOICES=['auto','off','browser','openai','compatible'];
export const TTS_CHOICES=['off','browser','openai','compatible'];
export const DEFAULT_VOICE={stt:'auto',sttModel:'',language:'',tts:'browser',ttsModel:'',ttsVoice:'',autoSpeak:false};
const AUDIO_EXT={'audio/webm':'webm','audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp3':'mp3','audio/mp4':'m4a','audio/m4a':'m4a','audio/x-m4a':'m4a','audio/wav':'wav','audio/x-wav':'wav','audio/wave':'wav','audio/flac':'flac','video/webm':'webm','video/mp4':'mp4'};

export function audioExt(mime){return AUDIO_EXT[String(mime||'').split(';')[0].trim().toLowerCase()]||null;}

// Which service turns speech into text on the server. 'auto' takes OpenAI when its key is there.
export function sttProvider(settings,has){
  const s=settings?.stt||'auto';
  if(s==='auto')return has('openai')?'openai':'browser';
  if((s==='openai'||s==='compatible')&&!has(s))return 'missing';
  return s;
}
export function ttsProvider(settings,has){
  const s=settings?.tts||'browser';
  if((s==='openai'||s==='compatible')&&!has(s))return 'missing';
  return s;
}
// The address for a kind of audio call: transcriptions or speech.
export function audioUrl(provider,config,kind){
  if(provider==='openai')return `https://api.openai.com/v1/audio/${kind}`;
  const end=String(config?.endpoint||'');
  if(!/^https:\/\//.test(end))throw Object.assign(new Error('The compatible endpoint needs an https address.'),{status:400});
  return end.replace(/\/chat\/completions\/?$/,'').replace(/\/+$/,'')+`/audio/${kind}`;
}
export const defaultModel=(provider,kind)=>provider==='openai'?(kind==='transcriptions'?'gpt-4o-mini-transcribe':'gpt-4o-mini-tts'):'';

async function failText(r,what){
  let msg='';try{const j=await r.json();msg=j?.error?.message||j?.error||'';}catch{}
  return `${what} answered ${r.status}${msg?': '+String(msg).slice(0,200):''}.`;
}
export async function transcribe({url,key,model,audio,mime,language,prompt,signal}){
  const ext=audioExt(mime);if(!ext)throw Object.assign(new Error('That sound format is not supported. Use webm, ogg, mp3, m4a, wav or flac.'),{status:415});
  if(!audio?.length)throw Object.assign(new Error('The recording is empty.'),{status:400});
  const form=new FormData();
  form.append('file',new Blob([audio],{type:String(mime).split(';')[0]}),'speech.'+ext);
  form.append('model',model);form.append('response_format','json');
  if(language)form.append('language',language);
  if(prompt)form.append('prompt',String(prompt).slice(0,800));
  const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+key},body:form,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
  if(!r.ok)throw Object.assign(new Error(await failText(r,'Speech to text')),{status:502});
  const j=await r.json();
  return {text:String(j.text||'').trim(),usage:j.usage||null};
}
export async function synthesize({url,key,model,voice,text,format='mp3',signal}){
  const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model,voice:voice||'alloy',input:text,response_format:format}),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000)});
  if(!r.ok)throw Object.assign(new Error(await failText(r,'Text to speech')),{status:502});
  const buf=Buffer.from(await r.arrayBuffer());
  if(buf.length>20e6)throw Object.assign(new Error('The spoken answer is too large.'),{status:502});
  return {audio:buf,mime:r.headers.get('content-type')||'audio/mpeg'};
}
// What is worth saying out loud: no code blocks, links or markdown marks.
export function speakable(text,max=4000){
  let t=String(text||'')
    .replace(/```[\s\S]*?```/g,' (code left out) ')
    .replace(/`([^`]+)`/g,'$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g,'')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g,'$1')
    .replace(/https?:\/\/\S+/g,'a link')
    .replace(/^#{1,6}\s+/gm,'')
    .replace(/^\s*[-*+]\s+/gm,'')
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g,'$1')
    .replace(/^\s*\|.*\|\s*$/gm,'')
    .replace(/\n{3,}/g,'\n\n').trim();
  if(t.length>max){const cut=t.lastIndexOf('. ',max);t=t.slice(0,cut>max/2?cut+1:max).trim();}
  return t;
}
