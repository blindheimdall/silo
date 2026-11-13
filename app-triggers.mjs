// App triggers: a workflow starts when something happens in an app. SILO asks the app every 15 seconds, minute or
// 5 minutes with the account connected in IT / Uplink (or, for feeds and web pages, with no account at all), remembers
// what it has already seen, and starts the workflow once for each new thing. What was there before the trigger was
// turned on is left alone. Each check returns { seen, items }: seen is kept with the workflow, items are { id, title, text }.
// GitHub and Slack can also send the event the moment it happens (a webhook); appEvent reads those, with the same item
// ids as the checks, so one issue never starts the workflow twice.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { serviceBase as B, serviceRequest, htmlText } from './connectors.mjs';
import { safeUrl } from './mcp-auth.mjs';
import { HOOK_APP_LIST } from './webhook-apps.mjs';

const enc=encodeURIComponent;
const one=(s,n=200)=>String(s??'').replace(/\s+/g,' ').trim().slice(0,n);
const clip=(s,n=12000)=>{s=String(s??'');return s.length>n?s.slice(0,n)+`\n[cut: ${s.length-n} more characters]`:s;};
const keepLast=(list,n=300)=>list.slice(-n);
const get=(svc,ctx,url)=>serviceRequest(svc,ctx,'GET',url);
const post=(svc,ctx,url,body)=>serviceRequest(svc,ctx,'POST',url,{body});
const repoOf=v=>{const r=String(v||'').trim();if(!/^[\w.-]+\/[\w.-]+$/.test(r))throw new Error('Give the repository as owner/name.');return r;};
// The id of a Google Sheet or Notion database, also when a whole link is pasted.
const sheetId=v=>{const s=String(v||'').trim(),m=s.match(/\/spreadsheets\/d\/([\w-]{20,})/);const id=m?m[1]:s;if(!/^[\w-]{20,}$/.test(id))throw new Error('Give the link of the Google Sheet, or its id.');return id;};
const notionId=v=>{const s=String(v||'').replace(/-/g,''),m=s.match(/([0-9a-f]{32})(?:\?|$)/i)||s.match(/([0-9a-f]{32})/i);if(!m)throw new Error('Give the link of the Notion database, or its id.');return m[1];};
// New ids in the order they came, the oldest first, and the list of ids to remember.
function fresh(ids,seen){const known=new Set(seen?.ids||[]);return {ids:keepLast([...(seen?.ids||[]),...ids.filter(x=>!known.has(x))]),add:seen?ids.filter(x=>!known.has(x)):[]};}
// When a check finds more than it hands on at once: what is remembered is what was there before plus what was handed
// on (or skipped on purpose), so the rest is still new at the next check. The first check remembers everything.
const seenAfter=(seen,f,done)=>seen?keepLast([...(seen.ids||[]),...done]):f.ids;

const slackItem=(m,channel)=>({id:m.ts,title:one(m.text||'(message)',100),text:`Slack message in ${channel}\nFrom: ${m.user||m.bot_id||'someone'}\nTime: ${new Date(Number(m.ts)*1000).toISOString()}\n\n${clip(m.text||'',6000)}`});
const issueItem=(i,repo)=>({id:'#'+i.number,title:`#${i.number} ${one(i.title,100)}`,text:`Issue #${i.number} in ${repo}: ${i.title}\nBy: ${i.user?.login||''}\nLabels: ${(i.labels||[]).map(l=>l.name).join(', ')||'none'}\n${i.html_url||''}\n\n${clip(i.body||'',8000)}`});
const pullItem=(i,repo)=>({id:'#'+i.number,title:`#${i.number} ${one(i.title,100)}`,text:`Pull request #${i.number} in ${repo}: ${i.title}\nBy: ${i.user?.login||''}\nFrom ${i.head?.ref||'?'} into ${i.base?.ref||'?'}\n${i.html_url||''}\n\n${clip(i.body||'',8000)}`});
const slackKept=(m,cfg)=>(!m.subtype||m.subtype==='file_share')&&(!cfg.contains||String(m.text||'').toLowerCase().includes(cfg.contains.toLowerCase()));

