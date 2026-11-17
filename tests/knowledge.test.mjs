// Knowledge: a Drive folder, Notion pages and a web site kept as copies in knowledge/, read again only when they
// change, with the copies of removed documents gone; documents are searched by their text, and a passage says how to
// cite it and where it came from. Vectors are kept small and give the same order.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {promises as fs,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {cleanSource,fileNameFor,readHeader,withHeader,notionText,sitemapUrls,syncSource} from '../knowledge.mjs';
import {packVector,vectorOf,ArchiveIndex} from '../archive-index.mjs';
import {makeDocx} from '../documents.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms,what)=>{const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(100);}};

test('sources, names and headers',()=>{
  assert.deepEqual(cleanSource({kind:'gdrive',name:' Policies ',ref:'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMn?usp=sharing'}),{name:'Policies',kind:'gdrive',ref:'1AbCdEfGhIjKlMn',every:360});
  assert.equal(cleanSource({kind:'notion',name:'Wiki',ref:'https://www.notion.so/team/Handbook-0123456789abcdef0123456789ABCDEF?pvs=4',every:60}).ref,'0123456789abcdef0123456789abcdef');
  assert.throws(()=>cleanSource({kind:'constructor',name:'x',ref:'y'}),/Choose a Google Drive folder/);
  assert.equal(cleanSource({kind:'onedrive',name:'Docs',ref:'Documents\\Policies\\'}).ref,'/Documents/Policies');
  assert.equal(cleanSource({kind:'web',name:'Site',ref:'https://a.example/x\nhttps://a.example/x\nhttps://a.example/y'}).ref,'https://a.example/x\nhttps://a.example/y');
  for(const bad of [{kind:'ftp',name:'x',ref:'y'},{kind:'gdrive',name:'',ref:'1AbCdEfGhIjKlMn'},{kind:'gdrive',name:'x',ref:'nope'},{kind:'web',name:'x',ref:'file:///etc/passwd'},{kind:'web',name:'x',ref:'https://u:p@a.example/'},{kind:'onedrive',name:'x',ref:'/a/../b'},{kind:'web',name:'x',ref:'https://a.example',every:5}])
    assert.throws(()=>cleanSource(bad),undefined,JSON.stringify(bad));
  assert.equal(cleanSource({name:'New name'},{name:'Old',kind:'gdrive',ref:'1AbCdEfGhIjKlMn',every:60}).every,60,'a change keeps what it does not say');
  const used=new Set();assert.deepEqual([fileNameFor('Plan: Q1/Q2',used),fileNameFor('plan q1 q2',used),fileNameFor('AUX',used)],['Plan Q1 Q2.md','plan q1 q2 2.md','_AUX.md']);
  const doc=withHeader({title:'Leave',url:'https://drive.google.com/file/d/1/view',modified:'2026-11-01'},'Text');
  assert.deepEqual(readHeader(doc),{title:'Leave',source:'https://drive.google.com/file/d/1/view',modified:'2026-11-01'});
  assert.equal(readHeader('---\nsource: javascript:alert(1)\n---\n').source,'','only web addresses lead anywhere');
  assert.equal(notionText([{block:{type:'heading_1',heading_1:{rich_text:[{plain_text:'Title'}]}},depth:0},{block:{type:'to_do',to_do:{checked:true,rich_text:[{plain_text:'Done'}]}},depth:1},{block:{type:'paragraph',paragraph:{rich_text:[]}},depth:0},{block:{type:'paragraph',paragraph:{rich_text:[]}},depth:0}]),'## Title\n  - [x] Done');
  assert.deepEqual(sitemapUrls('<urlset><url><loc>https://a.example/1</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://a.example/2?a=1&amp;b=2</loc></url></urlset>'),[{url:'https://a.example/1',modified:'2026-01-01'},{url:'https://a.example/2?a=1&b=2',modified:''}]);
});

