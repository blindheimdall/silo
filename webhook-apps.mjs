// Events sent by apps the moment something happens (webhooks). Each app signs its events in its own way; SILO checks
// the signature with the secret you give (or, for Asana and Notion, the one the app sends when the webhook is made),
// answers the app's address checks, and turns each event into an item { id, title, text } for the workflow.
// Events with a missing or wrong signature, or older than 5 minutes where the app sends the time, are refused.
import { createHmac, createHash, timingSafeEqual, verify as edVerify, createPublicKey } from 'node:crypto';

const same=(a,b)=>{a=Buffer.from(String(a??''));b=Buffer.from(String(b??''));return a.length>0&&a.length===b.length&&timingSafeEqual(a,b);};
const anyOf=(list,expected)=>list.some(x=>same(x,expected));
const mac=(alg,key,data,enc='hex')=>createHmac(alg,key).update(data).digest(enc);
const sha=(s,enc='hex')=>createHash('sha256').update(String(s)).digest(enc);
const recent=(sec,now,window=300)=>Number.isFinite(sec)&&sec>0&&Math.abs(now/1000-sec)<=window;
const pairs=(v,sep=',')=>String(v||'').split(sep).map(x=>x.trim()).filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];});
const field=(list,k)=>list.filter(x=>x[0]===k).map(x=>x[1]);
const pick=(o,...keys)=>keys.map(k=>k.split('.').reduce((v,p)=>v?.[p],o)).find(v=>v!==undefined&&v!==null&&v!=='');
const one=(s,n=120)=>String(s??'').replace(/\s+/g,' ').trim().slice(0,n);
const clip=(s,n=8000)=>{s=String(s??'');return s.length>n?s.slice(0,n)+`\n[cut: ${s.length-n} more characters]`:s;};
const hex256=c=>mac('sha256',c.secret,c.raw);
const b64256=c=>mac('sha256',c.secret,c.raw,'base64');
const ED_PREFIX=Buffer.from('302a300506032b6570032100','hex');

