// Talks to the Telegram Bot API by long polling, so SILO needs no public address: it asks Telegram for new
// messages and Telegram answers when one arrives. No packages. Only transport lives here; what a message means
// is decided by the server.
const API=process.env.SILO_TELEGRAM_API||'https://api.telegram.org';
const clip=(s,n)=>String(s??'').slice(0,n);

export class TelegramBot{
  constructor(token,{onUpdate,onError}={}){this.token=token;this.onUpdate=onUpdate;this.onError=onError;this.offset=0;this.running=false;this.ctrl=null;this.me=null;this.failures=0;}
  async call(method,body={},timeoutMs=15000,signal){
    const r=await fetch(`${API}/bot${encodeURIComponent(this.token)}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
    let j;try{j=await r.json();}catch{throw new Error(`Telegram answered ${r.status}.`);}
    if(!j.ok){
      const e=new Error(r.status===401||r.status===404?'Telegram refused the bot token.':`Telegram: ${clip(j.description||r.status,160)}`);
      e.status=r.status;e.retryAfter=j.parameters?.retry_after;throw e;
    }
    return j.result;
  }
  async check(){this.me=await this.call('getMe');return this.me;}
  start(){
    if(this.running)return;this.running=true;this.ctrl=new AbortController();
    (async()=>{
      // Old messages waiting from before SILO started are skipped, so nothing stale is acted on.
      try{const old=await this.call('getUpdates',{offset:-1,timeout:0},15000,this.ctrl.signal);if(old.length)this.offset=old.at(-1).update_id+1;}catch{}
      while(this.running){
        try{
          const updates=await this.call('getUpdates',{offset:this.offset,timeout:25,allowed_updates:['message','callback_query']},35000,this.ctrl.signal);
          this.failures=0;
          for(const u of updates){this.offset=Math.max(this.offset,u.update_id+1);try{await this.onUpdate?.(u);}catch(e){this.onError?.(e);}}
        }catch(e){
          if(!this.running)break;
          this.failures++;this.onError?.(e);
          if(e.status===401||e.status===404){this.running=false;break;}
          const wait=e.retryAfter?e.retryAfter*1000:Math.min(60000,1000*2**Math.min(this.failures,6));
          await new Promise(r=>{const t=setTimeout(r,wait);this.ctrl?.signal.addEventListener('abort',()=>{clearTimeout(t);r();},{once:true});});
        }
      }
    })();
  }
  stop(){this.running=false;this.ctrl?.abort();this.ctrl=null;}
  // Long answers are split at line breaks into pieces Telegram accepts.
  async send(chatId,text,buttons){
    const parts=split(String(text||'').trim()||'(empty)');let last;
    for(let i=0;i<parts.length;i++)last=await this.call('sendMessage',{chat_id:chatId,text:parts[i],disable_web_page_preview:true,...(buttons&&i===parts.length-1&&{reply_markup:{inline_keyboard:buttons}})});
    return last;
  }
  edit(chatId,messageId,text){return this.call('editMessageText',{chat_id:chatId,message_id:messageId,text:clip(text,4000),disable_web_page_preview:true}).catch(()=>{});}
  answer(callbackId,text=''){return this.call('answerCallbackQuery',{callback_query_id:callbackId,text:clip(text,190)}).catch(()=>{});}
  // A file someone sent, such as a voice note. Telegram keeps files for bots up to 20 MB.
  async download(fileId,max=20e6){
    const f=await this.call('getFile',{file_id:fileId});
    if(!f?.file_path)throw new Error('Telegram did not give the file.');
    if((f.file_size||0)>max)throw new Error('That file is too large.');
    const r=await fetch(`${API}/file/bot${encodeURIComponent(this.token)}/${String(f.file_path).split('/').map(encodeURIComponent).join('/')}`,{redirect:'error',signal:AbortSignal.timeout(60000)});
    if(!r.ok)throw new Error(`Telegram answered ${r.status} for the file.`);
    const data=Buffer.from(await r.arrayBuffer());if(data.length>max)throw new Error('That file is too large.');
    return {data,mime:r.headers.get('content-type')||''};
  }
  typing(chatId){return this.call('sendChatAction',{chat_id:chatId,action:'typing'}).catch(()=>{});}
}
function split(text,max=3900){
  const out=[];
  while(text.length>max){let cut=text.lastIndexOf('\n',max);if(cut<max/2)cut=max;out.push(text.slice(0,cut));text=text.slice(cut).replace(/^\n/,'');}
  out.push(text);return out.slice(0,8);
}