export const TRIGGERS={
  'google.mail':{service:'google',label:'New email in Gmail',fields:[{key:'query',label:'Only mail matching (Gmail search, optional)',placeholder:'from:billing@acme.com has:attachment'}],
    async check(ctx,cfg,seen){
      const q=['in:inbox',cfg.query||''].join(' ').trim();
      // Newest first, page after page until a message seen before (or 5 pages of 100), so a burst of mail between two
      // checks is not cut at the first page. The first check only learns the first page.
      const known=new Set(seen?.ids||[]),got=[];let page='';
      for(let n=0;n<5;n++){
        const list=await get('google',ctx,`${B('gmail')}/users/me/messages?maxResults=${seen?100:15}&q=${enc(q)}${page?'&pageToken='+enc(page):''}`);
        const ids=(list.messages||[]).map(m=>m.id);got.push(...ids);
        page=list.nextPageToken;if(!seen||!page||ids.some(id=>known.has(id)))break;
      }
      const ids=got.reverse(),f=fresh(ids,seen);
      // At most 10 a check, the oldest first; the others come at the next check.
      const take=f.add.slice(0,10),items=[];
      for(const id of take){
        const m=await get('google',ctx,`${B('gmail')}/users/me/messages/${enc(id)}?format=full`);
        const h=n=>(m.payload?.headers||[]).find(x=>x.name.toLowerCase()===n)?.value||'';
        items.push({id,title:one(h('subject')||'(no subject)',120),text:`From: ${h('from')}\nTo: ${h('to')}\nDate: ${h('date')}\nSubject: ${h('subject')}\n\n${clip(gmailText(m.payload)||m.snippet||'')}`});
      }
      return {seen:{ids:seenAfter(seen,f,take)},items};
    }},
  'google.sheet_row':{service:'google',label:'New row in a Google Sheet',fields:[{key:'sheet',label:'Link of the sheet',required:true,placeholder:'https://docs.google.com/spreadsheets/d/...'},{key:'tab',label:'Tab name (optional, the first one if empty)',placeholder:'Orders'}],
    async check(ctx,cfg,seen){
      const id=sheetId(cfg.sheet),range=cfg.tab?`'${String(cfg.tab).replace(/'/g,"''")}'!A1:Z5000`:'A1:Z5000';
      const d=await get('google',ctx,`${B('sheets')}/spreadsheets/${enc(id)}/values/${enc(range)}?majorDimension=ROWS`);
      const rows=d.values||[],head=rows[0]||[],count=rows.length;
      if(!seen)return {seen:{rows:count},items:[]};
      // Rows that were deleted move the count back; only rows past the last count are new. At most 20 a check, the first
      // new ones first, and the count moves on only past the rows handed on.
      const from=Math.min(seen.rows,count),items=rows.slice(from,from+20).map((r,i)=>{const n=from+i+1;return {id:'row'+n,title:`Row ${n}: ${one(r.filter(Boolean).join(', '),100)}`,text:`Sheet row ${n}\n`+r.map((v,k)=>`${head[k]||'Column '+(k+1)}: ${v}`).join('\n')};});
      return {seen:{rows:from+items.length},items};
    }},
  'google.drive_file':{service:'google',label:'New or changed file in Google Drive',fields:[{key:'query',label:'Name contains (optional)',placeholder:'invoice'}],
    async check(ctx,cfg,seen){
      const since=seen?.since||new Date().toISOString(),name=String(cfg.query||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
      if(!seen)return {seen:{since,at:[]},items:[]};
      // The oldest changes first, page after page, at most 20 a check. The mark moves only to the last change handed on;
      // changes made in that same second and already handed on are remembered (at), so none is lost or given twice.
      const q=`modifiedTime >= '${since}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'${name?` and name contains '${name}'`:''}`;
      const done=new Set(seen.at||[]),files=[];let page='';
      for(let n=0;n<10&&files.length<20;n++){
        const d=await get('google',ctx,`${B('gdrive')}/files?pageSize=100&orderBy=modifiedTime&fields=${enc('nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,lastModifyingUser(displayName))')}&q=${enc(q)}${page?'&pageToken='+enc(page):''}`);
        for(const f of d.files||[])if(files.length<20&&!done.has(f.id+'@'+f.modifiedTime))files.push(f);
        page=d.nextPageToken;if(!page)break;
      }
      const last=files.reduce((m,f)=>f.modifiedTime>m?f.modifiedTime:m,since);
      const at=[...(last===since?seen.at||[]:[]),...files.filter(f=>f.modifiedTime===last).map(f=>f.id+'@'+f.modifiedTime)].slice(-300);
      return {seen:{since:last,at},items:files.map(f=>({id:f.id+'@'+f.modifiedTime,title:one(f.name,120),text:`File: ${f.name}\nKind: ${f.mimeType}\nChanged: ${f.modifiedTime}${f.lastModifyingUser?.displayName?' by '+f.lastModifyingUser.displayName:''}\nId: ${f.id}\n${f.webViewLink||''}`}))};
    }},
  'google.event_soon':{service:'google',label:'Google Calendar event about to start',fields:[{key:'minutes',label:'Minutes before it starts',placeholder:'15',number:true}],
    async check(ctx,cfg,seen){
      const ahead=Math.max(1,Math.min(1440,Number(cfg.minutes)||15)),now=new Date();
      const d=await get('google',ctx,`${B('gcal')}/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=20&timeMin=${enc(now.toISOString())}&timeMax=${enc(new Date(now.getTime()+ahead*60000).toISOString())}`);
      const evs=(d.items||[]).filter(e=>e.start?.dateTime),f=fresh(evs.map(e=>e.id+'@'+e.start.dateTime),seen||{ids:[]});
      return {seen:{ids:f.ids},items:evs.filter(e=>f.add.includes(e.id+'@'+e.start.dateTime)).map(e=>({id:e.id+'@'+e.start.dateTime,title:one(e.summary||'(no title)',120),text:`Event: ${e.summary||''}\nStarts: ${e.start.dateTime}\nEnds: ${e.end?.dateTime||''}\n${e.location?'Where: '+e.location+'\n':''}${(e.attendees||[]).length?'With: '+e.attendees.map(a=>a.email).join(', ')+'\n':''}\n${clip(e.description||'',4000)}`}))};
    }},
  'microsoft.mail':{service:'microsoft',label:'New email in Outlook',fields:[{key:'from',label:'Only from (optional)',placeholder:'billing@acme.com'},{key:'subject',label:'Subject contains (optional)',placeholder:'invoice'}],
    async check(ctx,cfg,seen){
      // Newest first, page after page until a message seen before (or 5 pages), at most 10 handed on a check, the oldest
      // first; the rest stay new for the next check.
      const known=new Set(seen?.ids||[]),got=[];let next=`${B('graph')}/me/mailFolders/inbox/messages?$top=${seen?50:15}&$orderby=receivedDateTime%20desc&$select=id,subject,from,toRecipients,receivedDateTime,body`;
      for(let n=0;n<5&&next;n++){
        const d=await get('microsoft',ctx,next);got.push(...(d.value||[]));
        next=seen&&!(d.value||[]).some(m=>known.has(m.id))?d['@odata.nextLink']:'';
        if(next&&!String(next).startsWith(B('graph')+'/'))next='';
      }
      const list=got.reverse(),f=fresh(list.map(m=>m.id),seen),take=new Set(f.add.slice(0,10));
      const items=list.filter(m=>take.has(m.id)).filter(m=>(!cfg.from||String(m.from?.emailAddress?.address||'').toLowerCase().includes(cfg.from.toLowerCase()))&&(!cfg.subject||String(m.subject||'').toLowerCase().includes(cfg.subject.toLowerCase())))
        .map(m=>({id:m.id,title:one(m.subject||'(no subject)',120),text:`From: ${m.from?.emailAddress?.address||''}\nTo: ${(m.toRecipients||[]).map(r=>r.emailAddress?.address).join(', ')}\nDate: ${m.receivedDateTime}\nSubject: ${m.subject}\n\n${clip(m.body?.contentType==='html'?htmlText(m.body.content):m.body?.content||'')}`}));
      return {seen:{ids:seenAfter(seen,f,[...take])},items};
    }},
  'microsoft.event_soon':{service:'microsoft',label:'Outlook Calendar event about to start',fields:[{key:'minutes',label:'Minutes before it starts',placeholder:'15',number:true}],
    async check(ctx,cfg,seen){
      const ahead=Math.max(1,Math.min(1440,Number(cfg.minutes)||15)),now=new Date();
      const d=await get('microsoft',ctx,`${B('graph')}/me/calendarView?startDateTime=${enc(now.toISOString())}&endDateTime=${enc(new Date(now.getTime()+ahead*60000).toISOString())}&$top=20&$select=id,subject,start,end,location,attendees,bodyPreview`);
      const evs=d.value||[],f=fresh(evs.map(e=>e.id+'@'+e.start?.dateTime),seen||{ids:[]});
      return {seen:{ids:f.ids},items:evs.filter(e=>f.add.includes(e.id+'@'+e.start?.dateTime)).map(e=>({id:e.id+'@'+e.start?.dateTime,title:one(e.subject||'(no title)',120),text:`Event: ${e.subject||''}\nStarts: ${e.start?.dateTime} (${e.start?.timeZone||'UTC'})\n${e.location?.displayName?'Where: '+e.location.displayName+'\n':''}${(e.attendees||[]).length?'With: '+e.attendees.map(a=>a.emailAddress?.address).join(', ')+'\n':''}\n${e.bodyPreview||''}`}))};
    }},
  'slack.message':{service:'slack',instant:'slack',label:'New message in a Slack channel',fields:[{key:'channel',label:'Channel id',required:true,placeholder:'C0123456789'},{key:'contains',label:'Only messages containing (optional)',placeholder:'urgent'}],
    async check(ctx,cfg,seen){
      if(!/^[CGD][A-Z0-9]{6,}$/.test(String(cfg.channel)))throw new Error('Give the Slack channel id, like C0123456789. The channels action of the Slack tool lists them.');
      const d=await get('slack',ctx,`${B('slack')}/conversations.history?channel=${enc(cfg.channel)}&limit=30${seen?.ts?'&oldest='+enc(seen.ts):''}`);
      const msgs=(d.messages||[]).filter(m=>slackKept(m,{})).sort((a,b)=>Number(a.ts)-Number(b.ts));
      const ts=(d.messages||[]).reduce((m,x)=>Number(x.ts)>Number(m)?x.ts:m,seen?.ts||'0');
      if(!seen)return {seen:{ts:ts==='0'?String(Date.now()/1000):ts},items:[]};
      const items=msgs.filter(m=>Number(m.ts)>Number(seen.ts)&&slackKept(m,cfg)).map(m=>slackItem(m,cfg.channel));
      return {seen:{ts},items};
    }},
  'github.issue':{service:'github',instant:'github',label:'New issue on GitHub',fields:[{key:'repo',label:'Repository',required:true,placeholder:'owner/name'},{key:'label',label:'Only with this label (optional)',placeholder:'bug'}],
    async check(ctx,cfg,seen){
      const repo=repoOf(cfg.repo);
      const d=await get('github',ctx,`${B('github')}/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=20${cfg.label?'&labels='+enc(cfg.label):''}`);
      const list=(Array.isArray(d)?d:[]).filter(i=>!i.pull_request),top=list.reduce((m,i)=>Math.max(m,i.number),seen?.top||0);
      if(!seen)return {seen:{top},items:[]};
      return {seen:{top},items:list.filter(i=>i.number>seen.top).reverse().map(i=>issueItem(i,repo))};
    }},
  'github.pull':{service:'github',instant:'github',label:'New pull request on GitHub',fields:[{key:'repo',label:'Repository',required:true,placeholder:'owner/name'}],
    async check(ctx,cfg,seen){
      const repo=repoOf(cfg.repo);
      const d=await get('github',ctx,`${B('github')}/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=20`);
      const list=Array.isArray(d)?d:[],top=list.reduce((m,i)=>Math.max(m,i.number),seen?.top||0);
      if(!seen)return {seen:{top},items:[]};
      return {seen:{top},items:list.filter(i=>i.number>seen.top).reverse().map(i=>pullItem(i,repo))};
    }},
  'notion.database':{service:'notion',label:'New or changed page in a Notion database',fields:[{key:'database',label:'Link of the database',required:true,placeholder:'https://www.notion.so/...'}],
    async check(ctx,cfg,seen){
      const id=notionId(cfg.database),since=seen?.since||new Date().toISOString();
      const d=await post('notion',ctx,`${B('notion')}/databases/${enc(id)}/query`,{page_size:20,sorts:[{timestamp:'last_edited_time',direction:'descending'}],filter:{timestamp:'last_edited_time',last_edited_time:{after:since}}});
      const pages=(d.results||[]).filter(p=>p.last_edited_time>since).reverse(),last=pages.reduce((m,p)=>p.last_edited_time>m?p.last_edited_time:m,since);
      if(!seen)return {seen:{since:new Date().toISOString()},items:[]};
      return {seen:{since:last},items:pages.map(p=>{const props=notionProps(p.properties);return {id:p.id+'@'+p.last_edited_time,title:one(props.title||'(untitled)',120),text:`Notion page ${p.created_time===p.last_edited_time?'added':'changed'}: ${props.title||''}\nEdited: ${p.last_edited_time}\n${p.url||''}\n\n${props.lines.join('\n')}`};})};
    }},
  // Any of about 40 apps that send signed events (webhook-apps.mjs). Nothing to ask: the app calls SILO.
  'webhook.app':{service:null,instant:'any',label:'An app sends an event (Stripe, Shopify, Jira, Linear, Zoom and more)',fields:[{key:'app',label:'App',required:true,options:HOOK_APP_LIST},{key:'events',label:'Only events containing (optional, comma separated)',placeholder:'checkout.session.completed, invoice.paid'}],
    async check(ctx,cfg,seen){return {seen:seen||{},items:[]};}},
  'web.feed':{service:null,label:'New item in an RSS or Atom feed',fields:[{key:'url',label:'Feed address',required:true,placeholder:'https://example.com/feed.xml'},{key:'contains',label:'Only items containing (optional)',placeholder:'release'}],
    async check(ctx,cfg,seen){
      const xml=await fetchText(cfg.url,ctx),items=parseFeed(xml);
      const f=fresh(items.map(i=>i.id),seen),wanted=i=>!cfg.contains||(i.title+' '+i.text).toLowerCase().includes(cfg.contains.toLowerCase());
      // Of the new items that match, 10 a check, the oldest first. One that does not match is skipped for good once
      // the check got past it; the rest stay new for the next check.
      const added=items.filter(i=>f.add.includes(i.id)),take=added.filter(wanted).slice(0,10),end=take.length<10?added.length:added.indexOf(take.at(-1))+1;
      return {seen:{ids:seenAfter(seen,f,added.slice(0,end).map(i=>i.id))},items:take.map(i=>({id:i.id,title:one(i.title,120),text:`Feed item: ${i.title}\n${i.link}\n${i.date?'Date: '+i.date+'\n':''}\n${clip(i.text,6000)}`}))};
    }},
  'web.page':{service:null,label:'A web page changes',fields:[{key:'url',label:'Page address',required:true,placeholder:'https://example.com/prices'},{key:'contains',label:'Only when the page contains (optional)',placeholder:'in stock'}],
    async check(ctx,cfg,seen){
      const text=htmlText(await fetchText(cfg.url,ctx)).replace(/[ \t]+/g,' ').slice(0,200000);
      const hash=createHash('sha256').update(text).digest('hex').slice(0,24),hit=!cfg.contains||text.toLowerCase().includes(cfg.contains.toLowerCase());
      if(!seen||seen.hash===hash)return {seen:{hash},items:[]};
      return {seen:{hash},items:hit?[{id:hash,title:one(`Changed: ${cfg.url}`,120),text:`The page ${cfg.url} changed.\n\nIt says now:\n${clip(text,8000)}`}]:[]};
    }}
};

// The settings a trigger keeps, checked against its fields.
export function triggerConfig(b){
  const kind=String(b?.kind||''),t=TRIGGERS[kind];if(!t)throw new Error('Pick what should start the workflow.');
  const cfg={kind};
  for(const f of t.fields){
    const v=String(b[f.key]??'').trim().slice(0,500);
    if(f.required&&!v)throw new Error(`Give: ${f.label.replace(/ \(optional.*$/,'').toLowerCase()}.`);
    if(f.options&&v&&!f.options.some(o=>o.value===v))throw new Error(`Pick one of the listed choices for ${f.label.toLowerCase()}.`);
    if(v)cfg[f.key]=f.number?String(Math.max(1,Math.min(1440,Math.round(Number(v)||0))||'')):v;
  }
  if(cfg.repo)repoOf(cfg.repo);if(cfg.sheet)sheetId(cfg.sheet);if(cfg.database)notionId(cfg.database);if(cfg.url)safeUrl(cfg.url,'address');
  // How often SILO asks: 15 seconds, a minute or 5 minutes. Other people's web pages and feeds at most once a minute.
  const every=Number(b.every);cfg.every=[15,60,300].includes(every)?every:60;if(!t.service&&cfg.every<60)cfg.every=60;
  if(t.instant==='any'||t.instant&&(b.instant===true||b.instant==='on'||b.instant==='true'))cfg.instant=true;
  return cfg;
}
// What the trigger watches, without how often or how: changing those keeps what was already seen.
export const triggerWhat=cfg=>cfg&&Object.fromEntries(Object.entries(cfg).filter(([k])=>k!=='every'&&k!=='instant'));

// ---------- events sent the moment they happen ----------
const same=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&timingSafeEqual(a,b);};
// GitHub signs the body with the webhook secret; Slack signs "v0:time:body" with the app's signing secret.
export function verifyAppEvent(kind,secret,headers,raw,now=Date.now()){
  const via=TRIGGERS[kind]?.instant;if(!via||!secret)return false;
  if(via==='github')return same(headers['x-hub-signature-256']||'','sha256='+createHmac('sha256',secret).update(raw).digest('hex'));
  const ts=Number(headers['x-slack-request-timestamp']);if(!ts||Math.abs(now/1000-ts)>300)return false;
  return same(headers['x-slack-signature']||'','v0='+createHmac('sha256',secret).update(`v0:${ts}:${raw}`).digest('hex'));
}
// The items in one event. reply is sent back as is (Slack's address check, GitHub's ping).
export function appEvent(kind,cfg,headers,body){
  const via=TRIGGERS[kind]?.instant;
  if(via==='github'){
    const ev=String(headers['x-github-event']||'');
    if(ev==='ping')return {reply:{ok:true},items:[]};
    const repo=String(body.repository?.full_name||'');if(!repo||repo.toLowerCase()!==String(cfg.repo).toLowerCase())return {items:[]};
    if(kind==='github.issue'&&ev==='issues'&&body.issue){
      const i=body.issue,label=String(cfg.label||'').toLowerCase(),has=(i.labels||[]).some(l=>String(l.name).toLowerCase()===label);
      const ok=body.action==='opened'?(!label||has):body.action==='labeled'&&!!label&&String(body.label?.name||'').toLowerCase()===label;
      return {items:ok?[issueItem(i,repo)]:[]};
    }
    if(kind==='github.pull'&&ev==='pull_request'&&body.action==='opened'&&body.pull_request)return {items:[pullItem(body.pull_request,repo)]};
    return {items:[]};
  }
  if(via==='slack'){
    if(body.type==='url_verification')return {reply:{challenge:String(body.challenge||'')},items:[]};
    const m=body.type==='event_callback'&&body.event;
    if(!m||m.type!=='message'||m.channel!==cfg.channel||!m.ts||!slackKept(m,cfg))return {items:[]};
    return {items:[slackItem(m,cfg.channel)]};
  }
  return {items:[]};
}

