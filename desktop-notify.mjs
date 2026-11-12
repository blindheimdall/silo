// Windows notifications (the cards in the corner of the screen) through PowerShell, with no packages.
// Buttons open an address in your browser. For approvals that address is a one-time link that asks you to confirm.
import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

export const toastAvailable=()=>process.platform==='win32'||!!process.env.SILO_TOAST_LOG;
const APP_ID='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const xml=s=>String(s??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
const sent=[];

// toast: {title, body, open (address for a click on the card), buttons:[{label,url}]}
export function showToast({title,body='',open='',buttons=[]}){
  // Tests write the notification to a file instead of showing it on the screen.
  if(process.env.SILO_TOAST_LOG)return appendFile(process.env.SILO_TOAST_LOG,JSON.stringify({title,body,open,buttons})+'\n').then(()=>true,()=>false);
  if(!toastAvailable())return Promise.resolve(false);
  const now=Date.now();while(sent.length&&now-sent[0]>60000)sent.shift();
  if(sent.length>=10)return Promise.resolve(false);sent.push(now);
  const actions=buttons.slice(0,3).map(b=>`<action content="${xml(b.label).slice(0,40)}" activationType="protocol" arguments="${xml(b.url)}"/>`).join('');
  const doc=`<toast${open?` activationType="protocol" launch="${xml(open)}"`:''}><visual><binding template="ToastGeneric"><text>${xml(String(title).slice(0,120))}</text><text>${xml(String(body).slice(0,300))}</text></binding></visual>${actions?`<actions>${actions}</actions>`:''}</toast>`;
  const ps=`$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('${doc.replace(/'/g,"''")}')
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show((New-Object Windows.UI.Notifications.ToastNotification $x))`;
  return new Promise(resolve=>{
    let child;try{child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{windowsHide:true,stdio:'ignore'});}catch{return resolve(false);}
    const t=setTimeout(()=>{try{child.kill();}catch{}resolve(false);},15000);
    child.once('error',()=>{clearTimeout(t);resolve(false);});
    child.once('exit',code=>{clearTimeout(t);resolve(code===0);});
  });
}
