// Any web API with an OpenAPI 3 or Swagger 2 description becomes a set of tools, with no MCP server in between.
// It looks like an MCP client to the rest of SILO (listTools, callTool, close), so approvals, trust and
// traces work the same way. Reading operations (GET, HEAD) are marked read only; the rest ask first.
// Limits: JSON descriptions up to 5 MB, 200 tools, 30 seconds and 100 KB per answer, no redirects to another host.
import { promises as fs } from 'node:fs';
import { safeUrl } from './mcp-auth.mjs';
import { packSpec } from './public/app-packs.js';

const METHODS=['get','head','post','put','patch','delete'];
const MAX_SPEC=5*1024*1024,MAX_ANSWER=100*1024,MAX_JSON=4*1024*1024,MAX_TOOLS=200;

// JSON that fits in max characters: a long list loses items from the end instead of being cut in the middle,
// so it still reads as JSON. Long texts inside are shortened first.
export function fitJson(data,max,indent=2){
  const text=v=>JSON.stringify(v,null,indent);let out=text(data);if(out.length<=max)return out;
  const shorten=v=>typeof v==='string'&&v.length>4000?v.slice(0,4000)+' [cut]':Array.isArray(v)?v.map(shorten):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,shorten(x)])):v;
  let d=shorten(data);out=text(d);
  // Items are dropped from the end of the list, also of a list inside the answer like {"data": [...]}.
  const trim=(get,set)=>{while(out.length>max){const l=get();if(!Array.isArray(l)||l.length<=1)break;set(l.slice(0,Math.max(1,Math.floor(l.length*max/out.length)-1)));out=text(d);}};
  if(Array.isArray(d))trim(()=>d,v=>{d=v;});
  else if(d&&typeof d==='object'){const k=Object.keys(d).filter(k=>Array.isArray(d[k])).sort((a,b)=>text(d[b]).length-text(d[a]).length)[0];if(k)trim(()=>d[k],v=>{d={...d,[k]:v};});}
  return out.length>max?out.slice(0,max):out;
}
const BLOCKED_HEADERS=/^(authorization|cookie|host|content-length|connection|transfer-encoding|proxy-.*)$/i;

async function readLimited(r,max){
  const reader=r.body?.getReader();if(!reader)return {text:'',cut:false};
  const parts=[];let size=0,cut=false;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){parts.push(value.slice(0,value.length-(size-max)));cut=true;reader.cancel().catch(()=>{});break;}parts.push(value);}
  return {text:Buffer.concat(parts.map(p=>Buffer.from(p))).toString('utf8'),cut};
}

export async function loadSpec(source,{fetcher=globalThis.fetch}={}){
  if(String(source).startsWith('builtin:'))return packSpec(String(source).slice(8));
  let text;
  if(/^https?:\/\//i.test(source)){
    const u=safeUrl(source,'description address');
    let r;try{r=await fetcher(u.href,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(30000)});}catch(e){throw new Error(`Could not fetch the description: ${e.message}`);}
    if(!r.ok)throw new Error(`The description address answered ${r.status}.`);
    const got=await readLimited(r,MAX_SPEC+1);if(got.cut)throw new Error('The description is larger than 5 MB.');text=got.text;
  }else text=await fs.readFile(source,'utf8');
  return parseSpec(text);
}

export function parseSpec(text){
  if(String(text).length>MAX_SPEC)throw new Error('The description is larger than 5 MB.');
  let spec;try{spec=JSON.parse(text);}catch{throw new Error('The description is not JSON. Save a YAML description as JSON first.');}
  if(!spec||typeof spec!=='object')throw new Error('The description is empty.');
  if(!/^3\./.test(String(spec.openapi||''))&&String(spec.swagger||'')!=='2.0')throw new Error('This does not look like an OpenAPI 3 or Swagger 2 description.');
  if(!spec.paths||typeof spec.paths!=='object')throw new Error('The description has no operations.');
  return spec;
}

