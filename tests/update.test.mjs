// Updates, the supervisor, start at sign-in and the installer. Everything runs in temporary folders:
// the app folder and its data/ are never written by these tests.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promises as fs,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {compareVersions,feedUrl,safeReleasePath,buildRelease,verifyManifest,signManifest,fetchManifest,downloadRelease,stageUpdate,applyUpdate,rollback,updateInfo,confirmUpdate,listReleaseFiles} from '../update.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const win=process.platform==='win32';

const keys=()=>{const {publicKey,privateKey}=crypto.generateKeyPairSync('ed25519');return {pub:publicKey.export({type:'spki',format:'pem'}),priv:privateKey.export({type:'pkcs8',format:'pem'})};};
const writeTree=async(dir,files)=>{for(const [p,v] of Object.entries(files)){const f=path.join(dir,...p.split('/'));await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,v);}};
const read=(dir,p)=>fs.readFile(path.join(dir,...p.split('/')),'utf8');
const temp=async(t,clean=true)=>{const d=await fs.mkdtemp(path.join(os.tmpdir(),'silo-update-test-'));if(clean)t.after(()=>fs.rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:200}));return d;};
async function publish(feed,release){await fs.mkdir(feed,{recursive:true});await fs.writeFile(path.join(feed,release.zipName),release.zip);await fs.writeFile(path.join(feed,'latest.json'),JSON.stringify(release.manifest));}

test('versions, feeds and the paths a release may hold',()=>{
  assert.equal(compareVersions('1.10.0','1.9.9'),1);assert.equal(compareVersions('1.0.0','1.0.0'),0);assert.equal(compareVersions('0.9.0','1.0.0'),-1);
  assert.equal(feedUrl('https://x.example/silo'),'https://x.example/silo/latest.json');
  assert.equal(feedUrl('https://x.example/silo/'),'https://x.example/silo/latest.json');
  assert.equal(feedUrl('https://x.example/silo/beta.json'),'https://x.example/silo/beta.json');
  assert.equal(feedUrl('C:\\releases\\silo\\'),'file:///C:/releases/silo/latest.json');
  assert.equal(feedUrl('\\\\server\\share\\silo'),'file://server/share/silo/latest.json');
  assert.throws(()=>feedUrl(''),/feed first/);
  assert.equal(safeReleasePath('public/app.js'),'public/app.js');
  for(const bad of ['../x.js','public/../../x','data/state.json','workspace/a.txt','launch.json','/etc/x','a\\b.js','C:/x.js','tests/a.test.mjs','x.log',''])assert.throws(()=>safeReleasePath(bad),/may not hold/,bad);
});

