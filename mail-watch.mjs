// Reads new mail from an IMAP inbox so a workflow can start when an email arrives. No packages.
// It only reads: messages are fetched with PEEK, so they stay unread in your mail program.
// The connection always uses TLS (port 993), except to a mail server on this computer, for local tools and tests.
import net from 'node:net';
import tls from 'node:tls';

const isLocal=host=>/^(localhost|127\.0\.0\.1|::1)$/i.test(host);
const quote=s=>'"'+String(s).replace(/[\\"]/g,m=>'\\'+m)+'"';

class Wire{
  constructor(sock){this.sock=sock;this.buf=Buffer.alloc(0);this.items=[];this.wait=null;this.err=null;
    sock.on('data',d=>{this.buf=Buffer.concat([this.buf,d]);if(this.buf.length>8_000_000){this.err=new Error('The mail server sent too much data.');sock.destroy();}this.parse();this.wake();});
    const end=e=>{this.err||=e||new Error('The mail server closed the connection.');this.wake();};
    sock.on('error',end);sock.on('close',()=>end());
  }
  // One item is a full response line, with the literals ({n} blocks) it carries.
  parse(){
    for(;;){
      let pos=0,text='';const literals=[];let done=false;
      for(;;){
        const nl=this.buf.indexOf('\r\n',pos);if(nl<0)break;
        const line=this.buf.subarray(pos,nl).toString('latin1'),m=line.match(/\{(\d+)\}$/);
        if(m){const n=Number(m[1]);if(this.buf.length<nl+2+n)break;text+=line+'\r\n';literals.push(this.buf.subarray(nl+2,nl+2+n));pos=nl+2+n;continue;}
        text+=line;pos=nl+2;done=true;break;
      }
      if(!done)return;
      this.items.push({text,literals});this.buf=this.buf.subarray(pos);
    }
  }
  wake(){if(!this.wait)return;if(this.items.length){const w=this.wait;this.wait=null;w.resolve(this.items.shift());}else if(this.err){const w=this.wait;this.wait=null;w.reject(this.err);}}
  next(ms){return new Promise((resolve,reject)=>{const t=setTimeout(()=>{this.wait=null;reject(new Error('The mail server did not answer in time.'));},ms);this.wait={resolve:v=>{clearTimeout(t);resolve(v);},reject:e=>{clearTimeout(t);reject(e);}};this.wake();});}
}

async function open({host,port}){
  const secure=Number(port)===993;
  if(!secure&&!isLocal(host))throw new Error('Use the IMAP port with TLS, 993.');
  const sock=secure?tls.connect({host,port,servername:host}):net.connect({host,port});
  await new Promise((resolve,reject)=>{sock.once(secure?'secureConnect':'connect',resolve);sock.once('error',reject);setTimeout(()=>reject(new Error('Cannot reach the mail server.')),12000);});
  return sock;
}

// Returns {uidValidity, lastUid, messages:[{uid,from,subject,date,text}]}. The first call (no lastUid) only learns
// where the inbox ends, so mail that was already there does not start runs.
export async function checkMail({host,port=993,user,pass,folder='INBOX',uidValidity,lastUid,max=5,timeout=20000}){
  if(!/^[a-z0-9.-]+$/i.test(String(host||'')))throw new Error('Give the IMAP server, like imap.gmail.com.');
  if(!user||!pass)throw new Error('Give the mail user name and password.');
  const sock=await open({host,port:Number(port)||993}),wire=new Wire(sock);let n=0;
  const cmd=async line=>{
    const tag='s'+(++n);sock.write(`${tag} ${line}\r\n`);const out=[];
    for(;;){const it=await wire.next(timeout);if(it.text.startsWith(tag+' ')){if(!/^\S+ OK/i.test(it.text))throw new Error(line.startsWith('LOGIN')?'The mail server refused the user name or password.':`The mail server said: ${it.text.slice(tag.length+1,200)}`);return out;}out.push(it);}
  };
  try{
    const hello=await wire.next(timeout);if(!/^\* (OK|PREAUTH)/i.test(hello.text))throw new Error('This is not an IMAP server.');
    await cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
    const sel=await cmd(`EXAMINE ${quote(folder)}`);
    const all=sel.map(i=>i.text).join('\n');
    const validity=Number(all.match(/UIDVALIDITY (\d+)/i)?.[1]||0),uidNext=Number(all.match(/UIDNEXT (\d+)/i)?.[1]||0);
    // A changed UIDVALIDITY means the numbers start over, so the inbox is learned again.
    if(lastUid===undefined||lastUid===null||(uidValidity&&validity&&uidValidity!==validity)){
      let top=uidNext?uidNext-1:0;
      if(!uidNext){const s=await cmd('UID SEARCH ALL');top=Math.max(0,...s.flatMap(i=>(i.text.match(/^\* SEARCH(.*)$/i)?.[1]||'').trim().split(/\s+/).filter(Boolean).map(Number)));}
      return {uidValidity:validity,lastUid:top,messages:[],primed:true};
    }
    const s=await cmd(`UID SEARCH UID ${Number(lastUid)+1}:*`);
    const uids=[...new Set(s.flatMap(i=>(i.text.match(/^\* SEARCH(.*)$/i)?.[1]||'').trim().split(/\s+/).filter(Boolean).map(Number)))].filter(u=>u>lastUid).sort((a,b)=>a-b).slice(0,max);
    const messages=[];
    for(const uid of uids){
      const f=await cmd(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.200000>)`);
      const item=f.find(i=>i.literals.length>=2)||f.find(i=>i.literals.length);if(!item)continue;
      const head=parseHeaders(item.literals[0].toString('latin1')),body=item.literals[1]||Buffer.alloc(0);
      messages.push({uid,from:decodeWords(head.from||''),subject:decodeWords(head.subject||''),date:head.date||'',text:bodyText(head,body).slice(0,30000)});
    }
    return {uidValidity:validity,lastUid:Math.max(lastUid,...uids),messages};
  }finally{try{sock.write(`s${++n} LOGOUT\r\n`);}catch{}setTimeout(()=>sock.destroy(),300).unref?.();}
}

function parseHeaders(raw){
  const out={};for(const line of raw.replace(/\r?\n[ \t]+/g,' ').split(/\r?\n/)){const m=line.match(/^([\w-]+):\s*(.*)$/);if(m)out[m[1].toLowerCase()]=m[2].trim();}return out;
}
function charsetDecode(bytes,charset='utf-8'){try{return new TextDecoder(charset.toLowerCase().replace(/^"|"$/g,'')||'utf-8').decode(bytes);}catch{return bytes.toString('latin1');}}
function qp(s){const bytes=[];s=s.replace(/=\r?\n/g,'');for(let i=0;i<s.length;i++){if(s[i]==='='&&/^[0-9a-f]{2}$/i.test(s.slice(i+1,i+3))){bytes.push(parseInt(s.slice(i+1,i+3),16));i+=2;}else bytes.push(s.charCodeAt(i)&255);}return Buffer.from(bytes);}
export function decodeWords(s){
  // Spaces between two encoded words are dropped, other spaces are kept.
  return String(s).replace(/(\?=)\s+(?==\?)/g,'$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,(_,cs,enc,data)=>charsetDecode(enc.toLowerCase()==='b'?Buffer.from(data,'base64'):qp(data.replace(/_/g,' ')),cs));
}
function decodePart(headers,raw){
  const cte=(headers['content-transfer-encoding']||'').toLowerCase(),charset=(headers['content-type']||'').match(/charset="?([\w-]+)"?/i)?.[1]||'utf-8';
  const bytes=cte==='base64'?Buffer.from(raw.toString('latin1').replace(/\s+/g,''),'base64'):cte==='quoted-printable'?qp(raw.toString('latin1')):raw;
  return charsetDecode(bytes,charset);
}
const stripHtml=h=>h.replace(/<(script|style)[\s\S]*?<\/\1>/gi,'').replace(/<br\s*\/?>|<\/p>|<\/div>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
// The plain text of a message: the text/plain part when there is one, otherwise the HTML part without tags.
export function bodyText(headers,body,depth=0){
  const type=(headers['content-type']||'text/plain').toLowerCase(),boundary=(headers['content-type']||'').match(/boundary="?([^";]+)"?/i)?.[1];
  if(type.startsWith('multipart/')&&boundary&&depth<4){
    const raw=body.toString('latin1'),parts=raw.split('--'+boundary).slice(1).filter(p=>!p.startsWith('--'));
    const parsed=parts.map(p=>{const i=p.search(/\r?\n\r?\n/);const h=parseHeaders(i<0?p:p.slice(0,i));return {h,body:Buffer.from(i<0?'':p.slice(i).replace(/^\r?\n\r?\n/,''),'latin1')};});
    const pick=parsed.find(p=>(p.h['content-type']||'text/plain').toLowerCase().startsWith('text/plain'))||parsed.find(p=>(p.h['content-type']||'').toLowerCase().startsWith('multipart/'))||parsed.find(p=>(p.h['content-type']||'').toLowerCase().startsWith('text/html'));
    return pick?bodyText(pick.h,pick.body,depth+1).trim():'';
  }
  const text=decodePart(headers,body);
  return (type.startsWith('text/html')?stripHtml(text):text).replace(/\r\n/g,'\n').trim();
}