// ---------- helpers ----------
function gmailText(part){
  if(!part)return '';
  const data=s=>Buffer.from(String(s||'').replace(/-/g,'+').replace(/_/g,'/'),'base64').toString('utf8');
  if(part.mimeType==='text/plain'&&part.body?.data)return data(part.body.data);
  for(const p of part.parts||[]){const t=gmailText(p);if(t)return t;}
  if(part.mimeType==='text/html'&&part.body?.data)return htmlText(data(part.body.data));
  return '';
}
function notionProps(props={}){
  let title='';const lines=[];
  for(const [name,v] of Object.entries(props)){
    const t=v.type,x=v[t];let s='';
    if(t==='title'){s=(x||[]).map(r=>r.plain_text).join('');title=s;}
    else if(t==='rich_text')s=(x||[]).map(r=>r.plain_text).join('');
    else if(t==='select'||t==='status')s=x?.name||'';
    else if(t==='multi_select')s=(x||[]).map(o=>o.name).join(', ');
    else if(t==='date')s=x?.start?(x.start+(x.end?' to '+x.end:'')):'';
    else if(t==='people')s=(x||[]).map(p=>p.name||p.id).join(', ');
    else if(['number','checkbox','url','email','phone_number'].includes(t))s=x==null?'':String(x);
    else if(t==='formula')s=String(x?.[x?.type]??'');
    if(s)lines.push(`${name}: ${one(s,1000)}`);
  }
  return {title,lines};
}
async function fetchText(url,ctx){
  const u=safeUrl(url,'address'),fetcher=ctx?.fetch||globalThis.fetch;
  let r;try{r=await fetcher(u.href,{headers:{'User-Agent':'SILO-agent-world (watching for changes)',Accept:'application/rss+xml, application/atom+xml, application/xml, text/html, */*;q=0.5'},redirect:'follow',signal:AbortSignal.timeout(30000)});}
  catch(e){throw new Error(`Could not reach ${u.host}: ${e.message}`);}
  if(!r.ok)throw new Error(`${u.host} answered ${r.status}.`);
  const reader=r.body.getReader(),parts=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>3e6){reader.cancel().catch(()=>{});throw new Error('The page is larger than 3 MB.');}parts.push(Buffer.from(value));}
  return Buffer.concat(parts).toString('utf8');
}
const ent=s=>String(s||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&');
const tag=(x,name)=>{const m=x.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,'i'));return m?ent(m[1]).trim():'';};
export function parseFeed(xml){
  const out=[];
  for(const m of String(xml).matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)){
    const x=m[0],title=htmlText(tag(x,'title')),link=tag(x,'link')||(x.match(/<link[^>]*href="([^"]+)"/i)?.[1]||'');
    const id=tag(x,'guid')||tag(x,'id')||link||title,text=htmlText(tag(x,'content:encoded')||tag(x,'content')||tag(x,'description')||tag(x,'summary'));
    if(id)out.push({id:one(id,300),title:title||'(no title)',link:ent(link),date:tag(x,'pubDate')||tag(x,'updated')||tag(x,'published'),text});
  }
  // Feeds list the newest first; triggers go oldest first.
  return out.slice(0,50).reverse();
}
