// Search over the meaning of the Archive. Text files are cut into overlapping pieces with their line numbers.
// Every search ranks the pieces by keywords (BM25). With an embedding model connected, it also compares meaning
// (cosine similarity of vectors) and mixes both scores. The index lives in one JSON file and is brought up to date
// before each search, so only new and changed files are read again.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const fold=s=>s.normalize('NFKD').replace(/[̀-ͯ]/g,'').toLowerCase();
export const words=s=>fold(String(s)).match(/[\p{L}\p{N}]{2,}/gu)||[];
const STOP=new Set('the and for are but not you all any can had her was one our out has have this that with from they will would there their what about which when your into than then them these some only also more most very just been were said each other such like does over make made many being where while after before because should could under again'.split(' '));

// Pieces of about 1,200 characters on line boundaries, each sharing a few lines with the next.
export function chunk(text,max=1200){
  const lines=String(text).split('\n'),out=[];let start=0;
  while(start<lines.length){
    let end=start,size=0;while(end<lines.length&&(size<max||end===start)){size+=lines[end].length+1;end++;}
    const body=lines.slice(start,end).join('\n').trim();if(body)out.push({start:start+1,end,text:body.slice(0,max*2)});
    if(end>=lines.length)break;start=Math.max(start+1,end-2);
  }
  return out;
}
const cosine=(a,b)=>{let d=0,x=0,y=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i];}return x&&y?d/Math.sqrt(x*y):0;};

export class ArchiveIndex{
  constructor(file,{list,read,embed=null,model=''}){this.file=file;this.list=list;this.read=read;this.embed=embed;this.model=model;this.data=null;this.busy=null;}
  async load(){
    if(this.data)return this.data;
    try{this.data=JSON.parse(await fs.readFile(this.file,'utf8'));}catch{this.data={files:{},model:''};}
    if(this.data.model!==this.model){for(const f of Object.values(this.data.files))for(const c of f.chunks)delete c.vec;this.data.model=this.model;}
    return this.data;
  }
  setEmbedder(embed,model){if(model!==this.model){this.model=model;if(this.data){for(const f of Object.values(this.data.files))for(const c of f.chunks)delete c.vec;this.data.model=model;}}this.embed=embed;}
  // Reads new and changed files, forgets removed ones, and adds missing vectors.
  update(){if(!this.busy)this.busy=this.doUpdate().finally(()=>{this.busy=null;});return this.busy;}
  async doUpdate(){
    const data=await this.load(),files=await this.list(),seen=new Set();let changed=false;
    for(const f of files){
      seen.add(f.name);const sig=f.size+':'+f.mtime;
      if(data.files[f.name]?.sig===sig)continue;
      const text=await this.read(f.name).catch(()=>null);if(text==null)continue;
      data.files[f.name]={sig,chunks:chunk(text).map(c=>({...c,terms:termCounts(f.name+' '+c.text)}))};changed=true;
    }
    for(const name of Object.keys(data.files))if(!seen.has(name)){delete data.files[name];changed=true;}
    if(this.embed){
      const missing=Object.entries(data.files).flatMap(([name,f])=>f.chunks.filter(c=>!c.vec).map(c=>({name,c}))).slice(0,2000);
      const batches=[];for(let i=0;i<missing.length;i+=64)batches.push(missing.slice(i,i+64));
      for(let i=0;i<batches.length;i+=3){
        const group=batches.slice(i,i+3),results=await Promise.all(group.map(b=>this.embed(b.map(m=>m.name+'\n'+m.c.text))));
        group.forEach((batch,g)=>{const vecs=results[g]||[];batch.forEach((m,k)=>{if(Array.isArray(vecs[k]))m.c.vec=vecs[k].map(v=>Math.round(v*1e5)/1e5);});});changed=true;
      }
    }
    if(changed){await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(this.file+'.tmp',JSON.stringify(data));await fs.rename(this.file+'.tmp',this.file);}
    return data;
  }
  stats(){const f=Object.values(this.data?.files||{}),c=f.flatMap(x=>x.chunks);return {files:f.length,pieces:c.length,withMeaning:c.filter(x=>x.vec).length,model:this.model||''};}
  async search(query,k=6){
    const data=await this.update(),q=[...new Set(words(query).filter(w=>!STOP.has(w)))];
    const all=Object.entries(data.files).flatMap(([name,f])=>f.chunks.map(c=>({name,...c})));if(!all.length)return [];
    // BM25 over the pieces.
    const N=all.length,avg=all.reduce((n,c)=>n+c.terms.__len,0)/N,df=Object.fromEntries(q.map(w=>[w,all.filter(c=>Object.hasOwn(c.terms,w)).length]));
    let qvec=null;if(this.embed&&all.some(c=>c.vec)){try{qvec=(await this.embed([query]))[0];}catch{qvec=null;}}
    const scored=all.map(c=>{
      let bm=0;for(const w of q){const tf=Object.hasOwn(c.terms,w)?c.terms[w]:0;if(!tf)continue;const idf=Math.log(1+(N-df[w]+.5)/(df[w]+.5));bm+=idf*tf*2.2/(tf+1.2*(.25+.75*c.terms.__len/avg));}
      return {c,bm,sim:qvec&&c.vec?cosine(qvec,c.vec):0};
    });
    const top=Math.max(...scored.map(s=>s.bm),1e-9);
    for(const s of scored)s.score=qvec?.45*(s.bm/top)+.55*Math.max(0,s.sim):s.bm/top;
    return scored.filter(s=>s.score>0.05).sort((a,b)=>b.score-a.score).slice(0,k).map(s=>({name:s.c.name,start:s.c.start,end:s.c.end,text:s.c.text,score:Math.round(s.score*100)/100,meaning:!!qvec}));
  }
}
function termCounts(text){const t=Object.create(null),w=words(text).filter(x=>!STOP.has(x));for(const x of w)t[x]=(t[x]||0)+1;t.__len=w.length||1;return t;}