test('a release is signed, checked file by file, installed with a backup and rolled back',async t=>{
  const dir=await temp(t),{pub,priv}=keys(),other=keys().pub;
  const src=path.join(dir,'src'),app=path.join(dir,'app'),data=path.join(dir,'appdata'),feed=path.join(dir,'feed');
  await writeTree(src,{'package.json':'{"version":"1.1.0"}','server.mjs':'v2','public/app.js':'v2','public/new.js':'new','data/state.json':'SECRET','launch.json':'{}','workspace/w.txt':'w','tests/x.test.mjs':'t','debug.log':'l'});
  const release=await buildRelease({root:src,version:'1.1.0',notes:'Better pumps',privateKeyPem:priv});
  assert.deepEqual(Object.keys(release.manifest.files),['package.json','public/app.js','public/new.js','server.mjs'],'data, workspace, tests, logs and launch.json stay out');

  await t.test('the signature and the list are checked',()=>{
    assert.equal(verifyManifest(release.manifest,pub).version,'1.1.0');
    assert.throws(()=>verifyManifest(release.manifest,other),/not signed with this SILO/);
    assert.throws(()=>verifyManifest({...release.manifest,version:'9.9.9'},pub),/not signed/);
    assert.throws(()=>verifyManifest({...release.manifest,files:{...release.manifest.files,'public/evil.js':'0'.repeat(64)}},pub),/not signed/);
    assert.throws(()=>verifyManifest(release.manifest,''),/no release key/);
    const sneaky=signManifest({...release.manifest,files:{...release.manifest.files,'data/state.json':'0'.repeat(64)}},priv);
    assert.throws(()=>verifyManifest(sneaky,pub),/may not hold/,'even a signed release cannot write into data');
  });

  await t.test('a folder feed gives the release, and a changed zip is refused',async()=>{
    await publish(feed,release);
    const m=await fetchManifest(feed,pub);assert.equal(m.notes,'Better pumps');
    const files=await downloadRelease(feed,m);assert.equal(files.size,4);assert.equal(files.get('server.mjs').toString(),'v2');
    const bad=path.join(dir,'feed-bad');await publish(bad,{...release,zip:Buffer.concat([release.zip,Buffer.from('x')])});
    await assert.rejects(downloadRelease(bad,m),/does not match its signed hash/);
    const short=signManifest({...m,files:Object.fromEntries(Object.entries(m.files).filter(([p])=>p!=='public/new.js'))},priv);
    await assert.rejects(downloadRelease(feed,short),/not in its signed list/);
    await assert.rejects(fetchManifest('http://127.0.0.1:9/silo',pub),/https address or a folder/);
  });

  await t.test('installing replaces only app files, keeps a backup and never touches data',async()=>{
    await writeTree(app,{'package.json':'{"version":"1.0.0"}','server.mjs':'v1','public/app.js':'v1','public/old.js':'old','launch.json':'{"port":1}'});
    await writeTree(data,{'state.json':'MINE'});
    const m=await fetchManifest(feed,pub),files=await downloadRelease(feed,m);
    await stageUpdate(data,m,files);assert.equal((await updateInfo(data)).staged,'1.1.0');
    await fs.writeFile(path.join(data,'update','staged','files','server.mjs'),'changed');
    await assert.rejects(applyUpdate({root:app,dataDir:data,publicKeyPem:pub}),/changed on disk/);
    assert.equal(await read(app,'server.mjs'),'v1','nothing was written');
    await stageUpdate(data,m,files);
    assert.deepEqual(await applyUpdate({root:app,dataDir:data,publicKeyPem:pub}),{from:'1.0.0',to:'1.1.0'});
    assert.equal(await read(app,'server.mjs'),'v2');assert.equal(await read(app,'public/new.js'),'new');
    assert.equal(await read(app,'public/old.js'),'old','a file the first update does not know is left alone');
    assert.equal(await read(app,'launch.json'),'{"port":1}');assert.equal(await read(data,'state.json'),'MINE');
    const info=await updateInfo(data);assert.equal(info.backup,'1.0.0');assert.equal(info.pending.to,'1.1.0');assert.equal(info.last.kind,'updated');assert.equal(info.staged,null);
    await confirmUpdate(data);assert.equal((await updateInfo(data)).pending,null);
  });

  await t.test('the next update removes files it dropped, and rolling back puts them back',async()=>{
    await fs.rm(path.join(src,'public','new.js'));await fs.writeFile(path.join(src,'server.mjs'),'v3');await fs.writeFile(path.join(src,'package.json'),'{"version":"1.2.0"}');
    const feed2=path.join(dir,'feed2');await publish(feed2,await buildRelease({root:src,version:'1.2.0',privateKeyPem:priv}));
    const m=await fetchManifest(feed2,pub);await stageUpdate(data,m,await downloadRelease(feed2,m));
    await applyUpdate({root:app,dataDir:data,publicKeyPem:pub});
    assert.equal(await read(app,'server.mjs'),'v3');assert.ok(!existsSync(path.join(app,'public','new.js')),'dropped by the release');
    assert.equal(await read(app,'public/old.js'),'old');
    assert.deepEqual(await rollback({root:app,dataDir:data,reason:'test'}),{from:'1.2.0',to:'1.1.0'});
    assert.equal(await read(app,'server.mjs'),'v2');assert.equal(await read(app,'public/new.js'),'new');
    const info=await updateInfo(data);assert.equal(info.last.kind,'rolled back');assert.equal(info.last.reason,'test');assert.equal(info.backup,null);
    await assert.rejects(rollback({root:app,dataDir:data}),/no earlier version/);
    assert.equal(await read(data,'state.json'),'MINE');
  });
});