test('a sync reads only what changed, keeps names, and removes what is gone',async()=>{
  const files=new Map(),reads=[];
  let remote=[{id:'a',title:'Alpha',modified:'1',text:'first'},{id:'b',title:'Alpha',modified:'1',text:'second'}];
  // A Drive folder: the list, then each file read on its own.
  const deps={base:()=>'D',extract:async b=>b.toString(),write:async(p,t)=>{files.set(p,t);},remove:async p=>{files.delete(p);},exists:async p=>files.has(p),
    request:async(svc,url,o={})=>{
      if(!o.raw)return {files:remote.map(d=>({id:d.id,name:d.title+'.txt',mimeType:'text/plain',modifiedTime:d.modified,size:10}))};
      const id=decodeURIComponent(url.split('/files/')[1].split('?')[0]),d=remote.find(x=>x.id===id);reads.push(id);
      if(d.text===null)throw Error('locked');return {buf:Buffer.from(d.text),type:'text/plain'};
    }};
  const src={kind:'gdrive',folder:'f',ref:'r'};
  let r=await syncSource(src,{},deps);
  assert.equal(r.added,2);assert.deepEqual([...files.keys()].sort(),['knowledge/f/Alpha 2.md','knowledge/f/Alpha.md']);
  reads.length=0;r=await syncSource(src,r.manifest,deps);assert.equal(r.kept,2);assert.deepEqual(reads,[],'nothing changed, nothing read');
  const before=r.manifest;
  remote=[{id:'b',title:'Beta now',modified:'2',text:'second, changed'},{id:'c',title:'Alpha',modified:'1',text:null}];
  r=await syncSource(src,before,deps);
  assert.equal(r.changed,1);assert.equal(r.removed,1);assert.equal(r.failed,1);assert.match(r.errors[0],/locked/);
  assert.equal(r.manifest.b.file,before.b.file,'a renamed document keeps its file, so citations stay right');
  assert.match(files.get('knowledge/f/'+before.b.file),/^---\ntitle: Beta now\n[\s\S]*second, changed/);
  assert.ok(!files.has('knowledge/f/'+before.a.file),'removed at the source, removed here');
  assert.ok(!r.manifest.c,'what could not be read is tried again next time');
});

test('OneDrive folders are walked, pages followed, and only documents kept',async()=>{
  const files=new Map(),asked=[];
  const pages={'/root':{value:[{id:'1',name:'Rules.md',file:{},lastModifiedDateTime:'t1',webUrl:'https://x/1',size:5},{id:'2',name:'photo.jpg',file:{},size:5},{id:'9',name:'Old',folder:{}}],'@odata.nextLink':'G/next'},
    'G/next':{value:[{id:'3',name:'Big.pdf',file:{},size:2e7},{id:'4',name:'Notes.txt',file:{},lastModifiedDateTime:'t1',size:5}]},
    '/9':{value:[{id:'5',name:'Archive.txt',file:{},lastModifiedDateTime:'t1',size:5}]}};
  const deps={base:()=>'G',extract:async b=>b.toString(),write:async(p,t)=>{files.set(p,t);},remove:async()=>{},exists:async p=>files.has(p),
    request:async(svc,url,o={})=>{
      asked.push(url);assert.equal(svc,'microsoft');
      if(o.raw)return {buf:Buffer.from('text of '+url.match(/items\/(\w+)\/content/)[1])};
      if(url==='G/next')return pages['G/next'];
      if(url.startsWith('G/me/drive/root:/Documents/Team%20docs:/children?'))return pages['/root'];
      return pages['/'+url.match(/items\/(\w+)\/children/)[1]];
    }};
  const r=await syncSource({kind:'onedrive',folder:'od',ref:'/Documents/Team docs'},{},deps);
  assert.equal(r.added,3);assert.deepEqual([...files.keys()].sort(),['knowledge/od/Notes.md','knowledge/od/Old/Archive.md','knowledge/od/Rules.md']);
  assert.ok(!asked.some(u=>/items\/(2|3)\/content/.test(u)),'pictures and files too big are not read');
});

