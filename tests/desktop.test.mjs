// Desktop apps. The rules always run. The live part opens a small test app and runs only on Windows with
// SILO_TEST_DESKTOP=1, because it puts a window on your screen (it never takes your mouse or keyboard).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendKeysFor, blockedReason, windowText, DesktopWorker } from '../desktop-agent.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000,what='condition'){const end=Date.now()+ms;for(;;){const v=await fn();if(v)return v;if(Date.now()>end)throw Error('Timed out waiting for '+what);await wait(100);}}
const live=process.platform==='win32'&&process.env.SILO_TEST_DESKTOP==='1';

test('key combinations in words become key codes, and some keys are refused',()=>{
  assert.equal(sendKeysFor('ctrl+s'),'^s');assert.equal(sendKeysFor('alt+f4'),'%{F4}');assert.equal(sendKeysFor('ctrl+shift+n'),'^+n');
  assert.equal(sendKeysFor('enter'),'{ENTER}');assert.equal(sendKeysFor('tab tab enter'),'{TAB}{TAB}{ENTER}');
  assert.throws(()=>sendKeysFor('win+r'),/Windows key/);assert.throws(()=>sendKeysFor('ctrl'),/no key/);assert.throws(()=>sendKeysFor('ctrl+a+b'),/two keys/);
});
test('browsers, shells, system tools and password managers are never controlled',()=>{
  for(const p of ['chrome','msedge','firefox','powershell','cmd','WindowsTerminal','Code','regedit','Taskmgr','consent','KeePassXC','1Password','claude'])assert.ok(blockedReason(p),p);
  for(const p of ['notepad','EXCEL','WINWORD','explorer','CalculatorApp','silo-desktop-test'])assert.equal(blockedReason(p),null,p);
});
test('a window read is marked as untrusted and names its controls',()=>{
  const text=windowText({window:{handle:7,process:'notepad',title:'notes.txt',width:800,height:600},text:'Pump 3 leaks.',elements:[{ref:1,type:'Button',name:'Save',acts:['press']},{ref:2,type:'Edit',name:'Password',acts:['type'],password:true}]});
  assert.match(text,/<window id=7 app="notepad" title="notes.txt" size="800x600" trust="untrusted">/);
  assert.match(text,/\[1\] Button "Save" can: press/);assert.match(text,/\[2\] Edit "Password" can: type \(password: never typed by residents\)/);
});

// A tiny WPF app: notes, a password box, a check box and Save, which writes what it got into the title.
async function testApp(dir){
  const exe=path.join(dir,'silo-desktop-test.exe');
  if(!fss.existsSync(exe)){
    const cs=`using System;using System.Windows;using System.Windows.Controls;using System.Windows.Automation;
public static class P{[STAThread]public static void Main(){var w=new Window{Title="SILO desktop test",Width=420,Height=260,ShowActivated=false};
var sp=new StackPanel{Margin=new Thickness(10)};var t=new TextBox();AutomationProperties.SetName(t,"Notes");var pw=new PasswordBox();AutomationProperties.SetName(pw,"Password");
var c=new CheckBox{Content="Urgent"};var b=new Button{Content="Save"};b.Click+=(s,e)=>{w.Title="Saved: "+t.Text+" urgent="+c.IsChecked;};
sp.Children.Add(t);sp.Children.Add(pw);sp.Children.Add(c);sp.Children.Add(b);w.Content=sp;new Application().Run(w);}}`;
    await fs.writeFile(path.join(dir,'app.cs'),cs);
    const ps=`Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase,System.Xaml;$r=@([System.Windows.Window].Assembly.Location,[System.Windows.UIElement].Assembly.Location,[System.Windows.DependencyObject].Assembly.Location,[System.Xaml.XamlReader].Assembly.Location,[System.Windows.Automation.AutomationProperties].Assembly.Location);Add-Type -TypeDefinition (Get-Content -Raw '${path.join(dir,'app.cs')}') -ReferencedAssemblies $r -OutputAssembly '${exe}' -OutputType WindowsApplication`;
    execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{stdio:'ignore'});
  }
  return exe;
}