// A stand-in server: it reads version.txt, and counts its starts in a file.
const FAKE=`import fs from 'node:fs';
const v=fs.readFileSync(new URL('./version.txt',import.meta.url),'utf8').trim(),f=process.env.FAKE_RUNS;
const runs=(fs.existsSync(f)?Number(fs.readFileSync(f,'utf8')):0)+1;fs.writeFileSync(f,String(runs));
if(v==='bad')process.exit(1);
console.log('SILO is ready');
setTimeout(()=>process.exit(Number(process.env.FAKE_FIRST_EXIT||0)&&runs===1?Number(process.env.FAKE_FIRST_EXIT):0),300);
`;
function supervise(app,data,env){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['supervisor.mjs'],{cwd:app,env:{...process.env,SILO_DATA_DIR:data,PORT:'14345',SILO_SERVER_SCRIPT:'fake-server.mjs',SILO_NO_BROWSER:'1',...env},stdio:['ignore','pipe','pipe']});
    let out='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{out+=b;});
    const timer=setTimeout(()=>{child.kill();reject(Error('The supervisor did not finish: '+out));},30000);
    child.on('exit',code=>{clearTimeout(timer);resolve({code,out});});
  });
}
test('the supervisor restarts SILO after an update and goes back when the new version cannot start',async t=>{
  const dir=await temp(t),{pub,priv}=keys();
  const app=path.join(dir,'app'),data=path.join(dir,'data'),runs=path.join(dir,'runs.txt');
  const code={};for(const f of ['supervisor.mjs','update.mjs','documents.mjs'])code[f]=await fs.readFile(path.join(root,f));
  await writeTree(app,{...code,'fake-server.mjs':FAKE,'version.txt':'good','package.json':'{"version":"1.0.0"}'});
  await fs.mkdir(data,{recursive:true});

  await t.test('exit 75 starts it again, exit 0 stops it',async()=>{
    const r=await supervise(app,data,{FAKE_RUNS:runs,FAKE_FIRST_EXIT:'75'});
    assert.equal(r.code,0,r.out);assert.match(r.out,/Restarting SILO\./);assert.match(r.out,/SILO stopped\./);
    assert.equal(await fs.readFile(runs,'utf8'),'2');
    assert.ok(!existsSync(path.join(data,'silo.pid.json')),'the pid file goes when SILO stops');
    assert.match(await fs.readFile(path.join(data,'logs','silo.log'),'utf8'),/Starting SILO/);
  });
  await t.test('an update that crashes twice before it is ready is rolled back',async()=>{
    const src=path.join(dir,'src');await writeTree(src,{...code,'fake-server.mjs':FAKE,'version.txt':'bad','package.json':'{"version":"2.0.0"}'});
    const feed=path.join(dir,'feed');await publish(feed,await buildRelease({root:src,version:'2.0.0',privateKeyPem:priv}));
    const m=await fetchManifest(feed,pub);await stageUpdate(data,m,await downloadRelease(feed,m));
    await applyUpdate({root:app,dataDir:data,publicKeyPem:pub});
    assert.equal(await read(app,'version.txt'),'bad');
    await fs.rm(runs,{force:true});
    const r=await supervise(app,data,{FAKE_RUNS:runs});
    assert.equal(r.code,0,r.out);assert.match(r.out,/Version 2\.0\.0 could not start\. Went back to version 1\.0\.0\./);
    assert.equal(await read(app,'version.txt'),'good');assert.equal(await fs.readFile(runs,'utf8'),'3','two failed starts, then the old version');
    const info=await updateInfo(data);assert.equal(info.last.kind,'rolled back');assert.match(info.last.reason,/could not start/);assert.equal(info.pending,null);
  });
});

