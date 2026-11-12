import './pixel-avatar.js';
import {appearanceFor,residentAtlas,FRAMES,CELL_W,CELL_H} from './resident-sprite.js';
import {WIDTH as W,HEIGHT as H,LEVEL_COUNT,PITCH,SECTORS,clamp,levelBase,surfaceY,residentPose,stairPoint,visibleLevels,sectorForLevel} from './world-geometry.js';

const signs=[['settings','CONTROL'],['connections','IT / UPLINK'],['agents','THE MIDS'],['workflows','ENGINEERING'],['activity','SUPPLY'],['files','MECHANICAL']];
const bands=[[15,203],[210,341],[350,481],[490,617],[625,781],[790,1018]];
const noise=n=>{const x=Math.sin(n*127.1+61.7)*43758.5453;return x-Math.floor(x);};

// A sprite's local (0,0) is its exact foot contact, not its head or bounding box.
function resident(c,pose,agent,seconds,selected){
  const {x,feetY,scale,moving,direction}=pose;
  c.save();c.translate(Math.round(x),feetY);c.scale(scale,scale);
  c.fillStyle='#0008';c.beginPath();c.ellipse(0,0,7,1.6,0,0,Math.PI*2);c.fill();
  if(direction<0)c.scale(-1,1);
  const frame=moving&&agent.status!=='working'?Math.floor(seconds*5)%4:FRAMES-1;
  c.imageSmoothingEnabled=false;
  c.drawImage(residentAtlas(appearanceFor(agent)),frame*CELL_W,0,CELL_W,CELL_H,-CELL_W/4,-47/2,CELL_W/2,CELL_H/2);
  c.restore();
  if(selected){c.strokeStyle='#d7bd79';c.lineWidth=.8;c.setLineDash([3,3]);c.strokeRect(x-13,feetY-30,27,34);c.setLineDash([]);c.fillStyle='#e1c084';c.beginPath();c.moveTo(x-3,feetY-36);c.lineTo(x+3,feetY-36);c.lineTo(x,feetY-32);c.fill();}
}

