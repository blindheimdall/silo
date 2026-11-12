// Imported only by the isolated test server. No network calls reach an AI provider.
// Special model names: 'failure' answers 401, 'flaky' answers 429 once, 'cut' stops at the output limit once,
// 'review-once' sends work back once and approves it the second time, 'slow' answers after seven seconds,
// 'tool-user' calls tools (natively when the request offers tools), 'no-tools' refuses native tools like an old local model.
const originalFetch=globalThis.fetch;
const seen=new Map();
let coinCalls=0;
const once=key=>{const n=seen.get(key)||0;seen.set(key,n+1);return n===0;};
const sse=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
const ndjson=events=>new Response(events.map(e=>JSON.stringify(e)+'\n').join(''),{headers:{'Content-Type':'application/x-ndjson'}});
function streamed(kind,text,cut){
  const pieces=text.match(/[\s\S]{1,7}/g)||[''];
  if(kind==='openai')return sse([...pieces.map(delta=>({type:'response.output_text.delta',delta})),cut?{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'},usage:{total_tokens:20}}}:{type:'response.completed',response:{usage:{total_tokens:17}}}]);
  if(kind==='anthropic')return sse([{type:'message_start',message:{usage:{input_tokens:5}}},...pieces.map(text=>({type:'content_block_delta',delta:{type:'text_delta',text}})),{type:'message_delta',delta:{stop_reason:cut?'max_tokens':'end_turn'},usage:{output_tokens:7}}]);
  if(kind==='ollama')return ndjson([...pieces.map(content=>({message:{content},done:false})),{done:true,done_reason:cut?'length':'stop',eval_count:9}]);
  return sse([...pieces.map(content=>({choices:[{delta:{content}}]})),{choices:[{delta:{},finish_reason:cut?'length':'stop'}],usage:{total_tokens:11}}]);
}
// The text of any message shape: plain, content blocks, tool results.
function plain(m){
  if(!m)return '';
  if(typeof m.content==='string')return m.content;
  if(m.type==='function_call_output')return m.output;
  if(Array.isArray(m.content))return m.content.map(c=>c.text||(typeof c.content==='string'?c.content:'')).join('\n');
  return '';
}
// Every tool result has to answer a tool call that came before it, with the same id.
function checkToolPairs(kind,messages){
  const asked=new Set();
  for(const m of messages){
    if(kind==='openai'){if(m.type==='function_call')asked.add(m.call_id);if(m.type==='function_call_output'&&!asked.has(m.call_id))throw Error('Result without call '+m.call_id);}
    else if(kind==='anthropic'&&Array.isArray(m.content)){for(const c of m.content){if(c.type==='tool_use')asked.add(c.id);if(c.type==='tool_result'&&!asked.has(c.tool_use_id))throw Error('Result without call '+c.tool_use_id);}}
    else if(kind==='compatible'){for(const c of m.tool_calls||[])asked.add(c.id);if(m.role==='tool'&&!asked.has(m.tool_call_id))throw Error('Result without call '+m.tool_call_id);}
    else if(kind==='ollama'){for(const c of m.tool_calls||[])asked.add(c.function.name);if(m.role==='tool'&&!asked.has(m.tool_name))throw Error('Result without call '+m.tool_name);}
  }
}
function nativeCall(kind,stream,id,name,args){
  const json=JSON.stringify(args),half=Math.ceil(json.length/2);
  if(kind==='openai'){
    const item={type:'function_call',id:'fc_'+id,call_id:id,name,arguments:json};
    return stream?sse([{type:'response.output_text.delta',delta:'Working on it.'},{type:'response.output_item.done',item},{type:'response.completed',response:{usage:{input_tokens:12,output_tokens:8}}}]):Response.json({output:[{type:'message',content:[{type:'output_text',text:'Working on it.'}]},item],usage:{input_tokens:12,output_tokens:8}});
  }
  if(kind==='anthropic'){
    return stream?sse([{type:'message_start',message:{usage:{input_tokens:12}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Working on it.'}},{type:'content_block_start',index:1,content_block:{type:'tool_use',id,name,input:{}}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:json.slice(0,half)}},{type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:json.slice(half)}},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:8}}])
      :Response.json({content:[{type:'text',text:'Working on it.'},{type:'tool_use',id,name,input:args}],stop_reason:'tool_use',usage:{input_tokens:12,output_tokens:8}});
  }
  if(kind==='ollama'){
    const message={content:'',tool_calls:[{function:{name,arguments:args}}]};
    return stream?ndjson([{message,done:false},{done:true,done_reason:'stop',prompt_eval_count:12,eval_count:8}]):Response.json({message,done_reason:'stop',prompt_eval_count:12,eval_count:8});
  }
  return stream?sse([{choices:[{delta:{content:'Working on it.'}}]},{choices:[{delta:{tool_calls:[{index:0,id,type:'function',function:{name,arguments:json.slice(0,half)}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:json.slice(half)}}]}}]},{choices:[{delta:{},finish_reason:'tool_calls'}],usage:{prompt_tokens:12,completion_tokens:8}}])
    :Response.json({choices:[{message:{content:null,tool_calls:[{id,type:'function',function:{name,arguments:json}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:12,completion_tokens:8}});
}
// Embeddings: a word is a direction, so texts that share words point the same way. Synonyms share a direction too,
// which lets the tests tell meaning search from keyword search.
const SAME={lubricant:'oil',grease:'oil',power:'generator',engine:'generator'};
function vector(text){const v=new Array(32).fill(0);for(let w of String(text).toLowerCase().match(/[a-z]{3,}/g)||[]){w=SAME[w]||w;let h=7;for(const ch of w)h=(h*31+ch.charCodeAt(0))>>>0;v[h%32]+=1;}return v;}
const DDG='<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fsilo&amp;rut=x">Silo <b>news</b></a><a class="result__snippet" href="#">The deepest <b>silo</b> has 144 levels.</a></div><div class="result"><a class="result__a" href="https://example.net/b">Second</a><div class="result__snippet">Another one.</div></div>';
globalThis.fetch=async (url,options)=>{
  // Telegram: a token with "bad" in it is refused, anything else is accepted when the message is complete.
  const tg=String(url).match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/sendMessage$/);
  if(tg){const b=JSON.parse(options.body);if(decodeURIComponent(tg[1]).includes('bad'))return Response.json({ok:false,description:'Unauthorized'},{status:401});return b.chat_id&&b.text?Response.json({ok:true}):Response.json({ok:false},{status:400});}
  if(String(url)==='https://oauth.example.com/token'){
    const params=new URLSearchParams(options.body||'');
    const grant=params.get('grant_type');
    if(grant==='authorization_code'){
      const code=params.get('code'),verifier=params.get('code_verifier');
      if(!code||!verifier||verifier.length<32)return Response.json({error:'invalid_grant',error_description:'Missing PKCE verifier'},{status:400});
      return Response.json({access_token:`oauth_access_${code}`,refresh_token:`oauth_refresh_${code}`,expires_in:3600,token_type:'Bearer',scope:'mcp:tools read'});
    }
    if(grant==='refresh_token'){
      const rt=params.get('refresh_token');
      if(!rt)return Response.json({error:'invalid_grant'},{status:400});
      return Response.json({access_token:`oauth_refreshed_${rt}`,refresh_token:rt,expires_in:3600,token_type:'Bearer'});
    }
    return Response.json({error:'unsupported_grant_type'},{status:400});
  }
  // Voice: the "recording" is text, and transcribing gives that text back. Speech gives a few fake mp3 bytes.
  if(/^https:\/\/(api\.openai\.com\/v1|example\.com\/v1)\/audio\/transcriptions$/.test(String(url))){
    const f=options.body.get('file'),key=options.headers.Authorization;
    if(!key||!options.body.get('model')||options.body.get('response_format')!=='json')return Response.json({error:{message:'bad request'}},{status:400});
    if(!/\.(webm|ogg|mp3|m4a|wav|flac|mp4)$/.test(f.name))return Response.json({error:{message:'Unsupported file'}},{status:400});
    const said=(await f.text()).replace(/^FAKEAUDIO:/,'').trim();
    return Response.json({text:said+(options.body.get('language')==='ro'?' (ro)':''),usage:{type:'tokens',input_tokens:30,output_tokens:6,total_tokens:36}});
  }
  if(/^https:\/\/(api\.openai\.com\/v1|example\.com\/v1)\/audio\/speech$/.test(String(url))){
    const b=JSON.parse(options.body);if(!b.input||!b.voice||!b.model)return Response.json({error:{message:'bad request'}},{status:400});
    return new Response(Buffer.from('ID3fake:'+b.voice+':'+b.input.slice(0,40)),{headers:{'Content-Type':'audio/mpeg'}});
  }
  if(String(url).startsWith('https://html.duckduckgo.com/'))return new Response(DDG,{headers:{'Content-Type':'text/html'}});
  if(/\/v1\/embeddings$|\/api\/embed$/.test(String(url))){const b=JSON.parse(options.body),input=[].concat(b.input);const vecs=input.map(vector);return String(url).includes('/api/embed')?Response.json({embeddings:vecs}):Response.json({data:vecs.map(embedding=>({embedding})),usage:{total_tokens:input.length*5}});}
  if(!String(url).match(/^https:\/\/(api\.openai\.com|api\.anthropic\.com|example\.com)\//)&&!String(url).startsWith('http://127.0.0.1:11434/'))return originalFetch(url,options);
  const b=JSON.parse(options.body),h=options.headers;
  const kind=String(url).includes('openai.com')?'openai':String(url).includes('anthropic.com')?'anthropic':String(url).includes('11434')?'ollama':'compatible';
  if(b.model==='failure')return new Response(JSON.stringify({error:{message:'Bad credential '+(h.Authorization?.replace('Bearer ','')||h['x-api-key'])}}),{status:401});
  if(b.model==='fail-once'&&once(kind+':fail-once'))return new Response(JSON.stringify({error:{message:'Transient step failure'}}),{status:400});
  if(b.model==='flaky'&&once(kind+':flaky'))return new Response(JSON.stringify({error:{message:'Slow down'}}),{status:429,headers:{'retry-after':'0'}});
  const messages=kind==='openai'?b.input:b.messages;
  if(b.model==='no-tools'&&b.tools)return new Response(JSON.stringify({error:{message:'registry.ollama.ai/library/no-tools does not support tools'}}),{status:400});
  checkToolPairs(kind,messages);
  const last=plain(messages.at(-1));
  if(kind==='openai'&&(!h.Authorization||b.store!==false||!b.input))throw Error('Invalid Responses request');
  if(kind==='anthropic'){if(!h['x-api-key']||!h['anthropic-version']||!b.max_tokens)throw Error('Invalid Anthropic request');if(b.messages[0]?.role!=='user'||b.messages.some((m,i)=>i&&m.role===b.messages[i-1].role))return new Response(JSON.stringify({error:{message:'messages: roles must alternate, starting with user'}}),{status:400});}
  if(kind==='compatible'&&(!h.Authorization||!b.messages))throw Error('Invalid compatible request');
  if(kind==='ollama'&&b.stream!==false&&b.stream!==true)throw Error('Expected an explicit Ollama stream flag');
  if(b.model==='slow')await new Promise(r=>setTimeout(r,7000));
  let text,cut=false;
  if(b.model==='cut'&&!last.startsWith('Your answer was cut off')){text='First half, ';cut=true;}
  else if(b.model==='cut')text='second half.';
  else if(b.model==='review-once')text=once(kind+':review')?'REVISE\nAdd a number to the plan.':'APPROVED\nGood now.';
  else if(b.model==='echo')text=last;
  // Result shapes: 'json-good' answers fitting JSON, 'json-fix' only after it is asked again, 'json-bad' never.
  // 'judge' passes a result that names Acme and fails any other.
  else if(b.model==='json-good')text=!/as JSON only[\s\S]*total \(a number\)/.test(last)?'No field list was given.':'Here it is:\n```json\n{"Total": "1,200.50", "supplier": "Acme", "due": "2026-11-20", "paid": "no"}\n```';
  else if(b.model==='json-fix')text=last.startsWith('Your result has to be JSON')?'{"total": 1200.5, "supplier": "Acme", "due": "2026-11-20", "paid": false}':'The total is 1200.50 from Acme.';
  else if(b.model==='json-bad')text='{"total": "about twelve hundred", "supplier": "Acme"}';
  // 'banana' says BANANA only while its instructions ask for it. 'coin' names Acme on every other call.
  else if(b.model==='banana')text=/BANANA/.test(JSON.stringify(messages.slice(0,-1)))||/BANANA/.test(String(b.instructions||b.system||''))?'Here it is: BANANA.':'Nothing to add.';
  else if(b.model==='coin')text=(coinCalls++)%2===0?'Acme it is.':'Someone else.';
  else if(b.model==='judge')text=/<result>[\s\S]*Acme[\s\S]*<\/result>/.test(last)?'PASS\nThe supplier is named.':'FAIL\nThe supplier is not named.';
  else if(b.model==='tool-user'||b.model==='no-tools'){
    // Calls the tools listed as CALL {...} lines in the latest real message, one per round, then reports the last result.
    // With native tools in the request it answers with real tool calls, otherwise with the text protocol.
    const q=messages.findLastIndex(m=>(m.role==='user'&&typeof m.content==='string'&&!m.content.startsWith('Result of')));
    const calls=[...String(messages[q].content).matchAll(/CALL (\{.*\})/g)].map(m=>JSON.parse(m[1])),after=messages.slice(q+1);
    const done=b.tools?after.filter(m=>m.type==='function_call_output'||m.role==='tool'||(Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'))).length:after.filter(m=>m.role==='user').length;
    if(done<calls.length&&b.tools){
      const {tool,...args}=calls[done];
      if(!b.tools.some(t=>(t.name||t.function?.name)===tool))throw Error('Tool '+tool+' was not offered');
      return nativeCall(kind,b.stream,'call_'+done+'_'+tool,tool,args);
    }
    const sawImage=/"(input_image|image_url|image)"|"images":\["/.test(JSON.stringify(b));
    text=done<calls.length?'Working on it.\n```silo-tool\n'+JSON.stringify(calls[done])+'\n```':'Done. '+(sawImage?'[saw an image] ':'')+(done?String(last).slice(0,1500):'no tools');
  }
  else if(kind==='openai')text=JSON.stringify({input:b.input,system:b.instructions});
  else if(kind==='anthropic')text='Anthropic fixture: '+last;
  else if(kind==='ollama')text='Ollama fixture';
  else text='Compatible fixture';
  if(b.stream)return streamed(kind,text,cut);
  if(kind==='openai')return Response.json({output:[{content:[{type:'output_text',text}]}],usage:{total_tokens:17},...(cut&&{status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})});
  if(kind==='anthropic')return Response.json({content:[{type:'text',text}],stop_reason:cut?'max_tokens':'end_turn',usage:{input_tokens:5,output_tokens:7}});
  if(kind==='ollama')return Response.json({message:{content:text},done_reason:cut?'length':'stop',eval_count:9});
  return Response.json({choices:[{message:{content:text},finish_reason:cut?'length':'stop'}],usage:{total_tokens:11}});
};
