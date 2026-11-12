// Messages that leave the silo: Telegram, Slack, Discord, a webhook of your own, or email over SMTP.
// No packages. Each send returns when the other side accepted the message, or throws with a readable reason.
import net from 'node:net';
import tls from 'node:tls';
import {createHmac} from 'node:crypto';

export const CHANNEL_KINDS={telegram:'Telegram',slack:'Slack',discord:'Discord',webhook:'Webhook',email:'Email'};
export const NOTIFY_EVENTS={failed:'A workflow failed',completed:'A workflow finished',request:'A resident asks for approval',proposal:'A resident proposed a file',limit:'Spending is near or over a limit',tests:'Workflow tests finished',update:'A SILO update is available, or was rolled back'};

const isLocal=host=>/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host);
// Addresses must use HTTPS. Plain HTTP is only allowed on this computer, for local tools and tests.
export function checkUrl(value){
  let u;try{u=new URL(String(value||'').trim());}catch{throw new Error('Give a full address, starting with https://.');}
  if(u.username||u.password)throw new Error('Put no user name or password in the address.');
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&isLocal(u.hostname)))throw new Error('The address has to use https://.');
  return u.href;
}
async function post(url,body,headers={},signal){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body,redirect:'error',signal:signal||AbortSignal.timeout(15000)});
  if(!r.ok){const t=(await r.text().catch(()=>'')).replace(/\s+/g,' ').slice(0,160);throw new Error(`${new URL(url).hostname} answered ${r.status}${t?': '+t:''}`);}
  return r;
}
const clip=(s,n)=>String(s||'').slice(0,n);

// channel: {kind,config}, secret: {token,url,secret,pass}, message: {event,title,detail,time}
export async function sendNotification(channel,secret={},message){
  const title=clip(message.title,200),detail=clip(message.detail,1500),text=detail?`${title}\n${detail}`:title,c=channel.config||{};
  if(channel.kind==='telegram'){
    if(!secret.token||!c.chatId)throw new Error('Telegram needs a bot token and a chat ID.');
    await post(`https://api.telegram.org/bot${encodeURIComponent(secret.token)}/sendMessage`,JSON.stringify({chat_id:c.chatId,text:'SILO 18 / '+text,disable_web_page_preview:true}));
    return;
  }
  if(channel.kind==='slack'){if(!secret.url)throw new Error('Slack needs a webhook address.');await post(secret.url,JSON.stringify({text:`*${title}*${detail?'\n'+detail:''}`}));return;}
  if(channel.kind==='discord'){if(!secret.url)throw new Error('Discord needs a webhook address.');await post(secret.url,JSON.stringify({content:clip(`**${title}**${detail?'\n'+detail:''}`,1900),allowed_mentions:{parse:[]}}));return;}
  if(channel.kind==='webhook'){
    if(!secret.url)throw new Error('The webhook needs an address.');
    const body=JSON.stringify({source:'silo-18',event:message.event,title,detail,time:message.time||Date.now()});
    // With a shared secret the receiver can check that the message really came from SILO.
    const headers=secret.secret?{'X-Silo-Signature':'sha256='+createHmac('sha256',secret.secret).update(body).digest('hex')}:{};
    await post(secret.url,body,headers);return;
  }
  if(channel.kind==='email'){await smtpSend({...c,pass:secret.pass},'SILO 18: '+title,text);return;}
  throw new Error('Unknown channel kind.');
}

