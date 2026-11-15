// Talk channels: a resident answering people outside SILO, in a chat on your website, in Slack, on WhatsApp and in
// Microsoft Teams. This file holds what does not need the server: the short memory of each conversation, the limits,
// the checks that a message really comes from Slack, Meta or Microsoft, sending the answers, and the website script.
import { createHmac, timingSafeEqual, createPublicKey, verify as verifySignature } from 'node:crypto';

const REAL = {
  slack: 'https://slack.com/api', graph: 'https://graph.facebook.com/v21.0',
  bfOpenId: 'https://login.botframework.com/v1/.well-known/openidconfiguration', msLogin: 'https://login.microsoftonline.com',
};
// Tests point every outside service at one local fake server.
const B = k => process.env.SILO_TEST_TALK_BASE ? process.env.SILO_TEST_TALK_BASE + '/' + k : REAL[k];
const same = (a, b) => { a = Buffer.from(String(a ?? '')); b = Buffer.from(String(b ?? '')); return a.length === b.length && timingSafeEqual(a, b); };
const hmac = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');

export const TALK_KINDS = { widget: 'Website chat', slack: 'Slack', whatsapp: 'WhatsApp', teams: 'Microsoft Teams' };
// Public channels: anyone can write, so the resident answers from what it knows and never uses a tool.
export const PUBLIC_TALK = new Set(['widget', 'whatsapp']);
export const TALK_TEXT_MAX = 2000;

