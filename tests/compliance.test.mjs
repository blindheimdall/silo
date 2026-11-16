// The compliance report: model calls and decisions in the audit log, a report built from them for a period, what it
// points out, and the files it gives (PDF, Markdown, JSON), for owners only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {placeOf, modelDetail, readModelDetail, buildReport, reportMarkdown} from '../compliance.mjs';
import {roleAllows} from '../vault.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

const setup=(over={})=>({silo:{name:'Silo 18',version:'0.1.0'},accounts:{total:1,owner:1,roles:{owner:1}},sso:false,tokens:0,network:false,sandbox:'auto',pact:true,audit:{months:0,keyed:true},dataDir:'/data',
  guardrails:{pii:{mode:'off',kinds:[],terms:[],local:true},injection:{mode:'warn'},rules:[]},residents:[{name:'Ana',role:'Clerk',provider:'openai',model:'gpt-5',tools:['github'],trusted:[]}],channels:[],grants:[],pending:0,...over});
const rec=(action,o={})=>({time:'2026-11-10T10:00:00.000Z',action,outcome:'ok',actor:'Ana',...o});

test('where a host is, and a model call as an audit detail and back',()=>{
  assert.equal(placeOf('127.0.0.1:11434'),'this computer');assert.equal(placeOf('localhost'),'this computer');assert.equal(placeOf('[::1]:8080'),'this computer');
  assert.equal(placeOf('192.168.1.20:1234'),'your network');assert.equal(placeOf('gpu.lan'),'your network');assert.equal(placeOf('172.20.0.3'),'your network');
  assert.equal(placeOf('api.openai.com'),'internet');assert.equal(placeOf('172.40.0.3'),'internet');
  // A name is not read as an address: fdic.gov is on the internet, [fd00::1] and a Tailscale address are not.
  assert.equal(placeOf('fdic.gov'),'internet');assert.equal(placeOf('fd-ai.com:443'),'internet');
  assert.equal(placeOf('[fd00::1]:80'),'your network');assert.equal(placeOf('100.101.1.2:11434'),'your network');assert.equal(placeOf('gpu-box:11434'),'your network');
  const d=modelDetail({host:'api.openai.com',input:120,output:30,hidden:{email:2,phone:1},from:'workflow run',test:true});
  assert.equal(d,'host=api.openai.com in=120 out=30 hidden=email:2,phone:1 from=workflow_run test');
  assert.deepEqual(readModelDetail(d),{host:'api.openai.com',input:120,output:30,hidden:{email:2,phone:1},from:'workflow_run',test:true});
  assert.equal(modelDetail({host:'x'}),'host=x in=0 out=0');
});

test('the report counts where data went, decisions, catches and changes, and says what deserves a look',()=>{
  const records=[
    rec('model.call',{target:'openai:gpt-5',detail:modelDetail({host:'api.openai.com',input:100,output:20})}),
    rec('model.call',{target:'openai:gpt-5',detail:modelDetail({host:'api.openai.com',input:50,output:10,hidden:{email:1}})}),
    rec('model.call',{target:'ollama:llama3',actor:'Bo',detail:modelDetail({host:'127.0.0.1:11434',input:10,output:5})}),
    rec('model.call',{target:'openai:gpt-5',outcome:'failed',detail:modelDetail({host:'api.openai.com'})}),
    rec('resident.tool',{target:'github'}),rec('resident.tool',{target:'github',outcome:'failed'}),
    rec('request.allow'),rec('request.deny'),rec('run.approve'),
    rec('guardrail.injection',{detail:'read_page: tells the model to ignore its instructions'}),
    rec('sign-in'),rec('sign-in',{outcome:'denied'}),
    rec('POST /api/settings',{status:200}),rec('POST /api/settings',{status:200}),rec('POST /api/users',{status:403,outcome:'denied'}),
    rec('POST /api/agents/:id/chat',{status:200}),
  ];
  const r=buildReport({records,chain:{ok:true,records:40},now:setup({residents:[...setup().residents,{name:'Bo',role:'Local',provider:'ollama',model:'llama3',tools:['write_files'],trusted:['write_files']}]}),from:Date.parse('2026-11-01'),to:Date.parse('2026-11-30')});
  assert.equal(r.totals.calls,4);assert.equal(r.totals.external,3);assert.equal(r.totals.externalUnhidden,2);assert.equal(r.totals.withHidden,1);assert.equal(r.totals.failed,1);
  assert.deepEqual(r.totals.hidden,{email:1});
  const openai=r.destinations[0];assert.equal(openai.host,'api.openai.com');assert.equal(openai.calls,3);assert.equal(openai.place,'internet');assert.deepEqual(openai.residents,['Ana']);
  assert.equal(r.destinations[1].place,'this computer');
  assert.deepEqual(r.residents.find(x=>x.name==='Ana'),{name:'Ana',calls:3,internet:3,tools:2,failedTools:1});
  assert.deepEqual(r.tools,[{tool:'github',uses:2,failed:1,residents:['Ana']}]);
  assert.deepEqual(r.oversight,{allowed:1,denied:1,approved:1,rejected:0,pending:0});
  assert.deepEqual(r.guardrails.counts,{injection:1});
  assert.equal(r.access.signIns,1);assert.equal(r.access.failedSignIns,1);assert.equal(r.access.refused,1);
  assert.deepEqual(r.access.changes,[{action:'POST /api/settings',count:2}],'a chat is work, not a change of settings');
  const levels=r.findings.map(f=>f.level+':'+f.text.slice(0,30));
  assert.match(levels[0],/^high:2 model calls went to models/);
  assert.ok(r.findings.some(f=>f.level==='medium'&&/Bo \(write_files\)/.test(f.text)),'a resident that acts without asking');
  assert.ok(r.findings.some(f=>f.level==='ok'&&/chain is whole: 40/.test(f.text)));
  const md=reportMarkdown(r);
  for(const h of ['# SILO compliance report','## Findings','## Where data went','## Residents','## Human oversight','## Guardrails','## Access and changes','## Set up now'])assert.ok(md.includes(h),h);
  assert.match(md,/\| openai \| gpt-5 \| api\.openai\.com \| internet \| 3 \| 1 \| 1 \| email 1 \| Ana \|/);
  assert.match(md,/not legal advice/);
});

