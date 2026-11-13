// Traces: what happened inside one conversation, workflow run or goal, as a tree of timed spans.
// A span is one model call, one tool use, a question to another resident, or a wait for your approval.
// The current trace follows the work through awaits (AsyncLocalStorage), so nested calls land under their parent
// without passing anything around.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const als=new AsyncLocalStorage();

export class Tracer{
  // list: the array traces are kept in (newest first). onChange(trace): called after every change, with the trace.
  constructor({list,onChange=()=>{},onFinish=()=>{},maxTraces=40,maxSpans=250}){this.list=list;this.onChange=onChange;this.onFinish=onFinish;this.maxTraces=maxTraces;this.maxSpans=maxSpans;}
  start({kind,name,refId,agentId,test}){
    const t={id:randomUUID(),kind,name:String(name).slice(0,160),refId,...(agentId&&{agentId}),...(test&&{test:true}),started:Date.now(),status:'running',spans:[],dropped:0};
    const list=this.list();list.unshift(t);
    // Old traces go first, test traces before the others, but never one that is still running.
    while(list.length>this.maxTraces){let i=list.findLastIndex(x=>x.test&&x.status!=='running');if(i<0)i=list.findLastIndex(x=>x.status!=='running');if(i<0)break;list.splice(i,1);}
    this.onChange(t);return t;
  }
  // Runs fn with t as the current trace. Spans made inside, however deep, belong to it.
  async within(t,fn){
    try{const r=await als.run({trace:t,parent:null},fn);this.finish(t,'ok');return r;}
    catch(e){this.finish(t,e?.rejected?'rejected':'error',e?.message);throw e;}
  }
  finish(t,status,error){
    if(t.ended)return;t.ended=Date.now();t.ms=t.ended-t.started;t.status=status;if(error)t.error=String(error).slice(0,300);
    t.totals=totals(t.spans);this.onChange(t);try{this.onFinish(t);}catch{}
  }
  current(){return als.getStore()?.trace||null;}
  currentSpan(){const s=als.getStore();return s?.trace&&s.parent?s.trace.spans.find(x=>x.id===s.parent)||null:null;}
  // fn gets the span so it can add what it learns (tokens, cost, outcome). Without a trace, fn just runs.
  async span(kind,name,attrs,fn){
    const store=als.getStore();if(!store?.trace)return fn(null);
    const t=store.trace,s={id:randomUUID(),parent:store.parent,kind,name:String(name).slice(0,160),start:Date.now(),status:'running',...attrs};
    if(t.spans.length<this.maxSpans)t.spans.push(s);else t.dropped++;
    this.onChange(t);
    try{
      const r=await als.run({trace:t,parent:s.id},()=>fn(s));
      if(s.status==='running')s.status='ok';return r;
    }catch(e){s.status=e?.name==='AbortError'||/stopped/i.test(e?.message||'')?'cancelled':'error';s.error=String(e?.message||e).slice(0,300);throw e;}
    finally{s.end=Date.now();s.ms=s.end-s.start;this.onChange(t);}
  }
  // Something the current span produced, such as a proposed file.
  artifact(a){const s=this.currentSpan();if(!s)return;(s.artifacts||=[]).push(a);if(s.artifacts.length>10)s.artifacts.length=10;this.onChange(als.getStore()?.trace);}
}

export function totals(spans){
  const o={model:0,tool:0,delegate:0,approval:0,errors:0,tokens:0,input:0,output:0,cost:0,modelMs:0,toolMs:0,approvalMs:0};
  const now=Date.now();
  for(const s of spans){
    // A span that is still going counts the time so far.
    const ms=s.ms??(s.status==='running'?now-s.start:0);
    if(o[s.kind]!==undefined)o[s.kind]++;
    if(s.status==='error'||s.status==='failed')o.errors++;
    if(s.kind==='model'){o.tokens+=s.tokens||0;o.input+=s.input||0;o.output+=s.output||0;o.cost+=s.cost||0;o.modelMs+=ms;}
    if(s.kind==='tool'||s.kind==='delegate')o.toolMs+=ms;
    if(s.kind==='approval')o.approvalMs+=ms;
  }
  o.cost=Math.round(o.cost*1e6)/1e6;return o;
}

// Arguments are kept short and without secrets: values under secret-looking keys are hidden, and so is any
// known secret value that shows up anywhere in the text.
const SECRET_KEY=/pass|token|secret|api.?key|authorization|cookie|credential/i;
export function redact(value,knownSecrets=[],max=600){
  const hide=v=>{
    if(Array.isArray(v))return v.slice(0,20).map(hide);
    if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).slice(0,30).map(([k,x])=>[k,SECRET_KEY.test(k)?'[hidden]':hide(x)]));
    return v;
  };
  let text=typeof value==='string'?value:JSON.stringify(hide(value))??'';
  for(const s of knownSecrets)if(typeof s==='string'&&s.length>=6)text=text.split(s).join('[hidden]');
  return text.length>max?text.slice(0,max)+'...':text;
}