// ---------- memory and limits ----------
// The last turns of each conversation, kept in memory only: a restart starts every conversation over. Idle ones go after
// two hours, and the oldest go first when there are too many. Turns of one conversation run one after the other.
export class Conversations {
  constructor({ max = 500, keep = 12, idle = 2 * 3600000 } = {}) { this.max = max; this.keep = keep; this.idle = idle; this.map = new Map(); this.chains = new Map(); }
  history(key, now = Date.now()) {
    const c = this.map.get(key); if (!c) return [];
    if (now - c.at > this.idle) { this.map.delete(key); return []; }
    return c.turns.map(t => ({ ...t }));
  }
  add(key, user, assistant, now = Date.now()) {
    const c = this.map.get(key) || { turns: [] }; this.map.delete(key);
    c.turns.push({ role: 'user', content: user }, { role: 'assistant', content: assistant }); c.turns = c.turns.slice(-this.keep); c.at = now;
    this.map.set(key, c);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  forget(prefix) { for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k); }
  get size() { return this.map.size; }
  turn(key, fn) {
    const prev = this.chains.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {}).finally(() => { if (this.chains.get(key) === tail) this.chains.delete(key); });
    this.chains.set(key, tail);
    return next;
  }
}
// Counters in fixed windows: a few messages a minute from one sender, a cap a day for each channel.
export class Limits {
  constructor() { this.hits = new Map(); }
  hit(key, max, windowMs, now = Date.now()) {
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (now - v.at > v.window) this.hits.delete(k);
    let v = this.hits.get(key); if (!v || now - v.at > v.window) { v = { at: now, window: windowMs, n: 0 }; this.hits.set(key, v); }
    if (v.n >= max) return false;
    v.n++; return true;
  }
  used(key, now = Date.now()) { const v = this.hits.get(key); return v && now - v.at <= v.window ? v.n : 0; }
}
// Ids of messages already handled, so a message sent again by the service (Slack retries after 3 seconds) is answered once.
export class Seen {
  constructor(max = 5000, ttl = 3600000) { this.max = max; this.ttl = ttl; this.map = new Map(); }
  first(id, now = Date.now()) {
    if (!id) return true;
    const at = this.map.get(id); if (at !== undefined && now - at < this.ttl) return false;
    this.map.set(id, now); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return true;
  }
}
// Text from outside, made safe to hand on: control characters out, at most TALK_TEXT_MAX characters.
export function cleanText(text, max = TALK_TEXT_MAX) { return String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max); }
// An answer cut into parts a service takes in one message, at a line or a space when there is one near the end.
export function splitText(text, max) {
  const out = []; let t = String(text);
  while (t.length > max) { let cut = t.lastIndexOf('\n', max); if (cut < max * 0.6) cut = t.lastIndexOf(' ', max); if (cut < max * 0.6) cut = max; out.push(t.slice(0, cut).trimEnd()); t = t.slice(cut).trimStart(); }
  if (t) out.push(t);
  return out.slice(0, 5);
}
async function postJson(url, body, headers, fetcher, what) {
  const r = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${what} answered ${r.status}${d?.error?.message ? ': ' + String(d.error.message).slice(0, 200) : ''}.`);
  return d;
}

// ---------- Slack ----------
// Slack signs "v0:time:body" with the app's signing secret; an old time is refused so a copied event cannot be replayed.
export function slackVerify(secret, headers, raw, now = Date.now()) {
  if (!secret) return false;
  const ts = Number(headers['x-slack-request-timestamp']); if (!ts || Math.abs(now / 1000 - ts) > 300) return false;
  return same(headers['x-slack-signature'], 'v0=' + hmac(secret, `v0:${ts}:${raw}`));
}
// What one event asks: Slack's address check, a message to answer, or nothing. Only a direct message to the app or a
// mention of it is answered; messages of bots (the app's own answers too), edits and joins are left alone.
export function slackEvent(body) {
  if (body?.type === 'url_verification') return { challenge: String(body.challenge || '').slice(0, 200) };
  const e = body?.type === 'event_callback' ? body.event : null;
  if (!e || e.bot_id || e.subtype || !e.user || typeof e.text !== 'string') return null;
  const im = e.type === 'message' && e.channel_type === 'im';
  if (!im && e.type !== 'app_mention') return null;
  const text = cleanText(e.text.replace(/<@[A-Z0-9]+>/g, ''));
  if (!text) return null;
  // In a channel the answer goes in the thread of the mention; a direct message is one long conversation.
  const thread = e.thread_ts || (im ? '' : e.ts);
  return { id: String(body.event_id || e.client_msg_id || e.ts), team: String(body.team_id || ''), channel: String(e.channel), user: String(e.user), text, thread, key: `slack:${body.team_id || ''}:${e.channel}:${thread || 'dm'}` };
}
export async function slackSend(token, { channel, text, thread }, fetcher = globalThis.fetch) {
  for (const part of splitText(text, 3500)) {
    const d = await postJson(B('slack') + '/chat.postMessage', { channel, text: part, ...(thread && { thread_ts: thread }), unfurl_links: false }, { Authorization: 'Bearer ' + token }, fetcher, 'Slack');
    if (d.ok === false) throw new Error('Slack refused the answer: ' + String(d.error || 'unknown error').slice(0, 100));
  }
}

// ---------- WhatsApp (Meta Cloud API) ----------
export function whatsappHandshake(query, verifyToken) {
  if (query.get('hub.mode') !== 'subscribe') return null;
  return verifyToken && same(query.get('hub.verify_token'), verifyToken) ? { status: 200, text: String(query.get('hub.challenge') || '').slice(0, 200) } : { status: 403, text: 'Wrong verify token.' };
}
export function whatsappVerify(appSecret, headers, raw) { return !!appSecret && same(headers['x-hub-signature-256'], 'sha256=' + hmac(appSecret, raw)); }
// The messages in one notification, for this phone number only. Status updates (sent, read) are not messages.
export function whatsappMessages(body, phoneId) {
  const out = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
    const v = ch?.value; if (ch?.field !== 'messages' || !v || (phoneId && String(v.metadata?.phone_number_id) !== String(phoneId))) continue;
    const names = new Map((v.contacts || []).map(c => [String(c.wa_id), String(c.profile?.name || '').slice(0, 60)]));
    for (const m of Array.isArray(v.messages) ? v.messages : []) {
      if (!m?.id || !/^\d{6,20}$/.test(String(m.from || ''))) continue;
      out.push({ id: String(m.id), from: String(m.from), name: names.get(String(m.from)) || '', text: m.type === 'text' ? cleanText(m.text?.body) : '', kind: String(m.type || '') });
    }
  }
  return out;
}
export async function whatsappSend(phoneId, token, to, text, fetcher = globalThis.fetch) {
  for (const part of splitText(text, 4000))
    await postJson(`${B('graph')}/${encodeURIComponent(phoneId)}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: part, preview_url: false } }, { Authorization: 'Bearer ' + token }, fetcher, 'WhatsApp');
}

