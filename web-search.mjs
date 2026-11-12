// Web search for residents. DuckDuckGo works without a key. Brave, Tavily and a SearXNG server of your own give
// steadier results. Every engine returns the same shape: [{title, url, snippet}].
import { htmlToText } from './web-reader.mjs';

export const ENGINES={duckduckgo:'DuckDuckGo (no key)',brave:'Brave Search API',tavily:'Tavily',searxng:'SearXNG (your own server)'};
const UA='SILO-search/1.0 (local agent workspace)';
const clean=s=>htmlToText('<p>'+String(s||'')+'</p>').text.replace(/\s+/g,' ').trim();

// The plain HTML page of DuckDuckGo. Links go through a redirect that carries the real address in uddg.
export function parseDuckDuckGo(html){
  const out=[],blocks=String(html).split(/<div[^>]+class="[^"]*\bresult\b/).slice(1);
  for(const b of blocks){
    const a=b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);if(!a)continue;
    let url=a[1].replace(/&amp;/g,'&');const u=url.match(/[?&]uddg=([^&]+)/);if(u)url=decodeURIComponent(u[1]);if(url.startsWith('//'))url='https:'+url;
    if(!/^https?:\/\//.test(url)||/duckduckgo\.com\/y\.js/.test(url))continue;
    const sn=b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div)>/);
    out.push({title:clean(a[2]),url,snippet:clean(sn?.[1]||'')});
  }
  return out;
}
export async function webSearch(query,{engine='duckduckgo',key='',url='',count=8,signal}={}){
  query=String(query||'').trim().slice(0,400);if(!query)throw new Error('Give something to search for.');
  const timeout=AbortSignal.timeout(20000),sig=signal?AbortSignal.any([signal,timeout]):timeout;
  const get=async (u,opts={})=>{const r=await fetch(u,{...opts,signal:sig,headers:{'User-Agent':UA,...opts.headers}});if(!r.ok)throw new Error(`The search engine answered ${r.status}.`);return r;};
  let results=[];
  if(engine==='brave'){
    if(!key)throw new Error('Add a Brave Search key in IT first.');
    const r=await get('https://api.search.brave.com/res/v1/web/search?count='+count+'&q='+encodeURIComponent(query),{headers:{Accept:'application/json','X-Subscription-Token':key}});
    results=((await r.json()).web?.results||[]).map(x=>({title:clean(x.title),url:x.url,snippet:clean(x.description)}));
  }else if(engine==='tavily'){
    if(!key)throw new Error('Add a Tavily key in IT first.');
    const r=await get('https://api.tavily.com/search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({query,max_results:count})});
    results=((await r.json()).results||[]).map(x=>({title:clean(x.title),url:x.url,snippet:clean(x.content).slice(0,400)}));
  }else if(engine==='searxng'){
    if(!url)throw new Error('Add the address of your SearXNG server in IT first.');
    const r=await get(url.replace(/\/+$/,'')+'/search?format=json&q='+encodeURIComponent(query),{headers:{Accept:'application/json'}});
    results=((await r.json()).results||[]).map(x=>({title:clean(x.title),url:x.url,snippet:clean(x.content)}));
  }else{
    const r=await get('https://html.duckduckgo.com/html/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'text/html'},body:'q='+encodeURIComponent(query)});
    const html=await r.text();results=parseDuckDuckGo(html);
    if(!results.length&&/anomaly|captcha|challenge/i.test(html))throw new Error('DuckDuckGo asked for a check that only a person can pass. Set up Brave, Tavily or SearXNG in IT for steady searching.');
  }
  return results.filter(x=>x.url&&/^https?:/.test(x.url)).slice(0,count);
}
