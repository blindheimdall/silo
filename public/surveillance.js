// The security room: a bank of small monitors and one big one, fed by cameras placed around the silo.
import {paintFeed,feedOverlay} from './feed-effects.js';
import {sectorForLevel} from './world-geometry.js';

const pad=n=>String(n).padStart(3,'0');
const MAIN=[400,300],THUMB=[160,120];

export function defaultCameras(){
  return [
    {kind:'outside',title:'Surface sensor'},
    {kind:'gallery',level:1,angle:3.387,radius:27.8,turn:.7,zoom:1.5,title:'Cafeteria'},
    {kind:'shaft',level:2,angle:.4,title:'Upper stairwell'},
    {kind:'gallery',level:14,angle:Math.PI+.75,title:'IT department'},
    {kind:'gallery',level:48,angle:1.2,title:'The mids'},
    {kind:'shaft',level:72,angle:2.6,title:'Mid stairwell'},
    {kind:'gallery',level:84,angle:4.1,title:'Engineering'},
    {kind:'gallery',level:112,angle:.9,title:'Farm levels'},
    {kind:'hall',level:144,angle:Math.PI*.25,title:'Generator hall'}
  ].map((c,i)=>{const cam={pan:0,tilt:0,zoom:1,...c,num:i+1,home:c.level};cam.mount={level:cam.level,angle:cam.angle,radius:cam.radius,turn:cam.turn,zoom:cam.zoom,pan:0,tilt:0};return cam;});
}
export function cameraTitle(cam,floors){
  if(cam.kind==='outside'||cam.kind==='hall'||cam.level===cam.home)return cam.title;
  return (cam.kind==='shaft'?'Stairwell / ':'')+(floors?.[sectorForLevel(cam.level)]?.name||'Level '+cam.level);
}
export function cameraLabel(cam,floors){
  const where=cam.kind==='outside'?'EXT':'L'+pad(cam.kind==='hall'?144:cam.level);
  return `CAM ${String(cam.num).padStart(2,'0')} / ${where} / ${cameraTitle(cam,floors).toUpperCase()}`;
}
export function canMoveLevel(cam){return cam.kind==='gallery'||cam.kind==='shaft';}
export function limits(cam){return cam.kind==='shaft'?{pan:Math.PI,tilt:.7}:cam.kind==='outside'?{pan:.95,tilt:.3}:{pan:1.35,tilt:.6};}
export function steer(cam,{pan=0,tilt=0,zoom=1}={}){
  const l=limits(cam);
  cam.pan=Math.max(-l.pan,Math.min(l.pan,cam.pan+pan/cam.zoom));
  cam.tilt=Math.max(-l.tilt,Math.min(l.tilt,cam.tilt+tilt/cam.zoom));
  cam.zoom=Math.max(1,Math.min(4,cam.zoom*zoom));
}

