// Sign-in for remote MCP servers, following the MCP authorization spec (OAuth 2.1):
//   1. Ask the server. A 401 answer names where its "protected resource metadata" lives, or it sits at a
//      well-known address next to the server.
//   2. That metadata names the authorization server. Its own metadata gives the sign-in and token addresses.
//   3. When SILO has no client id for it yet, it registers itself (Dynamic Client Registration, RFC 7591).
//   4. Sign-in uses PKCE and names the MCP server as the "resource" (RFC 8707), so the token only works there.
// Every address found on the way must be https, or http on this computer only.

const LOCAL=['localhost','127.0.0.1','[::1]'];
const MAX=256*1024;

export function safeUrl(value,label='address'){
  let u;try{u=new URL(String(value||''));}catch{throw new Error(`The ${label} is not a valid address.`);}
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&LOCAL.includes(u.hostname)))throw new Error(`The ${label} must use https.`);
  if(u.username||u.password)throw new Error(`The ${label} must not hold a name or password.`);
  return u;
}

async function readJson(r){
  const text=await r.text();if(text.length>MAX)throw new Error('The answer was too large.');
  try{return JSON.parse(text);}catch{throw new Error('The answer was not JSON.');}
}

async function getJson(url,fetcher){
  let r;try{r=await fetcher(url,{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(15000)});}catch{return null;}
  if(!r.ok)return null;
  try{const j=await readJson(r);return j&&typeof j==='object'&&!Array.isArray(j)?j:null;}catch{return null;}
}

// Reads one parameter out of a WWW-Authenticate header, for example resource_metadata="https://...".
export function authParam(header,name){
  const m=String(header||'').match(new RegExp(`(?:^|[\\s,])${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^\\s,]+))`,'i'));
  return m?(m[1]??m[2]).replace(/\\(.)/g,'$1'):'';
}

// The address the token is meant for: the server address without the fragment.
export function resourceOf(mcpUrl){const u=new URL(mcpUrl);u.hash='';return u.href;}

function wellKnown(base,name){
  const u=new URL(base),path=u.pathname.replace(/\/$/,'');
  const out=[];
  if(path)out.push(`${u.origin}/.well-known/${name}${path}`);
  out.push(`${u.origin}/.well-known/${name}`);
  return out;
}

export async function discoverMcpAuth(mcpUrl,{fetcher=globalThis.fetch,headers={}}={}){
  const server=safeUrl(mcpUrl,'connector address');
  // Ask without a token. A server that wants sign-in answers 401 and may say where its metadata is.
  let challenge='',status=0;
  try{
    const r=await fetcher(server.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...headers},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'silo',version:'0.1.0'}}})});
    status=r.status;challenge=r.headers.get('www-authenticate')||'';r.body?.cancel?.().catch(()=>{});
  }catch(e){throw new Error(`Could not reach the connector: ${e.message}`);}
  const hinted=authParam(challenge,'resource_metadata'),scopeHint=authParam(challenge,'scope');
  let prm=null;
  for(const u of hinted?[safeUrl(hinted,'resource metadata address').href]:wellKnown(server.href,'oauth-protected-resource')){prm=await getJson(u,fetcher);if(prm)break;}
  let issuer,resource=resourceOf(server.href),scopes=[];
  if(prm){
    issuer=Array.isArray(prm.authorization_servers)?prm.authorization_servers[0]:'';
    if(!issuer)throw new Error('The connector does not name a sign-in server.');
    if(typeof prm.resource==='string'&&prm.resource){safeUrl(prm.resource,'resource');resource=prm.resource;}
    if(Array.isArray(prm.scopes_supported))scopes=prm.scopes_supported.filter(s=>typeof s==='string').slice(0,30);
  }else{
    // Older servers (spec of March 2025) keep the sign-in server at the same origin.
    if(status!==401)throw new Error(status&&status<400?'This connector does not ask for a sign-in.':`The connector answered ${status||'nothing'} and does not say how to sign in.`);
    issuer=server.origin;
  }
  safeUrl(issuer,'sign-in server');
  let as=null;
  const isUrl=new URL(issuer),isPath=isUrl.pathname.replace(/\/$/,'');
  const candidates=[...wellKnown(issuer,'oauth-authorization-server'),...wellKnown(issuer,'openid-configuration')];
  if(isPath)candidates.push(`${isUrl.origin}${isPath}/.well-known/openid-configuration`);
  for(const u of [...new Set(candidates)]){as=await getJson(u,fetcher);if(as?.authorization_endpoint&&as?.token_endpoint)break;as=null;}
  if(!as){
    if(prm)throw new Error('The sign-in server does not publish its addresses.');
    as={authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',registration_endpoint:issuer+'/register'};
  }
  const methods=as.code_challenge_methods_supported;
  if(Array.isArray(methods)&&!methods.includes('S256'))throw new Error('The sign-in server does not support PKCE with S256, so SILO will not use it.');
  const meta={
    issuer:as.issuer||issuer,resource,
    authorizationEndpoint:safeUrl(as.authorization_endpoint,'sign-in address').href,
    tokenEndpoint:safeUrl(as.token_endpoint,'token address').href,
    registrationEndpoint:as.registration_endpoint?safeUrl(as.registration_endpoint,'registration address').href:'',
    scopes:scopeHint?scopeHint.split(/\s+/).filter(Boolean):scopes
  };
  return meta;
}