// Each app: name, hint (which secret to give), setup (where to paste the address), verify(ctx), and optionally
// handshake(ctx) before the signature check, answer(ctx) after it, events(ctx) => [{ type, id, data }], learns.
// ctx: { secret, h (headers, lower case), raw, body, form, query, method, url (the address the app called), token, now }
export const HOOK_APPS={
  stripe:{name:'Stripe',group:'Payments and shops',hint:'The signing secret (whsec_...) of your endpoint in Stripe, Developers, Webhooks.',setup:'In Stripe: Developers, Webhooks, Add endpoint. Paste the address and pick the events.',
    verify:c=>{const p=pairs(c.h['stripe-signature']),t=Number(field(p,'t')[0]);return recent(t,c.now)&&anyOf(field(p,'v1'),mac('sha256',c.secret,`${t}.${c.raw}`));},
    events:c=>[{type:c.body.type,id:c.body.id,data:c.body.data?.object||c.body}]},
  shopify:{name:'Shopify',group:'Payments and shops',hint:'The secret shown under Settings, Notifications, Webhooks (or your app\'s client secret).',setup:'In Shopify: Settings, Notifications, Webhooks, Create webhook. Format JSON.',
    verify:c=>same(c.h['x-shopify-hmac-sha256'],b64256(c)),
    events:c=>[{type:c.h['x-shopify-topic'],id:c.h['x-shopify-webhook-id']||c.h['x-shopify-event-id'],data:c.body}]},
  woocommerce:{name:'WooCommerce',group:'Payments and shops',hint:'The secret you typed when making the webhook in WooCommerce.',setup:'In WordPress: WooCommerce, Settings, Advanced, Webhooks, Add webhook. Pick a topic and type a secret.',
    handshake:c=>c.method==='POST'&&c.form?.webhook_id&&!c.h['x-wc-webhook-topic']?{status:200,json:{ok:true}}:null,
    verify:c=>same(c.h['x-wc-webhook-signature'],b64256(c)),
    events:c=>[{type:c.h['x-wc-webhook-topic'],id:c.h['x-wc-webhook-delivery-id'],data:c.body}]},
  square:{name:'Square',group:'Payments and shops',hint:'The signature key of your webhook subscription in the Square Developer Dashboard.',setup:'In the Square Developer Dashboard: your app, Webhooks, Add subscription. Paste the address exactly.',
    verify:c=>same(c.h['x-square-hmacsha256-signature'],mac('sha256',c.secret,c.url+c.raw,'base64')),
    events:c=>[{type:c.body.type,id:c.body.event_id,data:c.body.data||c.body}]},
  paddle:{name:'Paddle',group:'Payments and shops',hint:'The secret key of your notification destination in Paddle, Developer tools, Notifications.',setup:'In Paddle: Developer tools, Notifications, New destination. Paste the address and pick the events.',
    verify:c=>{const p=pairs(c.h['paddle-signature'],';'),ts=Number(field(p,'ts')[0]);return recent(ts,c.now)&&anyOf(field(p,'h1'),mac('sha256',c.secret,`${ts}:${c.raw}`));},
    events:c=>[{type:c.body.event_type,id:c.body.event_id,data:c.body.data||c.body}]},
  lemonsqueezy:{name:'Lemon Squeezy',group:'Payments and shops',hint:'The signing secret you typed when making the webhook.',setup:'In Lemon Squeezy: Settings, Webhooks, add one. Type a signing secret and pick the events.',
    verify:c=>same(c.h['x-signature'],hex256(c)),
    events:c=>[{type:c.body.meta?.event_name||c.h['x-event-name'],id:`${c.body.meta?.event_name}:${c.body.data?.id}:${c.body.data?.attributes?.updated_at||''}`,data:c.body.data||c.body}]},
  github:{name:'GitHub (any event)',group:'Code and servers',hint:'The secret you typed when making the webhook.',setup:'In the repository: Settings, Webhooks, Add webhook. Content type application/json, type a secret, pick the events.',
    verify:c=>same(c.h['x-hub-signature-256'],'sha256='+hex256(c)),
    answer:c=>c.h['x-github-event']==='ping'?{status:200,json:{ok:true}}:null,
    events:c=>[{type:c.h['x-github-event']+(c.body.action?'.'+c.body.action:''),id:c.h['x-github-delivery'],data:c.body}]},
  gitlab:{name:'GitLab',group:'Code and servers',hint:'The secret token you typed when making the webhook.',setup:'In the project: Settings, Webhooks, Add new webhook. Type a secret token and pick the events.',
    verify:c=>same(c.h['x-gitlab-token'],c.secret),
    events:c=>[{type:(c.h['x-gitlab-event']||c.body.object_kind)+(c.body.object_attributes?.action?'.'+c.body.object_attributes.action:''),id:c.h['x-gitlab-event-uuid']||c.h['idempotency-key'],data:c.body}]},
  bitbucket:{name:'Bitbucket',group:'Code and servers',hint:'The secret you typed when making the webhook.',setup:'In the repository: Repository settings, Webhooks, Add webhook. Type a secret and pick the triggers.',
    verify:c=>same(c.h['x-hub-signature'],'sha256='+hex256(c)),
    events:c=>[{type:c.h['x-event-key'],id:c.h['x-request-uuid'],data:c.body}]},
  sentry:{name:'Sentry',group:'Code and servers',hint:'The client secret of your internal integration in Sentry, Settings, Custom integrations.',setup:'In Sentry: Settings, Custom integrations, a new internal integration. Paste the address as Webhook URL and tick the resources.',
    verify:c=>same(c.h['sentry-hook-signature'],hex256(c)),
    events:c=>[{type:`${c.h['sentry-hook-resource']||'event'}.${c.body.action||''}`,id:c.h['request-id'],data:c.body.data||c.body}]},
  pagerduty:{name:'PagerDuty',group:'Code and servers',hint:'The secret PagerDuty shows once when you add the webhook subscription.',setup:'In PagerDuty: Integrations, Generic webhooks (v3), New webhook. Pick the events.',
    verify:c=>anyOf(String(c.h['x-pagerduty-signature']||'').split(',').map(x=>x.trim()),'v1='+hex256(c)),
    events:c=>[{type:c.body.event?.event_type,id:c.body.event?.id,data:c.body.event?.data||c.body}]},
  vercel:{name:'Vercel',group:'Code and servers',hint:'The secret Vercel shows when you add the webhook (Team settings, Webhooks).',setup:'In Vercel: Team settings, Webhooks, Create webhook. Pick the events and projects.',
    verify:c=>same(c.h['x-vercel-signature'],mac('sha1',c.secret,c.raw)),
    events:c=>[{type:c.body.type,id:c.body.id,data:c.body.payload||c.body}]},
  netlify:{name:'Netlify',group:'Code and servers',hint:'The JWS secret token you typed for the deploy notification.',setup:'In Netlify: Site configuration, Notifications, Deploy notifications, HTTP POST request. Type a JWS secret token.',
    verify:c=>{const [hd,pl,sig]=String(c.h['x-webhook-signature']||'').split('.');if(!sig)return false;let p;try{p=JSON.parse(Buffer.from(pl,'base64url').toString('utf8'));}catch{return false;}return same(sig,mac('sha256',c.secret,`${hd}.${pl}`,'base64url'))&&p.iss==='netlify'&&same(p.sha256,sha(c.raw));},
    events:c=>[{type:'deploy '+(c.body.state||''),id:`${c.body.id}:${c.body.state}`,data:c.body}]},
  jira:{name:'Jira',group:'Work and projects',hint:'The secret you typed when making the webhook in Jira.',setup:'In Jira: Settings, System, Webhooks, Create a webhook. Type a secret and pick the events.',
    verify:c=>same(c.h['x-hub-signature'],'sha256='+hex256(c)),
    events:c=>[{type:c.body.webhookEvent,id:c.h['x-atlassian-webhook-identifier'],data:c.body}]},
  linear:{name:'Linear',group:'Work and projects',hint:'The signing secret Linear shows for the webhook (Settings, API, Webhooks).',setup:'In Linear: Settings, API, Webhooks, New webhook. Pick the data types.',
    verify:c=>same(c.h['linear-signature'],hex256(c))&&(!c.body.webhookTimestamp||recent(Number(c.body.webhookTimestamp)/1000,c.now)),
    events:c=>[{type:`${c.body.type}.${c.body.action}`,id:c.h['linear-delivery'],data:c.body.data||c.body}]},
  asana:{name:'Asana',group:'Work and projects',learns:true,hint:'Nothing: Asana sends its secret when the webhook is made. Leave it empty.',setup:'Make the webhook with the Asana API (POST /webhooks with the resource and this address). SILO answers Asana\'s handshake and keeps the secret.',
    handshake:c=>{const x=c.h['x-hook-secret'];if(!x||c.method!=='POST')return null;if(c.secret&&!same(x,c.secret))return {status:401,json:{error:'This webhook already has a secret.'}};return {status:200,json:{ok:true},headers:{'X-Hook-Secret':x},learn:c.secret?null:x};},
    verify:c=>same(c.h['x-hook-signature'],hex256(c)),
    events:c=>(c.body.events||[]).map(e=>({type:`${e.resource?.resource_type||'resource'}.${e.action}`,id:sha(JSON.stringify(e)).slice(0,24),data:e}))},
  trello:{name:'Trello',group:'Work and projects',hint:'Your Trello API secret (trello.com/power-ups/admin, your Power-Up, API key, Secret).',setup:'Make the webhook with the Trello API (POST /1/webhooks with callbackURL set to this address and the board id as idModel).',
    handshake:c=>c.method==='HEAD'?{status:200}:null,
    verify:c=>same(c.h['x-trello-webhook'],mac('sha1',c.secret,c.raw+c.url,'base64')),
    events:c=>[{type:c.body.action?.type,id:c.body.action?.id,data:c.body.action||c.body}]},
  clickup:{name:'ClickUp',group:'Work and projects',hint:'The secret ClickUp returns when the webhook is made.',setup:'Make the webhook with the ClickUp API (POST /team/{team_id}/webhook with this address as endpoint) and copy the secret from the answer.',
    verify:c=>same(c.h['x-signature'],hex256(c)),
    events:c=>[{type:c.body.event,id:c.body.history_items?.[0]?.id||`${c.body.event}:${c.body.task_id}:${c.body.webhook_id}`,data:c.body}]},
  todoist:{name:'Todoist',group:'Work and projects',hint:'The client secret of your app in the Todoist App Management Console.',setup:'In the Todoist App Management Console: your app, Webhooks. Paste the address and pick the events.',
    verify:c=>same(c.h['x-todoist-hmac-sha256'],b64256(c)),
    events:c=>[{type:c.body.event_name,id:c.h['x-todoist-delivery-id'],data:c.body.event_data||c.body}]},
  notion:{name:'Notion',group:'Work and projects',learns:true,hint:'Nothing: Notion sends a verification token to the address. SILO shows it; paste it back in Notion.',setup:'In your Notion integration: Webhooks, Create a subscription with this address. Then open this again and copy the verification token into Notion.',
    handshake:c=>c.method==='POST'&&c.body.verification_token&&Object.keys(c.body).length===1?(c.secret?{status:200,json:{ok:true}}:{status:200,json:{ok:true},learn:String(c.body.verification_token)}):null,
    verify:c=>same(c.h['x-notion-signature'],'sha256='+hex256(c)),
    events:c=>[{type:c.body.type,id:c.body.id,data:c.body}]},
  calendly:{name:'Calendly',group:'Work and projects',hint:'The signing key you gave when making the webhook subscription.',setup:'Make the webhook with the Calendly API (POST /webhook_subscriptions with this address and a signing_key).',
    verify:c=>{const p=pairs(c.h['calendly-webhook-signature']),t=Number(field(p,'t')[0]);return recent(t,c.now)&&anyOf(field(p,'v1'),mac('sha256',c.secret,`${t}.${c.raw}`));},
    events:c=>[{type:c.body.event,id:`${c.body.event}:${c.body.payload?.uri||sha(c.raw).slice(0,24)}`,data:c.body.payload||c.body}]},
  typeform:{name:'Typeform',group:'Work and projects',hint:'The secret you typed for the webhook (form, Connect, Webhooks, Edit).',setup:'In Typeform: your form, Connect, Webhooks, Add a webhook. Type a secret and turn it on.',
    verify:c=>same(c.h['typeform-signature'],'sha256='+b64256(c)),
    events:c=>[{type:c.body.event_type,id:c.body.event_id,data:c.body.form_response||c.body}]},
  zoom:{name:'Zoom',group:'Email and messages',hint:'The secret token of your Zoom app (Features, Access, Secret token).',setup:'In the Zoom App Marketplace: your app, Features, Event subscriptions. Paste the address, validate it, pick the events.',
    verify:c=>{const ts=c.h['x-zm-request-timestamp'];return recent(Number(ts),c.now)&&same(c.h['x-zm-signature'],'v0='+mac('sha256',c.secret,`v0:${ts}:${c.raw}`));},
    answer:c=>c.body.event==='endpoint.url_validation'?{status:200,json:{plainToken:String(c.body.payload?.plainToken||''),encryptedToken:mac('sha256',c.secret,String(c.body.payload?.plainToken||''))}}:null,
    events:c=>[{type:c.body.event,id:`${c.body.event}:${c.body.event_ts}:${c.body.payload?.object?.id||''}`,data:c.body.payload||c.body}]},
  discord:{name:'Discord',group:'Email and messages',hint:'The public key of your Discord app (General information, Public key).',setup:'In the Discord developer portal: your app, Webhooks, Endpoint URL. Turn on the events you want.',
    verify:c=>{try{const key=createPublicKey({key:Buffer.concat([ED_PREFIX,Buffer.from(c.secret,'hex')]),format:'der',type:'spki'});return edVerify(null,Buffer.from(String(c.h['x-signature-timestamp']||'')+c.raw),key,Buffer.from(String(c.h['x-signature-ed25519']||''),'hex'))&&recent(Number(c.h['x-signature-timestamp']),c.now);}catch{return false;}},
    answer:c=>c.body.type===0?{status:204}:c.body.type===1&&!c.body.event?{status:200,json:{type:1}}:null,
    events:c=>c.body.type===1&&c.body.event?[{type:c.body.event.type,id:sha(c.raw).slice(0,24),data:c.body.event.data||c.body.event}]:[]},
  telegram:{name:'Telegram bot',group:'Email and messages',hint:'The secret_token you gave to setWebhook. Use another bot than the SILO phone bot.',setup:'Call the Telegram API: setWebhook with url set to this address and a secret_token you choose.',
    verify:c=>same(c.h['x-telegram-bot-api-secret-token'],c.secret),
    events:c=>[{type:Object.keys(c.body).find(k=>k!=='update_id')||'update',id:'u'+c.body.update_id,data:c.body}]},
  meta:{name:'WhatsApp, Facebook, Instagram (Meta)',group:'Email and messages',hint:'The app secret from Meta for Developers, App settings, Basic.',setup:'In Meta for Developers: your app, Webhooks (or WhatsApp, Configuration). Paste the address, and the verify token shown here.',
    handshake:c=>c.method==='GET'&&c.query.get('hub.mode')==='subscribe'?(same(c.query.get('hub.verify_token'),c.token)?{status:200,text:String(c.query.get('hub.challenge')||'')}:{status:403,json:{error:'Wrong verify token.'}}):null,
    verify:c=>same(c.h['x-hub-signature-256'],'sha256='+hex256(c)),
    events:c=>(c.body.entry||[]).flatMap(e=>(e.changes||e.messaging||[e]).map(x=>({type:`${c.body.object}.${x.field||(x.message?'message':'event')}`,id:sha(JSON.stringify(x)+e.id).slice(0,24),data:x.value||x})))},
  twilio:{name:'Twilio',group:'Email and messages',hint:'Your Twilio auth token (Console, Account info).',setup:'In the Twilio Console: your phone number, Messaging (or Voice), A message comes in: Webhook, this address, HTTP POST.',
    verify:c=>c.form&&same(c.h['x-twilio-signature'],mac('sha1',c.secret,c.url+Object.keys(c.form).sort().map(k=>k+c.form[k]).join(''),'base64')),
    events:c=>{const f=c.form||{},type=f.SmsStatus||f.MessageStatus||f.CallStatus||(f.Body!==undefined?'incoming message':'event');return [{type,id:`${f.MessageSid||f.CallSid||sha(c.raw).slice(0,24)}:${type}`,data:f}];}},
  mailgun:{name:'Mailgun',group:'Email and messages',hint:'Your HTTP webhook signing key (Mailgun, Sending, Webhooks).',setup:'In Mailgun: Sending, Webhooks, Add webhook. Pick the event and paste the address.',
    verify:c=>{const s=c.body.signature||{};return recent(Number(s.timestamp),c.now)&&same(s.signature,mac('sha256',c.secret,String(s.timestamp)+String(s.token)));},
    events:c=>[{type:c.body['event-data']?.event,id:c.body['event-data']?.id,data:c.body['event-data']||c.body}]},
  svix:{name:'Resend, Clerk and others (Svix)',group:'Email and messages',hint:'The signing secret (whsec_...) the app shows for the endpoint.',setup:'In the app\'s webhook settings (Resend: Webhooks; Clerk: Configure, Webhooks), add an endpoint with this address.',
    verify:c=>{const id=c.h['svix-id']||c.h['webhook-id'],ts=Number(c.h['svix-timestamp']||c.h['webhook-timestamp']),sigs=String(c.h['svix-signature']||c.h['webhook-signature']||'').split(' ').map(x=>x.split(',')[1]).filter(Boolean);
      if(!id||!recent(ts,c.now))return false;const key=Buffer.from(String(c.secret).replace(/^whsec_/,''),'base64');return anyOf(sigs,mac('sha256',key,`${id}.${ts}.${c.raw}`,'base64'));},
    events:c=>[{type:c.body.type,id:c.h['svix-id']||c.h['webhook-id'],data:c.body.data||c.body}]},
  zendesk:{name:'Zendesk',group:'Sales and support',hint:'The signing secret of the webhook (Admin Center, Apps and integrations, Webhooks, the webhook, Reveal secret).',setup:'In Zendesk Admin Center: Apps and integrations, Webhooks, Create webhook. Then use it in a trigger.',
    verify:c=>{const ts=c.h['x-zendesk-webhook-signature-timestamp'];return recent(Date.parse(ts)/1000,c.now)&&same(c.h['x-zendesk-webhook-signature'],mac('sha256',c.secret,String(ts)+c.raw,'base64'));},
    events:c=>[{type:c.body.type||c.body.event?.type||'ticket',id:c.body.id||c.h['x-zendesk-webhook-invocation-id'],data:c.body}]},
  intercom:{name:'Intercom',group:'Sales and support',hint:'The client secret of your app (Developer Hub, your app, Basic information).',setup:'In the Intercom Developer Hub: your app, Webhooks. Paste the address and pick the topics.',
    verify:c=>same(c.h['x-hub-signature'],'sha1='+mac('sha1',c.secret,c.raw)),
    events:c=>[{type:c.body.topic,id:c.body.id,data:c.body.data?.item||c.body}]},
  hubspot:{name:'HubSpot',group:'Sales and support',hint:'The client secret of your HubSpot app (Auth tab).',setup:'In your HubSpot developer app: Webhooks. Paste the address as Target URL and add subscriptions.',
    verify:c=>{const ts=Number(c.h['x-hubspot-request-timestamp']);return recent(ts/1000,c.now)&&same(c.h['x-hubspot-signature-v3'],mac('sha256',c.secret,c.method+c.url+c.raw+ts,'base64'));},
    events:c=>(Array.isArray(c.body)?c.body:[c.body]).map(e=>({type:e.subscriptionType,id:String(e.eventId??sha(JSON.stringify(e)).slice(0,24)),data:e}))},
  webflow:{name:'Webflow',group:'Files, sites and content',hint:'The secret of the webhook (shown when it is made with the API or in Site settings, Apps and integrations).',setup:'In Webflow: Site settings, Apps and integrations, Webhooks, Add webhook. Pick the trigger.',
    verify:c=>{const ts=Number(c.h['x-webflow-timestamp']);return recent(ts/1000,c.now)&&same(c.h['x-webflow-signature'],mac('sha256',c.secret,`${ts}:${c.raw}`));},
    events:c=>[{type:c.body.triggerType,id:sha(c.raw).slice(0,24),data:c.body.payload||c.body}]},
  dropbox:{name:'Dropbox',group:'Files, sites and content',hint:'The app secret of your Dropbox app (App console, Settings).',setup:'In the Dropbox App console: your app, Settings, Webhooks. Add this address; SILO answers the check.',
    handshake:c=>c.method==='GET'&&c.query.get('challenge')?{status:200,text:String(c.query.get('challenge')),headers:{'X-Content-Type-Options':'nosniff'}}:null,
    verify:c=>same(c.h['x-dropbox-signature'],hex256(c)),
    events:c=>[{type:'files changed',id:'dropbox:'+c.now,data:c.body}]},
  basic:{name:'Postmark, Pipedrive and others (user and password)',group:'Any app',hint:'The user and password you put on the webhook, written as user:password.',setup:'In the app, add the webhook with this address and the same user and password (Postmark: https://user:password@ before the address; Pipedrive: HTTP auth fields).',
    verify:c=>same(c.h.authorization,'Basic '+Buffer.from(c.secret).toString('base64')),
    events:c=>[{type:pick(c.body,'RecordType','meta.action','event','type')||'event',id:pick(c.body,'MessageID','meta.id','id'),data:c.body}]},
  hmac:{name:'Any app that signs with HMAC SHA-256',group:'Any app',hint:'The app\'s webhook signing secret.',setup:'In the app, add a webhook with this address. SILO looks for the signature in X-Signature, X-Hub-Signature-256, X-Webhook-Signature or Signature, in hex or base64.',
    verify:c=>{const hex=hex256(c),b64=b64256(c),ok=[hex,b64,'sha256='+hex,'sha256='+b64];return ['x-signature-256','x-hub-signature-256','x-signature','x-webhook-signature','signature'].some(k=>c.h[k]&&ok.some(e=>same(c.h[k],e)));}},
  token:{name:'Any app with a secret in a header',group:'Any app',hint:'The secret the app sends in X-Webhook-Secret, X-Webhook-Token, X-Api-Key or Authorization: Bearer.',setup:'In the app, add a webhook with this address and put the secret in one of those headers.',
    verify:c=>anyOf([c.h['x-webhook-secret'],c.h['x-webhook-token'],c.h['x-api-key'],String(c.h.authorization||'').replace(/^Bearer\s+/i,'')],c.secret)},
};

