// Runs code for residents on a copy of the workspace, never on the workspace itself.
// With Docker the code runs in a throwaway container without network, with memory, CPU and process limits.
// Without Docker it runs as a local process in the copy, with a time limit and a small environment. That is not
// real isolation: the code can still reach the rest of the computer. The page says so, and every run waits for an OK.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const LANGUAGES=['python','javascript','shell'];
const IMAGES={python:'python:3.12-slim',javascript:'node:22-slim',shell:'node:22-slim'};
const SKIP=new Set(['node_modules','.git','.venv','__pycache__']);

function run(cmd,args,{cwd,env,timeout=60000,input,maxOutput=20000,signal,onKill}={}){
  return new Promise(resolve=>{
    if(signal?.aborted){onKill?.();return resolve({code:-1,stdout:'',stderr:'Stopped.',timedOut:false,aborted:true,ms:0});}
    let child;const started=Date.now();
    try{child=spawn(cmd,args,{cwd,env,windowsHide:true});}catch(e){return resolve({code:-1,stdout:'',stderr:e.message,timedOut:false,aborted:false,ms:0});}
    let stdout='',stderr='',timedOut=false,aborted=false;
    const cap=(s,d)=>s.length>maxOutput?s:(s+d).slice(0,maxOutput+1);
    child.stdout.on('data',d=>{stdout=cap(stdout,d.toString());});child.stderr.on('data',d=>{stderr=cap(stderr,d.toString());});
    const stop=()=>{kill(child);onKill?.();};
    const onAbort=()=>{aborted=true;stop();};
    signal?.addEventListener('abort',onAbort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
    const done=(code,extraErr='')=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);resolve({code,stdout,stderr:stderr+extraErr,timedOut,aborted,ms:Date.now()-started});};
    child.once('error',e=>done(-1,e.message));
    child.once('close',code=>done(code));
    if(input!==undefined)child.stdin.end(input);else child.stdin.end();
  });
}
export function kill(child){
  if(process.platform==='win32'&&child.pid)spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{windowsHide:true}).on('error',()=>{});
  else child.kill('SIGKILL');
}