// Local references (#/components/...) are put in place, a few levels deep, with loops cut.
function resolver(spec){
  const get=ref=>{if(typeof ref!=='string'||!ref.startsWith('#/'))return {};let v=spec;for(const k of ref.slice(2).split('/').map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~'))){v=v?.[k];if(v===undefined)return {};}return v;};
  const inline=(v,depth=0,seen=new Set())=>{
    if(Array.isArray(v))return v.map(x=>inline(x,depth,seen));
    if(!v||typeof v!=='object')return v;
    if(v.$ref){if(depth>6||seen.has(v.$ref))return {type:'object',description:'(nested)'};const next=new Set(seen).add(v.$ref);return inline(get(v.$ref),depth+1,next);}
    const out={};for(const [k,x] of Object.entries(v)){if(k==='example'||k==='examples'||k==='xml'||k.startsWith('x-'))continue;out[k]=inline(x,depth,seen);}return out;
  };
  return inline;
}

// A form body like Stripe's: nested values become key[sub] and key[0][sub]; a list of plain values repeats the key.
export function formBody(obj){
  const out=new URLSearchParams();
  const add=(key,v,top)=>{
    if(v===undefined||v===null)return;
    if(Array.isArray(v)){if(top&&v.every(x=>x===null||typeof x!=='object'))for(const x of v)out.append(key,String(x));else v.forEach((x,i)=>add(`${key}[${i}]`,x,false));}
    else if(typeof v==='object')for(const [k,x] of Object.entries(v))add(`${key}[${k}]`,x,false);
    else out.append(key,String(v));
  };
  if(obj&&typeof obj==='object'&&!Array.isArray(obj))for(const [k,v] of Object.entries(obj))add(k,v,true);
  return out.toString();
}
// How the API wants its key, read from the description's security schemes. The scheme the API uses by default wins.
export function detectAuth(spec){
  const schemes=spec.components?.securitySchemes||spec.securityDefinitions||{};
  const used=[...(spec.security||[]),...Object.values(spec.paths||{}).flatMap(i=>Object.values(i||{}).flatMap(o=>o?.security||[]))].flatMap(x=>Object.keys(x||{}));
  const order=[...new Set([...used,...Object.keys(schemes)])].filter(k=>schemes[k]);
  const read=x=>{
    const t=String(x?.type||'').toLowerCase(),sc=String(x?.scheme||'').toLowerCase();
    if(t==='basic'||(t==='http'&&sc==='basic'))return {kind:'basic',name:'',note:'User and password, written as user:password.'};
    if(t==='http'&&sc==='bearer')return {kind:'bearer',name:'',note:'A bearer token.'};
    if(t==='apikey'&&x.in==='header')return /^authorization$/i.test(x.name)?{kind:'header',name:'Authorization',note:'A key in the Authorization header. Write it the way the API says, for example with Bearer or Token before it.'}:{kind:'header',name:String(x.name||''),note:`A key in the ${x.name} header.`};
    if(t==='apikey'&&x.in==='query')return {kind:'query',name:String(x.name||''),note:`A key in the address, as ${x.name}.`};
    if(t==='oauth2'||t==='openidconnect')return {kind:'bearer',name:'',note:'The API signs in with OAuth. Give an access token you made for it (they often expire).'};
    return null;
  };
  // A plain key is easier to give than an OAuth token, so it wins when the API takes both.
  const found=order.map(k=>[String(schemes[k]?.type||'').toLowerCase(),read(schemes[k])]).filter(x=>x[1]);
  const pick=found.find(([t])=>t!=='oauth2'&&t!=='openidconnect')||found[0];if(pick)return pick[1];
  return {kind:'none',name:'',note:order.length?'The API uses a kind of key SILO cannot send. Try without one.':'The description names no key.'};
}
// What a description holds, before it is added: name, address, key, how many operations, the biggest groups.
export function describeSpec(spec,{specUrl=''}={}){
  const v2=String(spec.swagger||'')==='2.0';let base='';
  try{base=compileSpec(spec,{specUrl}).base;}catch{}
  const tags={};let ops=0;
  for(const item of Object.values(spec.paths||{}))for(const m of METHODS){const op=item?.[m];if(!op||typeof op!=='object')continue;ops++;for(const t of op.tags||[])tags[t]=(tags[t]||0)+1;}
  return {title:String(spec.info?.title||'').slice(0,100),description:String(spec.info?.description||'').replace(/<[^>]+>|[#*_`>]/g,' ').replace(/\s+/g,' ').trim().slice(0,300),version:v2?'Swagger 2':'OpenAPI '+String(spec.openapi||''),base,ops,tooMany:ops>MAX_TOOLS,auth:detectAuth(spec),groups:Object.entries(tags).sort((a,b)=>b[1]-a[1]).slice(0,24).map(([name,count])=>({name:String(name).slice(0,60),count}))};
}
const toolName=s=>String(s).replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,60)||'operation';

// Swagger 2 keeps the address in host, basePath and schemes.
function swaggerServer(spec,specUrl){
  if(!spec.host&&!specUrl)return '';
  const scheme=(spec.schemes||[]).includes('https')?'https':(spec.schemes?.[0]||(specUrl?new URL(specUrl).protocol.slice(0,-1):'https'));
  const host=spec.host||new URL(specUrl).host;
  return `${scheme}://${host}${spec.basePath||''}`;
}
// Only the operations whose name, path, tag or summary holds one of these words (comma separated).
function wanted(include,name,p,op){
  const words=String(include||'').toLowerCase().split(',').map(w=>w.trim()).filter(Boolean);if(!words.length)return true;
  const hay=[name,p,...(op.tags||[]),op.summary||''].join(' ').toLowerCase();
  return words.some(w=>hay.includes(w));
}
export function compileSpec(spec,{specUrl='',base='',include=''}={}){
  const inline=resolver(spec),v2=String(spec.swagger||'')==='2.0';
  let server=base||(v2?swaggerServer(spec,specUrl):spec.servers?.[0]?.url)||'';
  if(server){for(const [k,v] of Object.entries(spec.servers?.[0]?.variables||{}))server=server.replaceAll(`{${k}}`,String(v?.default??''));}
  if(server&&specUrl&&!/^https?:/i.test(server))server=new URL(server,specUrl).href;
  if(!server)throw new Error('The description does not say where the API is. Give the API address.');
  const baseUrl=safeUrl(server,'API address').href.replace(/\/$/,'');
  const ops=[],names=new Set();
  for(const [p,item] of Object.entries(spec.paths)){
    if(!item||typeof item!=='object')continue;
    for(const method of METHODS){
      const op=item[method];if(!op||typeof op!=='object')continue;
      if(ops.length>=MAX_TOOLS)break;
      if(!wanted(include,op.operationId||'',p,op))continue;
      let name=toolName(op.operationId||`${method}_${p}`),n=2;while(names.has(name))name=toolName((op.operationId||`${method}_${p}`))+'_'+n++;names.add(name);
      const params=new Map();
      let v2body=null;
      for(const raw of [...(item.parameters||[]),...(op.parameters||[])]){
        const x=inline(raw);if(!x?.name)continue;
        if(v2&&x.in==='body'){v2body=x;continue;}
        // Swagger 2 writes the type on the parameter itself.
        if(v2&&!x.schema){const {type,items,enum:en,format,default:def}=x;x.schema=Object.fromEntries(Object.entries({type:type==='file'?'string':type,items,enum:en,format,default:def}).filter(([,v])=>v!==undefined));}
        if(['path','query','header'].includes(x.in)&&!(x.in==='header'&&BLOCKED_HEADERS.test(x.name)))params.set(x.in+':'+x.name,x);
      }
      const properties={},required=[],list=[];
      for(const x of params.values()){
        const clean=String(x.name).replace(/[^a-zA-Z0-9_.-]/g,'_').slice(0,60)||'value',key=properties[clean]?`${x.in}_${clean}`:clean;
        properties[key]={...(x.schema||{type:'string'}),...(x.description&&{description:String(x.description).slice(0,300)})};
        if(x.required||x.in==='path')required.push(key);list.push({key,name:x.name,in:x.in});
      }
      let body=null,form=false;const content=inline(op.requestBody)?.content||{};
      const json=Object.keys(content).find(t=>/json/i.test(t)),formType=!json&&Object.keys(content).find(t=>/x-www-form-urlencoded/i.test(t));
      if(formType){form=true;body=properties.body?'_body':'body';properties[body]={...(content[formType].schema||{type:'object'}),type:'object',description:content[formType].schema?.description||'The fields of the form, as a JSON object. Nested values are sent as key[sub].'};if(op.requestBody.required)required.push(body);}
      else if(json){body=properties.body?'_body':'body';properties[body]={...(content[json].schema||{type:'object'}),description:content[json].schema?.description||'The JSON body of the request.'};if(op.requestBody.required)required.push(body);}
      else if(v2body){body=properties.body?'_body':'body';properties[body]={...(v2body.schema||{type:'object'}),description:v2body.description?String(v2body.description).slice(0,300):'The JSON body of the request.'};if(v2body.required)required.push(body);}
      const description=[op.summary,op.description].filter(Boolean).join('. ').replace(/\s+/g,' ').slice(0,700)||`${method.toUpperCase()} ${p}`;
      // A POST that only searches can say so, and then it runs without asking.
      const readOnly=method==='get'||method==='head'||op['x-silo-read-only']===true;
      ops.push({name,method:method.toUpperCase(),path:typeof op['x-silo-path']==='string'?op['x-silo-path']:p,params:list,body,form,readOnly,graphqlRead:op['x-silo-graphql']==='read',
        tool:{name,description:`${method.toUpperCase()} ${p}: ${description}`.slice(0,800),inputSchema:{type:'object',properties,...(required.length&&{required:[...new Set(required)]})},annotations:{readOnlyHint:readOnly}}});
    }
  }
  if(!ops.length)throw new Error(include?'No operation matches the words you gave. Try fewer or other words.':'The description has no operations SILO can use.');
  // Built-in apps can add fixed headers (like an API version) and name a harmless call that shows the key works.
  const headers=Object.fromEntries(Object.entries(spec['x-silo-headers']||{}).filter(([k,v])=>typeof v==='string'&&!BLOCKED_HEADERS.test(k)));
  const plain=ops.find(o=>o.method==='GET'&&!/\{/.test(o.path)&&!(o.tool.inputSchema.required||[]).length);
  const check=Array.isArray(spec['x-silo-check'])&&ops.some(o=>o.name===spec['x-silo-check'][0])?spec['x-silo-check']:spec['x-silo-check']===false?null:plain?[plain.name,{}]:null;
  return {base:baseUrl,ops,headers,check};
}

export class OpenApiClient{
  // config: {spec: address or file, base, include, auth:{kind:'none'|'bearer'|'basic'|'header'|'query'|'path', name, prefix, value}}
  constructor(config,{timeout=30000,fetcher=globalThis.fetch}={}){this.config=config;this.timeout=timeout;this.fetcher=fetcher;this.closed=false;this.compiled=null;}
  async load(){
    if(!this.compiled){const spec=await loadSpec(this.config.spec,{fetcher:this.fetcher});this.compiled=compileSpec(spec,{specUrl:/^https?:/i.test(this.config.spec)?this.config.spec:'',base:this.config.base,include:this.config.include});}
    return this.compiled;
  }
  async listTools(){return (await this.load()).ops.map(o=>o.tool);}
  // Runs the app's harmless check call with the saved key: { ok, status, detail } or null when the app has none.
  async checkKey(){
    const c=await this.load();if(!c.check)return null;
    const a=this.config.auth||{};if(a.kind&&a.kind!=='none'&&!a.value)return {ok:false,status:0,detail:'No key saved yet.',at:Date.now()};
    const r=await this.callTool(c.check[0],c.check[1]||{}),text=r.content?.[0]?.text||'',status=Number(text.match(/^(\d{3})\b/)?.[1])||0;
    return {ok:!r.isError,status,detail:r.isError?text.replace(/\s+/g,' ').slice(0,200):'',at:Date.now()};
  }
  async callTool(name,args={},signal){
    if(signal?.aborted)throw signal.reason||new Error('Stopped.');
    const {base,ops,headers:fixed={}}=await this.load(),op=ops.find(o=>o.name===name);
    if(!op)return {content:[{type:'text',text:`There is no operation called ${name}.`}],isError:true};
    // A GraphQL call marked as reading may not change anything.
    if(op.graphqlRead&&/\bmutation\b/i.test(String(args?.[op.body]?.query||'')))return {content:[{type:'text',text:'This operation only reads. Use the one that changes things for a mutation.'}],isError:true};
    let path=op.path;const url=new URL(base),headers={Accept:'application/json, text/plain;q=0.9, */*;q=0.5','User-Agent':'SILO-agent-world',...fixed};
    for(const p of op.params){
      const v=args[p.key];if(v===undefined||v===null||v==='')continue;
      // "." and ".." stay as they are when encoded, and would move the call to another address of the API.
      if(p.in==='path'){if(/^\.{1,2}$/.test(String(v).trim()))throw new Error(`${p.name} cannot be "${String(v).trim()}".`);path=path.replaceAll(`{${p.name}}`,encodeURIComponent(String(v)));}
      else if(p.in==='query'){if(Array.isArray(v))for(const x of v)url.searchParams.append(p.name,String(x));else url.searchParams.set(p.name,typeof v==='object'?JSON.stringify(v):String(v));}
      else headers[p.name]=String(v).replace(/[\r\n]/g,' ');
    }
    if(/\{[^}]+\}/.test(path))return {content:[{type:'text',text:`Missing a value for ${path.match(/\{([^}]+)\}/)[1]}.`}],isError:true};
    url.pathname=(url.pathname.replace(/\/$/,'')+path).replace(/\/{2,}/g,'/');
    const a=this.config.auth||{};
    if(a.value){if(a.kind==='bearer')headers.Authorization='Bearer '+a.value;else if(a.kind==='basic')headers.Authorization='Basic '+Buffer.from(a.value).toString('base64');
      // One header, or two like Datadog's keys: names "A,B", value "ONE:TWO". The prefix goes on the first.
      else if(a.kind==='header'&&a.name){const names=a.name.split(','),vals=names.length>1?a.value.split(':'):[a.value];names.forEach((n,i)=>{if(vals[i])headers[n.trim()]=(i===0?a.prefix||'':'')+vals[i].replace(/[\r\n]/g,'');});}
      // In the path, like Telegram's /bot<token>/getMe.
      else if(a.kind==='path'){if(!/^[\w:.-]+$/.test(a.value))return {content:[{type:'text',text:'The key has characters that cannot go in an address.'}],isError:true};url.pathname=(new URL(base).pathname.replace(/\/$/,'')+'/'+(a.prefix||'')+a.value+path).replace(/\/{2,}/g,'/');}
      // Two values in the address, like Trello's key and token: names "key,token", value "KEY:TOKEN".
      else if(a.kind==='query'&&a.name){const names=a.name.split(','),vals=names.length>1?a.value.split(':'):[a.value];names.forEach((n,i)=>{if(vals[i])url.searchParams.set(n.trim(),vals[i]);});}}
    let body;if(op.body&&args[op.body]!==undefined){
      if(op.form){headers['Content-Type']='application/x-www-form-urlencoded';body=formBody(typeof args[op.body]==='string'?JSON.parse(args[op.body]):args[op.body]);}
      else{headers['Content-Type']=headers['Content-Type']||'application/json';body=JSON.stringify(args[op.body]);}}
    const timer=AbortSignal.timeout(this.timeout),both=signal?AbortSignal.any([signal,timer]):timer;
    let target=url,r;
    // Redirects are followed only on the same host, at most three times.
    for(let hop=0;;hop++){
      try{r=await this.fetcher(target.href,{method:op.method,headers,body,redirect:'manual',signal:both});}
      catch(e){if(signal?.aborted)throw signal.reason||e;return {content:[{type:'text',text:timer.aborted?'The API did not answer within 30 seconds.':`Could not reach the API: ${e.message}`}],isError:true};}
      if(r.status<300||r.status>=400||hop>=3)break;
      const next=r.headers.get('location');if(!next)break;const n=new URL(next,target);
      if(n.host!==url.host||n.protocol!==url.protocol)return {content:[{type:'text',text:`The API sent the request on to another host (${n.host}). SILO did not follow it.`}],isError:true};
      target=n;
    }
    // JSON is read further and then made smaller as JSON, so a long list still parses; other text is cut at 100 KB.
    // 99,000 characters keeps the status line and the note under the 100,000 an app step keeps.
    const isJson=/json/i.test(r.headers.get('content-type')||''),got=await readLimited(r,isJson?MAX_JSON:MAX_ANSWER);
    let text=got.text;
    let smaller=false;
    if(isJson&&!got.cut){try{const full=got.text.length;text=fitJson(JSON.parse(text),99000,1);smaller=full>MAX_ANSWER&&text.length<full;}catch{}}
    if(text.length>MAX_ANSWER){text=text.slice(0,MAX_ANSWER);got.cut=true;}
    if(smaller)text+='\n[cut at 100 KB, still JSON: long texts shortened, the last items left out]';
    for(const secret of [a.value,...String(a.value||'').split(':')])if(secret&&secret.length>=6)text=text.split(secret).join('[secret]');
    return {content:[{type:'text',text:`${r.status} ${r.statusText||''}`.trim()+'\n'+text+(got.cut?'\n[cut at 100 KB]':'')}],isError:!r.ok};
  }
  close(){this.closed=true;}
}