test('findings for a broken chain, no accounts, public channels, short keeping and placeholders on',()=>{
  const r=buildReport({records:[],chain:{ok:false,records:3,broken:{file:'audit-2026-11.jsonl',line:4,reason:'This record was changed, or the audit key changed.'}},now:setup({accounts:{total:0,owner:0,roles:{}},audit:{months:3,keyed:false},channels:[{kind:'widget',resident:'Ana',public:true},{kind:'slack',resident:'Ana',public:false}],guardrails:{pii:{mode:'mask',kinds:['email'],terms:['(listed)'],local:true},injection:{mode:'off'},rules:[]}}),from:0,to:1});
  const t=r.findings.map(f=>f.level+' '+f.text).join('\n');
  assert.match(t,/^high The audit log chain breaks in audit-2026-11\.jsonl, line 4/);
  assert.match(t,/high SILO has no accounts/);assert.match(t,/medium Checking tool results for orders .* is off/);
  assert.match(t,/medium The audit chain uses the built-in key/);assert.match(t,/medium The audit log is kept for 3 months/);
  assert.match(t,/info People outside talk to residents on widget \(Ana\)\. /);assert.doesNotMatch(t,/slack \(Ana\)/);
  assert.match(t,/ok Personal data is hidden from models as placeholders, except for models on this computer/);
  assert.match(reportMarkdown(r),/No model calls in this period\./);
});

test('only owners read the report',()=>{
  assert.equal(roleAllows('owner','GET','/api/compliance'),true);
  assert.equal(roleAllows('operator','GET','/api/compliance'),false);
  assert.equal(roleAllows('viewer','GET','/api/compliance'),false);
});

test('inside SILO: model calls and page decisions reach the audit log and the report',async t=>{
  const port=14485,temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-comp-test-')),origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const headers={cookie,origin,'Content-Type':'application/json','x-silo-token':token};
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  await request('/connections',{provider:'compatible',key:'fixture-key-comp',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  await request('/settings',{guardrails:{pii:{mode:'mask'},rules:'tool ask write_file'}});
  const clerk=(await request('/agents',{name:'Clerk',role:'Fixture',floor:3,provider:'compatible',model:'tool-user',instructions:'Fixture.',tools:['read_files','write_files']})).data;
  await request('/agents/'+clerk.id+'/chat',{message:'Mail ana.pop@example.ro please.'});
  // A request decided on the page is in the audit log with its decision.
  const pending=request('/agents/'+clerk.id+'/chat',{message:'CALL '+JSON.stringify({tool:'write_file',name:'a.md',content:'a'})});
  let rq;for(let i=0;i<100&&!rq;i++){rq=(await request('/state')).data.requests.find(x=>x.status==='pending');if(!rq)await new Promise(r=>setTimeout(r,50));}
  assert.ok(rq,'the ask rule holds the call');
  await request('/requests/'+rq.id,{allow:false});await pending;

  const r=(await request('/compliance')).data;
  const d=r.destinations.find(x=>x.host==='example.com');
  assert.ok(d,JSON.stringify(r.destinations));assert.equal(d.provider,'compatible');assert.equal(d.place,'internet');assert.ok(d.calls>=2);assert.deepEqual(d.residents,['Clerk']);
  assert.ok(d.withHidden>=1);assert.ok(r.totals.hidden.email>=1);
  assert.ok(r.oversight.denied>=1,'the denial on the page is counted');
  assert.ok(r.residents.some(x=>x.name==='Clerk'&&x.calls>=2));
  assert.ok(r.access.changes.some(c=>c.action==='POST /api/settings'));
  assert.ok(r.findings.some(f=>f.level==='high'&&/no accounts/.test(f.text)));
  assert.ok(r.findings.some(f=>f.level==='ok'&&/hidden from models/.test(f.text)));
  const audit=(await request('/audit?q=model.call')).data.records;
  assert.ok(audit.length>=2);assert.match(audit[0].detail,/^host=example\.com in=\d+ out=\d+/);assert.doesNotMatch(JSON.stringify(audit),/ana\.pop/,'never what was said');

  const pdf=await fetch(origin+'/api/compliance?format=pdf&download=1',{headers});
  assert.equal(pdf.status,200);assert.equal(pdf.headers.get('content-type'),'application/pdf');assert.match(pdf.headers.get('content-disposition'),/silo-compliance-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.pdf/);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
  const md=await (await fetch(origin+'/api/compliance?format=md&download=1&from=2020-01-01',{headers})).text();
  assert.match(md,/## Where data went/);assert.match(md,/\| example\.com \| internet \|/);
  assert.equal((await request('/compliance?from=2026-12-01&to=2026-11-01')).status,400);
  assert.equal((await request('/compliance?format=docx')).status,400);
  assert.ok((await request('/audit?q=compliance.report')).data.records.length>=2,'making a file is in the audit log');
});