// ---------- Microsoft Teams (Bot Framework) ----------
// Every message carries a token signed by the Bot Framework. It must be signed with one of its published keys, be
// meant for this bot, be in date, and name the same service address the message asks the answer to go to.
const jwks = { at: 0, keys: [] };
async function botKeys(fetcher, fresh) {
  if (!fresh && jwks.keys.length && Date.now() - jwks.at < 3600000) return jwks.keys;
  const get = async (u, what) => { const r = await fetcher(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' }); if (!r.ok) throw new Error(`${what} answered ${r.status}.`); return r.json(); };
  const meta = await get(B('bfOpenId'), 'The Bot Framework');
  if (typeof meta?.jwks_uri !== 'string' || !(meta.jwks_uri.startsWith('https://') || process.env.SILO_TEST_TALK_BASE)) throw new Error('The Bot Framework gave no keys address.');
  const d = await get(meta.jwks_uri, 'The Bot Framework keys');
  jwks.keys = Array.isArray(d?.keys) ? d.keys : []; jwks.at = Date.now();
  return jwks.keys;
}
export const BOT_ISSUER = 'https://api.botframework.com';
export async function teamsVerify(auth, activity, appId, { fetcher = globalThis.fetch, now = Date.now(), skew = 300 } = {}) {
  const m = /^Bearer\s+([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(String(auth || '')); if (!m || !appId) throw new Error('No Bot Framework token.');
  let head, claims; try { head = JSON.parse(Buffer.from(m[1], 'base64url')); claims = JSON.parse(Buffer.from(m[2], 'base64url')); } catch { throw new Error('The token cannot be read.'); }
  if (head.alg !== 'RS256') throw new Error('The token is not signed with RS256.');
  let keys = await botKeys(fetcher), jwk = keys.find(k => k.kid === head.kid);
  if (!jwk && Date.now() - jwks.at > 60000) { keys = await botKeys(fetcher, true); jwk = keys.find(k => k.kid === head.kid); }
  if (!jwk) throw new Error('The token is signed with a key the Bot Framework does not publish.');
  // A key the Bot Framework vouches for only some channels may sign only messages from those.
  if (Array.isArray(jwk.endorsements) && activity?.channelId && !jwk.endorsements.includes(activity.channelId)) throw new Error('That key may not sign messages from this channel.');
  let ok = false; try { ok = verifySignature('sha256', Buffer.from(m[1] + '.' + m[2]), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(m[3], 'base64url')); } catch {}
  if (!ok) throw new Error('The token signature does not check out.');
  const t = Math.floor(now / 1000), aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== BOT_ISSUER) throw new Error('The token comes from another issuer.');
  if (!aud.includes(appId)) throw new Error('The token is for another bot.');
  if (!Number.isFinite(claims.exp) || claims.exp + skew < t) throw new Error('The token has expired.');
  if (Number.isFinite(claims.nbf) && claims.nbf - skew > t) throw new Error('The token is not valid yet.');
  const said = claims.serviceurl || claims.serviceUrl;
  if (said && String(said).replace(/\/$/, '') !== String(activity?.serviceUrl || '').replace(/\/$/, '')) throw new Error('The token names another service address.');
  return claims;
}
// Answers go only to Microsoft's own service addresses, never to one a message could make up.
export function serviceUrlAllowed(u) {
  let x; try { x = new URL(u); } catch { return false; }
  if (process.env.SILO_TEST_TALK_BASE && u.startsWith(process.env.SILO_TEST_TALK_BASE)) return true;
  return x.protocol === 'https:' && !x.username && !x.password && /(^|\.)(botframework\.com|trafficmanager\.net|teams\.microsoft\.com|botframework\.azure\.us)$/i.test(x.hostname);
}
// A message to answer: text with the mention of the bot taken out. Joins, typing and reactions are not.
export function teamsMessage(a) {
  if (a?.type !== 'message' || typeof a.text !== 'string' || !a.conversation?.id || !a.serviceUrl || !a.id) return null;
  const text = cleanText(a.text.replace(/<at>[^<]*<\/at>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' '));
  if (!text) return null;
  return { id: String(a.id), conversation: String(a.conversation.id), serviceUrl: String(a.serviceUrl), user: String(a.from?.name || a.from?.id || '').slice(0, 60), text, key: `teams:${a.conversation.id}` };
}
const botTokens = new Map();
export async function teamsToken(appId, password, tenant, fetcher = globalThis.fetch) {
  const k = appId + '|' + (tenant || ''), hit = botTokens.get(k); if (hit && hit.until > Date.now()) return hit.token;
  const r = await fetcher(`${B('msLogin')}/${encodeURIComponent(tenant || 'botframework.com')}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: appId, client_secret: password, scope: 'https://api.botframework.com/.default' }).toString(), signal: AbortSignal.timeout(20000), redirect: 'error' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Microsoft did not give the bot a token: ' + String(d.error_description || d.error || r.status).slice(0, 200));
  botTokens.set(k, { token: d.access_token, until: Date.now() + Math.max(60, (Number(d.expires_in) || 3600) - 300) * 1000 });
  return d.access_token;
}
export function forgetTeamsTokens() { botTokens.clear(); }
export async function teamsSend(msg, text, token, fetcher = globalThis.fetch) {
  if (!serviceUrlAllowed(msg.serviceUrl)) throw new Error('The message names a service address that is not Microsoft\'s.');
  const base = msg.serviceUrl.replace(/\/?$/, '/'), url = `${base}v3/conversations/${encodeURIComponent(msg.conversation)}/activities/${encodeURIComponent(msg.id)}`;
  for (const part of splitText(text, 20000)) await postJson(url, { type: 'message', text: part, textFormat: 'markdown', replyToId: msg.id }, { Authorization: 'Bearer ' + token }, fetcher, 'Teams');
}

// ---------- the website chat ----------
export const WIDGET_COLOR = /^#[0-9a-f]{6}$/i;
// The script a website loads. It draws a chat button in a shadow root, so the page's styles and its own do not mix,
// shows every text as text (never as markup), and remembers the visitor and the last messages in this browser only.
export function widgetScript({ key, title, greeting, color, base }) {
  const cfg = JSON.stringify({ key, title, greeting, color: WIDGET_COLOR.test(color) ? color : '#2f5d50', base }).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
  return `(()=>{"use strict";
const C=${cfg};if(window["siloTalk_"+C.key])return;window["siloTalk_"+C.key]=1;
const me=document.currentScript,base=(()=>{try{return me&&me.src?new URL(me.src).origin:C.base}catch(e){return C.base}})();
const K="silo-talk:"+C.key+":",get=k=>{try{return localStorage.getItem(K+k)}catch(e){return null}},put=(k,v)=>{try{localStorage.setItem(K+k,v)}catch(e){}};
let visitor=get("v");if(!/^[A-Za-z0-9_-]{16,64}$/.test(visitor||"")){const b=new Uint8Array(18);crypto.getRandomValues(b);visitor=Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");put("v",visitor);}
let log=[];try{log=JSON.parse(get("log")||"[]").filter(m=>m&&typeof m.t==="string"&&(m.r==="u"||m.r==="a")).slice(-30)}catch(e){log=[]}
const host=document.createElement("div");host.setAttribute("data-silo-talk","");const root=host.attachShadow({mode:"open"});
root.innerHTML='<style>:host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.b{position:fixed;right:20px;bottom:20px;width:56px;height:56px;border:0;border-radius:50%;background:var(--c);color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:grid;place-items:center;z-index:2147483646}.b:focus-visible,.x:focus-visible,.s:focus-visible{outline:3px solid #88b4ff;outline-offset:2px}.p{position:fixed;right:20px;bottom:88px;width:min(380px,calc(100vw - 32px));height:min(560px,calc(100vh - 120px));display:none;flex-direction:column;background:#fff;color:#1b1b1b;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden;z-index:2147483647}.p.o{display:flex}.h{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;background:var(--c);color:#fff;font-weight:600;font-size:15px}.x{border:0;background:transparent;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:6px}.l{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;font-size:14px;line-height:1.45}.m{max-width:85%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere}.u{align-self:flex-end;background:var(--c);color:#fff;border-bottom-right-radius:4px}.a{align-self:flex-start;background:#f0f0ee;border-bottom-left-radius:4px}.e{align-self:center;color:#a3302a;font-size:13px}.t{align-self:flex-start;color:#777;font-size:13px}.f{display:flex;gap:8px;padding:10px;border-top:1px solid #e4e4e0}.i{flex:1;resize:none;border:1px solid #cfcfc9;border-radius:10px;padding:9px 10px;font-size:14px;max-height:120px;color:inherit;background:transparent}.s{border:0;border-radius:10px;padding:0 14px;background:var(--c);color:#fff;font-weight:600;cursor:pointer}.s:disabled{opacity:.5;cursor:default}@media (prefers-color-scheme:dark){.p{background:#1d1f1d;color:#ecebe6}.a{background:#2c2f2c}.f{border-color:#3a3d3a}.i{border-color:#4a4d4a}}@media (max-width:480px){.p{right:16px;bottom:84px}.b{right:16px;bottom:16px}}</style><button class="b" type="button" aria-label="Open chat" aria-expanded="false"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button><div class="p" role="dialog" aria-modal="false"><div class="h"><span class="n"></span><button class="x" type="button" aria-label="Close chat">\\u00d7</button></div><div class="l" aria-live="polite"></div><form class="f"><textarea class="i" rows="1" maxlength="1000" aria-label="Your message" placeholder="Write a message"></textarea><button class="s" type="submit">Send</button></form></div>';
const $=s=>root.querySelector(s),btn=$(".b"),panel=$(".p"),list=$(".l"),form=$(".f"),input=$(".i"),send=$(".s");
host.style.setProperty("--c",C.color);panel.setAttribute("aria-label",C.title);$(".n").textContent=C.title;
const add=(r,t)=>{const d=document.createElement("div");d.className="m "+(r==="u"?"u":r==="a"?"a":r==="t"?"t":"e");d.textContent=t;list.appendChild(d);list.scrollTop=list.scrollHeight;return d;};
const save=()=>put("log",JSON.stringify(log.slice(-30)));
if(C.greeting)add("a",C.greeting);for(const m of log)add(m.r,m.t);
const open=v=>{panel.classList.toggle("o",v);btn.setAttribute("aria-expanded",String(v));if(v)setTimeout(()=>input.focus(),30);else btn.focus();};
btn.addEventListener("click",()=>open(!panel.classList.contains("o")));$(".x").addEventListener("click",()=>open(false));
root.addEventListener("keydown",e=>{if(e.key==="Escape"&&panel.classList.contains("o"))open(false);});
input.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();form.requestSubmit();}});
let busy=false;
form.addEventListener("submit",async e=>{e.preventDefault();const text=input.value.trim();if(!text||busy)return;busy=true;send.disabled=true;input.value="";
  add("u",text);log.push({r:"u",t:text});save();const wait=add("t","\\u2026");
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),100000);
  try{const r=await fetch(base+"/widget/"+C.key+"/chat",{method:"POST",mode:"cors",credentials:"omit",headers:{"Content-Type":"application/json"},body:JSON.stringify({visitor,text}),signal:ctl.signal});
    const d=await r.json().catch(()=>({}));wait.remove();
    if(r.ok&&typeof d.reply==="string"){add("a",d.reply);log.push({r:"a",t:d.reply});save();}
    else add("e",typeof d.error==="string"?d.error:"The chat cannot answer right now.");}
  catch(err){wait.remove();add("e","The chat cannot be reached right now.");}
  finally{clearTimeout(timer);busy=false;send.disabled=false;input.focus();}});
(document.body||document.documentElement).appendChild(host);
})();`;
}
export function widgetTryPage({ key, title }) {
  const e = t => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)}: try it</title><style>body{margin:0;min-height:100vh;background:#f6f5f1;color:#1d1d1b;font:16px/1.5 system-ui,sans-serif}main{max-width:620px;margin:0 auto;padding:48px 16px}code{background:#e9e7df;padding:2px 5px;border-radius:4px}@media (prefers-color-scheme:dark){body{background:#121412;color:#e8e6df}code{background:#2a2d2a}}</style></head><body><main><h1>${e(title)}</h1><p>This page shows the chat as your visitors see it. Open it with the button at the bottom right. It answers the same way as on your site and counts toward the daily limit.</p></main><script src="/widget/${e(key)}.js" async></script></body></html>`;
}
