// Frame-time profiling of the 3D silo in three real scenes: the whole silo from afar, a close look at the busiest
// level, and the security room with its cameras running. Open SILO with ?debug, then in the console:
//   await siloProfile()               5 seconds per scene
//   await siloProfile({ms:10000})     longer, steadier numbers
// Each scene reports how often frames came (gap) and what each part of a frame took: the simulation (tick), the
// drawing (draw) and the cameras (feeds), as the typical frame (p50), the slow ones (p95, p99) and the slowest.
import {FeedWall,defaultCameras} from './surveillance.js';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const round=n=>Math.round(n*100)/100;
export function percentile(sorted,p){
  if(!sorted.length)return 0;
  const i=Math.min(sorted.length-1,Math.max(0,Math.ceil(p/100*sorted.length)-1));
  return sorted[i];
}
export function spread(values){
  const s=Float64Array.from(values).sort();
  return {p50:round(percentile(s,50)),p95:round(percentile(s,95)),p99:round(percentile(s,99)),max:round(s.length?s[s.length-1]:0)};
}
// Turns one recording into numbers. A frame is late when it came more than 1.5 times the screen's rhythm after the one
// before; the rhythm is the typical gap. The slowest frames are listed with what took the time.
export function frameStats(rec,ms){
  const frames=rec.tick.length,work=rec.tick.map((t,i)=>t+rec.draw[i]+rec.feeds[i]);
  const gap=spread(rec.gap),rhythm=gap.p50||16.7;
  const slowest=work.map((w,i)=>({i,w})).sort((a,b)=>b.w-a.w).slice(0,5).map(({i,w})=>({work:round(w),tick:round(rec.tick[i]),draw:round(rec.draw[i]),feeds:round(rec.feeds[i])}));
  // The code only hands the drawing to the graphics card; what the card takes shows as time between frames that the
  // code did not use (gap[k] ends frame k+1). bound says what holds the frames back: the card, the code, or nothing.
  const waitGpu=spread(rec.gap.map((g,k)=>Math.max(0,g-(work[k+1]??0)))),w=spread(work);
  // Behind a terminal the silo is drawn about 20 times a second on purpose (throttle), which is not a slow frame.
  const enough=Math.max(25,(rec.throttle||0)*1.25),bound=gap.p50<=enough?'none':waitGpu.p50>w.p50?'graphics card':'code';
  return {frames,fps:round(frames/(ms/1000)),late:rec.gap.filter(g=>g>rhythm*1.5).length,gap,work:w,tick:spread(rec.tick),draw:spread(rec.draw),feeds:spread(rec.feeds),waitGpu,bound,lowQualityFrames:rec.lowFrames||0,pixelRatio:rec.ratio,size:rec.size,slowest};
}
async function measure(world,ms){world.record(true);await wait(ms);return frameStats(world.record(false),ms);}
// The level with the most residents on it, counting visitors where they are now.
function busiestLevel(world){
  const count=new Map();
  for(const e of world.people.values()){const lv=e.visit?.level??e.level;count.set(lv,(count.get(lv)||0)+1);}
  return [...count].sort((a,b)=>b[1]-a[1])[0]||[1,0];
}
// A security room like the real one, with its monitors in a hidden box, so FeedWall runs exactly as it does there.
function securityRoom(){
  const box=document.createElement('div');box.style.cssText='position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden';
  box.innerHTML='<canvas id="feed-main" width="400" height="300"></canvas>'+Array.from({length:8},(_,i)=>`<canvas data-feed="${i+1}" width="160" height="120"></canvas>`).join('');
  document.body.append(box);return box;
}
export async function profileScenarios(world,{ms=5000,settle=1500}={}){
  if(!world?.record)throw new Error('This needs the 3D silo.');
  const results={},was={afterDraw:world.afterDraw,background:world.background};
  try{
    world.background=false;
    if(!(world.mode==='outside'&&world.target.outDist>700))world.overview();await wait(settle);
    results.overview=await measure(world,ms);
    const [level,residents]=busiestLevel(world);
    world.focusLevel(level);world.setZoom?.(Infinity);await wait(settle);
    results.busyLevel={level,residents,...await measure(world,ms)};
    const box=securityRoom(),wall=new FeedWall(world,defaultCameras(),[]);
    // In the security room the silo behind the terminal is drawn at about 20 frames a second, as it is there.
    try{world.background=true;wall.attach(box);await wait(settle);results.surveillance={cameras:9,...await measure(world,ms)};}
    finally{wall.detach();box.remove();}
  }finally{world.afterDraw=was.afterDraw;world.background=was.background;}
  console.table(Object.fromEntries(Object.entries(results).map(([k,r])=>[k,{fps:r.fps,late:r.late,'gap p50':r.gap.p50,'gap p99':r.gap.p99,'work p50':r.work.p50,'work p95':r.work.p95,'work p99':r.work.p99,'work max':r.work.max,'feeds p95':r.feeds.p95,'card wait p50':r.waitGpu.p50,bound:r.bound,'pixel ratio':r.pixelRatio}])));
  return results;
}