test('a resident reads and uses a desktop app, only with your OK, and never types passwords',{skip:!live&&'Set SILO_TEST_DESKTOP=1 on Windows to run it'},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'silo-desktop-'));
  const exe=await testApp(temp);
  const app=spawn(exe,[],{stdio:'ignore'});
  const worker=new DesktopWorker();
  const port=14329,api=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['--import','./tests/provider-mock.mjs','server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),SILO_DATA_DIR:path.join(temp,'data'),SILO_WORK_DIR:path.join(temp,'workspace'),OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',COMPATIBLE_API_KEY:'',SILO_SECRET:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b;});
  t.after(async()=>{worker.close();try{app.kill();}catch{}child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(r,3000);});await wait(500);await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:300});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Test server did not start: '+errors)),10000);child.stdout.on('data',b=>{if(b.toString().includes('SILO is ready')){clearTimeout(timer);resolve();}});});
  const win=await until(async()=>(await worker.windows()).find(w=>w.title==='SILO desktop test'),20000,'the test app');
  const shell=(await worker.windows()).find(w=>w.blocked);
  const ses=await fetch(api+'/api/session');const {token}=await ses.json(),cookie=ses.headers.get('set-cookie').split(';')[0];
  const request=async(route,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(api+'/api'+route,{method,headers:{cookie,origin:api,'Content-Type':'application/json','x-silo-token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>({}))};};
  await request('/connections',{provider:'compatible',key:'fixture-desktop-key',model:'fixture',endpoint:'https://example.com/v1/chat/completions'});
  const clerk=(await request('/agents',{name:'Desk Clerk',role:'Fixture',floor:3,provider:'compatible',model:'tool-user',instructions:'Fixture.',tools:['desktop'],vision:'on'})).data;
  const CALL=o=>'CALL '+JSON.stringify({tool:'desktop',...o});
  const chat=message=>request('/agents/'+clerk.id+'/chat',{message});
  const pendingReq=()=>until(async()=>(await request('/state')).data.requests.find(x=>x.status==='pending'),15000,'approval');

  await t.test('listing windows needs nobody, seeing one waits for you',async()=>{
    const pending=chat([CALL({action:'windows'}),CALL({action:'read',window:win.handle})].join('\n'));
    const req=await pendingReq();
    assert.equal(req.tool,'desktop:silo-desktop-test');assert.match(req.title,/see the silo-desktop-test window "SILO desktop test"/);assert.match(req.detail,/goes to this resident's model provider/);
    await request('/requests/'+req.id,{allow:true,always:true});
    const r=await pending;assert.equal(r.status,200,JSON.stringify(r.data));
    assert.match(r.data.text,/\[\d+\] Edit "Notes" can: type/);assert.match(r.data.text,/\[\d+\] Button "Save" can: press/);
  });
  const refOf=async name=>{const r=await chat(CALL({action:'read',window:win.handle}));return Number(r.data.text.match(new RegExp('\\[(\\d+)\\] \\w+ "'+name+'"'))[1]);};

  await t.test('an app allowed always is used without asking, through its controls',async()=>{
    const notes=await refOf('Notes');
    let r=await chat(CALL({action:'type',window:win.handle,ref:notes,text:'pump 3 {ok}'}));assert.match(r.data.text,/Done \(set\)/);
    const urgent=await refOf('Urgent');r=await chat(CALL({action:'click',window:win.handle,ref:urgent}));assert.match(r.data.text,/Done \(toggled\)/);
    const save=await refOf('Save');r=await chat(CALL({action:'click',window:win.handle,ref:save}));assert.match(r.data.text,/Done \(pressed\)/);
    assert.match(r.data.text,/title="Saved: pump 3 \{ok\} urgent=True"/,'the app really did it');
    assert.equal((await request('/state')).data.requests.filter(x=>x.status==='pending').length,0);
  });

  await t.test('passwords, saved keys and blocked apps are refused, and look sends a screenshot',async()=>{
    const pw=await refOf('Password');
    let r=await chat(CALL({action:'type',window:win.handle,ref:pw,text:'hunter22'}));
    const tr=(await request('/traces/'+r.data.traceId)).data;assert.match(tr.spans.find(x=>x.name==='desktop').result,/never type passwords/);
    const notes=await refOf('Notes');r=await chat(CALL({action:'type',window:win.handle,ref:notes,text:'key fixture-desktop-key'}));
    assert.match(JSON.stringify((await request('/traces/'+r.data.traceId)).data.spans),/saved key or password/);
    if(shell){r=await chat(CALL({action:'read',window:shell.handle}));assert.match(JSON.stringify((await request('/traces/'+r.data.traceId)).data.spans),/cannot|is a /);}
    r=await chat(CALL({action:'look',window:win.handle}));assert.match(r.data.text,/\[saw an image\]/);
    const shot=(await request('/traces/'+r.data.traceId)).data.spans.find(x=>x.name==='desktop').artifacts.find(a=>a.type==='screenshot');
    const img=await fetch(api+'/api/browser/shots/'+shot.id+'.jpg',{headers:{cookie}});assert.equal(img.headers.get('content-type'),'image/jpeg');
  });
});
