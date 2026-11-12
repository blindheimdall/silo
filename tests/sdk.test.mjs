// The Python SDK (sdk/python) against an isolated test SILO, and the Python tool template. Skipped without Python 3.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {localCommand} from '../sandbox.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const py=await localCommand('python');
const python=(args,env={})=>new Promise(resolve=>{
  const p=spawn(py.cmd,[...py.pre,'-I',...args],{cwd:root,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',...env},windowsHide:true});
  let out='';p.stdout.on('data',d=>{out+=d;});p.stderr.on('data',d=>{out+=d;});p.on('exit',code=>resolve({code,out}));
});

test('the Python tool template compiles',{skip:!py&&'Python 3 is not installed'},async()=>{
  const r=await python(['-c','import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())','sdk/python/templates/silo-tool/server.py']);
  assert.equal(r.code,0,r.out);
});

test('silo-os: the Python client against a test SILO',{skip:!py&&'Python 3 is not installed'},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-sdk-test-'));
  const port=14399,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body)=>{const r=await fetch(origin+'/api'+route,{method:body===undefined?'GET':'POST',headers:{cookie,origin,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return r.json();};
  await request('/connections',{provider:'compatible',key:'fixture-key-sdk',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  const clerk=await request('/agents',{name:'Clerk',role:'Fixture',floor:2,provider:'compatible',model:'fixture',instructions:'Fixture.'});
  const flow=await request('/workflows',{name:'Stand',steps:[{agentId:clerk.id,prompt:'Answer the customer.'}]});
  await request('/workflows/'+flow.id+'/tests',{repeat:1,tests:[{name:'Answers',input:'Apples?',checks:[{op:'contains',text:'fixture'}]}]});
  const full=(await request('/tokens',{name:'SDK',scopes:['read','run','approve'],days:7})).secret,read=(await request('/tokens',{name:'SDK read',scopes:['read'],days:7})).secret;
  const r=await python(['sdk/python/tests/test_client.py'],{SILO_TEST_URL:origin,SILO_TEST_TOKEN:full,SILO_TEST_READ_TOKEN:read});
  assert.equal(r.code,0,r.out);
  assert.match(r.out,/Ran 10 tests/);assert.doesNotMatch(r.out,/skipped/);
});