test('a new document in a folder never takes the file of another, and a bad sitemap entry is left out',async()=>{
  const files=new Map();
  let list=[{id:'1',name:'Rules.md',file:{},lastModifiedDateTime:'t1',size:5}];
  const deps={base:()=>'G',extract:async b=>b.toString(),write:async(p,t)=>{files.set(p,t);},remove:async p=>{files.delete(p);},exists:async p=>files.has(p),
    request:async(svc,url,o={})=>o.raw?{buf:Buffer.from('text of '+url.match(/items\/(\w+)\/content/)[1])}:url.includes('/items/9/')?{value:list}:{value:[{id:'9',name:'Team',folder:{}}]}};
  const src={kind:'onedrive',folder:'od',ref:'/'};
  let r=await syncSource(src,{},deps);
  assert.equal(r.manifest['1'].file,'Team/Rules.md');
  list=[...list,{id:'2',name:'Rules.txt',file:{},lastModifiedDateTime:'t1',size:5}];
  r=await syncSource(src,r.manifest,deps);
  assert.equal(r.manifest['1'].file,'Team/Rules.md');assert.equal(r.manifest['2'].file,'Team/Rules 2.md');
  assert.equal(files.get('knowledge/od/Team/Rules.md').trim().split('\n').at(-1),'text of 1','the first copy is not written over');
  const xml='<urlset><url><loc>javascript:alert(1)</loc></url><url><loc>not an address</loc></url><url><loc>https://a.example/ok</loc></url></urlset>';
  const web={...deps,readPage:async(url,o)=>o?.raw?{text:xml}:{title:'Ok',text:'page '+url}};
  r=await syncSource({kind:'web',folder:'w',ref:'https://a.example/sitemap.xml'},{},web);
  assert.equal(r.docs,1);assert.equal(r.added,1);
});

test('search goes on by keywords when the embedding model cannot be reached',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'silo-archive-'));
  try{
    const docs={'a.md':'The office opens at nine.'};
    const idx=new ArchiveIndex(path.join(dir,'index.json'),{list:async()=>[{name:'a.md',size:1,mtime:1}],read:async n=>docs[n],embed:async()=>{throw Error('connect ECONNREFUSED');},model:'m'});
    const hits=await idx.search('office opens');
    assert.equal(hits[0]?.name,'a.md');assert.equal(hits[0].meaning,false);
    assert.ok(existsSync(path.join(dir,'index.json')),'what was read is kept');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('small vectors give the same order',()=>{
  // The same numbers every time, so a near tie cannot make the test flaky.
  let seed=7;const next=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648*2-1;
  const rnd=n=>Array.from({length:n},next),q=rnd(256),vs=Array.from({length:40},()=>rnd(256));
  const cos=(a,b)=>{let d=0,x=0,y=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i];}return d/Math.sqrt(x*y);};
  const exact=vs.map(v=>cos(q,v)),small=vs.map(v=>cos(q,vectorOf({vq:packVector(v)})));
  assert.ok(Math.max(...exact.map((s,i)=>Math.abs(s-small[i])))<0.005,'the similarity moves by less than 0.005');
  const top=s=>s.map((x,i)=>[i,x]).sort((a,b)=>b[1]-a[1])[0][0];assert.equal(top(small),top(exact));
  assert.ok(JSON.stringify(packVector(q)).length<JSON.stringify(q.map(v=>Math.round(v*1e5)/1e5)).length/4,'a quarter of the room or less');
});

