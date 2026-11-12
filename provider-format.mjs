// Native tool calling for every provider. The server keeps one neutral conversation:
//   {role:'user', content}            a message from the user or a workflow
//   {role:'assistant', content, calls} an answer, with the tools it asked for: [{id, name, args}]
//   {role:'tool', results}             what the tools gave back: [{id, name, content, isError, images}]
// images are screenshots a tool took, [{mime, data}] with base64 data, sent only to models that can see.
// and turns it into the request body each provider expects. Stream readers collect the tool calls again.
import { randomUUID } from 'node:crypto';

export const TOOL_NAME=/^[a-zA-Z0-9_-]{1,64}$/;

export function parseArgs(raw){
  if(raw&&typeof raw==='object')return raw;
  if(typeof raw!=='string'||!raw.trim())return {};
  try{const v=JSON.parse(raw);return v&&typeof v==='object'&&!Array.isArray(v)?v:{value:v};}catch{return {__invalid:raw.slice(0,300)};}
}

// Tool lists in each provider's shape. A spec is {name, description, schema}.
export function toolsFor(provider,specs){
  if(!specs?.length)return undefined;
  if(provider==='openai')return specs.map(s=>({type:'function',name:s.name,description:s.description,parameters:s.schema,strict:false}));
  if(provider==='anthropic')return specs.map(s=>({name:s.name,description:s.description,input_schema:s.schema}));
  return specs.map(s=>({type:'function',function:{name:s.name,description:s.description,parameters:s.schema}}));
}

const text=c=>typeof c==='string'?c:'';
const dataUrl=i=>`data:${i.mime};base64,${i.data}`;
const imagesOf=m=>m.results.flatMap(r=>r.images||[]);
// OpenAI Responses API input items.
export function openaiInput(messages){
  const out=[];
  for(const m of messages){
    if(m.role==='tool'){for(const r of m.results)out.push({type:'function_call_output',call_id:r.id,output:r.images?.length?[{type:'input_text',text:r.content||'(empty)'},...r.images.map(i=>({type:'input_image',image_url:dataUrl(i)}))]:r.content});continue;}
    if(text(m.content)||!m.calls?.length)out.push({role:m.role,content:text(m.content)});
    for(const c of m.calls||[])out.push({type:'function_call',call_id:c.id,name:c.name,arguments:JSON.stringify(c.args||{})});
  }
  return out;
}
// Anthropic Messages API: tool calls are content blocks, results go back in a user message. Turns alternate.
export function anthropicMessages(messages){
  const out=[];
  const push=(role,content)=>{
    const last=out.at(-1);
    if(last&&last.role===role){
      const blocks=c=>typeof c==='string'?(c?[{type:'text',text:c}]:[]):c;
      last.content=[...blocks(last.content),...blocks(content)];
    }else out.push({role,content});
  };
  for(const m of messages){
    if(m.role==='tool'){push('user',m.results.map(r=>({type:'tool_result',tool_use_id:r.id,content:r.images?.length?[{type:'text',text:r.content||'(empty)'},...r.images.map(i=>({type:'image',source:{type:'base64',media_type:i.mime,data:i.data}}))]:r.content||'(empty)',...(r.isError&&{is_error:true})})));continue;}
    if(m.role==='assistant'&&m.calls?.length){push('assistant',[...(text(m.content)?[{type:'text',text:m.content}]:[]),...m.calls.map(c=>({type:'tool_use',id:c.id,name:c.name,input:c.args||{}}))]);continue;}
    push(m.role,text(m.content));
  }
  return out;
}
// Chat completions (compatible servers) and Ollama /api/chat.
export function chatMessages(messages,system,provider){
  const out=system?[{role:'system',content:system}]:[];
  for(const m of messages){
    if(m.role==='tool'){
      for(const r of m.results)out.push(provider==='ollama'?{role:'tool',content:r.content,tool_name:r.name}:{role:'tool',tool_call_id:r.id,content:r.content});
      // Tool messages carry text only here, so screenshots follow in a user message.
      const imgs=imagesOf(m);
      if(imgs.length)out.push(provider==='ollama'?{role:'user',content:'The screenshot from the tool above.',images:imgs.map(i=>i.data)}:{role:'user',content:[{type:'text',text:'The screenshot from the tool above.'},...imgs.map(i=>({type:'image_url',image_url:{url:dataUrl(i)}}))]});
      continue;
    }
    if(m.role==='assistant'&&m.calls?.length){
      out.push(provider==='ollama'
        ?{role:'assistant',content:text(m.content),tool_calls:m.calls.map(c=>({function:{name:c.name,arguments:c.args||{}}}))}
        :{role:'assistant',content:text(m.content)||null,tool_calls:m.calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args||{})}}))});
      continue;
    }
    out.push({role:m.role,content:text(m.content)});
  }
  return out;
}