// A small SMTP client: implicit TLS on port 465, STARTTLS elsewhere. Passwords never travel unencrypted,
// except to a mail server on this computer.
const noBreak=s=>String(s||'').replace(/[\r\n]+/g,' ').trim();
const header=s=>/^[\x20-\x7e]*$/.test(s)?s:`=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
const address=s=>{const m=String(s).match(/<([^<>\s]+@[^<>\s]+)>|^\s*([^<>\s]+@[^<>\s]+)\s*$/);if(!m)throw new Error(`Not an email address: ${noBreak(s).slice(0,80)}`);return m[1]||m[2];};
export function emailList(value){return String(value||'').split(/[,;]/).map(s=>s.trim()).filter(Boolean).map(address);}
class Wire{
  constructor(sock){this.buf='';this.queue=[];this.wait=null;this.attach(sock);}
  attach(sock){
    this.sock=sock;this.buf='';
    sock.on('data',d=>{this.buf+=d.toString('utf8');let m;while((m=this.buf.match(/^(?:\d{3}-[^\n]*\n)*\d{3}(?: [^\n]*)?\r?\n/))){this.buf=this.buf.slice(m[0].length);this.queue.push(m[0]);}this.wake();});
    const end=e=>{this.err||=e||new Error('The mail server closed the connection.');this.wake();};
    sock.on('error',end);sock.on('close',()=>end());
  }
  wake(){if(!this.wait)return;if(this.queue.length){const w=this.wait;this.wait=null;w.resolve(this.queue.shift());}else if(this.err){const w=this.wait;this.wait=null;w.reject(this.err);}}
  next(){return new Promise((resolve,reject)=>{this.wait={resolve,reject};this.wake();});}
  async say(line,ok){
    if(line!=null)this.sock.write(line+'\r\n');
    const r=await this.next(),code=Number(r.slice(0,3));
    if(!ok.includes(code))throw new Error(`The mail server answered: ${r.trim().split(/\r?\n/).pop().slice(0,200)}`);
    return r;
  }
}
export async function smtpSend(o,subject,text,{timeout=20000}={}){
  const host=noBreak(o.host),port=Number(o.port)||587,secure=port===465;
  if(!host)throw new Error('Give the mail server address.');
  const from=address(o.from),to=emailList(o.to);if(!to.length)throw new Error('Give at least one address to send to.');
  const connect=()=>new Promise((resolve,reject)=>{
    const s=secure?tls.connect({host,port,servername:host}):net.connect({host,port});
    s.once(secure?'secureConnect':'connect',()=>{s.off('error',reject);resolve(s);});s.once('error',reject);
  });
  let sock=await connect();const wire=new Wire(sock),timer=setTimeout(()=>{wire.err=new Error('The mail server took too long.');sock.destroy();wire.wake();},timeout);
  try{
    await wire.say(null,[220]);
    let hello=await wire.say('EHLO silo18.local',[250]);
    if(!secure){
      if(/^250[- ]STARTTLS/mi.test(hello)){
        await wire.say('STARTTLS',[220]);
        sock.removeAllListeners('data');sock.removeAllListeners('error');sock.removeAllListeners('close');
        sock=await new Promise((resolve,reject)=>{const t=tls.connect({socket:sock,servername:host},()=>resolve(t));t.once('error',reject);});
        wire.attach(sock);hello=await wire.say('EHLO silo18.local',[250]);
      }else if(o.user&&!isLocal(host))throw new Error('The mail server does not offer encryption, so the password was not sent.');
    }
    if(o.user){
      if(!o.pass)throw new Error('The mail password is missing.');
      await wire.say('AUTH PLAIN '+Buffer.from(`\0${o.user}\0${o.pass}`).toString('base64'),[235]);
    }
    await wire.say(`MAIL FROM:<${from}>`,[250]);
    for(const r of to)await wire.say(`RCPT TO:<${r}>`,[250,251]);
    await wire.say('DATA',[354]);
    const body=Buffer.from(text).toString('base64').replace(/.{1,76}/g,'$&\r\n');
    const msg=[`From: ${header(noBreak(o.from))}`,`To: ${to.join(', ')}`,`Subject: ${header(noBreak(subject))}`,`Date: ${new Date().toUTCString()}`,`Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@silo18.local>`,'MIME-Version: 1.0','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: base64','',body].join('\r\n');
    await wire.say(msg+'\r\n.',[250]);
    await wire.say('QUIT',[221]).catch(()=>{});
  }finally{clearTimeout(timer);sock.destroy();}
}
