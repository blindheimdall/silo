// The live channel: small patches between versions of the state, and the stream that carries them to the page.
// Temporary data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {diffState,applyPatch} from '../public/live-patch.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// A small random number generator with a seed, so a failure can be replayed.
const rng=seed=>()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};

test('a patch turns any old version into the new one, also after the trip as JSON',()=>{
  const r=rng(42),pick=list=>list[Math.floor(r()*list.length)];
  const value=depth=>{
    const k=r();
    if(depth>3||k<.35)return pick([0,1,-2.5,'',null,true,false,'text','über ✓',Math.round(r()*1e6)]);
    if(k<.55)return Array.from({length:Math.floor(r()*4)},()=>value(depth+1));
    if(k<.8){const o={};for(let i=Math.floor(r()*4);i>0;i--)o[pick(['a','b','c','name','status','list'])]=value(depth+1);return o;}
    return Array.from({length:1+Math.floor(r()*5)},(_,i)=>({id:pick(['x','y','z',1,2])+'-'+i,name:pick(['Ana','Bo','Cy']),n:Math.floor(r()*9),tags:value(depth+2)}));
  };
  const change=(v,depth=0)=>{
    if(r()<.15)return value(depth);
    if(Array.isArray(v)){
      let out=v.map(x=>r()<.4?change(x,depth+1):x);
      if(r()<.3)out.reverse();
      if(r()<.3&&out.length)out.splice(Math.floor(r()*out.length),1);
      if(r()<.3)out.push(out.length&&out[0]?.id!==undefined?{id:'new-'+Math.floor(r()*1e9),name:'New',n:0,tags:null}:value(depth+1));
      return out;
    }
    if(v&&typeof v==='object'){
      const out={};for(const [k,x] of Object.entries(v)){if(r()<.15)continue;out[k]=r()<.5?change(x,depth+1):x;}
      if(r()<.3)out['k'+Math.floor(r()*5)]=value(depth+1);
      return out;
    }
    return r()<.5?value(depth):v;
  };
  for(let i=0;i<600;i++){
    const a={agents:value(0),events:value(1),settings:value(1)},b=change(structuredClone(a));
    const p=diffState(a,b);
    assert.deepEqual(applyPatch(structuredClone(a),p),b,'patch '+i);
    assert.deepEqual(applyPatch(structuredClone(a),p===undefined?undefined:JSON.parse(JSON.stringify(p))),b,'patch '+i+' as JSON');
    if(JSON.stringify(a)===JSON.stringify(b))assert.equal(p,undefined,'no patch when nothing changed');
  }
  // One resident out of many changes: the patch names that resident, not the whole list.
  const many={agents:Array.from({length:400},(_,i)=>({id:'a'+i,name:'Resident '+i,status:'idle',chats:[]}))},next=structuredClone(many);
  next.agents[123].status='working';
  const p=diffState(many,next);
  assert.deepEqual(p,{o:{agents:{a:{c:{a123:{o:{status:{s:'working'}}}}}}}});
  assert.ok(JSON.stringify(p).length*100<JSON.stringify(next).length);
  // Ids 1 and "1" are not the same thing on the wire, so such a list is sent whole.
  assert.deepEqual(applyPatch([{id:1,v:1},{id:'1',v:2}],diffState([{id:1,v:1},{id:'1',v:2}],[{id:'1',v:2},{id:1,v:3}])),[{id:'1',v:2},{id:1,v:3}]);
});

// Reads server-sent events from a fetch response.
function events(res){
  const got=[],reader=res.body.getReader(),dec=new TextDecoder();let buf='',closed=false;
  (async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
    while((i=buf.indexOf('\n\n'))>=0){const block=buf.slice(0,i);buf=buf.slice(i+2);let name='message',data='';
      for(const line of block.split('\n')){if(line.startsWith('event: '))name=line.slice(7);else if(line.startsWith('data: '))data+=line.slice(6);}
      if(data)got.push({name,data:JSON.parse(data),size:data.length});}}}catch{}closed=true;})();
  return {
    got,get closed(){return closed;},
    async next(match,ms=10000){const end=Date.now()+ms;for(;;){const k=got.findIndex(match);if(k>=0)return got.splice(k,1)[0];if(Date.now()>end||closed&&!got.some(match))return null;await new Promise(r=>setTimeout(r,40));}},
    stop(){reader.cancel().catch(()=>{});}
  };
}
const withoutTag=({tag,...rest})=>rest;