test('an old index is read, and documents are searched by their text',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'silo-archive-'));
  try{
    const file=path.join(dir,'index.json'),docs={'a.md':withHeader({title:'Holidays',url:'https://wiki.example/holidays'},'Staff get 25 days of paid leave a year.'),'b.md':'Invoices are paid within 30 days.'};
    await fs.writeFile(file,JSON.stringify({model:'m',files:{'old.md':{sig:'1:1',chunks:[{start:1,end:1,text:'old',terms:{old:1,__len:1},vec:[0.5,-0.5]}]}}}));
    const idx=new ArchiveIndex(file,{list:async()=>Object.keys(docs).map(name=>({name,size:1,mtime:1})),read:async n=>docs[n],model:'m'});
    const data=await idx.load();assert.ok(data.files['old.md'].chunks[0].vq&&!data.files['old.md'].chunks[0].vec,'packed on load');
    const hits=await idx.search('paid leave days');
    assert.equal(hits[0].name,'a.md');assert.equal(hits[0].source,'https://wiki.example/holidays');assert.equal(hits[0].title,'Holidays');
    // A file written while an update runs is in the update asked for after it.
    const first=idx.update();docs['c.md']='Parking is free behind the building.';const second=idx.update();
    await first;assert.ok((await second).files['c.md'],'the later update sees the new file');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('knowledge in a running SILO',async t=>{
  // One fake for Google Drive, Notion and a web site.
  const docx=makeDocx('Travel policy','Trains are booked in second class. Flights need approval from finance.');
  let driveFiles=[{id:'d1',name:'Leave policy.txt',mimeType:'text/plain',modifiedTime:'2026-11-01T10:00:00Z',size:60,webViewLink:'https://drive.google.com/file/d/d1/view',text:'Everyone gets 25 days of paid leave. Ask your manager two weeks ahead.'},
    {id:'d2',name:'Travel.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',modifiedTime:'2026-11-01T10:00:00Z',size:docx.length,webViewLink:'https://drive.google.com/file/d/d2/view'},
    {id:'sub',name:'Finance',mimeType:'application/vnd.google-apps.folder'},
    {id:'d3',name:'Budget',mimeType:'application/vnd.google-apps.document',modifiedTime:'2026-11-01T10:00:00Z',webViewLink:'https://docs.google.com/document/d/d3/edit',parent:'sub',text:'The marketing budget for 2027 is 40,000 euro.'}];
  const reads=[],seen=[];let busyOnce=false;
  const fake=http.createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    const u=new URL(req.url,'http://x'),p=u.pathname;seen.push(p);
    const json=(d,s=200)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(d));};
    if(p==='/notion/users/me')return json({name:'Wiki bot'});
    if(p==='/googleToken')return json({access_token:'g-access',refresh_token:'g-refresh',expires_in:3600});
    if(p==='/gmail/users/me/profile')return json({emailAddress:'ana@example.com'});
    if(p==='/gdrive/files'){const parent=/'([^']+)' in parents/.exec(u.searchParams.get('q'))[1];return json({files:driveFiles.filter(f=>(f.parent||'root1AbCdEf')===parent).map(({text,parent,...f})=>f)});}
    const dm=p.match(/^\/gdrive\/files\/([^/]+)(\/export)?$/);
    if(dm){reads.push(dm[1]);const f=driveFiles.find(x=>x.id===dm[1]);if(dm[1]==='d2'){res.writeHead(200,{'Content-Type':'application/octet-stream'});return res.end(docx);}res.writeHead(200,{'Content-Type':'text/plain'});return res.end(f.text);}
    const page=(id,title,edited)=>({object:'page',id,url:`https://www.notion.so/${id}`,last_edited_time:edited,properties:{title:{type:'title',title:[{plain_text:title}]}}});
    if(p==='/notion/pages/0123456789abcdef0123456789abcdef')return json(page('0123456789abcdef0123456789abcdef','Handbook','2026-11-02'));
    if(p==='/notion/pages/child-1')return json(page('child-1','On-call','2026-11-02'));
    if(p==='/notion/blocks/0123456789abcdef0123456789abcdef/children')return json({results:[{id:'b1',type:'paragraph',paragraph:{rich_text:[{plain_text:'Welcome to the team handbook.'}]}},{id:'child-1',type:'child_page',child_page:{title:'On-call'}}],has_more:false});
    if(p==='/notion/blocks/child-1/children')return json({results:[{id:'b2',type:'bulleted_list_item',has_children:true,bulleted_list_item:{rich_text:[{plain_text:'The on-call phone is answered within 15 minutes.'}]}}],has_more:false});
    // A list three levels under the page: it comes in, also after Notion says once that it is asked too often.
    if(p==='/notion/blocks/b2/children')return json({results:[{id:'b3',type:'bulleted_list_item',has_children:true,bulleted_list_item:{rich_text:[{plain_text:'Keys'}]}}],has_more:false});
    if(p==='/notion/blocks/b3/children'){if(!busyOnce){busyOnce=true;res.writeHead(429,{'Content-Type':'application/json','Retry-After':'0'});return res.end('{"message":"rate limited"}');}return json({results:[{id:'b4',type:'bulleted_list_item',bulleted_list_item:{rich_text:[{plain_text:'The spare keys are in the red box.'}]}}],has_more:false});}
    if(p==='/site/sitemap.xml'){res.writeHead(200,{'Content-Type':'application/xml'});return res.end('<urlset><url><loc>'+site+'/site/faq</loc></url></urlset>');}
    if(p==='/site/faq'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('<html><head><title>FAQ</title></head><body><main><h1>FAQ</h1><p>Our office opens at 8:30 on weekdays and closes at 17:00, so call before then about deliveries and visits to the warehouse.</p><p>Parking is free for visitors in the yard behind the building, and there are two spaces kept for vans.</p></main></body></html>');}
    json({error:'not found '+p},404);
  });
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));const site=`http://127.0.0.1:${fake.address().port}`;
  const port=14481,temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-knowledge-test-')),origin=`http://127.0.0.1:${port}`,work=path.join(temp,'workspace');
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:work,SILO_TEST_CONNECTOR_BASE:site,SILO_TEST_ALLOW_LOCAL_PAGES:'1',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:'',SILO_GOOGLE_CLIENT_ID:'g-silo-app.apps.googleusercontent.com',SILO_GOOGLE_CLIENT_SECRET:'GOCSPX-silo-desktop'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();fake.close();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  const synced=async id=>until(async()=>{const x=(await request('/knowledge')).data.sources.find(s=>s.id===id);return x&&!x.syncing&&x.last&&x;},20000,'the sync');
  let drive,notion,web;

  await t.test('a source needs its account; web pages need none',async()=>{
    assert.equal((await request('/knowledge',{kind:'gdrive',name:'Policies',ref:'root1AbCdEf'})).status,409,'not without the account');
    const r=await request('/knowledge',{kind:'web',name:'Website',ref:site+'/site/sitemap.xml',every:0});assert.equal(r.status,201,JSON.stringify(r.data));
    web=await synced(r.data.id);
    assert.equal(web.last.ok,true,JSON.stringify(web.last));assert.equal(web.last.added,1);assert.equal(web.folder,'knowledge/website');
    const text=await fs.readFile(path.join(work,'knowledge','website','127.0.0.1','FAQ.md'),'utf8');
    assert.match(text,/^---\ntitle: FAQ\nsource: http:\/\/127\.0\.0\.1:\d+\/site\/faq\n/);assert.match(text,/8:30/);
  });
  await t.test('a Drive folder: text, Word and Google Docs, with its folders',async()=>{
    const st=await request('/services/google',{});assert.equal(st.status,200,JSON.stringify(st.data));
    assert.match(await (await fetch(`${origin}/connect/callback?state=${new URL(st.data.url).searchParams.get('state')}&code=ok`)).text(),/is connected/);
    const r=await request('/knowledge',{kind:'gdrive',name:'Policies',ref:'https://drive.google.com/drive/folders/root1AbCdEf',every:60});assert.equal(r.status,201,JSON.stringify(r.data));
    drive=await synced(r.data.id);assert.equal(drive.last.added,3,JSON.stringify(drive.last));
    const dir=path.join(work,'knowledge','policies');
    assert.match(await fs.readFile(path.join(dir,'Leave policy.md'),'utf8'),/^---\ntitle: Leave policy\nsource: https:\/\/drive\.google\.com\/file\/d\/d1\/view\n[\s\S]*25 days/);
    assert.match(await fs.readFile(path.join(dir,'Travel.md'),'utf8'),/second class/);
    assert.match(await fs.readFile(path.join(dir,'Finance','Budget.md'),'utf8'),/40,000 euro/);
    assert.ok(seen.includes('/gdrive/files/d3/export'),'a Google Doc is exported as text');
    // Once more with one file changed and one gone: only that one is read.
    reads.length=0;driveFiles=driveFiles.filter(f=>f.id!=='d2');driveFiles[0]={...driveFiles[0],modifiedTime:'2026-11-03T10:00:00Z',text:'Everyone gets 27 days of paid leave.'};
    await request('/knowledge/'+drive.id+'/sync',{});
    const again=await until(async()=>{const x=(await request('/knowledge')).data.sources.find(s=>s.id===drive.id);return !x.syncing&&x.last.at>drive.last.at&&x;},20000,'second sync');
    assert.deepEqual([again.last.changed,again.last.removed,again.last.added],[1,1,0]);assert.deepEqual(reads,['d1']);
    assert.ok(!existsSync(path.join(dir,'Travel.md')));assert.match(await fs.readFile(path.join(dir,'Leave policy.md'),'utf8'),/27 days/);
  });
  await t.test('Notion pages, with the pages under them',async()=>{
    assert.equal((await request('/services/notion',{token:'secret_fixture'})).status,200);
    const r=await request('/knowledge',{kind:'notion',name:'Handbook',ref:'https://www.notion.so/Handbook-0123456789abcdef0123456789abcdef'});assert.equal(r.status,201);
    notion=await synced(r.data.id);assert.equal(notion.last.added,2,JSON.stringify(notion.last));
    const oncall=await fs.readFile(path.join(work,'knowledge','handbook','Handbook','On-call.md'),'utf8');
    assert.match(oncall,/within 15 minutes/);assert.match(oncall,/spare keys are in the red box/,'blocks three levels down come in');assert.ok(busyOnce,'asked again after a 429');
  });
  await t.test('the search finds documents, says where they came from and how to cite them',async()=>{
    const hits=(await request('/archive/search',{query:'on-call phone answered'})).data.hits;
    assert.equal(hits[0].name,'knowledge/handbook/Handbook/On-call.md');assert.equal(hits[0].source,'https://www.notion.so/child-1');assert.equal(hits[0].title,'On-call');
    // A Word file in the workspace is searched by its text too.
    await fs.writeFile(path.join(work,'Travel.docx'),docx);
    const doc=(await request('/archive/search',{query:'second class trains'})).data.hits;assert.equal(doc[0]?.name,'Travel.docx');
    const k=(await request('/knowledge')).data;assert.ok(k.index.files>=5,JSON.stringify(k.index));assert.equal(k.kinds.gdrive.connected,true);assert.equal(k.kinds.onedrive.connected,false);assert.equal(k.kinds.web.connected,true);
  });
  await t.test('change, sync again, remove: the copies go, the source is untouched',async()=>{
    assert.equal((await request('/knowledge/'+notion.id,{every:60,name:'Team handbook'})).data.every,60);
    assert.equal((await request('/knowledge/'+notion.id,{kind:'web'})).data.kind,'notion','the kind stays');
    assert.equal((await request('/knowledge/'+web.id+'/sync',{})).status,202);
    const again=await until(async()=>{const x=(await request('/knowledge')).data.sources.find(s=>s.id===web.id);return !x.syncing&&x.last.at>web.last.at&&x;},20000,'second sync');
    assert.equal(again.last.added,0);assert.equal(again.last.docs,1);
    assert.equal((await request('/knowledge/'+web.id,undefined,'DELETE')).status,200);
    assert.ok(!existsSync(path.join(work,'knowledge','website')),'its copies are gone');
    assert.ok(existsSync(path.join(work,'knowledge','handbook')),'another source keeps its own');
    assert.equal((await request('/knowledge/'+web.id+'/sync',{})).status,404);
    assert.equal((await request('/knowledge',{kind:'web',name:'Bad',ref:'ftp://x'})).status,400);
  });
});