class SiloWorld{
  constructor(canvas,options){
    Object.assign(this,options);this.canvas=canvas;this.ctx=canvas.getContext('2d');this.zoom=1;this.cx=W/2;this.cy=levelBase(4);this.level=4;this.floor=0;this.paused=false;this.hitboxes=[];this.terminals=[];this.alive=true;this.last=0;this.time=0;this.motion=new Map();this.lastTick=0;this.hover=null;this.pointers=new Map();this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.art=new Image();this.art.onload=()=>canvas.parentElement.classList.remove('is-loading');this.art.onerror=()=>{if(this.art.src.endsWith('.webp')){this.art.src='/assets/silo-atrium.png';return;}canvas.parentElement.classList.remove('is-loading');};canvas.parentElement.classList.add('is-loading');this.art.src='/assets/silo-atrium.webp';
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(canvas);this.resize();
    this.handlers={wheel:e=>{e.preventDefault();this.flight=null;if(e.ctrlKey||e.metaKey)this.setZoom(this.zoom*Math.exp(-e.deltaY*.0018),e.offsetX,e.offsetY);else{this.cy+=e.deltaY*.85/this.scale;if(e.shiftKey)this.cx+=e.deltaY*.6/this.scale;this.reportLevel();}},pointerdown:e=>this.down(e),pointermove:e=>this.move(e),pointerup:e=>this.up(e),pointercancel:e=>{this.pointers.delete(e.pointerId);this.drag=null;this.pinch=null;}};
    for(const [name,fn]of Object.entries(this.handlers))canvas.addEventListener(name,fn,{passive:false});
    this.animate=stamp=>{if(!this.alive)return;this.raf=requestAnimationFrame(this.animate);if(stamp-this.last<40)return;const dt=Math.min(.1,(stamp-this.last)/1000);this.last=stamp;if(!this.paused&&!this.reduced){this.time+=dt;for(const a of this.agents)if(a.status!=='working')this.motion.set(a.id,(this.motion.get(a.id)||0)+dt);}this.advanceCamera(stamp);this.draw(this.time);};this.raf=requestAnimationFrame(this.animate);
    this.reportLevel();
  }
  resize(){const r=this.canvas.getBoundingClientRect();this.width=r.width;this.height=r.height;this.dpr=Math.min(devicePixelRatio||1,2);this.canvas.width=Math.round(r.width*this.dpr);this.canvas.height=Math.round(r.height*this.dpr);this.baseScale=Math.max(r.width/W,.33);this.minZoom=Math.min(r.width/W,r.height/H)/this.baseScale*.94;this.transform();}
  update(agents,selected,paused){this.agents=agents;this.selected=selected;this.paused=paused;}
  transform(){this.zoom=clamp(this.zoom,this.minZoom||.025,4);this.scale=this.baseScale*this.zoom;const halfW=this.width/(2*this.scale),halfH=this.height/(2*this.scale);this.cx=halfW<W/2?clamp(this.cx,halfW,W-halfW):W/2;this.cy=halfH<H/2?clamp(this.cy,halfH,H-halfH):H/2;this.offsetX=this.width/2-this.cx*this.scale;this.offsetY=this.height/2-this.cy*this.scale;}
  reportLevel(){const level=clamp(Math.round((this.cy-180)/PITCH)+1,1,144);this.level=level;const sector=sectorForLevel(level);this.floor=sector;this.onLevel?.(level);this.onFloor?.(sector);}
  setZoom(next,x=this.width/2,y=this.height/2){this.flight=null;this.transform();const wx=(x-this.offsetX)/this.scale,wy=(y-this.offsetY)/this.scale;this.zoom=clamp(next,this.minZoom,4);this.scale=this.baseScale*this.zoom;this.cx=wx-(x-this.width/2)/this.scale;this.cy=wy-(y-this.height/2)/this.scale;this.transform();this.onZoom?.(Math.round(this.zoom*100));this.reportLevel();}
  reset(){this.flight=null;this.zoom=1;this.cx=W/2;this.cy=levelBase(4);this.transform();this.onZoom?.(100);this.reportLevel();}
  overview(){this.flight=null;this.zoom=this.minZoom;this.cx=W/2;this.cy=H/2;this.transform();this.onZoom?.(Math.round(this.zoom*100));this.reportLevel();}
  focus(f){this.focusLevel(SECTORS[f].home);}
  focusAgent(a){this.focusLevel(a.level||SECTORS[a.floor].home);}
  focusLevel(level){level=clamp(Math.round(level),1,144);const z=this.width<700?1:1.05;this.flight={start:performance.now(),x:this.cx,y:this.cy,z:this.zoom,endY:levelBase(level)-32,endZ:z,duration:this.reduced?1:650};this.level=level;this.onLevel?.(level);this.onFloor?.(sectorForLevel(level));this.onZoom?.(Math.round(z*100));}
  advanceCamera(stamp){if(!this.flight)return;const f=this.flight,p=clamp((stamp-f.start)/f.duration,0,1),ease=1-Math.pow(1-p,3);this.cx=f.x+(W/2-f.x)*ease;this.cy=f.y+(f.endY-f.y)*ease;this.zoom=f.z+(f.endZ-f.z)*ease;if(p===1){this.flight=null;this.reportLevel();}}
  down(e){e.preventDefault();this.flight=null;this.canvas.setPointerCapture(e.pointerId);this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});this.drag={x:e.clientX,y:e.clientY,cx:this.cx,cy:this.cy,moved:false};if(this.pointers.size===2){const p=[...this.pointers.values()];this.pinch={distance:Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y),zoom:this.zoom};this.drag.moved=true;}}
  findHit(x,y){return [...this.hitboxes,...this.terminals].find(h=>x>=h.x&&x<=h.x+h.w&&y>=h.y&&y<=h.y+h.h);}
  move(e){const r=this.canvas.getBoundingClientRect();if(!this.drag){const hit=this.findHit((e.clientX-r.left-this.offsetX)/this.scale,(e.clientY-r.top-this.offsetY)/this.scale);this.hover=hit?.agent?.id||null;this.hoverTerminal=hit?.view||null;this.canvas.style.cursor=hit?'pointer':'grab';return;}
    this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});if(this.pointers.size===2&&this.pinch){const p=[...this.pointers.values()];this.setZoom(this.pinch.zoom*Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)/this.pinch.distance);return;}const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;if(Math.abs(dx)+Math.abs(dy)>5)this.drag.moved=true;this.cx=this.drag.cx-dx/this.scale;this.cy=this.drag.cy-dy/this.scale;this.reportLevel();}
  up(e){this.pointers.delete(e.pointerId);if(!this.drag)return;if(!this.drag.moved){const r=this.canvas.getBoundingClientRect(),x=(e.clientX-r.left-this.offsetX)/this.scale,y=(e.clientY-r.top-this.offsetY)/this.scale,hit=this.findHit(x,y);if(hit?.agent)this.onSelect?.(hit.agent);else if(hit?.view)this.onTerminal?.(hit.view);else if(this.zoom<.15)this.focusLevel(clamp(Math.round((y-180)/PITCH)+1,1,144));}this.drag=null;this.pinch=null;}
  destroy(){this.alive=false;cancelAnimationFrame(this.raf);this.resizeObserver.disconnect();for(const [name,fn]of Object.entries(this.handlers))this.canvas.removeEventListener(name,fn);}
  polygon(points,color){const c=this.ctx;c.fillStyle=color;c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fill();}
  wall(level,sector){
    const c=this.ctx,base=levelBase(level),top=base-PITCH+14;let artSector=sector;
    if(level!==SECTORS[sector].home)artSector=sector===4?(level%4===0?3:4):sector===5?3:[1,2,3][(level+sector)%3];
    const [sy,ey]=bands[artSector];
    c.save();c.beginPath();c.rect(0,top,480,PITCH);c.rect(1056,top,W-1056,PITCH);c.clip();
    if(this.art.complete&&this.art.naturalWidth)c.drawImage(this.art,0,sy,W,ey-sy,0,top,W,PITCH);
    c.fillStyle=`rgba(13,22,17,${.07+(level%5)*.018})`;c.fillRect(0,top,W,PITCH);
    if(level%7===0){c.fillStyle='#90744319';c.fillRect(100,top+12,480,120);}
    c.restore();
    // Concrete walkable slabs. These exact curves also define every resident's feet.
    for(const side of [0,1]){const xs=side?[1056,1176,1296,1416,1536]:[0,120,240,360,480];const edge=xs.map(x=>[x,surfaceY(level,x)]);this.polygon([...edge,...edge.slice().reverse().map(([x,y])=>[x,y+20])],'#615f47');c.beginPath();edge.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.strokeStyle='#b4a17a';c.lineWidth=2;c.stroke();
      for(let x=side?1060:10;x<(side?1530:475);x+=13){const y=surfaceY(level,x);c.fillStyle=x%3?'#383e3066':'#b0a27c77';c.fillRect(x,y+4,1,11);}c.strokeStyle='#353d2c';c.lineWidth=3;c.beginPath();edge.forEach(([x,y],i)=>i?c.lineTo(x,y+19):c.moveTo(x,y+19));c.stroke();}
    for(const x of [469,1056]){c.fillStyle='#333e2bcc';c.fillRect(x,top,11,PITCH-27);c.fillStyle='#8b7c4d';c.fillRect(x+3,top,2,PITCH-27);}
    // Thin concrete bridges cross the open shaft; walkable galleries stop at their edge.
    const left=level%2===0,ax=left?480:1056,bx=left?604:932,ay=surfaceY(level,ax),by=base-18;
    this.polygon([[ax,ay],[bx,by],[bx,by+12],[ax,ay+15]],'#6b674b');c.strokeStyle='#a88d58';c.lineWidth=1.2;c.beginPath();c.moveTo(ax,ay-23);c.lineTo(bx,by-23);c.stroke();for(let n=0;n<=5;n++){const u=n/5,x=ax+(bx-ax)*u,y=ay+(by-ay)*u;c.beginPath();c.moveTo(x,y-23);c.lineTo(x,y);c.stroke();}
    if(level%12===0){for(const x of [80,1392]){c.fillStyle='#a68b48';c.fillRect(x,surfaceY(level,x)+2,48,13);c.fillStyle='#33392b';for(let n=0;n<5;n++)this.polygon([[x+n*10,surfaceY(level,x)+2],[x+6+n*10,surfaceY(level,x)+2],[x-1+n*10,surfaceY(level,x)+15],[x-7+n*10,surfaceY(level,x)+15]],'#33392b');}}
    // Floor numbers are part of the architecture rather than a detached dashboard.
    c.font='12px Consolas,monospace';c.fillStyle='#e0c38b';c.textAlign='center';for(const x of [78,1458]){c.fillStyle='#1d281ce6';c.fillRect(x-22,base-70,44,21);c.fillStyle='#c3b183';c.fillText(String(level).padStart(3,'0'),x,base-55);}
    const [view,label]=signs[sector];if(level===SECTORS[sector].home){const x=1090,y=surfaceY(level,1090)+4;const hover=this.hoverTerminal===view;c.fillStyle=hover?'#b89b61':'#1a251cee';c.fillRect(x,y,145,17);c.strokeStyle='#a18c5b';c.lineWidth=.7;c.strokeRect(x,y,145,17);c.textAlign='left';c.font='8px Consolas,monospace';c.fillStyle=hover?'#1b251b':'#c7b17c';c.fillText(label+' / TERMINAL ↗',x+8,y+12);this.terminals.push({x,y:y-3,w:145,h:22,view});}
    // Every twelfth floor has a recognizable sector landing.
    if(level===SECTORS[sector].home){c.save();c.fillStyle='#9d845226';c.fillRect(590,base-102,8,75);c.font='8px Consolas,monospace';c.textAlign='right';c.fillStyle='#b7a779';c.fillText(this.floors[sector].name.toUpperCase(),585,base-86);c.restore();}
  }
  stair(level,front){
    const c=this.ctx,steps=36;
    for(let i=0;i<steps;i++){const u=i/steps,v=(i+1)/steps,a=stairPoint(level,u,127),b=stairPoint(level,u,205),d=stairPoint(level,v,127),e=stairPoint(level,v,205);if(b.front!==front)continue;
      this.polygon([[a.x,a.y+10],[b.x,b.y+10],[e.x,e.y+10],[d.x,d.y+10]],front?'#575940':'#303a2b');
      this.polygon([[a.x,a.y],[b.x,b.y],[e.x,e.y],[d.x,d.y]],front?(i%2?'#968567':'#a18e6c'):'#595e46');
      c.strokeStyle=front?'#b5a17b':'#6b7351';c.lineWidth=.8;c.beginPath();c.moveTo(a.x,a.y);c.lineTo(b.x,b.y);c.stroke();
      if(i%3===0){c.strokeStyle=front?'#b9955d':'#64704b';c.lineWidth=1.3;c.beginPath();c.moveTo(b.x,b.y-2);c.lineTo(b.x,b.y-30);c.stroke();}
      c.strokeStyle=front?'#ad8b52':'#536143';c.lineWidth=1.5;c.beginPath();c.moveTo(b.x,b.y-30);c.lineTo(e.x,e.y-30);c.stroke();
    }
    // Actual landing bridging the helix and its gallery, at a shared height.
    const p=stairPoint(level,0);if(p.front===front){const wallX=p.x>W/2?936:600;this.polygon([[p.x,levelBase(level)-5],[wallX,levelBase(level)-31],[wallX,levelBase(level)-18],[p.x,levelBase(level)+8]],'#898064');c.strokeStyle='#b89b64';c.lineWidth=1.5;c.beginPath();c.moveTo(p.x,levelBase(level)-32);c.lineTo(wallX,levelBase(level)-56);c.stroke();}
  }
  foregroundRail(level){const c=this.ctx;for(const side of [0,1]){const start=side?1056:8,end=side?1536:480;c.strokeStyle='#a4844b';c.lineWidth=1.4;c.beginPath();for(let x=start;x<=end;x+=4){const y=surfaceY(level,x)-23;x===start?c.moveTo(x,y):c.lineTo(x,y);}c.stroke();c.strokeStyle='#79683e';c.lineWidth=.9;c.beginPath();for(let x=start;x<=end;x+=4){const y=surfaceY(level,x)-9;x===start?c.moveTo(x,y):c.lineTo(x,y);}c.stroke();for(let x=start+8;x<end;x+=33){const y=surfaceY(level,x);c.strokeStyle='#b09159';c.lineWidth=1.5;c.beginPath();c.moveTo(x,y-23);c.lineTo(x,y+1);c.stroke();}}}
  draw(time){
    const c=this.ctx;c.setTransform(this.dpr,0,0,this.dpr,0,0);c.fillStyle='#09120f';c.fillRect(0,0,this.width,this.height);this.transform();this.hitboxes=[];this.terminals=[];c.save();c.translate(this.offsetX,this.offsetY);c.scale(this.scale,this.scale);c.imageSmoothingEnabled=false;
    const {first,last}=visibleLevels(this.cy,this.height,this.scale),top=levelBase(first)-PITCH-70,bottom=levelBase(last)+PITCH;
    const shaft=c.createLinearGradient(590,0,946,0);shaft.addColorStop(0,'#18221b');shaft.addColorStop(.18,'#0c1814');shaft.addColorStop(.48,'#080f0d');shaft.addColorStop(.8,'#111e17');shaft.addColorStop(1,'#18251a');c.fillStyle=shaft;c.fillRect(0,top,W,bottom-top);
    const detailed=this.scale>.13;
    for(let level=first;level<=last;level++){
      const sector=sectorForLevel(level);if(detailed)this.wall(level,sector);else{const y=levelBase(level);c.fillStyle=['#a08e65','#7d9268','#9d8265','#728875','#7b9161','#8a7854'][sector];c.fillRect(0,y,600,15);c.fillRect(936,y,600,15);c.fillStyle='#374635';c.fillRect(0,y-PITCH+20,600,PITCH-25);c.fillRect(936,y-PITCH+20,600,PITCH-25);}
    }
    const texturedStairs=detailed&&this.art.complete&&this.art.naturalWidth;
    if(detailed&&!texturedStairs)for(let level=first;level<=last;level++)this.stair(level,false);
    // Massive continuous central support, with seams and exposed service pipes.
    const column=c.createLinearGradient(746,0,792,0);column.addColorStop(0,'#3b4130');column.addColorStop(.35,'#777055');column.addColorStop(.6,'#5e6048');column.addColorStop(1,'#29392a');c.fillStyle=column;c.fillRect(746,top,46,bottom-top);
    c.fillStyle='#b2a17435';c.fillRect(755,top,2,bottom-top);c.fillStyle='#2b3825';c.fillRect(784,top,3,bottom-top);for(let level=first;level<=last;level++){const y=levelBase(level);c.fillStyle='#b49b58';c.fillRect(762,y-78,3,16);c.fillStyle='#e5bb65';c.fillRect(763,y-76,2,12);c.fillStyle='#212e20';c.fillRect(746,y,46,2);}
    if(detailed&&!texturedStairs)for(let level=first;level<=last;level++)this.stair(level,true);
    if(!detailed){c.beginPath();for(let level=first;level<=last;level++)for(let i=0;i<=8;i++){const p=stairPoint(level,i/8);level===first&&i===0?c.moveTo(p.x,p.y):c.lineTo(p.x,p.y);}c.lineWidth=28;c.strokeStyle='#a99563';c.stroke();}
    // Reuse the detailed concrete/metal stair material as a continuous central ribbon.
    // Gallery walking surfaces remain independently defined and exact.
    if(detailed&&this.art.complete&&this.art.naturalWidth){
      const period=PITCH*2;
      for(let block=Math.floor((top-40)/period);block<=Math.ceil(bottom/period);block++){
        c.drawImage(this.art,605,300,325,330,604,block*period,328,period);
      }
      const edge=c.createLinearGradient(594,0,942,0);edge.addColorStop(0,'#101c14cc');edge.addColorStop(.05,'#101c1400');edge.addColorStop(.95,'#101c1400');edge.addColorStop(1,'#101c14cc');c.fillStyle=edge;c.fillRect(594,top,348,bottom-top);
    }
    if(detailed){
      for(let level=first;level<=last;level++){
        const agents=this.agents.filter(a=>(a.level||SECTORS[a.floor].home)===level);
        agents.forEach((agent,index)=>{const walkTime=this.motion.get(agent.id)||0,pose=residentPose(level,index,walkTime),selected=agent.id===this.selected||agent.id===this.hover;if(agent.status==='working'||this.paused||this.reduced)pose.moving=false;resident(c,pose,agent,walkTime,selected);this.hitboxes.push({x:pose.x-16,y:pose.feetY-36,w:34,h:39,agent});
          if(selected||this.zoom>2){const label=agent.name.toUpperCase();c.font='8px Consolas,monospace';const w=c.measureText(label).width+14;c.fillStyle='#15241aee';c.fillRect(pose.x-w/2,pose.feetY-47,w,13);c.fillStyle='#d8bf87';c.textAlign='center';c.fillText(label,pose.x,pose.feetY-37);}
        });this.foregroundRail(level);
      }
      // Dust moves in the open shaft, never in place of actual resident motion.
      for(let i=0;i<45;i++){const x=615+noise(i)*300,y=top+(noise(i+100)*(bottom-top)+time*(3+noise(i)*3))%(bottom-top);c.fillStyle=i%3?'#bfa66b27':'#dbc58c4a';c.fillRect(x,y,1,1);}
    }
    // A sealed surface and the foundation make the world genuinely finite.
    if(first===1){c.fillStyle='#353e2d';c.fillRect(0,-30,W,45);c.fillStyle='#9b8759';c.fillRect(0,12,W,4);c.font='18px Consolas,monospace';c.textAlign='center';c.fillStyle='#c7af78';c.fillText('S I L O  1 8  /  S U R F A C E  A C C E S S',W/2,-5);}
    if(last===144){const y=levelBase(144)+30;c.fillStyle='#253122';c.fillRect(0,y,W,180);c.fillStyle='#4e5639';c.fillRect(0,y,W,8);c.font='14px Consolas,monospace';c.textAlign='center';c.fillStyle='#a9915f';c.fillText('MECHANICAL / FOUNDATION / LEVEL 144',W/2,y+64);}
    c.restore();
    if(!detailed){let lastY=75;c.font='9px Consolas,monospace';c.textAlign='left';for(let sector=0;sector<6;sector++){const level=SECTORS[sector].home,y=Math.max(lastY+30,Math.min(this.height-120,this.offsetY+levelBase(level)*this.scale)),x=this.width/2+W*this.scale/2+22;c.strokeStyle='#8b8f5166';c.lineWidth=1;c.beginPath();c.moveTo(this.width/2+W*this.scale/2+4,y);c.lineTo(x-5,y);c.stroke();c.fillStyle='#b6b086';c.fillText(String(level).padStart(3,'0')+' / '+this.floors[sector].name.toUpperCase(),x,y+3);lastY=y;}}
    const vignette=c.createLinearGradient(0,0,0,this.height);vignette.addColorStop(0,'#06110c30');vignette.addColorStop(.4,'#06110c00');vignette.addColorStop(1,'#07100c55');c.fillStyle=vignette;c.fillRect(0,0,this.width,this.height);
  }
}
window.SiloWorld=SiloWorld;
