// A small Model Context Protocol client. It speaks JSON-RPC 2.0 over two transports:
//   stdio: the server is a local program, one JSON message per line on stdin and stdout
//   http:  Streamable HTTP, every message is a POST and the answer is JSON or a short event stream
// Only what residents need is used: initialize, tools/list and tools/call.
import { spawn } from 'node:child_process';

export const PROTOCOL_VERSION='2025-06-18';
const CLIENT={name:'silo',title:'SILO 18',version:'0.1.0'};

export class McpClient{
  constructor(config,{timeout=60000}={}){this.config=config;this.timeout=timeout;this.pending=new Map();this.next=1;this.ready=null;this.closed=false;this.log='';}
  connect(){
    if(!this.ready)this.ready=(this.config.transport==='http'?this.startHttp():this.startStdio()).then(()=>this.initialize()).catch(e=>{this.close();throw e;});
    return this.ready;
  }
  startStdio(){
    const {command,args=[],env={},cwd}=this.config;
    if(!command)throw new Error('The connector has no command.');
    // On Windows, npx and similar are .cmd scripts that need a shell. Every argument is quoted.
    const win=process.platform==='win32',quote=a=>/^[\w@%+=:,./\\-]+$/.test(a)?a:'"'+String(a).replace(/"/g,'\\"')+'"';
    const child=win?spawn([command,...args].map(quote).join(' '),{shell:true,cwd,env:{...process.env,...env},windowsHide:true}):spawn(command,args,{cwd,env:{...process.env,...env}});
    this.child=child;let buffer='';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(line)this.receive(line);}});
    child.stderr.setEncoding('utf8');child.stderr.on('data',d=>{this.log=(this.log+d).slice(-2000);});
    return new Promise((resolve,reject)=>{
      child.once('error',e=>reject(new Error(`Could not start ${command}: ${e.message}`)));
      child.once('spawn',resolve);
      child.once('exit',code=>{const e=new Error(`The connector program stopped (exit code ${code}). ${this.log.trim().split('\n').slice(-3).join(' ')}`.trim());this.closed=true;this.failAll(e);});
    });
  }
  async startHttp(){
    const u=new URL(this.config.url);
    const local=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
    if(u.protocol!=='https:'&&!(u.protocol==='http:'&&local))throw new Error('Use an https address, or http on this computer only.');
    if(u.username||u.password)throw new Error('Put credentials in a header, not in the address.');
  }
  receive(line){
    let msg;try{msg=JSON.parse(line);}catch{return;}
    for(const m of Array.isArray(msg)?msg:[msg])this.handle(m);
  }
  handle(m){
    if(m.id!==undefined&&(m.result!==undefined||m.error!==undefined)){
      const p=this.pending.get(m.id);if(!p)return;
      if(m.error)p.reject(Object.assign(new Error(m.error.message||'The connector returned an error.'),{code:m.error.code}));else p.resolve(m.result);
      return;
    }
    // A request from the server. Answer the few that are common, refuse the rest politely.
    if(m.id!==undefined&&m.method){
      const result=m.method==='ping'?{}:m.method==='roots/list'?{roots:[]}:null;
      this.write(result?{jsonrpc:'2.0',id:m.id,result}:{jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Not supported by SILO.'}});
    }
  }
  // Ends every open request: each one's HTTP request is aborted too.
  failAll(e){for(const p of [...this.pending.values()])p.end(e,false);this.pending.clear();}
  write(msg,signal){if(this.config.transport==='http')return this.post(msg,signal);if(!this.child||this.closed)throw new Error('The connector is not running.');this.child.stdin.write(JSON.stringify(msg)+'\n');}
  async post(msg,signal){
    if(signal?.aborted)throw signal.reason||new Error('Stopped.');
    const headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream',...(this.config.headers||{})};
    if(this.session)headers['Mcp-Session-Id']=this.session;
    if(this.protocol)headers['MCP-Protocol-Version']=this.protocol;
    const r=await fetch(this.config.url,{method:'POST',headers,body:JSON.stringify(msg),signal,redirect:'error'});
    const sid=r.headers.get('mcp-session-id');if(sid)this.session=sid;
    if(r.status===202||r.status===204)return;
    if(!r.ok){const t=(await r.text()).slice(0,300);throw Object.assign(new Error(`The connector answered ${r.status}. ${t}`.trim()),{status:r.status});}
    const type=r.headers.get('content-type')||'';
    if(type.includes('text/event-stream')){
      const decoder=new TextDecoder();let buffer='',data='';
      for await(const chunk of r.body){
        if(signal?.aborted)throw signal.reason||new Error('Stopped.');
        buffer+=decoder.decode(chunk,{stream:true});let i;
        while((i=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,i).replace(/\r$/,'');buffer=buffer.slice(i+1);
          if(line.startsWith('data:'))data+=(data?'\n':'')+line.slice(5).trimStart();
          else if(!line&&data){this.receive(data);data='';if(msg.id!==undefined&&!this.pending.has(msg.id))return;}
        }
      }
      if(data)this.receive(data);
    }else{const text=await r.text();if(text.trim())this.receive(text);}
  }
  // One request. Its own AbortController carries the HTTP request, so a timeout, a stop from outside and closing the
  // connector all end it the same way: the request on the wire is aborted, the server is told it was cancelled (unless
  // the connector is closing) and the caller gets the reason.
  request(method,params,signal){
    if(signal?.aborted)return Promise.reject(signal.reason||new Error('Stopped.'));
    const id=this.next++,ctrl=new AbortController();
    return new Promise((resolve,reject)=>{
      const onAbort=()=>end(signal.reason||new Error('Stopped.'));
      const settle=()=>{const p=this.pending.get(id);if(!p)return false;this.pending.delete(id);clearTimeout(p.timer);signal?.removeEventListener('abort',onAbort);return true;};
      const end=(e,tell=true)=>{if(!settle())return;if(tell&&!this.closed)this.cancelled(id);ctrl.abort(e);reject(e);};
      const timer=setTimeout(()=>end(new Error(`The connector did not answer ${method} within ${Math.round(this.timeout/1000)} seconds.`)),this.timeout);
      this.pending.set(id,{timer,end,resolve:v=>{if(settle())resolve(v);},reject:e=>{if(settle())reject(e);}});
      signal?.addEventListener('abort',onAbort,{once:true});
      Promise.resolve().then(()=>{
        if(ctrl.signal.aborted||!this.pending.has(id))return;
        return this.write({jsonrpc:'2.0',id,method,...(params&&{params})},ctrl.signal);
      }).catch(e=>end(e,false));
    });
  }
  // Tells the server a request was given up, so it can stop working on it. Best effort: it may be gone.
  cancelled(id){
    const msg={jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason:'Cancelled'}};
    if(this.config.transport==='http'){this.post(msg,AbortSignal.timeout(5000)).catch(()=>{});return;}
    if(this.child&&!this.closed){try{this.child.stdin.write(JSON.stringify(msg)+'\n');}catch{}}
  }
  async initialize(){
    const r=await this.request('initialize',{protocolVersion:PROTOCOL_VERSION,capabilities:{},clientInfo:CLIENT});
    this.protocol=r?.protocolVersion||PROTOCOL_VERSION;this.server=r?.serverInfo||{};this.instructions=r?.instructions||'';
    await this.write({jsonrpc:'2.0',method:'notifications/initialized'});
    return r;
  }
  async listTools(){
    await this.connect();const tools=[];let cursor;
    for(let page=0;page<20;page++){const r=await this.request('tools/list',cursor?{cursor}:{});tools.push(...(r?.tools||[]));cursor=r?.nextCursor;if(!cursor)break;}
    return tools;
  }
  async callTool(name,args,signal){if(signal?.aborted)throw signal.reason||new Error('Stopped.');await this.connect();if(signal?.aborted)throw signal.reason||new Error('Stopped.');return this.request('tools/call',{name,arguments:args||{}},signal);}
  close(){
    this.closed=true;this.failAll(new Error('The connector was closed.'));
    if(this.child&&this.child.exitCode===null){try{this.child.stdin.end();}catch{}const c=this.child;setTimeout(()=>{if(c.exitCode===null)c.kill();},500).unref?.();}
    if(this.config.transport==='http'&&this.session){fetch(this.config.url,{method:'DELETE',headers:{'Mcp-Session-Id':this.session,...(this.config.headers||{})},signal:AbortSignal.timeout(5000)}).catch(()=>{});}
  }
}

// What a tool call gave back, as text a model can read.
export function resultText(result){
  const parts=[];
  for(const c of result?.content||[]){
    if(c.type==='text')parts.push(c.text);
    else if(c.type==='resource')parts.push(c.resource?.text??`[resource ${c.resource?.uri||''}]`);
    else if(c.type==='resource_link')parts.push(`[link ${c.name||''} ${c.uri||''}]`);
    else parts.push(`[${c.type}${c.mimeType?' '+c.mimeType:''}]`);
  }
  if(!parts.length&&result?.structuredContent)parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n')||'(no content)';
}
export const safeToolName=(prefix,name)=>(prefix.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,20)+'__'+String(name).replace(/[^a-zA-Z0-9_-]/g,'_')).slice(0,64);