// What the trigger editor shows.
export const HOOK_APP_LIST=Object.entries(HOOK_APPS).map(([value,a])=>({value,label:a.name,group:a.group,hint:a.hint,setup:a.setup,learns:!!a.learns}));

function parse(raw,type){
  if(!raw)return {body:{},form:null};
  try{const b=JSON.parse(raw);return {body:b&&typeof b==='object'?b:{value:b},form:null};}catch{}
  if(/x-www-form-urlencoded/i.test(type||'')||/^[\w%.\-[\]]+=/.test(raw)){const form=Object.fromEntries(new URLSearchParams(raw));return {body:form,form};}
  return {body:{text:raw},form:null};
}

// One request to the address. Returns { status, json?, text?, headers?, learn?, items }.
export function readWebhook(cfg,{method='POST',headers={},raw='',query=new URLSearchParams(),url='',token='',secret='',now=Date.now()}){
  const app=HOOK_APPS[cfg?.app];if(!app)return {status:404,json:{error:'Not found.'},items:[]};
  const {body,form}=parse(raw,headers['content-type']);
  const ctx={secret,h:headers,raw,body,form,query,method,url,token,now};
  const pre=app.handshake?.(ctx);if(pre)return {...pre,items:[]};
  if(method!=='POST')return {status:405,json:{error:'Send a POST request.'},items:[]};
  let ok=false;try{ok=!!secret&&!!app.verify(ctx);}catch{ok=false;}
  if(!ok)return {status:401,json:{error:'Invalid signature.'},items:[]};
  const post=app.answer?.(ctx);if(post)return {...post,items:[]};
  const words=String(cfg.events||'').toLowerCase().split(',').map(w=>w.trim()).filter(Boolean);
  const list=(app.events?app.events(ctx):[{type:pick(body,'type','event','event_type','topic','action'),id:pick(body,'id','event_id'),data:body}]).filter(Boolean);
  const items=list.map(e=>({...e,type:one(e.type||'event',100)})).filter(e=>!words.length||words.some(w=>e.type.toLowerCase().includes(w)))
    .map(e=>({id:`${cfg.app}:${one(e.id||sha(raw).slice(0,24),200)}`,title:`${app.name.replace(/ \(.*$/,'')}: ${e.type}`,text:`${app.name} event: ${e.type}\n\n${clip(JSON.stringify(e.data??body,null,1))}`}));
  return {status:200,json:{ok:true},items};
}