test('start at sign-in makes and removes a shortcut in the Startup folder',{skip:!win&&'Windows only'},async t=>{
  const dir=await temp(t),old=process.env.SILO_STARTUP_DIR;process.env.SILO_STARTUP_DIR=path.join(dir,'Startup');
  t.after(()=>{if(old===undefined)delete process.env.SILO_STARTUP_DIR;else process.env.SILO_STARTUP_DIR=old;});
  const {setStartup,startupStatus,readShortcut,startupLink}=await import('../startup.mjs');
  const here=path.join(dir,'silo');await fs.mkdir(here);
  assert.equal((await startupStatus(here)).enabled,false);
  const on=await setStartup(true,here);assert.equal(on.enabled,true);assert.equal(on.here,true);
  const s=await readShortcut(startupLink());assert.equal(path.resolve(s.target),path.resolve(process.execPath));assert.equal(s.args,'"supervisor.mjs"');assert.equal(s.style,7,'starts minimized');
  assert.equal((await startupStatus(path.join(dir,'other'))).here,false,'a shortcut to another SILO folder is told apart');
  const off=await setStartup(false,here);assert.equal(off.enabled,false);assert.ok(!existsSync(startupLink()));
});

test('System checks, downloads, installs and rolls back an update from a folder feed',async t=>{
  const dir=await temp(t,false),{pub,priv}=keys();
  const app=path.join(dir,'app'),src=path.join(dir,'src'),feed=path.join(dir,'feed'),data=path.join(dir,'data');
  // A copy of SILO to update, so the real app folder is never changed.
  for(const p of await listReleaseFiles(root)){for(const d of [app,src]){const f=path.join(d,...p.split('/'));await fs.mkdir(path.dirname(f),{recursive:true});await fs.copyFile(path.join(root,...p.split('/')),f);}}
  await fs.writeFile(path.join(app,'release-key.pub'),pub);await fs.writeFile(path.join(src,'release-key.pub'),pub);
  const version=JSON.parse(await read(app,'package.json')).version;
  await fs.writeFile(path.join(src,'public','marker.txt'),'new version');
  const pkg=JSON.parse(await read(src,'package.json'));pkg.version='99.0.0';await fs.writeFile(path.join(src,'package.json'),JSON.stringify(pkg));
  await publish(feed,await buildRelease({root:src,version:'99.0.0',notes:'Big one',privateKeyPem:priv}));

  const port=14347,origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['server.mjs'],{cwd:app,env:{...process.env,PORT:String(port),SILO_DATA_DIR:data,SILO_WORK_DIR:path.join(dir,'workspace'),SILO_STARTUP_DIR:path.join(dir,'Startup'),SILO_SUPERVISED:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  // The server goes first, then its folder.
  t.after(async()=>{child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,2000);});await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),15000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const s=await fetch(origin+'/api/session');const {token}=await s.json(),cookie=s.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(origin+'/api'+route,{method,headers:{cookie,origin,'x-silo-token':token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};

  let u=(await request('/system/update')).data;
  assert.equal(u.version,version);assert.equal(u.keyPresent,true);assert.equal(u.supervised,false);assert.equal(u.feed,'');
  assert.equal((await request('/state')).data.app.version,version);
  assert.equal((await request('/system/update',{feed:'http://x.example/silo'})).status,400,'plain http is refused');
  assert.equal((await request('/system/update/check',{})).status,409,'no feed yet');
  assert.equal((await request('/system/update',{feed})).data.feed,feed);
  assert.equal((await request('/system/update/install',{})).status,409,'nothing downloaded yet');
  u=(await request('/system/update/check',{})).data;assert.equal(u.available.version,'99.0.0');assert.equal(u.available.notes,'Big one');
  assert.match(JSON.stringify((await request('/state')).data.events||[]),/SILO 99\.0\.0 is available/);
  u=(await request('/system/update/download',{})).data;assert.equal(u.staged,'99.0.0');
  assert.equal((await request('/system/restart',{})).status,409,'without the supervisor SILO cannot restart itself');
  const inst=await request('/system/update/install',{});
  assert.equal(inst.status,200,JSON.stringify(inst.data));assert.equal(inst.data.to,'99.0.0');assert.equal(inst.data.restarting,false);
  assert.equal(await read(app,'public/marker.txt'),'new version');assert.equal(JSON.parse(await read(app,'package.json')).version,'99.0.0');
  u=(await request('/system/update')).data;assert.equal(u.backup,version);assert.equal(u.last.kind,'updated');assert.equal(u.staged,null);
  const back=await request('/system/update/rollback',{});assert.equal(back.status,200,JSON.stringify(back.data));assert.equal(back.data.to,version);
  assert.ok(!existsSync(path.join(app,'public','marker.txt')),'a file the update added goes with it');
  assert.equal(JSON.parse(await read(app,'package.json')).version,version);
  assert.ok(!existsSync(path.join(root,'public','marker.txt')),'the real app folder was not touched');
  if(win){
    const on=(await request('/system/startup',{enabled:true})).data;assert.equal(on.enabled,true);assert.equal(on.here,true);
    assert.ok(existsSync(path.join(dir,'Startup','SILO.lnk')));
    assert.equal((await request('/system/startup',{enabled:false})).data.enabled,false);
  }
});

const ps=(file,args)=>new Promise(resolve=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file,...args],{timeout:120000,windowsHide:true},(e,out,err)=>resolve({code:e?e.code||1:0,out:String(out)+String(err)})));
test('the installer copies the app without your data, and the uninstaller keeps the data',{skip:!win&&'Windows only'},async t=>{
  const dir=await temp(t),app=path.join(dir,'Programs','SILO'),data=path.join(dir,'SILO data'),work=path.join(dir,'work'),menu=path.join(dir,'menu'),startup=path.join(dir,'startup');
  const r=await ps(path.join(root,'installer','install.ps1'),['-InstallDir',app,'-DataDir',data,'-WorkDir',work,'-Port','14349','-Quiet','-NoRegistry','-NoLaunch','-StartAtSignIn','-StartMenuDir',menu,'-StartupDir',startup]);
  assert.equal(r.code,0,r.out);
  for(const f of ['server.mjs','supervisor.mjs','public/app.js','installer/uninstall.ps1'])assert.ok(existsSync(path.join(app,...f.split('/'))),f);
  for(const f of ['data','workspace','tests','node_modules'])assert.ok(!existsSync(path.join(app,f)),f+' is not copied');
  assert.ok(!existsSync(path.join(data,'state.json')),'no data was copied');
  const launch=JSON.parse(await read(app,'launch.json'));assert.equal(launch.dataDir,data);assert.equal(launch.workDir,work);assert.equal(launch.port,14349);
  assert.ok(existsSync(path.join(menu,'SILO.lnk')));assert.ok(existsSync(path.join(startup,'SILO.lnk')));
  // Installing again keeps the folders it was given the first time.
  const again=await ps(path.join(root,'installer','install.ps1'),['-InstallDir',app,'-Quiet','-NoRegistry','-NoLaunch','-NoShortcuts','-NoStartAtSignIn']);
  assert.equal(again.code,0,again.out);assert.equal(JSON.parse(await read(app,'launch.json')).dataDir,data);
  await fs.writeFile(path.join(data,'state.json'),'{"mine":true}');
  const u=await ps(path.join(app,'installer','uninstall.ps1'),['-Quiet','-NoRegistry','-StartMenuDir',menu,'-StartupDir',startup]);
  assert.equal(u.code,0,u.out);
  assert.ok(!existsSync(app),'the app folder is gone');assert.ok(!existsSync(path.join(menu,'SILO.lnk')));assert.ok(!existsSync(path.join(startup,'SILO.lnk')));
  assert.equal(await read(data,'state.json'),'{"mine":true}','your data stays');
});