test('the live channel sends the state once, then patches, the text residents write, and ends on sign out',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-live-test-'));
  const port=14357,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  const streams=[];
  t.after(async()=>{for(const s of streams)s.stop();child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),15000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session'),token=(await s.json()).token,cookie=s.headers.get('set-cookie').split(';')[0];
  const api=async(route,body)=>{const r=await fetch(origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin,'x-silo-token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:r.status===204?null:await r.json()};};
  const open=async(c=cookie)=>{const r=await fetch(origin+'/api/stream',{headers:{cookie:c,'accept-encoding':'br'}});if(r.ok)streams.push(events(r));return r;};

  const res=await open();
  assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/event-stream/);assert.equal(res.headers.get('content-encoding'),'br','compressed, and still flushed event by event');
  const live=streams[0];
  const full=await live.next(e=>e.name==='full');assert.ok(full,'the whole state comes first');
  let mine=full.data.state;assert.equal(mine.tag,full.data.tag);assert.ok(mine.agents.length>100);

  await t.test('a change arrives as a small patch that rebuilds the same state',async()=>{
    const made=await api('/agents',{name:'Patch Tester',role:'Fixture',floor:2,provider:'demo',instructions:'Fixture.'});
    assert.equal(made.status,201,JSON.stringify(made.data));
    let current=null;
    for(let i=0;i<20;i++){
      const p=await live.next(e=>e.name==='patch'||e.name==='full');assert.ok(p,'a patch arrived');
      if(p.name==='full')mine=p.data.state;else{assert.equal(p.data.from,mine.tag,'each patch starts where the last ended');mine=applyPatch(mine,p.data.p);assert.ok(p.size*5<full.size,`patch of ${p.size} bytes, state of ${full.size}`);}
      mine.tag=p.data.tag;
      if(mine.agents.some(a=>a.name==='Patch Tester')){current=(await api('/state')).data;if(current.tag===mine.tag)break;}
    }
    assert.ok(current,'the new resident is there');assert.equal(current.tag,mine.tag);
    assert.deepEqual(withoutTag(mine),withoutTag(current));
  });

  await t.test('the text of a resident at work streams as it is written',async()=>{
    const agent=mine.agents.find(a=>a.name==='Patch Tester');
    assert.equal((await api('/agents/'+agent.id+'/chat',{message:'Check the pumps.'})).status,200);
    const seen=[];let done=null;
    for(let i=0;i<200&&!done;i++){const e=await live.next(x=>x.name==='live'&&x.data.id===agent.id);if(!e)break;if(e.data.done)done=e;else seen.push(e.data);}
    assert.ok(seen.length>=1,'live text arrived');assert.ok(done,'and then the end of it');
    assert.ok(seen.every(x=>typeof x.add==='string'||typeof x.text==='string'));
  });

  await t.test('signing out or a new owner ends the channel; without a session it is refused',async()=>{
    assert.equal((await api('/users',{name:'Owner',password:'owner-pass-1'})).status,201);
    const end=await live.next(e=>e.name==='end');
    assert.ok(end,'a page from before the owner existed is told to start again');
    await new Promise(r=>setTimeout(r,200));assert.ok(live.closed,'and the stream is closed');
    const fresh=await fetch(origin+'/api/session'),other=fresh.headers.get('set-cookie')?.split(';')[0]||'';
    const r=await open(other);assert.equal(r.status,401);
  });
  assert.equal(errors.trim(),'');
});