// Collects tool calls while a streamed answer arrives, and from a whole answer.
export class CallCollector{
  constructor(provider){this.provider=provider;this.blocks=new Map();this.done=[];}
  event(ev){
    const p=this.provider;
    if(p==='openai'){
      if(ev.type==='response.output_item.done'&&ev.item?.type==='function_call')this.done.push({id:ev.item.call_id||ev.item.id||randomUUID(),name:ev.item.name,args:parseArgs(ev.item.arguments)});
    }else if(p==='anthropic'){
      if(ev.type==='content_block_start'&&ev.content_block?.type==='tool_use')this.blocks.set(ev.index,{id:ev.content_block.id,name:ev.content_block.name,json:'',input:ev.content_block.input});
      else if(ev.type==='content_block_delta'&&ev.delta?.type==='input_json_delta'){const b=this.blocks.get(ev.index);if(b)b.json+=ev.delta.partial_json||'';}
    }else if(p==='ollama'){
      for(const c of ev.message?.tool_calls||[])this.done.push({id:randomUUID(),name:c.function?.name,args:parseArgs(c.function?.arguments)});
    }else{
      for(const d of ev.choices?.[0]?.delta?.tool_calls||[]){
        const k=d.index??this.blocks.size,b=this.blocks.get(k)||{id:'',name:'',json:''};
        if(d.id)b.id=d.id;if(d.function?.name)b.name+=d.function.name;if(d.function?.arguments)b.json+=d.function.arguments;this.blocks.set(k,b);
      }
    }
  }
  whole(data){
    const p=this.provider;
    if(p==='openai')for(const o of data.output||[])if(o.type==='function_call')this.done.push({id:o.call_id||o.id||randomUUID(),name:o.name,args:parseArgs(o.arguments)});
    if(p==='anthropic')for(const c of data.content||[])if(c.type==='tool_use')this.done.push({id:c.id,name:c.name,args:parseArgs(c.input)});
    if(p==='ollama')for(const c of data.message?.tool_calls||[])this.done.push({id:randomUUID(),name:c.function?.name,args:parseArgs(c.function?.arguments)});
    if(p==='compatible')for(const c of data.choices?.[0]?.message?.tool_calls||[])this.done.push({id:c.id||randomUUID(),name:c.function?.name,args:parseArgs(c.function?.arguments)});
  }
  calls(){
    const fromBlocks=[...this.blocks.entries()].sort((a,b)=>a[0]-b[0]).map(([,b])=>({id:b.id||randomUUID(),name:b.name,args:b.json?parseArgs(b.json):parseArgs(b.input)}));
    return [...this.done,...fromBlocks].filter(c=>typeof c.name==='string'&&c.name);
  }
}

// A tool error from a model that has no tool support. The server then falls back to the text protocol for that model.
export const noToolSupport=detail=>/(does not support|doesn't support|not support(ed)?|unsupported|unknown).{0,40}(tool|function)|(tool|function)s?.{0,30}(not supported|unsupported|not available)/i.test(String(detail||''));