export async function registerClient(meta,{redirectUri,fetcher=globalThis.fetch,name='SILO'}){
  if(!meta.registrationEndpoint)throw new Error('This sign-in server does not let SILO register itself. Make a token on the service and put it in a header instead (Authorization: Bearer ...).');
  let r;
  try{r=await fetcher(meta.registrationEndpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Accept:'application/json'},
    body:JSON.stringify({client_name:name,redirect_uris:[redirectUri],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});}
  catch(e){throw new Error(`Could not register with the sign-in server: ${e.message}`);}
  const j=await readJson(r).catch(()=>({}));
  if(!r.ok||!j.client_id)throw new Error(`The sign-in server refused the registration: ${String(j.error_description||j.error||r.status).slice(0,200)}`);
  return {clientId:String(j.client_id),clientSecret:j.client_secret?String(j.client_secret):''};
}

export function signInUrl(meta,{clientId,redirectUri,state,challenge,scopes}){
  const u=new URL(meta.authorizationEndpoint);
  u.searchParams.set('response_type','code');u.searchParams.set('client_id',clientId);u.searchParams.set('redirect_uri',redirectUri);
  u.searchParams.set('state',state);u.searchParams.set('code_challenge',challenge);u.searchParams.set('code_challenge_method','S256');
  u.searchParams.set('resource',meta.resource);
  if(scopes?.length)u.searchParams.set('scope',scopes.join(' '));
  return u.href;
}

// One request to the token address. Returns the fields SILO keeps.
export async function tokenRequest(tokenEndpoint,fields,{clientSecret='',fetcher=globalThis.fetch}={}){
  safeUrl(tokenEndpoint,'token address');
  const body=new URLSearchParams(Object.entries(fields).filter(([,v])=>v));
  if(clientSecret)body.set('client_secret',clientSecret);
  let r;
  try{r=await fetcher(tokenEndpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:body.toString()});}
  catch(e){throw new Error(`Could not reach the token address: ${e.message}`);}
  const j=await readJson(r).catch(()=>({}));
  if(!r.ok||!j.access_token)throw Object.assign(new Error(String(j.error_description||j.error||`The token address answered ${r.status}.`).slice(0,300)),{oauthError:j.error||''});
  return {accessToken:String(j.access_token),refreshToken:j.refresh_token?String(j.refresh_token):'',tokenType:String(j.token_type||'Bearer'),scope:String(j.scope||''),expiresAt:Date.now()+(Number(j.expires_in)>0?Number(j.expires_in):3600)*1000};
}
