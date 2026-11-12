// Reads public web pages for residents with web access. Addresses on this computer or the local network are refused,
// also when a public name points to one (the check runs on every connection, so a changed DNS answer cannot slip through).
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export function privateAddress(ip){
  if(net.isIPv4(ip)){const [a,b]=ip.split('.').map(Number);return a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19))||a>=224;}
  const v=ip.toLowerCase().replace(/^\[|\]$/g,'');
  const v4=v.startsWith('::ffff:')?v.slice(7):v.startsWith('64:ff9b::')?v.slice(9):null;
  if(v4!==null){
    if(net.isIPv4(v4))return privateAddress(v4);
    const m=v4.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if(m){const hi=parseInt(m[1],16),lo=parseInt(m[2],16);return privateAddress(`${hi>>8}.${hi&255}.${lo>>8}.${lo&255}`);}
    return true;
  }
  return v==='::'||v==='::1'||/^f[cd]/.test(v)||/^fe[89ab]/.test(v)||v.startsWith('ff')||v.startsWith('64:ff9b:');
}
const refused=()=>Object.assign(new Error('Pages on this computer or the local network cannot be read.'),{code:'EPRIVATE'});
function lookupFor(allowLocal){
  return (host,opts,cb)=>dns.lookup(host,{...opts,all:true},(err,list)=>{
    if(err)return cb(err);
    const ok=allowLocal?list:list.filter(a=>!privateAddress(a.address));
    if(!ok.length)return cb(refused());
    if(opts?.all)return cb(null,ok);
    cb(null,ok[0].address,ok[0].family);
  });
}
const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',mdash:'-',ndash:'-',hellip:'...',rsquo:"'",lsquo:"'",rdquo:'"',ldquo:'"',copy:'(c)',reg:'(R)',trade:'(TM)'};
function decode(s){return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,(m,e)=>{if(e[0]==='#'){const n=e[1].toLowerCase()==='x'?parseInt(e.slice(2),16):Number(e.slice(1));return n>0&&n<0x110000?String.fromCodePoint(n):'';}return ENTITIES[e.toLowerCase()]??m;});}
// Plain text of an HTML page: the title, then the readable text with paragraphs, headings and list items kept apart.
export function htmlToText(html){
  const title=decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'').replace(/\s+/g,' ').trim());
  let body=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|noscript|svg|template|head|iframe|form)\b[\s\S]*?<\/\1>/gi,' ');
  const main=body.match(/<(main|article)\b[\s\S]*?<\/\1>/i);if(main&&main[0].length>500)body=main[0];
  body=body.replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi,' ')
    .replace(/<li\b[^>]*>/gi,'\n- ').replace(/<h([1-6])\b[^>]*>/gi,'\n\n## ').replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(p|div|section|h[1-6]|tr|table|ul|ol|pre|blockquote|header)>/gi,'\n').replace(/<\/t[dh]>/gi,' | ')
    .replace(/<[^>]+>/g,' ');
  const text=decode(body).replace(/[ \t\f\v ]+/g,' ').replace(/ *\n */g,'\n').replace(/ ([.,;:!?)])/g,'$1').replace(/\n{3,}/g,'\n\n').trim();
  return {title,text};
}
function get(url,{allowLocal,timeout}){
  return new Promise((resolve,reject)=>{
    const u=new URL(url),mod=u.protocol==='https:'?https:http;
    if(net.isIP(u.hostname.replace(/^\[|\]$/g,''))&&!allowLocal&&privateAddress(u.hostname))return reject(refused());
    const req=mod.request(u,{method:'GET',lookup:lookupFor(allowLocal),timeout,headers:{'User-Agent':'SILO-reader/1.0 (local agent workspace)','Accept':'text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.3','Accept-Encoding':'identity'}},res=>{
      const chunks=[];let size=0;
      res.on('data',c=>{size+=c.length;if(size>2_000_000){req.destroy();resolve({res,body:Buffer.concat(chunks),cut:true});return;}chunks.push(c);});
      res.on('end',()=>resolve({res,body:Buffer.concat(chunks),cut:false}));
      res.on('error',reject);
    });
    req.on('timeout',()=>req.destroy(Object.assign(new Error('The page took too long to answer.'),{code:'ETIMEDOUT'})));
    req.on('error',reject);req.end();
  });
}
// Follows up to four redirects, each checked again. Returns the page as plain text, cut at maxChars.
export async function readPage(url,{allowLocal=false,maxChars=20000,timeout=15000}={}){
  let current;
  try{current=new URL(String(url));}catch{throw new Error('That is not a valid web address.');}
  for(let hop=0;hop<5;hop++){
    if(!/^https?:$/.test(current.protocol))throw new Error('Only http and https pages can be read.');
    if(current.username||current.password)throw new Error('Addresses with a user name or password are not allowed.');
    const {res,body,cut}=await get(current.href,{allowLocal,timeout});
    if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){current=new URL(res.headers.location,current);continue;}
    if(res.statusCode>=400)throw new Error(`The page answered ${res.statusCode}.`);
    const type=String(res.headers['content-type']||'text/html').toLowerCase();
    if(!/text\/|json|xml|javascript/.test(type))throw new Error(`This is not a text page (${type.split(';')[0]}).`);
    const charset=type.match(/charset=([\w-]+)/)?.[1]||'utf-8';
    let raw;try{raw=new TextDecoder(charset).decode(body);}catch{raw=body.toString('utf8');}
    const page=/html|xml/.test(type)&&/<[a-z!]/i.test(raw)?htmlToText(raw):{title:'',text:raw.trim()};
    const long=page.text.length>maxChars;
    return {url:current.href,title:page.title,text:page.text.slice(0,maxChars)+(long||cut?'\n\n(The page was cut here.)':''),bytes:body.length};
  }
  throw new Error('The page redirected too many times.');
}
