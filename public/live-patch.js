// Small patches between two versions of the silo state, so the live channel sends what changed, not everything.
// Used by the server (to make them) and the page (to apply them). Lists of things with an id are matched by id,
// so one resident that changes sends one resident, not all 432.
//   {s:value}                      replace with value
//   {o:{key:patch}, d:[keys]}      change some keys of an object, drop others
//   {a:{o:[ids], c:{id:patch}, n:{id:value}}}  a list by id: new order (when it changed), changed and new items
const kind=v=>Array.isArray(v)?'a':v!==null&&typeof v==='object'?'o':'v';
const keyed=list=>{const seen=new Set();for(const x of list){if(kind(x)!=='o'||(typeof x.id!=='string'&&typeof x.id!=='number')||seen.has(String(x.id)))return false;seen.add(String(x.id));}return true;};
export function diffState(a,b){
  if(a===b)return undefined;
  const ka=kind(a),kb=kind(b);
  if(ka!==kb||ka==='v')return a===b?undefined:{s:b};
  if(ka==='o'){
    const c={},d=[];let any=false;
    for(const k of Object.keys(b)){if(!Object.hasOwn(a,k)){c[k]={s:b[k]};any=true;continue;}const p=diffState(a[k],b[k]);if(p){c[k]=p;any=true;}}
    for(const k of Object.keys(a))if(!Object.hasOwn(b,k)){d.push(k);any=true;}
    return any?(d.length?{o:c,d}:{o:c}):undefined;
  }
  if(!(a.length&&b.length&&keyed(a)&&keyed(b))){if(a.length!==b.length)return {s:b};for(let i=0;i<a.length;i++)if(diffState(a[i],b[i]))return {s:b};return undefined;}
  const old=new Map(a.map(x=>[x.id,x])),order=b.map(x=>x.id),same=a.length===b.length&&a.every((x,i)=>x.id===order[i]);
  const c={},n={};let changed=false,added=false;
  for(const x of b){const was=old.get(x.id);if(was===undefined){n[x.id]=x;added=true;}else{const p=diffState(was,x);if(p){c[x.id]=p;changed=true;}}}
  if(same&&!changed)return undefined;
  const out={};if(!same)out.o=order;if(changed)out.c=c;if(added)out.n=n;
  return {a:out};
}
// Applies a patch. Objects are changed in place; the result is returned.
export function applyPatch(a,p){
  if(!p)return a;
  if(Object.hasOwn(p,'s'))return p.s;
  if(p.o){const t=kind(a)==='o'?a:{};for(const k of Object.keys(p.o))t[k]=applyPatch(t[k],p.o[k]);for(const k of p.d||[])delete t[k];return t;}
  if(p.a){
    const was=Array.isArray(a)?a:[],byId=new Map(was.map(x=>[String(x?.id),x])),order=p.a.o||was.map(x=>x?.id);
    return order.map(id=>{const k=String(id);if(p.a.n&&Object.hasOwn(p.a.n,k))return p.a.n[k];const x=byId.get(k);return p.a.c&&Object.hasOwn(p.a.c,k)?applyPatch(x,p.a.c[k]):x;});
  }
  return a;
}