// Renders the monitors. One camera per frame at most: the big monitor about 18 times a second,
// the small ones in turn, so the main view of the silo stays smooth.
export class FeedWall{
  constructor(world,cameras,floors){this.world=world;this.cameras=cameras;this.floors=floors;this._main=0;this.next=0;this.lastMain=-1;this.lastThumb=-1;this.pending=null;this.seq=0;this.latest=new Map();this.track=null;this.aim=true;this.hook=t=>this.frame(t);}
  // Each capture has a number, and each monitor remembers the newest one meant for it. A capture that comes back late
  // (after the one-second limit let another start, or after the big monitor switched camera) is dropped, so a monitor
  // never shows an older picture or another camera, and a late answer never frees the place of a newer capture.
  get main(){return this._main;}
  set main(i){if(i!==this._main){this._main=i;if(this.mainCtx)this.latest.set(this.mainCtx,++this.seq);}}
  attach(root){
    this.root=root;const c=root.querySelector('#feed-main');this.mainCanvas=c;this.mainCtx=c.getContext('2d');
    this.thumbs=[...root.querySelectorAll('canvas[data-feed]')].map(canvas=>({canvas,ctx:canvas.getContext('2d'),index:Number(canvas.dataset.feed)}));
    for(const t of [{ctx:this.mainCtx,w:MAIN[0],h:MAIN[1]},...this.thumbs.map(t=>({ctx:t.ctx,w:THUMB[0],h:THUMB[1]}))]){t.ctx.fillStyle='#010401';t.ctx.fillRect(0,0,t.w,t.h);feedOverlay(t.ctx,t.w,t.h,{label:'NO SIGNAL',rec:false,small:t.w<200});}
    this.world.afterDraw=this.hook;
  }
  detach(){if(this.world.afterDraw===this.hook)this.world.afterDraw=null;this.root=null;}
  frame(t){
    if(!this.mainCanvas?.isConnected){this.detach();return;}
    if(document.hidden)return;
    // One read in flight at a time. A read that never comes back is dropped after a second.
    if(this.pending){if(t-this.pending.t<1)return;this.pending=null;}
    // Whichever is more overdue goes first, so a slow machine still refreshes the small monitors.
    const mainDue=(t-this.lastMain)*18,thumbDue=this.thumbs.length?(t-this.lastThumb)*12:0;
    if(Math.max(mainDue,thumbDue)<1)return;
    if(mainDue>=thumbDue){this.lastMain=t;this.paint(this.cameras[this.main],this.mainCtx,MAIN,t,false);}
    else{this.lastThumb=t;const th=this.thumbs[this.next++%this.thumbs.length];this.paint(this.cameras[th.index],th.ctx,THUMB,t,true);}
  }
  paint(cam,ctx,[w,h],t,small){
    const outside=cam.kind==='outside',read=this.world.captureFeed(cam,w,h,true);
    // Where the followed resident is, measured now, while the camera still points the way it rendered.
    const mark=!small&&this.track?{p:this.world.feedProject(this.track.id),name:this.track.name}:null;
    const ticket={id:++this.seq,t:t||1e-6};this.pending=ticket;this.latest.set(ctx,ticket.id);
    read.then(pixels=>{
      if(this.pending===ticket)this.pending=null;
      if(!pixels||!ctx.canvas.isConnected||this.latest.get(ctx)!==ticket.id)return;
      paintFeed(ctx,pixels,w,h,{palette:'green',exposure:outside?1.15:1.35,noise:small?.1:.07,grime:outside?this.world.lensGrime:0,time:t+cam.num});
      if(mark)this.drawMark(ctx,w,h,mark,cam);
      feedOverlay(ctx,w,h,{label:small?`CAM ${String(cam.num).padStart(2,'0')}`:cameraLabel(cam,this.floors),time:t,small,rec:!small||cam.num%3===1});
    },()=>{if(this.pending===ticket)this.pending=null;});
    // Following: the camera turns toward the resident on its own, as far as its mount allows.
    if(!small&&this.track&&this.aim&&cam.kind!=='outside'){
      const g=this.world.feedBearing(cam,this.track.id),l=limits(cam);
      if(g&&Math.abs(g.pan)<=l.pan&&g.level>=cam.level-1&&g.level<=cam.level+(cam.kind==='shaft'?20:3)){cam.pan+=(g.pan-cam.pan)*.18;cam.tilt+=(Math.max(-l.tilt,Math.min(l.tilt,g.tilt))-cam.tilt)*.18;}
    }
  }
  // Amber brackets around the followed resident, or a note that they are out of this camera's view.
  drawMark(ctx,w,h,{p,name},cam){
    ctx.font="bold 11px 'Lucida Console',Consolas,monospace";ctx.fillStyle=ctx.strokeStyle='#ffbd4a';ctx.shadowColor='#ffbd4a';ctx.shadowBlur=5;ctx.lineWidth=1.5;
    if(!p){if(cam.kind!=='outside'){ctx.textBaseline='bottom';ctx.fillText('TRACKING '+name.toUpperCase()+' / OUT OF VIEW',8,h-8);}ctx.shadowBlur=0;return;}
    const top=p.top*h,bottom=p.bottom*h,bw=Math.max(10,(bottom-top)*.62),x=p.x*w-bw/2,c=8;
    ctx.beginPath();
    for(const [px,py,dx,dy] of [[x,top,1,1],[x+bw,top,-1,1],[x,bottom,1,-1],[x+bw,bottom,-1,-1]]){ctx.moveTo(px+dx*c,py);ctx.lineTo(px,py);ctx.lineTo(px,py+dy*c);}
    ctx.stroke();ctx.textBaseline='bottom';ctx.fillText(name.toUpperCase(),Math.max(4,Math.min(w-8*name.length-4,x)),Math.max(14,top-3));ctx.shadowBlur=0;
  }
}