let dockerCache=null;
export async function dockerAvailable(){
  if(dockerCache&&Date.now()-dockerCache.at<60000)return dockerCache.ok;
  const r=await run('docker',['version','--format','{{.Server.Version}}'],{timeout:6000});
  dockerCache={ok:r.code===0&&!!r.stdout.trim(),at:Date.now()};return dockerCache.ok;
}
// The local programs that run each language. Windows has a store alias called python that only prints a message.
const localCache={};
export async function localCommand(language){
  if(language in localCache)return localCache[language];
  const win=process.platform==='win32';
  const candidates={python:win?[['python',[]],['py',['-3']]]:[['python3',[]],['python',[]]],javascript:[[process.execPath,[]]],shell:win?[['powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File']]]:[['sh',[]]]}[language];
  // Python installed from python.org is often not on the PATH, so the usual folders are checked too.
  if(language==='python'&&win)for(const base of [path.join(process.env.LOCALAPPDATA||'','Programs','Python'),process.env.ProgramFiles||'C:\\Program Files']){
    try{for(const d of (await fs.readdir(base)).filter(d=>/^Python3\d+$/i.test(d)).sort().reverse())candidates.push([path.join(base,d,'python.exe'),[]]);}catch{}
  }
  for(const [cmd,pre] of candidates){
    if(language!=='python'){localCache[language]={cmd,pre};return localCache[language];}
    const r=await run(cmd,[...pre,'--version'],{timeout:8000});
    if(r.code===0&&/Python 3/.test(r.stdout+r.stderr)){localCache[language]={cmd,pre};return localCache[language];}
  }
  return localCache[language]=null;
}
export async function sandboxInfo(mode='auto'){
  const docker=await dockerAvailable();
  const using=mode==='off'?'off':mode==='docker'?(docker?'docker':'missing'):mode==='local'?'local':docker?'docker':'local';
  const local={};for(const l of LANGUAGES)local[l]=!!await localCommand(l);
  return {mode,docker,using,local};
}
export async function copyTree(from,to,budget){
  await fs.mkdir(to,{recursive:true});
  for(const entry of await fs.readdir(from,{withFileTypes:true})){
    if(SKIP.has(entry.name)||entry.isSymbolicLink())continue;
    const a=path.join(from,entry.name),b=path.join(to,entry.name);
    if(entry.isDirectory())await copyTree(a,b,budget);
    else if(entry.isFile()){const s=await fs.stat(a);if(s.size>5_000_000||budget.files>=3000||budget.bytes+s.size>100_000_000)continue;budget.files++;budget.bytes+=s.size;await fs.copyFile(a,b);}
  }
}
export async function snapshot(dir,prefix='',out=new Map()){
  for(const entry of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){
    if(SKIP.has(entry.name)||entry.isSymbolicLink())continue;
    const p=path.join(dir,entry.name),rel=prefix?prefix+'/'+entry.name:entry.name;
    if(entry.isDirectory())await snapshot(p,rel,out);
    else if(entry.isFile()){
      const s=await fs.stat(p);
      const sig=s.size<=200000?s.size+':'+createHash('sha1').update(await fs.readFile(p)).digest('base64url'):s.size+':'+s.mtimeMs;
      out.set(rel,sig);
    }
  }
  return out;
}
const SCRIPT={python:'silo_main.py',javascript:'silo_main.mjs',shell:process.platform==='win32'?'silo_main.ps1':'silo_main.sh'};
// Runs one piece of code. Returns the output and the files the code created or changed in its copy of the workspace.
export async function runCode({language,code},{work,mode='auto',expectedMode,expectedHash,timeout=60000,signal,textFile=/\.(txt|md|json|csv|js|mjs|ts|py|html|css|yaml|yml|xml|svg|log)$/i}){
  if(signal?.aborted)throw signal.reason||new Error('Stopped.');
  if(!LANGUAGES.includes(language))throw new Error('Choose python, javascript or shell.');
  if(typeof code!=='string'||!code.trim())throw new Error('There is no code to run.');
  if(code.length>100000)throw new Error('The code is longer than 100,000 characters.');
  if(expectedHash&&createHash('sha256').update(language+':'+code).digest('hex')!==expectedHash)throw new Error('Code changed after approval. Refusing to run.');
  const info=await sandboxInfo(mode);
  if(info.using==='off')throw new Error('The sandbox is turned off in System.');
  if(info.using==='missing')throw new Error('The sandbox is set to Docker, but Docker is not running.');
  if(expectedMode&&info.using!==expectedMode)throw new Error(`Sandbox isolation changed from ${expectedMode} to ${info.using}. Re-approval is required before running code.`);
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-sandbox-')),dir=path.join(temp,'work');
  try{
    await copyTree(work,dir,{files:0,bytes:0});
    if(signal?.aborted)throw signal.reason||new Error('Stopped.');
    const docker=info.using==='docker',script=docker&&language==='shell'?'silo_main.sh':SCRIPT[language];
    await fs.writeFile(path.join(dir,script),code);
    const before=await snapshot(dir);
    let r;
    if(docker){
      const inner={python:['python',script],javascript:['node',script],shell:['sh',script]}[language];
      const cname='silo-sbx-'+randomBytes(6).toString('hex');
      const stopContainer=()=>{try{spawn('docker',['rm','-f',cname],{windowsHide:true}).on('error',()=>{});}catch{}};
      r=await run('docker',['run','--rm','--name',cname,'--network','none','--memory','512m','--cpus','1','--pids-limit','256','--security-opt','no-new-privileges','-v',`${dir}:/work`,'-w','/work',IMAGES[language],...inner],{timeout,signal,onKill:stopContainer});
    }else{
      const local=await localCommand(language);if(!local)throw new Error(language==='python'?'Python 3 is not installed on this computer.':'No program to run this language was found.');
      const keep=['PATH','Path','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','LANG','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA'];
      const env=Object.fromEntries(keep.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));env.PYTHONIOENCODING='utf-8';env.PYTHONDONTWRITEBYTECODE='1';
      r=await run(local.cmd,[...local.pre,script],{cwd:dir,env,timeout,signal});
    }
    if(r.aborted||signal?.aborted)throw signal?.reason||new Error('Stopped.');
    const after=await snapshot(dir),changed=[];
    for(const [name,sig] of after){
      if(name===script||before.get(name)===sig||!textFile.test(name))continue;
      const full=path.join(dir,name),size=(await fs.stat(full)).size;if(size>200000)continue;
      changed.push({name,content:await fs.readFile(full,'utf8')});if(changed.length>=10)break;
    }
    return {mode:info.using,exitCode:r.code,stdout:r.stdout.slice(0,20000),stderr:r.stderr.slice(0,8000),timedOut:r.timedOut,ms:r.ms,changed};
  }finally{await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});}
}
