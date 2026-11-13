import * as T from './vendor/three.module.js';
import './world-depth.js';
import {SECTORS,sectorForLevel,clamp} from './world-geometry.js';
import {FLOOR_HEIGHT,INNER_RADIUS,FLOOR_TOP,physicalFloorY,spatialResidentPose} from './spatial-geometry.js';
import {appearanceFor,residentAtlas,reserveAtlas,fillAtlas,atlasPending,FRAMES} from './resident-sprite.js';
import {paintFeed} from './feed-effects.js';

const FallbackWorld=window.SiloWorld;
const TAU=Math.PI*2,LEVELS=144,DEPTH=LEVELS*FLOOR_HEIGHT;
const CHUNK=8,CHUNKS=Math.ceil(LEVELS/CHUNK);
const BAYS=18,WALL_RADIUS=34.9,PILLAR_RADIUS=33.6,LAMP_RADIUS=33.06,PROP_RADIUS=32.65;
const STAIR_INNER=4.77,STAIR_OUTER=7.63,STEPS_PER_LEVEL=48;
const MAX_PEOPLE=4096;
// The silo sits under a dead plain. These numbers shape the surface and the cutaway.
const GROUND_Y=16,SHELL_RADIUS=36.8,WELL_RADIUS=11.6,ROOF_Y=6,ROOF_CAP=8;
const BOTTOM_Y=physicalFloorY(LEVELS),SHELL_BOTTOM=BOTTOM_Y-3.2,EARTH_BOTTOM=BOTTOM_Y-620;
const ZOOM_MIN=.65,ZOOM_MAX=3.1,OUT_MIN=55,OUT_NEAR=150,OUT_FAR=1600,OUT_MAX=1900,FAR_VIEW=420;
const random=n=>{const a=Math.sin(n*127.1+31.7)*43758.5453;return a-Math.floor(a);};
const chunkOf=level=>Math.floor((level-1)/CHUNK);
const smooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
const mix=(a,b,t)=>a+(b-a)*t;
const wrapAngle=a=>Math.atan2(Math.sin(a),Math.cos(a));
const hdr=(hex,scale)=>new T.Color(hex).multiplyScalar(scale);
const levelAt=y=>clamp(Math.round(-y/FLOOR_HEIGHT)+1,1,LEVELS);
// Crops of the original artwork: one interior per row, a left and a right variant.
const ROOM_CROPS=[
  [[115,34,285,128],[1136,34,285,128]],
  [[132,196,250,112],[1154,196,250,112]],
  [[141,338,232,104],[1163,338,232,104]],
  [[126,468,263,118],[1148,468,263,118]],
  [[101,606,312,140],[1123,606,312,140]],
  [[240,760,357,160],[940,760,357,160]]
];
// Which interiors each sector is built from: command, library, studio, workshop, farm, machinery.
const ROOM_POOLS=[[0,0,1,2],[0,1,1,0],[2,1,2,3],[3,3,5,1],[4,4,4,1],[5,5,3,5]];

// Post effects: bloom from HDR highlights, then one pass for tone mapping and a fine CRT finish.
const POST_VERTEX='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
const BRIGHT_FRAGMENT=`uniform sampler2D tMap;uniform vec2 uTexel;uniform float uThreshold;varying vec2 vUv;
void main(){
  vec3 c=(texture2D(tMap,vUv+uTexel*vec2(-1.,-1.)).rgb+texture2D(tMap,vUv+uTexel*vec2(1.,-1.)).rgb+texture2D(tMap,vUv+uTexel*vec2(-1.,1.)).rgb+texture2D(tMap,vUv+uTexel).rgb)*.25;
  if(uThreshold>0.){float l=max(c.r,max(c.g,c.b));c*=smoothstep(uThreshold,uThreshold*1.8,l);}
  gl_FragColor=vec4(min(c,vec3(24.)),1.);
}`;
const BLUR_FRAGMENT=`uniform sampler2D tMap;uniform vec2 uDir;varying vec2 vUv;
void main(){
  vec3 c=texture2D(tMap,vUv).rgb*.2270270;
  c+=(texture2D(tMap,vUv+uDir*1.3846153).rgb+texture2D(tMap,vUv-uDir*1.3846153).rgb)*.3162162;
  c+=(texture2D(tMap,vUv+uDir*3.2307692).rgb+texture2D(tMap,vUv-uDir*3.2307692).rgb)*.0702703;
  gl_FragColor=vec4(c,1.);
}`;
const FINAL_FRAGMENT=`uniform sampler2D tScene;uniform sampler2D tBloomA;uniform sampler2D tBloomB;
uniform vec2 uRes;uniform float uTime;uniform float uCrt;uniform float uExposure;uniform float uBloom;varying vec2 vUv;
vec3 rrt(vec3 v){vec3 a=v*(v+.0245786)-.000090537;vec3 b=v*(.983729*v+.4329510)+.238081;return a/b;}
vec3 aces(vec3 c){
  const mat3 i=mat3(vec3(.59719,.07600,.02840),vec3(.35458,.90834,.13383),vec3(.04823,.01566,.83777));
  const mat3 o=mat3(vec3(1.60475,-.10208,-.00327),vec3(-.53108,1.10813,-.07276),vec3(-.07367,-.00605,1.07602));
  c*=uExposure/.6;c=i*c;c=rrt(c);c=o*c;return clamp(c,0.,1.);
}
vec3 srgb(vec3 c){return mix(c*12.92,1.055*pow(c,vec3(1./2.4))-.055,step(vec3(.0031308),c));}
float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec2 cc=vUv-.5;float k=.1*uCrt;
  vec2 uv=.5+cc*(1.+k*dot(cc,cc))/(1.+k*.5);
  vec2 off=(uv-.5)*.0045*uCrt;
  vec3 col=vec3(texture2D(tScene,uv+off).r,texture2D(tScene,uv).g,texture2D(tScene,uv-off).b);
  col+=(texture2D(tBloomA,uv).rgb*.6+texture2D(tBloomB,uv).rgb*.8)*uBloom;
  col=aces(col);
  // Grade like the show's photography: slightly muted colour, cool shadows, warm highlights.
  float lum=dot(col,vec3(.2126,.7152,.0722));
  col=mix(vec3(lum),col,.86)*mix(vec3(.86,.97,1.06),vec3(1.05,1.,.91),smoothstep(0.,.35,lum));
  float scan=.5+.5*sin(gl_FragCoord.y*2.0944);
  col*=mix(1.,.9+.1*scan,uCrt)*(1.+.05*uCrt);
  float cell=mod(floor(gl_FragCoord.x),3.);
  vec3 mask=cell<.5?vec3(1.05,.96,.96):cell<1.5?vec3(.96,1.05,.96):vec3(.96,.96,1.05);
  col*=mix(vec3(1.),mask,.7*uCrt);
  col*=1.-dot(cc,cc)*(.35+.45*uCrt);
  col*=1.+uCrt*.01*sin(uTime*53.);
  col=srgb(clamp(col,0.,1.));
  // Gentle film S-curve and blacks lifted a touch towards teal.
  col=mix(col,col*col*(3.-2.*col),.22)*.975+vec3(.004,.011,.013);
  col+=(hash(gl_FragCoord.xy+fract(uTime*7.31)*91.7)-.5)*(.012+.026*uCrt);
  vec2 q=abs(cc)*2.;vec2 rad=vec2(.028*uRes.y/uRes.x,.028)*uCrt+1e-4;
  float corner=1.-smoothstep(.75,1.,length(max(q-(1.-rad),0.)/rad));
  gl_FragColor=vec4(col*corner,1.);
}`;

// Pixel glyphs for the activity icons, 9 by 7.
const GLYPH={
  tool:['.....##..','....#..#.','....#.##.','...###...','..###....','.###.....','.##......'],
  asking:['.....#...','.....##..','########.','#########','########.','.....##..','.....#...'],
  approval:['...###...','...###...','...###...','...###...','.........','...###...','...###...'],
  queued:['.#######.','..#####..','...###...','....#....','...#.#...','..#...#..','.#######.'],
  blocked:['.........','.........','#########','#########','#########','.........','.........'],
  failed:['##.....##','.##...##.','..##.##..','...###...','..##.##..','.##...##.','##.....##'],
  verified:['........#','.......##','......##.','#....##..','##..##...','.####....','..##.....'],
  unverified:['..#####..','.##...##.','.....##..','....##...','....##...','.........','....##...'],
  regressed:['....#....','....#....','....#....','#...#...#','.#..#..#.','..#.#.#..','...###...']
};
// Fills are kept dark and saturated so the bloom does not wash them out to cream.
const ICONS=[['tool','#9fc3dc','#123552',GLYPH.tool],['asking','#94d2c8','#0f4a50',GLYPH.asking],['approval','#d98a12','#1a0f02',GLYPH.approval],['queued','#8a9186','#1d211c',GLYPH.queued],['blocked','#8f2318','#f6eadc',GLYPH.blocked],['failed','#a8261a','#fff4e6',GLYPH.failed],['verified','#2f9a3e','#06200a',GLYPH.verified],['unverified','#8d8a7c','#1f1e18',GLYPH.unverified],['regressed','#b5561a','#fff1e0',GLYPH.regressed]];
const BUSY=new Set(['queued','thinking','tool','asking','approval']);
const TRAIL_TONE={done:'#7fe08f',running:'#f2c46f',waiting:'#7d877a',failed:'#ef5a45',skipped:'#4f584d'};
// Concrete walls mark the stencil where they are the nearest surface (they draw after the other solid things), so
// residents behind them can be drawn through them, and only through them.
const STENCIL_MARK={stencilWrite:true,stencilRef:1,stencilFunc:T.AlwaysStencilFunc,stencilZPass:T.ReplaceStencilOp};
function paintSign(x,text,x0,y0,w,h,{color='#e2c98d',bg='#16231a',border='#a18a56',size=text.length>12?18:text.length>8?22:30,line=3}={}){
  x.fillStyle=bg;x.fillRect(x0,y0,w,h);x.strokeStyle=border;x.lineWidth=line;x.strokeRect(x0+line,y0+line,w-line*2,h-line*2);
  x.font=`bold ${size}px Consolas,monospace`;x.textAlign='center';x.textBaseline='middle';x.fillStyle=color;x.fillText(text,x0+w/2,y0+h/2+1);
}
function makeCanvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c;}
function speckle(c,w,h,seed,tones,amount=.3){
  for(let n=0;n<w*h*amount;n++){c.globalAlpha=.12+random(n*1.31+seed)*.33;c.fillStyle=tones[n%tones.length];const s=random(n*.7+seed*7)>.94?2:1;c.fillRect(Math.floor(random(n+seed)*w),Math.floor(random(n*3.1+seed*.3)*h),s,s);}
  c.globalAlpha=1;
}
function paintHazard(c,x,y,w,h,step){
  c.save();c.beginPath();c.rect(x,y,w,h);c.clip();c.fillStyle='#d1a221';c.fillRect(x,y,w,h);c.fillStyle='#1e1c15';
  for(let k=-h;k<w+h;k+=step*2){c.beginPath();c.moveTo(x+k,y+h);c.lineTo(x+k+step,y+h);c.lineTo(x+k+step+h,y);c.lineTo(x+k+h,y);c.fill();}
  for(let n=0;n<w*h*.12;n++){c.globalAlpha=.2+random(n+x)*.35;c.fillStyle=n%2?'#5b5032':'#8f7a3c';c.fillRect(x+Math.floor(random(n*1.7+y)*w),y+Math.floor(random(n*2.9+x)*h),1,1);}
  c.restore();
}
// Cast concrete as in the show: cloudy pours, formwork panels with tie holes, water streaks and grime where water
// collects. Every mark is also drawn into a height canvas (grey = flat), which becomes the normal map. All of it tiles.
function tiled(w,h,x0,y0,draw){for(const dx of [-w,0,w])for(const dy of [-h,0,h])draw(x0+dx,y0+dy);}
function drip(c,w,h,sx,sy,len,width,rgb,alpha){tiled(w,h,sx,sy,(x0,y0)=>{if(x0+width<0||x0>w||y0+len<0||y0>h)return;const g=c.createLinearGradient(0,y0,0,y0+len);g.addColorStop(0,`rgba(${rgb},${alpha})`);g.addColorStop(.25,`rgba(${rgb},${alpha*.7})`);g.addColorStop(1,`rgba(${rgb},0)`);c.fillStyle=g;c.fillRect(x0,y0,width,len);});}
// Value noise that wraps on the tile: one random grid per octave, smoothly interpolated, summed.
function noiseField(w,h,seed,octaves){
  const f=new Float32Array(w*h);
  for(const [cell,amp] of octaves){
    const gw=Math.max(2,Math.round(w/cell)),gh=Math.max(2,Math.round(h/cell)),g=new Float32Array(gw*gh);for(let i=0;i<g.length;i++)g[i]=random(seed*13.7+i*7.13+cell)*2-1;
    for(let y=0;y<h;y++){const fy=y/h*gh,j0=Math.floor(fy),ty=fy-j0,sy=ty*ty*(3-2*ty),r0=j0%gh*gw,r1=(j0+1)%gh*gw;
      for(let x=0;x<w;x++){const fx=x/w*gw,i0=Math.floor(fx),tx=fx-i0,sx=tx*tx*(3-2*tx),i1=(i0+1)%gw;
        f[y*w+x]+=amp*((g[r0+i0]*(1-sx)+g[r0+i1]*sx)*(1-sy)+(g[r1+i0]*(1-sx)+g[r1+i1]*sx)*sy);}}
  }
  return f;
}
function castConcrete(w,h,seed,{base='#83857c',cols=2,rows=1,ties=true,streaks=1,grime=.6,cracks=2}={}){
  // Both canvases stay in main memory: they are read back once, and many small draws on GPU canvases are slow.
  const color=makeCanvas(w,h),c=color.getContext('2d',{willReadFrequently:true}),height=makeCanvas(w,h),b=height.getContext('2d',{willReadFrequently:true});
  // Cloudy pours: large blotches down to fine mottling in the colour, mostly fine grain in the relief.
  const tone=noiseField(w,h,seed,[[w/3,.5],[w/10,.3],[w/36,.2],[w/120,.15]]),grain=noiseField(w,h,seed+5,[[w/3,.1],[w/10,.2],[w/36,.3],[w/120,.4]]);
  const [cr,cg,cb]=[1,3,5].map(i=>parseInt(base.slice(i,i+2),16)),ci=c.createImageData(w,h),hi=b.createImageData(w,h);
  for(let i=0;i<w*h;i++){const k=1+tone[i]*.32,q=i*4,hv=128+grain[i]*80;ci.data[q]=cr*k;ci.data[q+1]=cg*k;ci.data[q+2]=cb*k*(1+tone[i]*.04);ci.data[q+3]=255;hi.data[q]=hi.data[q+1]=hi.data[q+2]=hv;hi.data[q+3]=255;}
  c.putImageData(ci,0,0);b.putImageData(hi,0,0);
  // Air pockets and aggregate: tiny pits, a few bigger ones.
  const pits=w*h*.012;b.globalAlpha=.6;b.fillStyle='#3a3a3a';
  for(let n=0;n<pits;n++){const px=random(n*1.37+seed)*w|0,py=random(n*2.71+seed*.7)*h|0,s=random(n*.91+seed)>.93?2:1;
    c.globalAlpha=.25+random(n*3.3)*.35;c.fillStyle=n%5?'#4b4d46':'#a7a89e';c.fillRect(px,py,s,s);if(n%5)b.fillRect(px,py,s,s);}
  c.globalAlpha=b.globalAlpha=1;
  // Water runs down from each pour line and from the top of the tile; rust bleeds from a few tie holes.
  const streak=(sx,sy,len,width,rgb,alpha)=>drip(c,w,h,sx,sy,len,width,rgb,alpha);
  for(let n=0;n<w/7*streaks;n++){const row=Math.floor(random(n*5.3+seed)*rows),sy=row*h/rows+(random(n*1.9)<.7?2:random(n*8.1+seed)*h/rows*.6);
    streak(random(n*3.7+seed)*w,sy,h*(.12+Math.pow(random(n*2.2+seed),1.5)*.75),1+random(n*4.4)*w/110,random(n*6.6+seed)>.9?'92,62,38':'34,37,32',.12+random(n*9.3)*.3);}
  // Formwork: seams at the panel edges (drawn on the tile edge so they tile), tie holes inside every panel.
  const pw=w/cols,ph=h/rows;
  for(let i=0;i<cols;i++){c.fillStyle='rgba(40,42,37,.55)';c.fillRect(i*pw,0,2,h);c.fillStyle='rgba(180,180,170,.25)';c.fillRect(i*pw+2,0,1,h);b.fillStyle='#2c2c2c';b.fillRect(i*pw-1,0,4,h);}
  for(let j=0;j<rows;j++){c.fillStyle='rgba(40,42,37,.6)';c.fillRect(0,j*ph,w,2);c.fillStyle='rgba(180,180,170,.25)';c.fillRect(0,j*ph+2,w,1);b.fillStyle='#2c2c2c';b.fillRect(0,j*ph-1,w,4);}
  if(ties)for(let i=0;i<cols;i++)for(let j=0;j<rows;j++)for(const [u,v] of [[.2,.22],[.8,.22],[.2,.78],[.8,.78]]){
    const tx=i*pw+u*pw,ty=j*ph+v*ph,r=Math.max(2,w/170),k=i*7+j*3+u*5+v*9;
    if(random(k+seed)>.82)streak(tx-r*.6,ty,ph*(.25+random(k*2)*.4),r*1.2,'110,66,34',.35);
    c.fillStyle='rgba(120,122,114,.6)';c.beginPath();c.arc(tx,ty,r*1.9,0,TAU);c.fill();c.fillStyle='#2b2d28';c.beginPath();c.arc(tx,ty,r,0,TAU);c.fill();
    b.fillStyle='#606060';b.beginPath();b.arc(tx,ty,r*1.9,0,TAU);b.fill();b.fillStyle='#101010';b.beginPath();b.arc(tx,ty,r,0,TAU);b.fill();}
  // Grime gathers at the foot of every panel row, a thinner band of soot under the top.
  for(let j=0;j<rows;j++){let g=c.createLinearGradient(0,(j+1)*ph-ph*.3,0,(j+1)*ph);g.addColorStop(0,'rgba(28,30,25,0)');g.addColorStop(1,`rgba(28,30,25,${grime})`);c.fillStyle=g;c.fillRect(0,(j+1)*ph-ph*.3,w,ph*.3);
    g=c.createLinearGradient(0,j*ph,0,j*ph+ph*.08);g.addColorStop(0,`rgba(28,30,25,${grime*.6})`);g.addColorStop(1,'rgba(28,30,25,0)');c.fillStyle=g;c.fillRect(0,j*ph,w,ph*.08);}
  // Hairline cracks.
  for(let n=0;n<cracks;n++){let px=random(n*7.7+seed)*w,py=random(n*3.1+seed)*h;const dir=random(n*4.9+seed)*TAU;
    c.fillStyle='rgba(30,32,28,.55)';b.fillStyle='#404040';
    for(let k=0;k<w*.25;k++){px+=Math.cos(dir+(random(k*1.3+n)-.5)*2.4);py+=Math.sin(dir+(random(k*2.9+n)-.5)*2.4);c.fillRect(px|0,py|0,1,1);b.fillRect(px|0,py|0,1,1);}}
  return {color,height};
}
// Height canvas to a tangent-space normal map (OpenGL convention, as three.js expects). Edges wrap.
function normalMap(height,strength){
  const w=height.width,h=height.height,src=height.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h).data,out=makeCanvas(w,h),o=out.getContext('2d'),img=o.createImageData(w,h),d=img.data;
  const v=new Float32Array(w*h);for(let i=0;i<w*h;i++)v[i]=src[i*4]*strength/255;
  for(let j=0;j<h;j++){const up=((j+h-1)%h)*w,down=((j+1)%h)*w,row=j*w;
    for(let i=0;i<w;i++){const dx=v[row+(i+1)%w]-v[row+(i+w-1)%w],dy=v[down+i]-v[up+i],l=1/Math.sqrt(dx*dx+dy*dy+1),k=(row+i)*4;
      d[k]=(.5-dx*l*.5)*255;d[k+1]=(dy*l*.5+.5)*255;d[k+2]=(l*.5+.5)*255;d[k+3]=255;}}
  o.putImageData(img,0,0);return out;
}
// Weathered plate steel for the generator: mottled paint eaten by rust, riveted panel seams, rows of small louvred
// vents with rust running out of them. Same {color,height} pair as cast concrete, and it tiles the same way.
function weatheredSteel(w,h,seed,{base='#6b675e',cols=2,rows=2,vents=true,rust=.2}={}){
  const color=makeCanvas(w,h),c=color.getContext('2d',{willReadFrequently:true}),height=makeCanvas(w,h),b=height.getContext('2d',{willReadFrequently:true});
  const tone=noiseField(w,h,seed,[[w/4,.5],[w/12,.3],[w/40,.2]]),eaten=noiseField(w,h,seed+9,[[w/6,.6],[w/20,.3],[w/60,.25]]),grain=noiseField(w,h,seed+3,[[w/12,.2],[w/40,.3],[w/128,.4]]);
  const [br,bg,bb]=[1,3,5].map(i=>parseInt(base.slice(i,i+2),16)),ci=c.createImageData(w,h),hi=b.createImageData(w,h);
  for(let i=0;i<w*h;i++){const t=1+tone[i]*.25,k=smooth(.35-rust,.75-rust,eaten[i]),q=i*4,r=1+tone[i]*.35;
    ci.data[q]=mix(br*t,112*r,k);ci.data[q+1]=mix(bg*t,72*r,k);ci.data[q+2]=mix(bb*t,44*r,k);ci.data[q+3]=255;
    hi.data[q]=hi.data[q+1]=hi.data[q+2]=128+grain[i]*(30+k*40)-k*18;hi.data[q+3]=255;}
  c.putImageData(ci,0,0);b.putImageData(hi,0,0);
  // Seams on the tile edges, so they tile; a rivet row on both sides of each.
  const pw=w/cols,ph=h/rows,step=Math.max(6,w/48);
  const rivet=(x,y)=>{c.fillStyle='rgba(30,28,24,.7)';c.fillRect(x,y+1,2,1);c.fillStyle='rgba(176,170,156,.55)';c.fillRect(x,y,2,1);b.fillStyle='#e0e0e0';b.fillRect(x,y,2,2);};
  for(let i=0;i<cols;i++){const x=i*pw;c.fillStyle='rgba(22,22,19,.75)';c.fillRect(x,0,2,h);c.fillStyle='rgba(170,166,152,.3)';c.fillRect(x+2,0,1,h);b.fillStyle='#303030';b.fillRect(x-1,0,4,h);
    for(let y=step/2;y<h;y+=step){rivet(x+5,y);rivet(x-6,y);}}
  for(let j=0;j<rows;j++){const y=j*ph;c.fillStyle='rgba(22,22,19,.75)';c.fillRect(0,y,w,2);c.fillStyle='rgba(170,166,152,.3)';c.fillRect(0,y+2,w,1);b.fillStyle='#303030';b.fillRect(0,y-1,w,4);
    for(let x=step/2;x<w;x+=step){rivet(x,y+5);rivet(x,y-6);}}
  // Two lines of louvres through the middle of every panel row; some of them weep rust.
  if(vents)for(let j=0;j<rows;j++)for(const v of [.36,.56]){
    const vw=Math.round(w/36),vh=Math.max(4,Math.round(ph*.08)),gap=w/22,y=Math.round(j*ph+ph*v);
    for(let x=gap/2;x<w-vw;x+=gap){const xi=Math.round(x),k=xi*.37+y*1.3+seed;
      c.fillStyle='rgba(150,146,134,.45)';c.fillRect(xi-1,y-1,vw+2,vh+2);c.fillStyle='#121110';c.fillRect(xi,y,vw,vh);c.fillStyle='rgba(120,116,104,.6)';for(let s=y+2;s<y+vh;s+=3)c.fillRect(xi,s,vw,1);
      b.fillStyle='#d8d8d8';b.fillRect(xi-1,y-1,vw+2,vh+2);b.fillStyle='#181818';b.fillRect(xi,y,vw,vh);
      if(random(k)>.55)drip(c,w,h,xi+1,y+vh,ph*(.12+random(k*2)*.3),vw-2,'92,64,40',.2+random(k*3)*.2);}
  }
  for(let j=0;j<rows;j++){const g=c.createLinearGradient(0,(j+1)*ph-ph*.25,0,(j+1)*ph);g.addColorStop(0,'rgba(24,22,18,0)');g.addColorStop(1,'rgba(24,22,18,.45)');c.fillStyle=g;c.fillRect(0,(j+1)*ph-ph*.25,w,ph*.25);}
  return {color,height};
}
// Wind-blown dust for the surface: near-white so the ground's vertex colours tint it, with ripples bent by noise
// and a scatter of grit. Ripples and grit are in the height canvas too.
function dustSurface(w,h,seed){
  const color=makeCanvas(w,h),c=color.getContext('2d',{willReadFrequently:true}),height=makeCanvas(w,h),b=height.getContext('2d',{willReadFrequently:true});
  const tone=noiseField(w,h,seed,[[w/3,.5],[w/10,.3],[w/40,.2]]),bend=noiseField(w,h,seed+4,[[w/2,.6],[w/6,.3]]),grain=noiseField(w,h,seed+8,[[w/32,.3],[w/128,.5]]);
  const ci=c.createImageData(w,h),hi=b.createImageData(w,h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x,q=i*4,rip=Math.sin((y/h*14+bend[i]*2.2)*TAU),k=1+tone[i]*.14+rip*.035;
    ci.data[q]=232*k;ci.data[q+1]=224*k;ci.data[q+2]=208*k;ci.data[q+3]=255;hi.data[q]=hi.data[q+1]=hi.data[q+2]=128+rip*38*(.6+.4*tone[i])+grain[i]*30;hi.data[q+3]=255;}
  c.putImageData(ci,0,0);b.putImageData(hi,0,0);
  for(let n=0;n<w*h*.004;n++){const px=random(n*1.7+seed)*w|0,py=random(n*2.3+seed)*h|0,s=random(n*.7)>.9?2:1;c.globalAlpha=.3+random(n*3.1)*.4;c.fillStyle=n%3?'#5b5144':'#f4eee0';c.fillRect(px,py,s,s);b.fillStyle='#e8e8e8';b.fillRect(px,py,s,s);}
  c.globalAlpha=1;return {color,height};
}
// Sharpen an image in place with a 3x3 unsharp kernel: each pixel pushed away from the mean of its four neighbours.
function sharpen(img,amount){
  const {width:w,height:h,data:d}=img,src=new Uint8ClampedArray(d);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++)for(let c=0;c<3;c++){const i=(y*w+x)*4+c;d[i]=src[i]*(1+4*amount)-amount*(src[i-4]+src[i+4]+src[i-w*4]+src[i+w*4]);}
  return img;
}
// A box whose UVs are in metres (divided by tile) on every face, so a texture keeps one scale on long thin pieces.
function boxMetres(w,h,d,tile){
  const g=new T.BoxGeometry(w,h,d),p=g.attributes.position,n=g.attributes.normal,uv=g.attributes.uv;
  for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),ax=Math.abs(n.getX(i)),ay=Math.abs(n.getY(i));uv.setXY(i,(ax>.5?z:x)/tile,(ay>.5?z:y)/tile);}
  return g;
}
// A bush: a sphere pushed in and out by a few lobes, so it reads as clumps of leaves. Points on the UV seam get the
// same push as their twins, so the surface stays closed.
function shrubGeometry(){
  const g=new T.SphereGeometry(.42,18,12),p=g.attributes.position,v=new T.Vector3();
  for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i);const n=v.clone().normalize(),k=1+.16*Math.sin(n.x*7+1)*Math.sin(n.y*6+2)*Math.sin(n.z*7)+.08*Math.sin(n.x*15+n.z*13);v.multiplyScalar(k);if(v.y<0)v.y*=.75;p.setXYZ(i,v.x,v.y,v.z);}
  g.computeVertexNormals();return g;
}
// A box cross-section swept along the stair helix: radius r0..r1, height y0..y1 over the tread line, over each run
// [u0,u1] of levels, with end caps. Four strips and two caps per run, so a whole chunk of parapet is one small mesh.
// With rise 0 the sweep is a flat ring, which is how the gallery parapets are made.
function helixBox(runs,r0,r1,y0,y1,perLevel,rise=FLOOR_HEIGHT){
  const pos=[],nor=[],uv=[],index=[],vert=(r,y,s,c,n,u,v)=>{pos.push(s*r,y,c*r);nor.push(...n);uv.push(u,v);return pos.length/3-1;};
  // Each face goes from edge A to edge B so that (along the helix) x (A to B) points out of the face.
  const faces=[[r1,y0,r1,y1,(s,c)=>[s,0,c]],[r0,y1,r0,y0,(s,c)=>[-s,0,-c]],[r1,y1,r0,y1,()=>[0,1,0]],[r0,y0,r1,y0,()=>[0,-1,0]]];
  for(const [u0,u1] of runs){
    const n=Math.max(1,Math.ceil((u1-u0)*perLevel)),at=k=>{const u=u0+(u1-u0)*k/n,th=Math.PI+u*TAU;return [Math.sin(th),Math.cos(th),-u*rise+FLOOR_TOP,u*TAU*r1/4];};
    for(const [ra,ya,rb,yb,normal] of faces)for(let k=0;k<=n;k++){
      const [sn,cs,y,d]=at(k),a=vert(ra,y+ya,sn,cs,normal(sn,cs),d,(ya-y0)/(y1-y0)),b=vert(rb,y+yb,sn,cs,normal(sn,cs),d,(yb-y0)/(y1-y0));
      if(k)index.push(a-2,a,a-1,a-1,a,b);
    }
    for(const [k,sign] of [[0,-1],[n,1]]){const [sn,cs,y]=at(k),t=[cs*sign,0,-sn*sign],q=[[r0,y0],[r1,y0],[r1,y1],[r0,y1]].map(([r,h],i)=>vert(r,y+h,sn,cs,t,i%3?.1:0,i>1?1:0));
      index.push(...(sign<0?[q[0],q[1],q[2],q[0],q[2],q[3]]:[q[0],q[2],q[1],q[0],q[3],q[2]]));}
  }
  const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('normal',new T.Float32BufferAttribute(nor,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(index);g.computeBoundingSphere();return g;
}
// The silos stand in a grid, each roof at the bottom of a round crater. Silo 18 is the one at the origin.
const SILO_SPACING=620,SILO_GRID=7,SILO_I=2,SILO_J=3;
const SILO_SITES=[];for(let i=0;i<SILO_GRID;i++)for(let j=0;j<SILO_GRID;j++)SILO_SITES.push([(i-SILO_I)*SILO_SPACING+(i===SILO_I&&j===SILO_J?0:(random(i*7+j)-.5)*90),(j-SILO_J)*SILO_SPACING+(i===SILO_I&&j===SILO_J?0:(random(i+j*11)-.5)*90)]);
function nearestSite(x,z){let best=Infinity,site=SILO_SITES[0];for(const s of SILO_SITES){const d=(x-s[0])**2+(z-s[1])**2;if(d<best){best=d;site=s;}}return [Math.sqrt(best),site];}
const crater=d=>d<46?-8:d<92?mix(-8,3,smooth(46,92,d)):mix(3,0,smooth(92,135,d));
// Height of the surface: craters around the silos, rolling dead ground, ridges on the horizon.
function terrainHeight(x,z){
  const r=Math.hypot(x,z),[d]=nearestSite(x,z);
  const n=Math.sin(x*.0043+Math.cos(z*.0031)*2.1)*Math.cos(z*.0049-x*.0013)+.5*Math.sin(x*.0107+z*.0093+.7)+.25*Math.sin(x*.0231-z*.0273+1.3)+.13*Math.sin(x*.061+z*.047);
  const bump=(Math.sin(x*.21+z*.13)*Math.cos(z*.17-x*.07)*.35+Math.sin(x*.47-z*.39)*.15)*smooth(46,70,d);
  const base=(smooth(160,900,r)*(n*30+24)+smooth(2400,3900,r)*130*(.6+.4*n))*mix(.2,1,smooth(70,260,d));
  return Math.max(-9,bump+base+crater(d));
}

export class SiloWorld3D{
  constructor(canvas,options){
    Object.assign(this,options);
    this.canvas=canvas;this.alive=true;this.level=0;this.floor=-1;
    const startY=physicalFloorY(4);
    // Camera rig: input only moves the target, the view eases toward it, and the camera eases toward the view.
    this.mode='orbit';this.followId=null;
    this.target={focusY:startY,yaw:.2,zoom:1,outDist:OUT_NEAR,outY:startY};this.view={...this.target};
    this.camPos=new T.Vector3();this.camLook=new T.Vector3();this.wantPos=new T.Vector3();this.wantLook=new T.Vector3();
    this.camFov=64;this.camR=23;this.camReady=false;this.blend=0;this.blendMax=1;this.push=0;this.pushAt=0;
    this.crt=options.crt!==false;this.crtLevel=this.crt?1:0;
    this.motion=new Map();this.people=new Map();this.couriers=new Map();this.courierSeq=0;this.meetings=[];this.councilMarks=new Map();this.pulse={tpm:0,working:0,budget:0,alarm:null};this.load=0;this.alarmUntil=0;this.alarmSeen=undefined;this.materials=[];this.ownedTextures=[];this.geometries=[];this.clock=0;this.last=0;this.selected=null;this.paused=false;
    this.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false,stencil:true,powerPreference:'high-performance'});
    // Phones and tablets get a lighter start; slow machines drop to 1:1 pixels once and stay there.
    // Sharpness follows the machine: it starts as before, gets sharper (up to the screen's own pixels, at most 2x)
    // while frames keep arriving on time, and steps down when they do not. A step that made it late is not tried again.
    const coarse=matchMedia('(pointer: coarse)').matches;
    this.ratioMin=Math.min(1,devicePixelRatio||1);this.ratioMax=Math.max(this.ratioMin,Math.min(devicePixelRatio||1,coarse?1.5:2));
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,coarse?1.25:1.5));this.gapAvg=0;this.gapBest=99;this.scaleCheck=0;this.ratioChanged=performance.now();
    this.renderer.outputColorSpace=T.SRGBColorSpace;this.renderer.toneMapping=T.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.35;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=T.PCFShadowMap;this.renderer.shadowMap.autoUpdate=false;this.shadowKey='';this.shadowAge=0;
    // One clipping plane is always installed. Moving it far away turns the cutaway off without recompiling shaders.
    this.clipPlane=new T.Plane(new T.Vector3(0,0,-1),1e5);this.renderer.clippingPlanes=[this.clipPlane];this.clipDir=new T.Vector3(0,0,1);this.clipC=1e5;
    this.maxAnisotropy=Math.min(8,this.renderer.capabilities.getMaxAnisotropy());
    this.scene=new T.Scene();this.scene.background=new T.Color('#070c09');this.scene.fog=new T.FogExp2('#0a110c',.0105);
    this.fogInside=new T.Color('#0a110c');this.fogBottom=new T.Color('#1f0f07');this.fogOutside=new T.Color('#b39f7c');
    this.lampColor=new T.Color('#ffb466');this.lampWarm=new T.Color('#ff7f45');
    this.camera=new T.PerspectiveCamera(64,1,.1,1400);
    this.raycaster=new T.Raycaster();this.pointer=new T.Vector2();this.pointers=new Map();this.sprites=[];this.terminalSigns=[];this.occluders=[];this.floorMeshes=[];this.detailMeshes=[];
    this.dummy=new T.Object3D();this.banks=new Map();this.glowBanks=new Map();this.atlasTextures=new Map();this.atlasQueue=[];this.atlasWaiting=new Map();this.atlasWorkers=new Set();this.labelCache=new Map();
    this.chunks=Array.from({length:CHUNKS},(_,i)=>{const group=new T.Group();group.userData={first:i*CHUNK+1,last:Math.min(LEVELS,(i+1)*CHUNK)};this.scene.add(group);return group;});
    this.onContextLost=e=>e.preventDefault();canvas.addEventListener('webglcontextlost',this.onContextLost);this.onContextBack=()=>{this.shadowKey='';};canvas.addEventListener('webglcontextrestored',this.onContextBack);
    const s0=performance.now();this.build();const s1=performance.now();this.setupPost();const s2=performance.now();this.precompile();
    this.startup={build:s1-s0,post:s2-s1,shaders:performance.now()-s2};
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(canvas);this.resize();
    this.scene.updateMatrixWorld(true);this.lensWorld=this.lensMesh.getWorldPosition(new T.Vector3());this.lensHeading=Math.PI+.35;
    this.feedCamera=new T.PerspectiveCamera(60,4/3,.1,420);this.feedTargets=new Map();this.feedsThisFrame=0;this.feedErrors=0;this.background=false;this.lowQuality=false;this.frameAvgMs=8;
    try{this.lensCleanedAt=Number(localStorage.getItem('silo-lens-cleaned'))||Date.now()-3*3600e3;}catch{this.lensCleanedAt=Date.now()-3*3600e3;}
    const s3=performance.now();this.update(this.agents,this.selected,false);this.startup.residents=performance.now()-s3;this.installControls();this.reportLevel(true);this.emitZoom();
    canvas.dataset.renderer='3d';canvas.dataset.crt=this.crt?'on':'off';canvas.parentElement.dataset.world='3d';
    // With ?debug: window.siloDebug is the world, and siloProfile() measures frame times in three scenes (profile-3d.js).
    if(new URLSearchParams(location.search).has('debug')){window.siloDebug=this;window.siloProfile=o=>import('./profile-3d.js').then(m=>m.profileScenarios(this,o));}
    this.animate=stamp=>{
      if(!this.alive)return;this.raf=requestAnimationFrame(this.animate);
      if(document.hidden){this.last=stamp;return;}
      // Behind an open terminal the silo is only a dim backdrop: throttle both simulation and drawing to ~20 Hz.
      const minStep=this.background?50:15;
      if(stamp-this.last<minStep)return;
      const dt=Math.min(.08,(stamp-this.last)/1000);this.last=stamp;
      if(!this.paused&&!this.reduced){this.clock+=dt;for(const a of this.agents)if(a.status!=='working'&&!this.busy(a.id))this.motion.set(a.id,(this.motion.get(a.id)||0)+dt);}
      const t0=performance.now();this.tick(dt);const t1=performance.now();
      if(this.shadersReady===false){this.last=stamp;return;}
      const gpuQuery=this.rec&&this.gpuTimerBegin();
      this.draw(stamp/1000);this.lastDraw=stamp;
      const t2=performance.now();
      // Extra cameras only run when visible (Security view or main world cafeteria screen).
      this.feedsThisFrame=0;
      try{
        if(this.afterDraw)this.afterDraw(stamp/1000);
        else if(!this.background&&!this.lowQuality)this.updateWallScreen(stamp/1000);
        this.feedErrors=0;
      }catch(error){console.warn('Camera feed skipped.',error);if(++this.feedErrors>=3){this.afterDraw=null;this.wallCtx=null;}}
      const t3=performance.now(),totalMs=t3-t0;
      if(gpuQuery)this.gpuTimerEnd(gpuQuery);
      this.frameAvgMs=this.frameAvgMs*.9+totalMs*.1;this.tickAvgMs=(this.tickAvgMs??t1-t0)*.9+(t1-t0)*.1;
      if(!this.background)this.adaptSharpness(dt*1000);
      // Less detail when the frames are slow, whether the time goes into the code (frameAvgMs) or into waiting for the
      // graphics card, which only shows in the time between frames (gpuSlow, see adaptSharpness).
      if((this.frameAvgMs>24||this.gpuSlow)&&!this.lowQuality)this.lowQuality=true;
      else if(this.frameAvgMs<14&&!this.gpuSlow&&this.lowQuality)this.lowQuality=false;
      this.timing={tick:t1-t0,draw:t2-t1,feeds:t3-t2,avg:this.frameAvgMs,lowQuality:this.lowQuality};
      const rec=this.rec;if(rec){if(rec.prev)rec.gap.push(stamp-rec.prev);rec.prev=stamp;rec.tick.push(t1-t0);rec.draw.push(t2-t1);rec.feeds.push(t3-t2);if(this.lowQuality)rec.low++;}
      if((this.framesDrawn=(this.framesDrawn||0)+1)<=3)(this.startup.frames||=[]).push({tick:Math.round(t1-t0),draw:Math.round(t2-t1),feeds:Math.round(t3-t2)});
    };
    this.raf=requestAnimationFrame(this.animate);
  }

  // ---------- resources ----------
  texture(canvas,{repeat=[1,1],wrap=false,smooth=false,linear=false}={}){
    const t=new T.CanvasTexture(canvas);t.colorSpace=linear?T.NoColorSpace:T.SRGBColorSpace;
    t.magFilter=smooth?T.LinearFilter:T.NearestFilter;t.minFilter=smooth?T.LinearMipmapLinearFilter:T.NearestMipmapLinearFilter;t.anisotropy=this.maxAnisotropy;
    if(wrap)t.wrapS=t.wrapT=T.RepeatWrapping;t.repeat.set(repeat[0],repeat[1]);this.ownedTextures.push(t);return t;
  }
  // A surface is a colour map with its normal map, both smooth and wrapping, sharing one repeat.
  surface({color,height},repeat=[1,1],strength=3){return {map:this.texture(color,{wrap:true,smooth:true,repeat}),normalMap:this.texture(normalMap(height,strength),{wrap:true,smooth:true,linear:true,repeat})};}
  resurface(s,repeat){const again=t=>{const k=t.clone();k.repeat.set(repeat[0],repeat[1]);this.ownedTextures.push(k);return k;};return {map:again(s.map),normalMap:again(s.normalMap)};}
  standard(options){const m=new T.MeshStandardMaterial({roughness:.9,metalness:.05,...options});this.materials.push(m);return m;}
  basic(options){const m=new T.MeshBasicMaterial(options);this.materials.push(m);return m;}
  geometry(g){this.geometries.push(g);return g;}
  mesh(geometry,material,parent=this.scene){const m=new T.Mesh(geometry,material);parent.add(m);return m;}
  bank(name,geometry,material,opts={}){this.banks.set(name,{geometry:this.geometry(geometry),material,opts,lists:Array.from({length:CHUNKS},()=>[])});}
  put(name,level,x,y,z,ry=0,sx=1,sy=1,sz=1,rx=0){this.dummy.position.set(x,y,z);this.dummy.rotation.set(rx,ry,0);this.dummy.scale.set(sx,sy,sz);this.dummy.updateMatrix();this.banks.get(name).lists[chunkOf(level)].push(this.dummy.matrix.clone());}
  glowBank(name,color,size,opacity=1){const material=new T.PointsMaterial({map:this.glowMap,color:hdr(color,1.5),size,transparent:true,opacity,depthWrite:false,blending:T.AdditiveBlending,fog:false,toneMapped:false,sizeAttenuation:true});this.materials.push(material);this.glowBanks.set(name,{material,lists:Array.from({length:CHUNKS},()=>[])});}
  glow(name,level,x,y,z){this.glowBanks.get(name).lists[chunkOf(level)].push(x,y,z);}
  flush(){
    for(const b of this.banks.values())b.lists.forEach((list,i)=>{
      if(!list.length)return;const mesh=new T.InstancedMesh(b.geometry,b.material,list.length);
      list.forEach((m,k)=>mesh.setMatrixAt(k,m));mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();
      mesh.castShadow=!!b.opts.cast;mesh.receiveShadow=!!b.opts.receive;mesh.renderOrder=b.opts.order||0;mesh.userData.seeThrough=!!b.opts.seeThrough;if(b.opts.occlude)this.occluders.push(mesh);if(b.opts.detail)this.detailMeshes.push(mesh);this.chunks[i].add(mesh);
    });
    for(const b of this.glowBanks.values())b.lists.forEach((list,i)=>{
      if(!list.length)return;const g=this.geometry(new T.BufferGeometry());g.setAttribute('position',new T.Float32BufferAttribute(list,3));g.computeBoundingSphere();
      const points=new T.Points(g,b.material);points.renderOrder=2;this.chunks[i].add(points);
    });
    this.banks.clear();this.glowBanks.clear();
  }

  makeTextures(){
    const glow=makeCanvas(64,64),g=glow.getContext('2d'),grad=g.createRadialGradient(32,32,0,32,32,32);
    grad.addColorStop(0,'rgba(255,255,255,1)');grad.addColorStop(.18,'rgba(255,236,200,.75)');grad.addColorStop(.5,'rgba(255,190,110,.18)');grad.addColorStop(1,'rgba(255,170,80,0)');
    g.fillStyle=grad;g.fillRect(0,0,64,64);this.glowMap=this.texture(glow,{smooth:true});
    const puff=makeCanvas(64,64),p=puff.getContext('2d'),pg=p.createRadialGradient(32,32,0,32,32,32);
    pg.addColorStop(0,'rgba(255,255,255,.9)');pg.addColorStop(.45,'rgba(255,255,255,.35)');pg.addColorStop(1,'rgba(255,255,255,0)');p.fillStyle=pg;p.fillRect(0,0,64,64);this.puffMap=this.texture(puff,{smooth:true});
    const tx={};
    // Concrete surfaces are {map,normalMap} pairs. Floors: saw-cut slabs with oil stains, no runs on a flat surface.
    let s=castConcrete(512,512,3,{base:'#8a897d',cols:4,rows:4,ties:false,streaks:0,grime:.12,cracks:3}),x=s.color.getContext('2d'),hx;
    for(let n=0;n<7;n++){const r=14+random(n*3.9)*40;tiled(512,512,random(n*5.1+3)*512,random(n*7.3+3)*512,(px,py)=>{const g=x.createRadialGradient(px,py,0,px,py,r);g.addColorStop(0,'rgba(30,30,26,.32)');g.addColorStop(.7,'rgba(30,30,26,.12)');g.addColorStop(1,'rgba(30,30,26,0)');x.fillStyle=g;x.fillRect(px-r,py-r,r*2,r*2);});}
    tx.floor=this.surface(s,[10,10],2.5);
    // Outer wall between the rooms: dark poured panels under a run of pipes, rust bleeding down from the brackets.
    // One tile is one level, floor at the bottom; the half-tile offset lines it up with the slabs.
    s=castConcrete(512,512,17,{base:'#64675e',cols:2,rows:2,ties:true,streaks:1.3,grime:.55,cracks:3});x=s.color.getContext('2d');hx=s.height.getContext('2d');
    const pipe=(py,h,col,hi)=>{
      let lg=x.createLinearGradient(0,py,0,py+h);lg.addColorStop(0,'#1a1c16');lg.addColorStop(.3,hi);lg.addColorStop(.55,col);lg.addColorStop(1,'#1a1c16');x.fillStyle=lg;x.fillRect(0,py,512,h);
      lg=hx.createLinearGradient(0,py,0,py+h);lg.addColorStop(0,'#808080');lg.addColorStop(.4,'#e0e0e0');lg.addColorStop(1,'#808080');hx.fillStyle=lg;hx.fillRect(0,py,512,h);
      for(let k=40;k<512;k+=140){x.fillStyle='#2a2b22';x.fillRect(k,py-2,8,h+4);hx.fillStyle='#f0f0f0';hx.fillRect(k,py-2,8,h+4);drip(x,512,512,k,py+h+2,60+random(k+py)*120,7,'104,58,30',.4);}
    };
    pipe(16,20,'#8a4a25','#c0703a');pipe(44,12,'#6d6f63','#a5a797');pipe(64,16,'#7a3f22','#b0653a');
    x.fillStyle='#22241d';x.fillRect(80,84,6,428);x.fillRect(92,84,4,428);x.fillStyle='#4e5245';x.fillRect(400,84,20,428);x.fillStyle='#6a6f5d';x.fillRect(404,84,4,428);
    hx.fillStyle='#c8c8c8';hx.fillRect(80,84,6,428);hx.fillRect(92,84,4,428);hx.fillRect(400,84,20,428);
    tx.wall=this.surface(s,[BAYS*2,(DEPTH+12)/FLOOR_HEIGHT],3);tx.wall.map.offset.y=tx.wall.normalMap.offset.y=.5;
    s=castConcrete(128,960,23,{base:'#8a897d',cols:1,rows:2,ties:false,streaks:.7,grime:.4,cracks:1});
    tx.pillar=this.surface(s,[1,1],2.5);
    let c=makeCanvas(256,128);x=c.getContext('2d');paintHazard(x,0,0,256,128,32);tx.hazard=this.texture(c,{smooth:true});
    tx.core=this.surface(castConcrete(256,512,31,{base:'#8a897d',cols:1,rows:2,ties:true,streaks:1,grime:.45,cracks:1}),[6,LEVELS+2],2.5);tx.core.map.offset.y=tx.core.normalMap.offset.y=.5;
    // Stair parapet: one tile is 4 m of band, full height, panel joints every 2 m.
    tx.parapet=this.surface(castConcrete(512,256,41,{base:'#8a897d',cols:2,rows:1,ties:true,streaks:.9,grime:.5,cracks:2}),[1,1],2.5);
    // Ribbed lamp glass: bright ribs, darker grooves, dimmer towards the steel rings.
    c=makeCanvas(64,32);x=c.getContext('2d');
    for(let i=0;i<64;i++){const v=.62+.38*Math.pow(.5+.5*Math.cos(i/64*TAU*8),.6);for(let j=0;j<32;j++){const e=Math.sin(j/31*Math.PI),k=Math.round(255*v*(.55+.45*e));x.fillStyle=`rgb(${k},${k},${k})`;x.fillRect(i,j,1,1);}}
    tx.ribs=this.texture(c,{wrap:true,smooth:true});
    tx.shell=this.surface(castConcrete(512,512,37,{base:'#86867c',cols:2,rows:2,ties:true,streaks:.8,grime:.35,cracks:4}),[1,1],2.5);
    // Props on the galleries. Crate: nailed boards in a frame with a diagonal brace, grain and relief.
    c=makeCanvas(256,256);x=c.getContext('2d',{willReadFrequently:true});hx=makeCanvas(256,256).getContext('2d',{willReadFrequently:true});
    {const grain=noiseField(256,256,131,[[64,.3],[8,.2]]),img=x.createImageData(256,256),hi=hx.createImageData(256,256);
      for(let py=0;py<256;py++)for(let px=0;px<256;px++){const i=py*256+px,board=Math.floor(py/43),w=Math.sin(py*.9+board*7+grain[i]*6+px*.012)*.5+.5,k=.78+w*.18+grain[i]*.25+random(board*3.1)*.12,q=i*4;
        img.data[q]=138*k;img.data[q+1]=96*k;img.data[q+2]=56*k;img.data[q+3]=255;hi.data[q]=hi.data[q+1]=hi.data[q+2]=140+w*30;hi.data[q+3]=255;}
      x.putImageData(img,0,0);hx.putImageData(hi,0,0);}
    for(let k=43;k<256;k+=43){x.fillStyle='rgba(30,18,8,.8)';x.fillRect(0,k-1,256,3);hx.fillStyle='#303030';hx.fillRect(0,k-1,256,3);}
    const plank=(draw)=>{for(const [ctx,fill,edge] of [[x,'#7d5530','rgba(30,18,8,.85)'],[hx,'#d8d8d8','#404040']]){ctx.save();draw(ctx);ctx.fillStyle=fill;ctx.fill();ctx.strokeStyle=edge;ctx.lineWidth=3;ctx.stroke();ctx.restore();}};
    for(const [rx,ry,rw,rh] of [[0,0,256,26],[0,230,256,26],[0,0,26,256],[230,0,26,256]])plank(ctx=>{ctx.beginPath();ctx.rect(rx,ry,rw,rh);});
    plank(ctx=>{ctx.beginPath();ctx.translate(128,128);ctx.rotate(-Math.PI/4);ctx.rect(-170,-13,340,26);});
    speckle(x,256,256,137,['#4a321c','#9a7040','#5c3e22'],.12);
    for(const [a,b] of [[13,13],[243,13],[13,243],[243,243],[128,13],[128,243],[13,128],[243,128]]){x.fillStyle='#2b2620';x.fillRect(a-3,b-3,6,6);x.fillStyle='#8a8478';x.fillRect(a-2,b-2,3,3);hx.fillStyle='#f0f0f0';hx.fillRect(a-3,b-3,6,6);}
    x.fillStyle='rgba(30,24,16,.75)';x.font='bold 20px Consolas,monospace';x.textAlign='center';x.fillText('RATIONS 18',150,200);
    tx.crate=this.surface({color:c,height:hx.canvas},[1,1],2.5);
    // Steel drum: painted, chipped to rust, with rolling hoops.
    let st=weatheredSteel(256,128,139,{base:'#4f6a73',cols:1,rows:1,vents:false,rust:.18});x=st.color.getContext('2d');hx=st.height.getContext('2d');
    for(const v of [.2,.5,.8]){const y=Math.round(v*128);x.fillStyle='rgba(20,26,28,.75)';x.fillRect(0,y-3,256,2);x.fillStyle='rgba(150,176,180,.45)';x.fillRect(0,y-1,256,2);x.fillStyle='rgba(20,26,28,.6)';x.fillRect(0,y+1,256,2);hx.fillStyle='#e8e8e8';hx.fillRect(0,y-3,256,6);}
    x.fillStyle='rgba(230,200,70,.85)';x.fillRect(96,46,64,34);x.fillStyle='#2a2a22';x.font='bold 14px Consolas,monospace';x.textAlign='center';x.fillText('OIL',128,68);
    tx.barrel=this.surface(st,[1,1],2);
    // Grey-green machine cabinet: louvres, a dial and a stencilled number.
    st=weatheredSteel(256,128,149,{base:'#56684f',cols:2,rows:1,vents:true,rust:-.05});x=st.color.getContext('2d');
    x.fillStyle='#1a1c18';x.beginPath();x.arc(64,30,15,0,TAU);x.fill();x.fillStyle='#d9d2bb';x.beginPath();x.arc(64,30,12,0,TAU);x.fill();x.strokeStyle='#a3241a';x.lineWidth=2;x.beginPath();x.moveTo(64,30);x.lineTo(72,24);x.stroke();
    paintHazard(x,150,96,90,14,7);x.fillStyle='rgba(235,225,200,.8)';x.font='bold 16px Consolas,monospace';x.textAlign='center';x.fillText('PUMP 07',192,34);
    tx.machine=this.surface(st,[1,1],2);
    // Steel desk: drawer fronts with pulls; the monitor housing is plain beige plate.
    st=weatheredSteel(256,128,151,{base:'#4a5046',cols:3,rows:1,vents:false,rust:.04});x=st.color.getContext('2d');hx=st.height.getContext('2d');
    for(const dy of [26,62,98]){x.fillStyle='rgba(16,18,14,.7)';x.fillRect(184,dy-16,64,2);x.fillStyle='#9a9a8c';x.fillRect(204,dy,24,4);hx.fillStyle='#f0f0f0';hx.fillRect(204,dy,24,4);}
    tx.desk=this.surface(st,[1,1],2);
    tx.monitor=this.surface(weatheredSteel(128,128,157,{base:'#8f8a78',cols:1,rows:1,vents:false,rust:0}),[1,1],1.5);
    // Leaves for the farm troughs and the potted shrubs: layered leaf shapes over dark soil.
    c=makeCanvas(256,128);x=c.getContext('2d');x.fillStyle='#24301b';x.fillRect(0,0,256,128);
    for(let n=0;n<700;n++){const lx=random(n*1.9)*256,ly=random(n*2.3)*128,s=4+random(n*3.7)*7,a=random(n*5.1)*TAU,g=['#3c6d2a','#4f8a35','#6fae45','#93c95a','#2f5a22'][n%5];
      x.save();tiled(256,128,lx,ly,(px,py)=>{x.setTransform(1,0,0,1,px,py);x.rotate(a);x.fillStyle=g;x.beginPath();x.ellipse(0,0,s,s*.42,0,0,TAU);x.fill();x.strokeStyle='rgba(20,40,14,.5)';x.lineWidth=.8;x.beginPath();x.moveTo(-s,0);x.lineTo(s,0);x.stroke();});x.restore();}
    tx.plants=this.texture(c,{wrap:true,smooth:true});
    // Fired clay for the pots.
    c=makeCanvas(64,64);x=c.getContext('2d');let lg=x.createLinearGradient(0,0,0,64);lg.addColorStop(0,'#6e3f25');lg.addColorStop(.18,'#a7633b');lg.addColorStop(.24,'#7a4428');lg.addColorStop(1,'#93583a');x.fillStyle=lg;x.fillRect(0,0,64,64);
    speckle(x,64,64,163,['#6a3a20','#b77a50','#5a3018'],.35);tx.pot=this.texture(c,{wrap:true,smooth:true});
    c=makeCanvas(256,192);x=c.getContext('2d');x.scale(4,4);x.fillStyle='#0d1a10';x.fillRect(0,0,64,48);x.fillStyle='#6fe28a';
    for(let k=0;k<7;k++)x.fillRect(5,5+k*5,8+Math.floor(random(k*9)*44),2);x.strokeStyle='#59c473';x.beginPath();x.arc(48,32,9,0,TAU);x.stroke();x.fillStyle='#0d1a10';x.globalAlpha=.35;for(let k=0;k<48;k+=2)x.fillRect(0,k,64,1);x.globalAlpha=1;
    tx.screen=this.texture(c,{smooth:true});
    // Skylight: warm glass behind a steel grille of rings and spokes in a heavy frame. Drawn at 1024 px so the bars
    // stay sharp when the camera is right under it.
    c=makeCanvas(1024,1024);x=c.getContext('2d');x.scale(4,4);const sky=x.createRadialGradient(128,128,10,128,128,128);sky.addColorStop(0,'#fff6dc');sky.addColorStop(.7,'#f6d79c');sky.addColorStop(1,'#c59a5c');x.fillStyle=sky;x.fillRect(0,0,256,256);
    for(let n=0;n<160;n++){const r=8+random(n*2.1)*110,a=random(n*3.7)*TAU,g=x.createRadialGradient(128+Math.cos(a)*r,128+Math.sin(a)*r,0,128+Math.cos(a)*r,128+Math.sin(a)*r,4+random(n)*10);g.addColorStop(0,'rgba(120,96,60,.16)');g.addColorStop(1,'rgba(120,96,60,0)');x.fillStyle=g;x.fillRect(0,0,256,256);}
    const bars=(color,width)=>{x.strokeStyle=color;x.lineWidth=width;for(const r of [38,78,118]){x.beginPath();x.arc(128,128,r,0,TAU);x.stroke();}for(let k=0;k<16;k++){const a=k/16*TAU;x.beginPath();x.moveTo(128+Math.cos(a)*20,128+Math.sin(a)*20);x.lineTo(128+Math.cos(a)*126,128+Math.sin(a)*126);x.stroke();}};
    bars('#3b3424',5);bars('rgba(150,128,90,.5)',1.2);
    x.strokeStyle='#2a251b';x.lineWidth=7;x.beginPath();x.arc(128,128,124.5,0,TAU);x.stroke();x.fillStyle='#2a251b';x.beginPath();x.arc(128,128,20,0,TAU);x.fill();
    tx.sky=this.texture(c,{smooth:true});
    c=makeCanvas(256,128);x=c.getContext('2d');x.fillStyle='#000';x.fillRect(0,0,256,128);
    for(let n=0;n<26;n++){const sx=Math.floor(random(n*3.3)*256),w=2+Math.floor(random(n*7.1)*14),a=.25+random(n*1.9)*.6,lg=x.createLinearGradient(0,0,0,128);lg.addColorStop(0,`rgba(255,226,170,${a})`);lg.addColorStop(.55,`rgba(255,200,130,${a*.35})`);lg.addColorStop(1,'rgba(0,0,0,0)');x.fillStyle=lg;x.fillRect(sx,0,w,128);}
    tx.rays=this.texture(c,{wrap:true,smooth:true,repeat:[3,1]});tx.rays.wrapT=T.ClampToEdgeWrapping;
    // Machine hall: the generator's plate steel, rusted pipe, bar grating and the console faces.
    tx.drum=this.surface(weatheredSteel(512,256,83,{base:'#5f5c55',cols:2,rows:2,rust:.06}),[5,2],2);
    tx.hull=this.surface(weatheredSteel(256,256,91,{base:'#5f5c55',cols:2,rows:1,vents:false,rust:.1}),[4,1],2);
    tx.pipe=this.surface(weatheredSteel(256,256,89,{base:'#5e5a52',cols:1,rows:1,vents:false,rust:.38}),[3,1],2);
    c=makeCanvas(128,128);x=c.getContext('2d',{willReadFrequently:true});hx=makeCanvas(128,128).getContext('2d',{willReadFrequently:true});
    x.fillStyle='#16170f';x.fillRect(0,0,128,128);hx.fillStyle='#202020';hx.fillRect(0,0,128,128);
    for(let k=0;k<128;k+=8){x.fillStyle='#6f6e64';x.fillRect(0,k,128,3);x.fillStyle='#9a988c';x.fillRect(0,k,128,1);hx.fillStyle='#e0e0e0';hx.fillRect(0,k,128,3);}
    for(let k=0;k<128;k+=32){x.fillStyle='#5d5c53';x.fillRect(k,0,2,128);hx.fillStyle='#c0c0c0';hx.fillRect(k,0,2,128);}
    speckle(x,128,128,97,['#7a4424','#3a3a32','#8a6a44'],.18);
    tx.grate=this.surface({color:c,height:hx.canvas},[1,1],2);
    c=makeCanvas(128,96);x=c.getContext('2d');const glowC=makeCanvas(128,96),gx=glowC.getContext('2d');gx.fillStyle='#000';gx.fillRect(0,0,128,96);
    x.fillStyle='#4c5049';x.fillRect(0,0,128,96);speckle(x,128,96,101,['#3a3d37','#62665d','#5a4632'],.3);x.fillStyle='#24261f';x.fillRect(0,0,128,3);x.fillRect(0,93,128,3);
    for(const [gxp,gyp] of [[22,26],[58,26]]){x.fillStyle='#1b1c18';x.beginPath();x.arc(gxp,gyp,15,0,TAU);x.fill();x.fillStyle='#d9d2bb';x.beginPath();x.arc(gxp,gyp,12,0,TAU);x.fill();
      x.strokeStyle='#2a2a24';x.lineWidth=1;for(let k=0;k<9;k++){const a=Math.PI*.8+k/8*Math.PI*1.4;x.beginPath();x.moveTo(gxp+Math.cos(a)*8,gyp+Math.sin(a)*8);x.lineTo(gxp+Math.cos(a)*11,gyp+Math.sin(a)*11);x.stroke();}
      x.strokeStyle='#a3241a';x.lineWidth=2;x.beginPath();x.moveTo(gxp,gyp);x.lineTo(gxp+Math.cos(gxp)*9,gyp-Math.abs(Math.sin(gxp))*9);x.stroke();}
    x.fillStyle='#0c140d';x.fillRect(84,12,36,28);gx.fillStyle='#2f9a48';gx.fillRect(84,12,36,28);gx.fillStyle='#7cf08f';for(let k=0;k<5;k++)gx.fillRect(87,16+k*5,6+Math.floor(random(k*3.3)*24),2);
    for(let k=0;k<6;k++){const lx=12+k*19;x.fillStyle='#151612';x.beginPath();x.arc(lx,60,5,0,TAU);x.fill();gx.fillStyle=k===4?'#ff4a2a':k===5?'#ffb030':'#5cff7a';gx.beginPath();gx.arc(lx,60,3.5,0,TAU);gx.fill();x.fillStyle=gx.fillStyle;x.beginPath();x.arc(lx,60,3.5,0,TAU);x.fill();}
    for(let k=0;k<8;k++){x.fillStyle=k%3?'#2a2b25':'#8a2a1c';x.fillRect(10+k*14,76,9,9);x.fillStyle='rgba(200,196,180,.35)';x.fillRect(10+k*14,76,9,1);}
    tx.console=this.texture(c,{smooth:true});tx.consoleGlow=this.texture(glowC,{smooth:true});
    // Earth strata for the cutaway, topsoil at the top: layers with wavy contacts, grain in every layer, stones.
    // Smooth filtering: one pixel is about a third of a metre, nearest filtering would show it.
    c=makeCanvas(512,2048);x=c.getContext('2d',{willReadFrequently:true});
    const bands=[[0,'#3a2f24'],[24,'#574735'],[68,'#6a5843'],[160,'#5d5242'],[300,'#746757'],[480,'#585046'],[700,'#4b463f'],[960,'#555049'],[1240,'#423e39'],[1560,'#38352f'],[1800,'#2e2c28'],[2048,'#2e2c28']].map(([y,hex])=>[y,[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16))]);
    {const tone=noiseField(512,2048,67,[[128,.45],[32,.3],[8,.25],[3,.2]]),wave=noiseField(512,64,71,[[128,.7],[32,.3]]),img=x.createImageData(512,2048),d=img.data;
      for(let py=0;py<2048;py++)for(let px=0;px<512;px++){const i=py*512+px,yy=py+Math.sin(px/512*TAU*2+py*.01)*6+wave[px]*14;let b=0;while(b<bands.length-2&&yy>=bands[b+1][0])b++;
        const edge=b?1-.4*smooth(4,0,Math.abs(yy-bands[b][0])):1,k=(1+tone[i]*.3)*edge,q=i*4;d[q]=bands[b][1][0]*k;d[q+1]=bands[b][1][1]*k;d[q+2]=bands[b][1][2]*k;d[q+3]=255;}
      x.putImageData(img,0,0);}
    for(let n=0;n<900;n++){const rx=random(n*3.7)*512,ry=60+random(n*5.1)*1980,s=.7+Math.pow(random(n*2.3),3)*3.2;x.fillStyle=random(n*1.1)>.5?'rgba(133,123,107,.6)':'rgba(41,37,31,.5)';x.beginPath();x.ellipse(rx,ry,s*1.5,s,random(n*4.4)-.5,0,TAU);x.fill();}
    tx.earth=this.texture(c,{smooth:true});tx.earth.wrapS=T.RepeatWrapping;
    // Surface dust, and the facades of the dead city: floors of empty windows, some blown out.
    tx.dust=this.surface(dustSurface(256,256,113),[1,1],2.5);
    c=makeCanvas(128,256);x=c.getContext('2d');x.fillStyle='#77756c';x.fillRect(0,0,128,256);speckle(x,128,256,121,['#5e5c55','#8c8a80','#4a4843'],.35);
    for(let row=0;row<32;row++)for(let col=0;col<8;col++){const k=row*8+col,gone=random(k*1.9)>.88;x.fillStyle=gone?'#2e2d29':random(k*3.3)>.25?'#1d1e1b':'#3a3934';x.fillRect(col*16+4,row*8+2,gone?12:8,gone?7:4);}
    for(let n=0;n<10;n++){const g=x.createLinearGradient(0,0,0,256),sx=random(n*7.7)*128;g.addColorStop(0,'rgba(30,28,24,0)');g.addColorStop(1,'rgba(30,28,24,.35)');x.fillStyle=g;x.fillRect(sx,random(n*2.9)*128,3+random(n)*6,256);}
    tx.facade=this.texture(c,{wrap:true,smooth:true});
    return tx;
  }
  signTexture(text,options={}){const {w=256,h=64}=options,c=makeCanvas(w,h);paintSign(c.getContext('2d'),text,0,0,w,h,options);return this.texture(c);}

  // ---------- world ----------
  build(){
    const tx=this.tx=this.makeTextures();
    const slab=this.standard({color:'#c6c4b8',...tx.floor,shadowSide:T.DoubleSide});
    const wall=this.standard({color:'#aaa99f',...tx.wall,side:T.BackSide});
    const pillarMat=this.standard({color:'#c9c7bb',...tx.pillar});
    const hazardMat=this.standard({color:'#ffffff',map:tx.hazard,roughness:.8});
    // Railings are thin dark painted steel, as in the show.
    const railing=this.standard({color:'#3b3f3a',metalness:.6,roughness:.42});
    const rust=this.standard({color:'#8f4a24',metalness:.45,roughness:.62});
    const steel=this.standard({color:'#6f7466',metalness:.6,roughness:.55});
    const darkMetal=this.standard({color:'#2f362c',metalness:.4,roughness:.7});
    const lampGlass=this.basic({color:hdr('#ffcf86',5)});
    const screenMat=this.basic({map:tx.screen,color:hdr('#ffffff',2.2)});
    const growMat=this.basic({color:hdr('#fff1cf',3)});
    const parapet=this.standard({color:'#c6c4b8',...tx.parapet,...STENCIL_MARK});
    const m=this.mats={slab,parapet,wall,pillarMat,hazardMat,railing,rust,steel,darkMetal,lampGlass,screenMat,growMat};

    // Light: dim cavern fill, a warm shaft from the surface, and lamp pools near the camera.
    // The number of lights never changes, only their intensity, so shaders are compiled once.
    this.scene.add(new T.HemisphereLight('#e8d2a2','#1a2219',1.15));this.scene.add(new T.AmbientLight('#7b8667',.42));
    this.key=new T.DirectionalLight('#ffd9a0',1.6);this.key.castShadow=true;this.key.shadow.mapSize.set(2048,2048);
    Object.assign(this.key.shadow.camera,{left:-40,right:40,top:40,bottom:-40,near:.5,far:120});this.key.shadow.bias=-.0004;this.key.shadow.normalBias=.08;this.scene.add(this.key,this.key.target);
    this.sun=new T.DirectionalLight('#f3dcb2',0);this.sun.position.set(420,300,-640);this.scene.add(this.sun);
    this.lampLights=[];for(let i=0;i<8;i++){const light=new T.PointLight('#ffb466',38,24,1.6);this.scene.add(light);this.lampLights.push(light);}
    this.stairLights=[];for(let i=0;i<3;i++){const light=new T.PointLight('#ffc27a',26,16,1.7);this.scene.add(light);this.stairLights.push(light);}

    const ringGeometry=this.geometry(new T.RingGeometry(INNER_RADIUS,WALL_RADIUS,128,1));ringGeometry.rotateX(-Math.PI/2);
    // Slab joints run around the ring and across it, not on a square grid: 28 floor tiles round, one across.
    {const uv=ringGeometry.attributes.uv;for(let i=0;i<uv.count;i++)uv.setXY(i,(i%129)/128*2.8,Math.floor(i/129)*.1);}
    // The underside of each slab is its own ring of plain cast concrete, one 7 m panel per tile, facing down.
    const ceilingGeometry=new T.RingGeometry(INNER_RADIUS,WALL_RADIUS,128,1).rotateX(Math.PI/2);
    {const uv=ceilingGeometry.attributes.uv;for(let i=0;i<uv.count;i++)uv.setXY(i,(i%129)/128*28,Math.floor(i/129));}
    this.bank('ceilings',ceilingGeometry,this.standard({color:'#a9a79b',...this.resurface(tx.shell,[1,1])}));
    const torus=(radius,tube,seg=128)=>{const g=new T.TorusGeometry(radius,tube,6,seg);g.rotateX(Math.PI/2);return g;};
    // Galleries: a concrete parapet with a steel handrail on its inner face, open where the stair bridge comes in.
    this.bank('galleryWalls',helixBox([[.0074,.9926]],INNER_RADIUS-.2,INNER_RADIUS+.06,-.62,.98,160,0),parapet,{cast:true,receive:true,occlude:true,order:1,seeThrough:true});
    this.bank('railTop',helixBox([[.0074,.9926]],INNER_RADIUS+.1,INNER_RADIUS+.16,.81,.87,160,0),railing,{detail:true});
    
    this.bank('pipeA',torus(33.2,.16),rust);this.bank('pipeB',torus(33.25,.1),steel,{detail:true});this.bank('pipeC',torus(33.2,.13),rust);
    this.bank('pillars',new T.BoxGeometry(.8,6,.8),pillarMat,{cast:true,receive:true,occlude:true});
    this.bank('pillarBands',new T.BoxGeometry(.86,.5,.86),hazardMat);
    // Lamps wrap the pillars: a ribbed glass collar between two steel rings.
    this.bank('lamps',new T.CylinderGeometry(.62,.62,.62,24,1,true),this.basic({map:tx.ribs,color:hdr('#ffd6a0',3.4)}));this.bank('lampCages',new T.CylinderGeometry(.68,.68,.08,24,1),darkMetal,{detail:true});
    this.bank('crates',new T.BoxGeometry(.85,.85,.85),this.standard({...tx.crate}),{cast:true,receive:true,detail:true});
    this.bank('barrels',new T.CylinderGeometry(.36,.36,1.05,14),this.standard({...tx.barrel,metalness:.4,roughness:.6}),{cast:true,detail:true});
    this.bank('planters',new T.BoxGeometry(2.6,.55,.8),this.standard({...this.resurface(tx.desk,[2,1]),color:'#d4d0c0',metalness:.25,roughness:.75}),{receive:true,detail:true});this.bank('foliage',new T.BoxGeometry(2.4,.5,.68),this.standard({map:tx.plants,color:'#d0e0b8',roughness:.8}),{detail:true});
    this.bank('growLights',new T.BoxGeometry(2.2,.08,.18),growMat);this.bank('growHangers',new T.CylinderGeometry(.015,.015,3.62,4),darkMetal,{detail:true});
    this.bank('desks',new T.BoxGeometry(1.5,.8,.7),this.standard({...tx.desk,metalness:.4,roughness:.6}),{cast:true,receive:true,detail:true});this.bank('monitors',new T.BoxGeometry(.62,.5,.5),this.standard({...tx.monitor,roughness:.7}),{detail:true});
    this.bank('screens',new T.PlaneGeometry(.5,.38),screenMat,{detail:true});
    this.bank('machines',new T.BoxGeometry(1.7,1,.8),this.standard({...tx.machine,metalness:.4,roughness:.6}),{cast:true,detail:true});
    this.bank('pots',new T.CylinderGeometry(.28,.22,.45,16),this.standard({map:tx.pot,roughness:.85}),{detail:true});this.bank('shrubs',shrubGeometry(),this.standard({map:tx.plants,color:'#c8dcb0',roughness:.8}),{detail:true});
    this.glowBank('lampGlow','#ffbf6e',3.2,.85);this.glowBank('screenGlow','#5fe07c',1.4,.55);this.glowBank('growGlow','#fff0c4',2.2,.5);this.glowBank('coreGlow','#ffc277',2.2,.8);

    const roomGeometry=new T.PlaneGeometry(11.8,5.3);
    // The rooms get a plain stand-in picture from the start, so their shader is made once, in the background, with
    // everything else. Swapping in the artwork later is then only a new picture, not a new shader.
    const roomBlank=makeCanvas(4,4),rb=roomBlank.getContext('2d');rb.fillStyle='#ffffff';rb.fillRect(0,0,4,4);const roomStandIn=this.texture(roomBlank);
    this.roomMaterials=[];for(let i=0;i<12;i++){const mat=this.basic({color:'#2a2a22',side:T.FrontSide,map:roomStandIn});this.roomMaterials.push(mat);this.bank('room'+i,i?roomGeometry.clone():roomGeometry,mat,{occlude:true});}

    for(let level=1;level<=LEVELS;level++){
      const y=physicalFloorY(level),sector=sectorForLevel(level),chunk=this.chunks[chunkOf(level)];
      const floor=this.mesh(ringGeometry,slab,chunk);floor.position.y=y+FLOOR_TOP;floor.receiveShadow=true;floor.castShadow=true;floor.userData.level=level;this.occluders.push(floor);this.floorMeshes.push(floor);
      this.put('galleryWalls',level,0,y,0);this.put('railTop',level,0,y,0);this.put('ceilings',level,0,y+FLOOR_TOP-.03,0);
      this.put('pipeA',level,0,y+5.15,0);this.put('pipeB',level,0,y+5.48,0);this.put('pipeC',level,0,y+4.82,0);
      const pool=ROOM_POOLS[sector],used=new Set([8,9]);
      for(let bay=0;bay<BAYS;bay++){
        const theta=bay/BAYS*TAU,px=Math.sin(theta),pz=Math.cos(theta);
        this.put('pillars',level,px*PILLAR_RADIUS,y+3,pz*PILLAR_RADIUS,theta);
        this.put('pillarBands',level,px*PILLAR_RADIUS,y+.28,pz*PILLAR_RADIUS,theta);
        for(const dy of [-.35,.35])this.put('lampCages',level,px*PILLAR_RADIUS,y+3.05+dy,pz*PILLAR_RADIUS,theta);this.put('lamps',level,px*PILLAR_RADIUS,y+3.05,pz*PILLAR_RADIUS,theta);
        this.glow('lampGlow',level,px*(LAMP_RADIUS-.85),y+3.05,pz*(LAMP_RADIUS-.85));
        const type=level===SECTORS[sector].home?sector:pool[(level*7+bay*3)%pool.length],variant=(level*5+bay)%2,a=theta+TAU/(BAYS*2);
        this.put('room'+(type*2+variant),level,Math.sin(a)*34.2,y+2.68,Math.cos(a)*34.2,a+Math.PI);
      }
      // Furniture: placed in the middle of bays, clear of pillars and the stair landing.
      const pick=k=>{let bay=Math.floor(random(level*13.1+k*7.7)*BAYS);while(used.has(bay))bay=(bay+5)%BAYS;used.add(bay);return (bay+.5)/BAYS*TAU+(random(level+k*3.3)-.5)*.16;};
      const place=(name,k,height,radius=PROP_RADIUS,s=[1,1,1])=>{const a=pick(k);this.put(name,level,Math.sin(a)*radius,y+FLOOR_TOP+height,Math.cos(a)*radius,a+(random(level*k)-.5)*.5,...s);return a;};
      for(let k=0;k<2;k++){const a=place('crates',k,.43);if(random(level*3+k)>.5)this.put('crates',level,Math.sin(a+.012)*PROP_RADIUS,y+FLOOR_TOP+1.28,Math.cos(a+.012)*PROP_RADIUS,a+.4,.8,.8,.8);}
      place('barrels',3,.53);if(sector===5||sector===3)place('barrels',4,.53);
      if(sector===4)for(let k=0;k<5;k++){const a=pick(10+k),r=32.3,ry=a;this.put('planters',level,Math.sin(a)*r,y+.3,Math.cos(a)*r,ry);this.put('foliage',level,Math.sin(a)*r,y+.8,Math.cos(a)*r,ry);this.put('growLights',level,Math.sin(a)*r,y+2.3,Math.cos(a)*r,ry);for(const t of [-.95,.95])this.put('growHangers',level,Math.sin(a)*r+Math.cos(a)*t,y+4.15,Math.cos(a)*r-Math.sin(a)*t);this.glow('growGlow',level,Math.sin(a)*r,y+2.2,Math.cos(a)*r);}
      if(sector<=1)for(let k=0;k<4;k++){const a=pick(20+k),r=32.7;this.put('desks',level,Math.sin(a)*r,y+.42,Math.cos(a)*r,a);this.put('monitors',level,Math.sin(a)*r,y+1.08,Math.cos(a)*r,a);const sr=r-.26;this.put('screens',level,Math.sin(a)*sr,y+1.1,Math.cos(a)*sr,a+Math.PI);this.glow('screenGlow',level,Math.sin(a)*(sr-.15),y+1.1,Math.cos(a)*(sr-.15));}
      if(sector===3||sector===5)for(let k=0;k<2;k++)place('machines',30+k,.52,32.6);
      if(sector===2)for(let k=0;k<3;k++){const a=pick(40+k);this.put('pots',level,Math.sin(a)*32.9,y+.25,Math.cos(a)*32.9);this.put('shrubs',level,Math.sin(a)*32.9,y+.78,Math.cos(a)*32.9,a);}
    }
    // Every level carries its number at the stair landing, as in a real stairwell. All 144 numbers share one picture
    // and each chunk's plaques are one mesh.
    {
      const cols=12,rows=Math.ceil(LEVELS/cols),cw=128,ch=40,atlas=makeCanvas(cols*cw,rows*ch),ax=atlas.getContext('2d');
      for(let level=1;level<=LEVELS;level++)paintSign(ax,String(level).padStart(3,'0'),((level-1)%cols)*cw,Math.floor((level-1)/cols)*ch,cw,ch,{color:'#f0d79a',size:22,line:2});
      const material=this.basic({map:this.texture(atlas,{smooth:true}),toneMapped:false}),z=-PILLAR_RADIUS+.42;
      this.chunks.forEach((chunk,i)=>{
        const {first,last}=chunk.userData,pos=[],uv=[],index=[];
        for(let level=first;level<=last;level++){
          const y=physicalFloorY(level)+4.15,c=(level-1)%cols,r=Math.floor((level-1)/cols),u0=c/cols,u1=(c+1)/cols,v1=1-r/rows,v0=1-(r+1)/rows,k=pos.length/3;
          pos.push(-1.3,y-.41,z,1.3,y-.41,z,1.3,y+.41,z,-1.3,y+.41,z);uv.push(u0,v0,u1,v0,u1,v1,u0,v1);index.push(k,k+1,k+2,k,k+2,k+3);
        }
        const g=this.geometry(new T.BufferGeometry());g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setIndex(index);g.computeBoundingSphere();
        this.mesh(g,material,chunk);
      });
    }

    const terminals=[['settings','CONTROL'],['connections','IT / UPLINK'],['agents','RESIDENTS'],['workflows','SEQUENCES'],['activity','OPERATIONS'],['files','ARCHIVE']];
    [...terminals.map(([view,text],sector)=>[view,text,SECTORS[sector].home,Math.PI+.36]),['security','SECURITY',1,Math.PI-.36]].forEach(([view,text,level,theta])=>{
      const chunk=this.chunks[chunkOf(level)];
      const sign=this.mesh(this.geometry(new T.PlaneGeometry(4.6,1.15)),this.basic({map:this.signTexture(text,{color:'#ffd998',bg:'#1b2a1e',border:'#d1a560'}),toneMapped:false}),chunk);
      sign.position.set(Math.sin(theta)*33.0,physicalFloorY(level)+3.9,Math.cos(theta)*33.0);sign.rotation.y=theta+Math.PI;sign.userData.view=view;this.terminalSigns.push(sign);
      this.glow('lampGlow',level,Math.sin(theta)*32.6,physicalFloorY(level)+3.9,Math.cos(theta)*32.6);
    });

    // The cafeteria screen: a live picture from the sensor on the surface.
    {
      const a=Math.PI-.1745,r=33.72,y=physicalFloorY(1)+2.72,chunk=this.chunks[0];
      this.wallCanvas=makeCanvas(192,108);this.wallCtx=this.wallCanvas.getContext('2d');this.wallCtx.fillStyle='#0b0d09';this.wallCtx.fillRect(0,0,192,108);
      this.wallTexture=this.texture(this.wallCanvas,{smooth:true});
      const frame=this.mesh(this.geometry(new T.BoxGeometry(7.1,4.1,.3)),m.darkMetal,chunk);frame.position.set(Math.sin(a)*(r+.18),y,Math.cos(a)*(r+.18));frame.rotation.y=a+Math.PI;
      const screen=this.mesh(this.geometry(new T.PlaneGeometry(6.6,3.7)),this.basic({map:this.wallTexture,color:hdr('#ffffff',1.25),toneMapped:false}),chunk);
      screen.position.set(Math.sin(a)*r,y,Math.cos(a)*r);screen.rotation.y=a+Math.PI;
      this.glow('lampGlow',1,Math.sin(a)*(r-.6),y-2.2,Math.cos(a)*(r-.6));
    }

    // Central core with lamp strips at every landing.
    const coreMaterial=this.standard({color:'#cfcdc1',...this.tx.core});
    const core=this.mesh(this.geometry(new T.CylinderGeometry(2.4,2.4,DEPTH+12,32)),coreMaterial);core.position.y=-DEPTH/2+3;core.castShadow=true;core.receiveShadow=true;this.occluders.push(core);
    this.bank('coreLamps',new T.BoxGeometry(.16,.55,.16),lampGlass);
    for(let level=1;level<=LEVELS;level++)for(let k=0;k<4;k++){const a=k/4*TAU+.4,y=physicalFloorY(level)+2.6;this.put('coreLamps',level,Math.sin(a)*2.45,y,Math.cos(a)*2.45,a);this.glow('coreGlow',level,Math.sin(a)*2.75,y,Math.cos(a)*2.75);}

    // The spiral stair: solid wedge treads, a concrete parapet on the outside, thin steel rails on the inside.
    // It is lit by the stair lights that follow the camera, not by glow sprites, which would float off the treads.
    const half=TAU/STEPS_PER_LEVEL/2,shape=new T.Shape();
    shape.moveTo(STAIR_INNER*Math.cos(-half),STAIR_INNER*Math.sin(-half));shape.lineTo(STAIR_OUTER*Math.cos(-half),STAIR_OUTER*Math.sin(-half));
    shape.absarc(0,0,STAIR_OUTER,-half,half,false);shape.lineTo(STAIR_INNER*Math.cos(half),STAIR_INNER*Math.sin(half));shape.absarc(0,0,STAIR_INNER,half,-half,true);shape.closePath();
    const wedge=new T.ExtrudeGeometry(shape,{depth:.2,bevelEnabled:false,curveSegments:2,steps:1});wedge.rotateX(-Math.PI/2);
    // Tread UVs are in metres, so the stair gets the slab concrete at a scale of its own.
    this.bank('steps',wedge,this.standard({color:'#c6c4b8',...this.resurface(this.tx.floor,[.35,.35])}),{cast:true,receive:true,occlude:true});this.bank('stairPosts',new T.BoxGeometry(.05,1.03,.05),railing,{detail:true});
    const totalSteps=(LEVELS-1)*STEPS_PER_LEVEL;
    for(let i=0;i<totalSteps;i++){
      const level=Math.floor(i/STEPS_PER_LEVEL)+1,theta=Math.PI+i/STEPS_PER_LEVEL*TAU,y=-i/STEPS_PER_LEVEL*FLOOR_HEIGHT;
      this.put('steps',level,0,y-.2+FLOOR_TOP,0,theta-Math.PI/2);
      if(i%3===0)this.put('stairPosts',level,Math.sin(theta)*STAIR_INNER,y+.51,Math.cos(theta)*STAIR_INNER);
    }
    class Helix extends T.Curve{constructor(radius,height,from,to){super();Object.assign(this,{radius,height,from,to});}getPoint(t,target=new T.Vector3()){const u=this.from+(this.to-this.from)*t,theta=Math.PI+u*TAU;return target.set(Math.sin(theta)*this.radius,-u*FLOOR_HEIGHT+this.height,Math.cos(theta)*this.radius);}}
    this.chunks.forEach((chunk,i)=>{const from=i*CHUNK,to=Math.min(LEVELS-1,(i+1)*CHUNK);if(to<=from)return;for(const h of [.5,1.06]){const tube=this.mesh(this.geometry(new T.TubeGeometry(new Helix(STAIR_INNER,h,from,to),(to-from)*40,h>1?.045:.03,5,false)),railing,chunk);tube.castShadow=false;}
      // The parapet opens where each gallery bridge meets the stair.
      const runs=[];for(let u=from;u<to;u++)runs.push([u+.0273,u+1-.0273]);
      const wall=this.mesh(this.geometry(helixBox(runs,STAIR_OUTER-.22,STAIR_OUTER+.06,-.8,1.02,64)),parapet,chunk);wall.castShadow=wall.receiveShadow=true;wall.renderOrder=1;wall.userData.seeThrough=true;this.occluders.push(wall);
      this.mesh(this.geometry(helixBox(runs,STAIR_OUTER-.31,STAIR_OUTER-.25,.84,.9,64)),railing,chunk);});

    // Landings: a concrete bridge from the stair to each gallery, walled on both sides like the stair, with a steel
    // handrail along the inside of each wall. The walls meet the openings in the stair and gallery parapets.
    // The deck is paved on top only; its edges and underside are cast concrete (box faces: +x, -x, top, bottom, +z, -z).
    // UVs are in metres: a floor slab every 2.8 m on top, 7 m formwork panels on the edges, so the thin end faces are
    // not one panel squeezed into 30 cm. The deck runs 15 cm under the gallery floor so no sliver opens at the joint.
    const deckTop=this.standard({color:'#c6c4b8',...this.resurface(this.tx.floor,[1/2.8,1/2.9])}),deckUnder=this.standard({color:'#a9a79b',...this.resurface(this.tx.shell,[1/7,1/7])});
    this.bank('bridges',boxMetres(2.8,.3,20.6,1),[deckUnder,deckUnder,deckTop,deckUnder,deckUnder,deckUnder],{cast:true,receive:true,occlude:true});
    this.bank('bridgeWalls',new T.BoxGeometry(.22,1.62,20.38),this.standard({color:'#c6c4b8',...this.resurface(this.tx.parapet,[5,1]),...STENCIL_MARK}),{cast:true,receive:true,occlude:true,order:1,seeThrough:true});
    this.bank('bridgeRails',new T.BoxGeometry(.05,.05,20.38),railing,{detail:true});
    for(let level=1;level<=LEVELS;level++){const y=physicalFloorY(level);this.put('bridges',level,0,y-.13,-17.825);for(const side of [-1,1]){this.put('bridgeWalls',level,side*1.3,y+.19,-17.75);this.put('bridgeRails',level,side*1.14,y+.84,-17.75);}}
    this.flush();

    // Outer wall, risers, roof with a skylight.
    const wallMesh=this.mesh(this.geometry(new T.CylinderGeometry(WALL_RADIUS,WALL_RADIUS,DEPTH+12,BAYS*4,1,true)),wall);wallMesh.position.y=-DEPTH/2+3;wallMesh.receiveShadow=true;
    for(let n=0;n<8;n++){const a=(n+.5)/8*TAU+.05,riser=this.mesh(this.geometry(new T.CylinderGeometry(.2,.2,DEPTH+12,8)),rust);riser.position.set(Math.sin(a)*34.3,-DEPTH/2+3,Math.cos(a)*34.3);}
    const roofGeometry=this.geometry(new T.RingGeometry(WELL_RADIUS,WALL_RADIUS,96,1));{const uv=roofGeometry.attributes.uv;for(let i=0;i<uv.count;i++)uv.setXY(i,(i%97)/96*24,Math.floor(i/97)*3.3);}
    const roof=this.mesh(roofGeometry,this.standard({color:'#a9a79b',...this.resurface(this.tx.shell,[1,1]),side:T.DoubleSide}));roof.rotation.x=Math.PI/2;roof.position.y=ROOF_Y;
    const sky=this.mesh(this.geometry(new T.CircleGeometry(WELL_RADIUS,64)),this.basic({map:this.tx.sky,color:hdr('#ffffff',2.4),fog:false}));sky.rotation.x=Math.PI/2;sky.position.y=ROOF_Y-.05;
    // Light shafts from the skylight. Only the inside of the far half is drawn, so a shaft never paints over the stair,
    // the core or anything else between it and the camera; it leaves an opening where the bridges cross it, and the
    // streaks drift in the texture so the opening stays over the bridges.
    this.rays=[];for(const [top,bottom,len,speed,op] of [[10.5,15,54,.012,.16],[8,11.5,70,-.008,.1]]){const g=this.geometry(new T.CylinderGeometry(top,bottom,len,48,1,true,Math.PI+.22,TAU-.44));g.translate(0,-len/2,0);const map=this.tx.rays.clone();this.ownedTextures.push(map);const mat=this.basic({map,color:'#ffd49a',transparent:true,opacity:op,blending:T.AdditiveBlending,depthWrite:false,side:T.BackSide,fog:false,toneMapped:false});const ray=this.mesh(g,mat);ray.position.y=ROOF_Y-.1;ray.renderOrder=3;ray.userData.speed=speed;this.rays.push(ray);}

    this.buildBottom(m);
    this.buildOutside(m);

    // Floating dust caught in the lamp light.
    const dustCount=900,dust=new Float32Array(dustCount*3);this.dustSeed=new Float32Array(dustCount);
    for(let i=0;i<dustCount;i++){const a=random(i*2.1)*TAU,r=3+Math.sqrt(random(i*3.7))*24;dust[i*3]=Math.sin(a)*r;dust[i*3+1]=-random(i*5.3)*48;dust[i*3+2]=Math.cos(a)*r;this.dustSeed[i]=random(i*9.1)*TAU;}
    const dustGeometry=this.geometry(new T.BufferGeometry());dustGeometry.setAttribute('position',new T.BufferAttribute(dust,3));
    const dustMaterial=new T.PointsMaterial({map:this.glowMap,color:'#ffe0aa',size:.16,transparent:true,opacity:.55,depthWrite:false,blending:T.AdditiveBlending,fog:false,toneMapped:false});this.materials.push(dustMaterial);
    this.dust=new T.Points(dustGeometry,dustMaterial);this.dust.frustumCulled=false;this.scene.add(this.dust);

    // Shared helpers for residents.
    // Contact shadows are soft: dark in the middle, fading out to the rim.
    const blob=makeCanvas(64,64),bl=blob.getContext('2d'),bg=bl.createRadialGradient(32,32,0,32,32,32);bg.addColorStop(0,'rgba(255,255,255,1)');bg.addColorStop(.5,'rgba(255,255,255,.75)');bg.addColorStop(1,'rgba(255,255,255,0)');bl.fillStyle=bg;bl.fillRect(0,0,64,64);
    this.shadows=new T.InstancedMesh(this.geometry(new T.PlaneGeometry(1,1).rotateX(-Math.PI/2)),this.basic({map:this.texture(blob,{smooth:true}),color:'#030604',transparent:true,opacity:.85,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2}),MAX_PEOPLE);
    this.shadows.count=0;this.shadows.frustumCulled=false;this.shadows.instanceMatrix.setUsage(T.DynamicDrawUsage);this.scene.add(this.shadows);
    const ring=this.geometry(new T.RingGeometry(.5,.58,28).rotateX(-Math.PI/2));
    this.selectMarker=this.mesh(ring,this.basic({color:hdr('#f2c46f',1.6),transparent:true,opacity:.95,depthWrite:false,side:T.DoubleSide}));this.selectMarker.visible=false;
    this.hoverMarker=this.mesh(ring,this.basic({color:'#cfd8a8',transparent:true,opacity:.7,depthWrite:false,toneMapped:false,side:T.DoubleSide}));this.hoverMarker.visible=false;
    this.selectLabel=new T.Sprite(new T.SpriteMaterial({depthTest:false,toneMapped:false,fog:false,sizeAttenuation:false}));this.selectLabel.scale.set(.15,.0375,1);this.selectLabel.visible=false;this.selectLabel.renderOrder=5;this.scene.add(this.selectLabel);this.materials.push(this.selectLabel.material);
    this.hoverLabel=new T.Sprite(new T.SpriteMaterial({depthTest:false,toneMapped:false,fog:false,sizeAttenuation:false}));this.hoverLabel.scale.set(.15,.0375,1);this.hoverLabel.visible=false;this.hoverLabel.renderOrder=5;this.scene.add(this.hoverLabel);this.materials.push(this.hoverLabel.material);
    const bubble=makeCanvas(24,16),b=bubble.getContext('2d');b.fillStyle='#10160f';b.fillRect(1,0,22,12);b.fillRect(0,1,24,10);b.fillRect(4,12,4,3);b.fillStyle='#e9dfbf';b.fillRect(2,1,20,10);b.fillRect(1,2,22,8);b.fillRect(5,11,2,2);b.fillStyle='#3e5a35';for(const k of [6,11,16])b.fillRect(k,5,2,2);
    this.bubbleMaterial=new T.SpriteMaterial({map:this.texture(bubble),toneMapped:false,depthWrite:false});this.materials.push(this.bubbleMaterial);
    // One pixel icon per thing a resident can really be doing. The server reads it from the work in progress.
    const iconCanvas=(fill,ink,glyph)=>{const c=makeCanvas(24,16),g=c.getContext('2d');g.fillStyle='#10160f';g.fillRect(1,0,22,12);g.fillRect(0,1,24,10);g.fillRect(4,12,4,3);g.fillStyle=fill;g.fillRect(2,1,20,10);g.fillRect(1,2,22,8);g.fillRect(5,11,2,2);g.fillStyle=ink;glyph.forEach((row,y)=>[...row].forEach((ch,x)=>{if(ch==='#')g.fillRect(7+x,2+y,1,1);}));return c;};
    this.icons={thinking:this.bubbleMaterial};
    for(const [key,fill,ink,glyph] of ICONS){const m=new T.SpriteMaterial({map:this.texture(iconCanvas(fill,ink,glyph)),toneMapped:false,depthWrite:false});this.materials.push(m);this.icons[key]=m;}
    this.activity={};this.trail=null;
    // Connected residents (a real model behind them) stand on a green ring. Demo residents are drawn paler.
    this.liveTint=new T.Color(1.25,1.2,1.1);this.demoTint=new T.Color(.82,.88,.86);this.throughTint=new T.Color(.78,.84,.92);
    this.liveRings=new T.InstancedMesh(this.geometry(new T.RingGeometry(.4,.48,24).rotateX(-Math.PI/2)),this.basic({color:hdr('#6fe08a',1.3),transparent:true,opacity:.8,depthWrite:false,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:-3}),MAX_PEOPLE);
    this.liveRings.count=0;this.liveRings.frustumCulled=false;this.liveRings.instanceMatrix.setUsage(T.DynamicDrawUsage);this.scene.add(this.liveRings);
    const folder=makeCanvas(20,14),fc=folder.getContext('2d');fc.fillStyle='#2a1d0e';fc.fillRect(0,2,20,12);fc.fillRect(1,0,8,3);fc.fillStyle='#d9a75a';fc.fillRect(1,3,18,10);fc.fillRect(2,1,6,2);fc.fillStyle='#f0c77c';fc.fillRect(1,3,18,2);fc.fillStyle='#7a2c1c';fc.fillRect(12,7,5,4);fc.fillStyle='#b4823d';fc.fillRect(3,8,7,1);fc.fillRect(3,10,6,1);
    this.folderMaterial=new T.SpriteMaterial({map:this.texture(folder),toneMapped:false,depthWrite:false,color:new T.Color(1.3,1.25,1.15)});this.materials.push(this.folderMaterial);

    this.buildRoomTextures();
  }

  // The bottom of the silo: the generator hall. A tall riveted drum on a ribbed skirt over an octagonal base with a
  // vault door, a grating walkway with red rails out to it, and rusted pipe loops on both sides, as in the series.
  buildBottom(m){
    const y0=BOTTOM_Y+FLOOR_TOP,group=new T.Group();this.scene.add(group);this.bottomGroup=group;const tx=this.tx;
    const floor=this.mesh(this.geometry(new T.CircleGeometry(INNER_RADIUS,96)),this.standard({...this.resurface(tx.floor,[6,6]),color:'#a29e92'}),group);
    floor.rotation.x=-Math.PI/2;floor.position.y=y0-.006;floor.receiveShadow=true;floor.userData.level=LEVELS;this.floorMeshes.push(floor);this.occluders.push(floor);
    const paint=this.standard({color:'#d6a92f',roughness:.7});
    const line=this.mesh(this.geometry(new T.RingGeometry(24.6,24.95,96)),paint,group);line.rotation.x=-Math.PI/2;line.position.y=y0+.012;
    const drum=this.standard({...tx.drum,color:'#bdb6aa',metalness:.5,roughness:.62});
    const plinth=this.standard({...this.resurface(tx.drum,[4,1]),color:'#a29b90',metalness:.45,roughness:.66});
    const hull=this.standard({...tx.hull,color:'#a29b90',metalness:.45,roughness:.66});
    const red=this.standard({color:'#b4482c',metalness:.35,roughness:.55});
    const pipeMat=this.standard({...tx.pipe,color:'#e2d8cc',metalness:.4,roughness:.7});
    const grate=(repeat)=>this.standard({...this.resurface(tx.grate,repeat),color:'#a8a69c',metalness:.55,roughness:.55});
    // Instanced parts are placed with a scratch object: position, yaw, pitch (yaw first), scale.
    const dummy=new T.Object3D(),at=(x,y,z,ry=0,rx=0,sx=1,sy=sx,sz=sx)=>{dummy.position.set(x,y,z);dummy.rotation.set(rx,ry,0,'YXZ');dummy.scale.set(sx,sy,sz);dummy.updateMatrix();return dummy.matrix.clone();};
    const inst=(geometry,mat,list,parent=group,cast=true)=>{const im=new T.InstancedMesh(this.geometry(geometry),mat,list.length);list.forEach((mx,i)=>im.setMatrixAt(i,mx));im.computeBoundingSphere();im.castShadow=cast;im.receiveShadow=true;parent.add(im);return im;};
    const part=(geometry,mat,x,y,z,parent,cast=true)=>{const p=this.mesh(this.geometry(geometry),mat,parent);p.position.set(x,y,z);p.castShadow=cast;p.receiveShadow=true;return p;};
    const rail=(list,x0,z0,x1,z1,h,size=.07)=>{const len=Math.hypot(x1-x0,z1-z0);list.push(at((x0+x1)/2,h,(z0+z1)/2,Math.atan2(x1-x0,z1-z0),0,size,size,len));};
    const posts=[],rails=[];

    // The generator stands off the stair on the side away from the bridges; its door faces +x.
    const GZ=16,gen=new T.Group();gen.position.set(0,y0,GZ);group.add(gen);
    const deck=part(new T.CylinderGeometry(6.2,6.2,.35,8),grate([25,25]),0,.175,0,gen);deck.rotation.y=Math.PI/8;this.occluders.push(deck);
    const base=part(new T.CylinderGeometry(3.8,3.9,3.8,8),plinth,0,2.25,0,gen);base.rotation.y=Math.PI/8;this.occluders.push(base);
    // Platform rail on seven sides of the octagon; the side facing the walkway stays open.
    for(let k=0;k<8;k++){const a=Math.PI/8+k*Math.PI/4,b=a+Math.PI/4;if(k===1)continue;const [xa,za,xb,zb]=[Math.sin(a)*6,Math.cos(a)*6,Math.sin(b)*6,Math.cos(b)*6];
      for(const t of k?[0,.5]:[0,.5,1])posts.push(at(mix(xa,xb,t),y0+.35+.55,GZ+mix(za,zb,t),0,0,.08,1.1,.08));for(const h of [.62,1.42])rail(rails,xa,GZ+za,xb,GZ+zb,y0+.35+h);}
    // Short returns from the platform rail to the walkway rails.
    for(const s of [-1,1])for(const h of [.62,1.42])rail(rails,Math.sin(Math.PI*3/8)*6,GZ+s*Math.cos(Math.PI*3/8)*6,5.7,GZ+s*1.05,y0+.35+h);
    // Vault door: a ring, the round leaf, a spoked hand wheel; the sign over it.
    const face=3.8*Math.cos(Math.PI/8),door=new T.Group();door.position.set(face,1.85,0);door.rotation.y=Math.PI/2;gen.add(door);
    part(new T.TorusGeometry(1.3,.13,12,64),hull,0,0,.04,door);
    // Door face: worn steel with machined rings, a bolt circle at the rim and the unit number, relief in a height map.
    const vault=weatheredSteel(256,256,167,{base:'#6a665c',cols:1,rows:1,vents:false,rust:.12}),vx=vault.color.getContext('2d'),vh=vault.height.getContext('2d');
    for(const [r,wd] of [[122,6],[96,3],[60,3],[30,2]]){vx.strokeStyle='rgba(20,20,16,.75)';vx.lineWidth=wd;vx.beginPath();vx.arc(128,128,r,0,TAU);vx.stroke();vx.strokeStyle='rgba(190,184,168,.35)';vx.lineWidth=1;vx.beginPath();vx.arc(128,128,r+wd/2+1,0,TAU);vx.stroke();vh.strokeStyle='#202020';vh.lineWidth=wd;vh.beginPath();vh.arc(128,128,r,0,TAU);vh.stroke();}
    for(let k=0;k<20;k++){const a=k/20*TAU,bx=128+Math.cos(a)*110,by=128+Math.sin(a)*110;vx.fillStyle='#2a2822';vx.beginPath();vx.arc(bx,by,5,0,TAU);vx.fill();vx.fillStyle='#9a9484';vx.beginPath();vx.arc(bx-1,by-1,3,0,TAU);vx.fill();vh.fillStyle='#f0f0f0';vh.beginPath();vh.arc(bx,by,5,0,TAU);vh.fill();}
    vx.fillStyle='rgba(225,205,150,.8)';vx.font='bold 26px Consolas,monospace';vx.textAlign='center';vx.fillText('01',128,205);
    const vaultFace=this.standard({map:this.texture(vault.color,{smooth:true}),normalMap:this.texture(normalMap(vault.height,2.5),{smooth:true,linear:true}),metalness:.55,roughness:.55});
    part(new T.CylinderGeometry(1.17,1.17,.22,48).rotateX(Math.PI/2),[m.steel,vaultFace,m.steel],0,0,.08,door);
    part(new T.TorusGeometry(.62,.055,8,28),red,0,0,.42,door);
    part(new T.CylinderGeometry(.15,.15,.36,24).rotateX(Math.PI/2),m.darkMetal,0,0,.3,door);
    for(let k=0;k<3;k++)part(new T.BoxGeometry(1.24,.07,.07),red,0,0,.42,door).rotation.z=k*Math.PI/3;
    for(const s of [-1,1]){part(new T.BoxGeometry(.22,.38,.3),hull,-1.28,s*.62,.12,door);part(new T.CylinderGeometry(.06,.06,.5,12),m.steel,-1.28,s*.62,.12,door);}
    const sign=this.mesh(this.geometry(new T.PlaneGeometry(1.9,.42)),this.basic({map:this.signTexture('GENERATOR 01',{color:'#f2d18c',bg:'#26291f',border:'#c9a14f'}),toneMapped:false}),gen);
    sign.position.set(face+.02,3.62,0);sign.rotation.y=Math.PI/2;
    // Consoles on the faces either side of the door.
    const consoleMat=this.standard({map:tx.console,emissiveMap:tx.consoleGlow,emissive:'#ffffff',emissiveIntensity:1.6,metalness:.3,roughness:.6});
    for(const a of [Math.PI/4,Math.PI*3/4]){const desk=new T.Group();desk.position.set(Math.sin(a)*(face+.45),.35,Math.cos(a)*(face+.45));desk.rotation.y=a;gen.add(desk);
      part(new T.BoxGeometry(1.7,1.05,.7),m.darkMetal,0,.52,0,desk);part(new T.BoxGeometry(1.7,1.5,.25),m.darkMetal,0,1.3,-.28,desk);
      part(new T.PlaneGeometry(1.56,1.1),consoleMat,0,1.35,-.14,desk,false);}
    // Rotating collar on the neck, then the ribbed skirt flaring out to the lip under the drum.
    this.flywheel=new T.Group();this.flywheel.position.y=4.4;gen.add(this.flywheel);
    part(new T.CylinderGeometry(3,3,.6,40),m.darkMetal,0,0,0,this.flywheel,false);
    inst(new T.BoxGeometry(.22,.4,.16),m.steel,Array.from({length:16},(_,k)=>at(Math.sin(k/16*TAU)*3.04,0,Math.cos(k/16*TAU)*3.04,k/16*TAU)),this.flywheel,false);
    part(new T.CylinderGeometry(5.25,3.05,1.6,48,1,true),hull,0,5.5,0,gen);
    inst(new T.BoxGeometry(.16,2.75,.32),m.darkMetal,Array.from({length:24},(_,k)=>at(Math.sin(k/24*TAU)*4.25,5.5,Math.cos(k/24*TAU)*4.25,k/24*TAU,Math.atan2(2.2,1.6))),gen);
    part(new T.CylinderGeometry(5.65,5.65,.32,48),m.darkMetal,0,6.46,0,gen);
    // Red-orange lamps under the lip; they pulse with the load.
    this.coilBase=hdr('#ff5a26',5);this.coilMaterial=this.basic({color:this.coilBase.clone()});
    const lamps=[],lampGlow=[];for(let k=0;k<12;k++){const a=(k+.5)/12*TAU;lamps.push(at(Math.sin(a)*5.3,6.12,Math.cos(a)*5.3,a));lampGlow.push(Math.sin(a)*5.45,y0+6.02,GZ+Math.cos(a)*5.45);}
    inst(new T.BoxGeometry(.42,.2,.22),this.coilMaterial,lamps,gen,false);
    const lampPoints=this.geometry(new T.BufferGeometry());lampPoints.setAttribute('position',new T.Float32BufferAttribute(lampGlow,3));
    const lampGlowMat=new T.PointsMaterial({map:this.glowMap,color:hdr('#ff6a34',1.5),size:2.4,transparent:true,opacity:.7,depthWrite:false,blending:T.AdditiveBlending,fog:false,toneMapped:false});this.materials.push(lampGlowMat);
    group.add(new T.Points(lampPoints,lampGlowMat));
    // The drum, its flanges and a cone up to a short stack.
    const shell=part(new T.CylinderGeometry(5.4,5.4,7.4,64,1,true),drum,0,10.32,0,gen);this.occluders.push(shell);
    for(const y of [6.75,10.3,13.85])part(new T.CylinderGeometry(5.52,5.52,.26,64),m.darkMetal,0,y,0,gen);
    part(new T.CylinderGeometry(2.4,5.4,1.6,48),hull,0,14.82,0,gen);
    part(new T.CylinderGeometry(.95,.95,3,20),hull,0,17.1,0,gen);part(new T.CylinderGeometry(1.1,1.1,.3,20),m.darkMetal,0,18.45,0,gen);
    // Red ladder up the drum beside the door.
    const la=Math.PI/2+.62,lx=Math.sin(la),lz=Math.cos(la),rungs=[];
    for(const s of [-.26,.26])part(new T.BoxGeometry(.07,7.8,.07),red,lx*5.62+lz*s,10.4,lz*5.62-lx*s,gen);
    for(let y=6.9;y<14.2;y+=.36)rungs.push(at(lx*5.62,y,lz*5.62,la+Math.PI/2,0,.52,.05,.05));
    inst(new T.BoxGeometry(1,1,1),red,rungs,gen,false);

    // Walkway from the open floor to the door: grating deck, red rails, posts every 1.4 m.
    const W0=5.7,W1=17.2,wz=GZ;
    const walk=part(new T.BoxGeometry(W1-W0,.35,2.2),grate([(W1-W0)/.5,4.4]),(W0+W1)/2,y0+.175,wz,group);this.occluders.push(walk);
    for(const s of [-1,1]){for(let x=W0;x<=W1+.01;x+=(W1-W0)/8)posts.push(at(x,y0+.9,wz+s*1.05,0,0,.08,1.1,.08));for(const h of [.62,1.42])rail(rails,W0,wz+s*1.05,W1,wz+s*1.05,y0+.35+h);}
    inst(new T.BoxGeometry(1,1,1),red,posts);inst(new T.BoxGeometry(1,1,1),red,rails);

    // Pipe loops: inverted U bends with flanges at the legs and a valve wheel on top. Two banks along each side of
    // the walkway, more in pairs around the hall, clear of the courier lane under the bridges.
    const loop=new T.CatmullRomCurve3([[0,-.3,0],[0,1.2,0],[0,1.9,.55],[0,2.1,1.6],[0,1.9,2.65],[0,1.2,3.2],[0,-.3,3.2]].map(p=>new T.Vector3(...p)));
    const loops=[];
    for(const s of [-1,1])for(const k of [0,1])for(const x of [7,11.6])loops.push(at(x,y0,wz+s*(1.95+k*1.2),Math.PI/2,0,1+k*.18));
    for(const a of [1.55,2.2,4.25,4.9,5.9])for(const k of [0,1]){const r=21.5+k*1.5,t=a+Math.PI/2;loops.push(at(Math.sin(a)*r-Math.sin(t)*2,y0,Math.cos(a)*r-Math.cos(t)*2,t,0,1.3+k*.15));}
    inst(new T.TubeGeometry(loop,40,.48,12,false),pipeMat,loops);
    const flange=new T.Matrix4().makeTranslation(0,.9,0),flange2=new T.Matrix4().makeTranslation(0,.9,3.2),wheel=new T.Matrix4().makeTranslation(0,2.86,1.6);
    inst(new T.CylinderGeometry(.62,.62,.18,18),m.darkMetal,loops.flatMap(l=>[l.clone().multiply(flange),l.clone().multiply(flange2)]));
    inst(new T.TorusGeometry(.42,.05,6,20).rotateX(Math.PI/2),red,loops.map(l=>l.clone().multiply(wheel)));
    inst(new T.CylinderGeometry(.05,.05,.32,6),m.steel,loops.map(l=>l.clone().multiply(new T.Matrix4().makeTranslation(0,2.7,1.6))),group,false);
    // Two heavy feeds from the back of the base out to the wall.
    for(const s of [-1,1]){const curve=new T.CatmullRomCurve3([[-3.4,2.4,GZ+s*1.3],[-8,2.6,GZ+s*1.5],[-13,2.6,GZ+1+s*1.6],[-18,1.8,GZ+2+s*1.4],[-20,-.6,GZ+2.6+s*1.3]].map(([x,y,z])=>new T.Vector3(x,y0+y,z)));
      part(new T.TubeGeometry(curve,48,.6,12,false),pipeMat,0,0,0,group);}

    // Beacon on a pole at the start of the walkway, alarm lamps on the walls of the lowest level.
    this.beaconAt=new T.Vector3(W1+.5,y0+4.5,wz+2.1);
    part(new T.CylinderGeometry(.1,.12,4.2,10),m.darkMetal,this.beaconAt.x,y0+2.1,this.beaconAt.z,group);
    this.beaconMaterial=this.basic({color:hdr('#ffae3a',4)});
    part(new T.CylinderGeometry(.3,.36,.5,14),this.beaconMaterial,this.beaconAt.x,this.beaconAt.y,this.beaconAt.z,group,false);
    this.beaconLight=new T.SpotLight('#ffa040',0,46,.42,.55,1.4);this.beaconLight.position.copy(this.beaconAt);this.scene.add(this.beaconLight,this.beaconLight.target);
    this.alarmLight=new T.PointLight('#ff3322',0,34,1.5);this.alarmLight.position.set(0,y0+6,5);this.scene.add(this.alarmLight);
    this.alarmBase=hdr('#ff3a24',4);this.alarmMaterial=this.basic({color:this.alarmBase.clone()});
    const alarmGlow=[];
    for(let k=0;k<8;k++){const a=(k+.25)/8*TAU,lamp=this.mesh(this.geometry(new T.BoxGeometry(.4,.4,.2)),this.alarmMaterial,group);lamp.position.set(Math.sin(a)*33.1,y0+4.4,Math.cos(a)*33.1);lamp.rotation.y=a;alarmGlow.push(Math.sin(a)*32.8,y0+4.4,Math.cos(a)*32.8);}
    const glowGeometry=this.geometry(new T.BufferGeometry());glowGeometry.setAttribute('position',new T.Float32BufferAttribute(alarmGlow,3));
    this.alarmGlow=new T.PointsMaterial({map:this.glowMap,color:hdr('#ff4630',1.6),size:4,transparent:true,depthWrite:false,blending:T.AdditiveBlending,fog:false,toneMapped:false});this.materials.push(this.alarmGlow);
    group.add(new T.Points(glowGeometry,this.alarmGlow));
    // A work lamp over the walkway lights the door side; the lamps under the lip throw red light on the back.
    this.heats=[['#ffcf98',70,30,1.5,11,10,GZ+2],['#ff7a40',34,18,1.7,-6.4,5.4,GZ]].map(([color,power,range,decay,x,y,z])=>{const heat=new T.PointLight(color,0,range,decay);heat.position.set(x,y0+y,z);heat.userData.power=power;this.scene.add(heat);return heat;});
    // Steam from the stack (the first source rises highest), then from around the base and the pipe banks.
    this.steamSources=[[0,y0+18.7,GZ],[4.8,y0+.6,GZ-3.4],[4.8,y0+.6,GZ+3.4],[9.2,y0+2.6,wz-3.15],[13.6,y0+2.6,wz+3.15],[-17,y0+2.6,GZ+3]];
    const count=240,positions=new Float32Array(count*3);this.steamLife=new Float32Array(count);
    for(let i=0;i<count;i++)this.steamLife[i]=random(i*1.7);
    const sg=this.geometry(new T.BufferGeometry());sg.setAttribute('position',new T.BufferAttribute(positions,3));
    const steamMaterial=new T.PointsMaterial({map:this.puffMap,color:'#a59e90',size:2.4,transparent:true,opacity:.09,depthWrite:false});this.materials.push(steamMaterial);
    this.steam=new T.Points(sg,steamMaterial);this.steam.frustumCulled=false;group.add(this.steam);
  }

  // The surface as in the series: a dead plain under a dust sky, silo roofs in round craters, a ruined city far away.
  buildOutside(m){
    const out=new T.Group();out.visible=false;this.scene.add(out);this.outside=out;
    const skyGeometry=this.geometry(new T.SphereGeometry(6000,48,24)),colors=[],tmp=new T.Color();
    const top=new T.Color('#3b4243'),mid=new T.Color('#857e6d'),horizon=new T.Color('#c4ad86'),low=new T.Color('#5d5444'),pos=skyGeometry.attributes.position;
    for(let i=0;i<pos.count;i++){const h=pos.getY(i)/6000;if(h>.22)tmp.copy(mid).lerp(top,smooth(.22,1,h));else if(h>0)tmp.copy(horizon).lerp(mid,h/.22);else tmp.copy(horizon).lerp(low,smooth(0,.1,-h));colors.push(tmp.r,tmp.g,tmp.b);}
    skyGeometry.setAttribute('color',new T.Float32BufferAttribute(colors,3));
    const sky=this.mesh(skyGeometry,this.basic({vertexColors:true,side:T.BackSide,fog:false,depthWrite:false}),out);sky.renderOrder=-10;sky.frustumCulled=false;this.outsideSkyMat=sky.material;
    const sunMaterial=new T.SpriteMaterial({map:this.glowMap,color:hdr('#ffe2b4',1.1),transparent:true,depthWrite:false,fog:false,blending:T.AdditiveBlending});this.materials.push(sunMaterial);
    const sun=new T.Sprite(sunMaterial);sun.position.set(2400,1100,-3900);sun.scale.set(2400,2400,1);out.add(sun);
    // Ground: a wide ring around the roof of silo 18, dense near it and coarse at the horizon.
    const inner=SHELL_RADIUS,outer=4300,ground=this.geometry(new T.RingGeometry(inner,outer,240,130)),gp=ground.attributes.position,gc=[];
    const dirt=new T.Color('#5a5244'),dust=new T.Color('#8b806a'),ash=new T.Color('#3d3830');
    for(let i=0;i<gp.count;i++){
      const x0=gp.getX(i),y0=gp.getY(i),r=Math.hypot(x0,y0),t=clamp((r-inner)/(outer-inner),0,1),r2=inner+(outer-inner)*Math.pow(t,2.2),s=r?r2/r:0,x=x0*s,z=-y0*s,h=terrainHeight(x,z),[d]=nearestSite(x,z);
      gp.setXYZ(i,x,GROUND_Y+h,z);
      tmp.copy(dirt).lerp(dust,clamp(h/60+.25+random(i*.37)*.3,0,1)).lerp(ash,smooth(95,40,d)*.55);tmp.multiplyScalar(.86+random(i*1.13)*.22);gc.push(tmp.r,tmp.g,tmp.b);
    }
    // (x, y) of the flat ring becomes (x, -z), the same turn as rotateX(-90deg), so the faces point up.
    ground.setAttribute('color',new T.Float32BufferAttribute(gc,3));ground.computeVertexNormals();
    // Dust texture in world units, one tile every 24 m (the ring's own UVs are bent by the warp above).
    const guv=ground.attributes.uv;for(let i=0;i<gp.count;i++)guv.setXY(i,gp.getX(i)/24,gp.getZ(i)/24);ground.computeBoundingSphere();
    const terrain=this.mesh(ground,this.standard({vertexColors:true,...this.tx.dust,roughness:1,metalness:0}),out);terrain.frustumCulled=false;this.outsideTerrainMat=terrain.material;
    // The ruined city on the horizon, the view from the cafeteria screen.
    const towers=180,city=new T.InstancedMesh(this.geometry(new T.BoxGeometry(1,1,1).translate(0,.5,0)),this.standard({map:this.tx.facade,color:'#8a8a80',roughness:1}),towers*2);
    for(let i=0;i<towers;i++){
      const a=Math.PI+.35+(random(i*2.7)-.5)*1.5,dist=2700+random(i*2.9)*1100,x=Math.sin(a)*dist,z=Math.cos(a)*dist;
      const w=18+random(i*4.1)*46,d=18+random(i*6.3)*40,h=30+Math.pow(random(i*5.3),1.6)*230;
      this.dummy.position.set(x,GROUND_Y+terrainHeight(x,z)-8,z);this.dummy.rotation.set((random(i*7.7)-.5)*.1,random(i*8.1)*TAU,(random(i*9.9)-.5)*.12);this.dummy.scale.set(w,h,d);this.dummy.updateMatrix();city.setMatrixAt(i,this.dummy.matrix);
      // Half the towers keep a narrower upper block, broken off at an angle; the others lost it.
      const crown=random(i*3.7)>.5,ch=h*(.12+random(i*1.9)*.35);this.dummy.position.y+=h*Math.cos(this.dummy.rotation.x)-1;this.dummy.rotation.z+=(random(i*4.9)-.5)*.2;
      this.dummy.scale.set(crown?w*(.45+random(i*2.1)*.25):0,crown?ch:0,crown?d*(.45+random(i*5.9)*.25):0);this.dummy.updateMatrix();city.setMatrixAt(towers+i,this.dummy.matrix);
    }
    city.instanceMatrix.needsUpdate=true;city.computeBoundingSphere();out.add(city);
    // Silo roofs: a concrete disc with a raised rim and hatches, at the bottom of each crater.
    const concrete=this.standard({color:'#8e8b7c',...this.tx.shell});
    const roofGeometry=this.geometry(new T.CylinderGeometry(SHELL_RADIUS,SHELL_RADIUS+.6,ROOF_CAP-ROOF_Y,72).translate(0,(ROOF_CAP-ROOF_Y)/2,0));
    const rimGeometry=this.geometry(new T.TorusGeometry(SHELL_RADIUS-.4,.7,8,72).rotateX(Math.PI/2));
    const hatchGeometry=this.geometry(new T.CylinderGeometry(3.2,3.6,1.1,24).translate(0,.55,0));
    const others=SILO_SITES.filter(([x,z])=>x||z),count=others.length+1;
    const roofs=new T.InstancedMesh(roofGeometry,this.standard({color:'#8e8b7c',...this.resurface(this.tx.shell,[6,6])}),count),rims=new T.InstancedMesh(rimGeometry,this.standard({color:'#8e8b7c',...this.resurface(this.tx.shell,[32,1])}),count),hatches=new T.InstancedMesh(hatchGeometry,this.standard({...this.resurface(this.tx.hull,[3,1]),color:'#a8a294',metalness:.5,roughness:.6}),count*3);
    [[0,0],...others].forEach(([x,z],i)=>{
      const base=i?GROUND_Y+terrainHeight(x,z)-(ROOF_CAP-ROOF_Y)+.15:ROOF_Y;
      this.dummy.rotation.set(0,random(i*3.3)*TAU,0);this.dummy.scale.set(1,1,1);this.dummy.position.set(x,base,z);this.dummy.updateMatrix();roofs.setMatrixAt(i,this.dummy.matrix);
      this.dummy.position.set(x,base+ROOF_CAP-ROOF_Y,z);this.dummy.updateMatrix();rims.setMatrixAt(i,this.dummy.matrix);
      for(let k=0;k<3;k++){const a=k/3*TAU+i,rr=k?19:0;this.dummy.position.set(x+Math.sin(a)*rr,base+ROOF_CAP-ROOF_Y,z+Math.cos(a)*rr);this.dummy.scale.setScalar(k?.7:1.6);this.dummy.updateMatrix();hatches.setMatrixAt(i*3+k,this.dummy.matrix);}
    });
    for(const im of [roofs,rims,hatches]){im.instanceMatrix.needsUpdate=true;im.computeBoundingSphere();im.castShadow=false;out.add(im);}
    // The airlock of silo 18: a concrete block on the roof edge, a heavy door, and a ramp up the crater wall.
    const lock=new T.Group();lock.rotation.y=Math.PI+.35;out.add(lock);this.airlock=lock;
    const lbox=(w,h,d,mat,x,y,z)=>{const b=this.mesh(this.geometry(mat===concrete?boxMetres(w,h,d,7):new T.BoxGeometry(w,h,d)),mat,lock);b.position.set(x,y,z);return b;};
    lbox(9,5,12,concrete,0,ROOF_CAP+2.5,29);lbox(10,.6,13,concrete,0,ROOF_CAP+5.3,29);
    // Hazard paint at its real size on the frame: one stripe pair per 0.7 m, whatever the length of the piece.
    const hazard=(u,v)=>{const t=this.tx.hazard.clone();t.wrapS=t.wrapT=T.RepeatWrapping;t.repeat.set(u,v);this.ownedTextures.push(t);return this.standard({map:t,roughness:.8});};
    lbox(3.2,3.6,.3,this.standard({...this.resurface(this.tx.hull,[1,1]),color:'#8a867c',metalness:.5,roughness:.6}),0,ROOF_CAP+1.8,35.1);lbox(4,.35,.35,hazard(4/.7,.5),0,ROOF_CAP+3.8,35.2);for(const sx of [-1.8,1.8])lbox(.35,3.6,.35,hazard(.5,3.6/.7),sx,ROOF_CAP+1.8,35.2);
    const wheel=this.mesh(this.geometry(new T.TorusGeometry(.7,.1,6,20)),m.steel,lock);wheel.position.set(0,ROOF_CAP+1.9,35.3);
    const rampStart=35.4,rampEnd=96,rampRise=GROUND_Y+3-ROOF_CAP,rampLen=Math.hypot(rampEnd-rampStart,rampRise),rampTilt=Math.atan2(rampRise,rampEnd-rampStart);
    const ramp=new T.Group();ramp.position.set(0,ROOF_CAP,rampStart);ramp.rotation.x=-rampTilt;lock.add(ramp);
        const rbox=(w,h,d,x,y,z)=>{const b=this.mesh(this.geometry(boxMetres(w,h,d,7)),concrete,ramp);b.position.set(x,y,z);return b;};
    rbox(5,.5,rampLen,0,-.25,rampLen/2);rbox(.6,1.6,rampLen,-2.8,.55,rampLen/2);rbox(.6,1.6,rampLen,2.8,.55,rampLen/2);
    // The sensor mast whose lens the cleaners wipe.
    const mast=new T.Group();mast.position.set(3.4,ROOF_CAP+5.6,32);lock.add(mast);
    this.mesh(this.geometry(new T.CylinderGeometry(.14,.18,4.5,8)),m.darkMetal,mast).position.y=2.25;
    this.mesh(this.geometry(new T.BoxGeometry(.9,.65,1.4)),m.steel,mast).position.set(0,4.6,.3);
    const lens=this.mesh(this.geometry(new T.CylinderGeometry(.24,.24,.2,16)),this.basic({color:hdr('#86b6c4',1.8)}),mast);lens.rotation.x=Math.PI/2;lens.position.set(0,4.6,1.05);this.lensMesh=lens;
    const antenna=this.mesh(this.geometry(new T.CylinderGeometry(.08,.14,12,6)),m.darkMetal,lock);antenna.position.set(-3.6,ROOF_CAP+11.6,25);
    this.blinkerBase=hdr('#ff2a1a',6);this.blinker=this.basic({color:this.blinkerBase.clone(),fog:false});
    this.mesh(this.geometry(new T.SphereGeometry(.3,8,6)),this.blinker,lock).position.set(-3.6,ROOF_CAP+17.7,25);
    // Two cleaners lie on the crater rim, facing the city.
    const suit=this.standard({color:'#cfcabb',roughness:.85}),visor=this.standard({color:'#20252a',metalness:.6,roughness:.25});
    for(const [a,r,turn] of [[Math.PI+.56,99,.2],[Math.PI+.62,100.5,-.3]]){
      const x=Math.sin(a)*r,z=Math.cos(a)*r,body=new T.Group();body.position.set(x,GROUND_Y+terrainHeight(x,z)+.35,z);body.rotation.set(0,a+turn,Math.PI/2);out.add(body);
      this.mesh(this.geometry(new T.CapsuleGeometry(.36,1.3,4,10)),suit,body);const head=this.mesh(this.geometry(new T.SphereGeometry(.38,12,8)),visor,body);head.position.y=1.1;
    }
    // Rubble scattered around the crater.
    const rubbleCount=180,rubble=new T.InstancedMesh(this.geometry(new T.IcosahedronGeometry(1,0)),this.standard({color:'#5b5448',flatShading:true,roughness:1}),rubbleCount);
    for(let i=0;i<rubbleCount;i++){const a=random(i*2.3)*TAU,r=48+Math.pow(random(i*3.9),1.4)*190,x=Math.sin(a)*r,z=Math.cos(a)*r,s=.4+random(i*5.1)*2.2;this.dummy.position.set(x,GROUND_Y+terrainHeight(x,z)+s*.2,z);this.dummy.rotation.set(random(i)*3,random(i*2)*3,0);this.dummy.scale.set(s,s*.6,s*(.7+random(i*7)*.6));this.dummy.updateMatrix();rubble.setMatrixAt(i,this.dummy.matrix);}
    rubble.instanceMatrix.needsUpdate=true;rubble.computeBoundingSphere();out.add(rubble);
    // The cut face: earth strata around a concrete shell, rebuilt when the cut moves.
    const cap=new T.Group();out.add(cap);this.cap=cap;
    const quadGeometry=n=>{const g=this.geometry(new T.BufferGeometry());g.setAttribute('position',new T.BufferAttribute(new Float32Array(n*18),3));g.setAttribute('uv',new T.BufferAttribute(new Float32Array(n*12),2));g.setDrawRange(0,0);return g;};
    this.earthCap=this.mesh(quadGeometry(180),this.basic({map:this.tx.earth,color:'#b3a48c',side:T.DoubleSide}),cap);this.earthCap.frustumCulled=false;
    this.shellCap=this.mesh(quadGeometry(8),this.basic({map:this.tx.shell.map,color:'#a9a490',side:T.DoubleSide}),cap);this.shellCap.frustumCulled=false;
  }
  // Each quad is [x0, x1, bottom at x0, bottom at x1, top at x0, top at x1].
  setQuads(mesh,quads,uv){
    const g=mesh.geometry,p=g.attributes.position.array,t=g.attributes.uv.array,max=p.length/3;let n=0;
    for(const [x0,x1,b0,b1,t0,t1] of quads){
      if(x1-x0<.001||(t0-b0<.001&&t1-b1<.001)||n+6>max)continue;
      for(const [x,y] of [[x0,b0],[x1,b1],[x1,t1],[x0,b0],[x1,t1],[x0,t0]]){p[n*3]=x;p[n*3+1]=y;p[n*3+2]=0;const [u,v]=uv(x,y);t[n*2]=u;t[n*2+1]=v;n++;}
    }
    g.setDrawRange(0,n);g.attributes.position.needsUpdate=true;g.attributes.uv.needsUpdate=true;
  }
  updateCap(){
    const c=this.clipC;this.cap.visible=c<1e4;if(!this.cap.visible)return;
    const dir=this.clipDir,theta=Math.atan2(dir.x,dir.z);this.cap.position.set(dir.x*(c-.08),0,dir.z*(c-.08));this.cap.rotation.y=theta;
    const key=c.toFixed(2)+'/'+theta.toFixed(3);if(this.capKey===key)return;this.capKey=key;
    const half=r=>Math.sqrt(Math.max(0,r*r-c*c)),hs=half(SHELL_RADIUS),hw=half(WALL_RADIUS),W=5200,N=80,ex=Math.cos(theta),ez=-Math.sin(theta);
    // The top of the earth follows the ground along the cut line.
    const top=s=>GROUND_Y+terrainHeight(dir.x*c+ex*s,dir.z*c+ez*s)-.35,quads=[[-hs,hs,EARTH_BOTTOM,EARTH_BOTTOM,SHELL_BOTTOM,SHELL_BOTTOM]];
    for(const side of [-1,1])for(let k=0;k<N;k++){
      const a=hs+(W-hs)*Math.pow(k/N,2.2),b=hs+(W-hs)*Math.pow((k+1)/N,2.2),ta=top(side*a),tb=top(side*b);
      quads.push(side>0?[a,b,EARTH_BOTTOM,EARTH_BOTTOM,ta,tb]:[-b,-a,EARTH_BOTTOM,EARTH_BOTTOM,tb,ta]);
    }
    this.setQuads(this.earthCap,quads,(x,y)=>[x/185,(y-EARTH_BOTTOM)/(GROUND_Y-EARTH_BOTTOM)]);
    const S=SHELL_BOTTOM,R=ROOF_CAP;
    this.setQuads(this.shellCap,[[-hs,-hw,S,S,R,R],[hw,hs,S,S,R,R],[-hw,hw,S,S,BOTTOM_Y-.12,BOTTOM_Y-.12],[-hw,hw,ROOF_Y,ROOF_Y,R,R]],(x,y)=>[x/12,y/12]);
  }
  buildRoomTextures(){
    const image=new Image();
    const cut=source=>{
      if(!this.alive)return;
      ROOM_CROPS.forEach((pair,type)=>pair.forEach(([sx,sy,sw,sh],variant)=>{
        // Each room is only ~280 px wide in the picture. It is enlarged 3x with high-quality smoothing and sharpened,
        // and the GPU filters it smoothly from there, so close up it is soft-edged instead of blocky.
        const W=sw*3,H=sh*3,c=makeCanvas(W,H),x=c.getContext('2d',{willReadFrequently:true});x.imageSmoothingEnabled=true;x.imageSmoothingQuality='high';x.drawImage(source,sx,sy,sw,sh,0,0,W,H);
        x.putImageData(sharpen(x.getImageData(0,0,W,H),.45),0,0);
        const v=x.createLinearGradient(0,0,0,H);v.addColorStop(0,'rgba(10,14,10,.45)');v.addColorStop(.25,'rgba(10,14,10,0)');v.addColorStop(1,'rgba(10,14,10,.15)');x.fillStyle=v;x.fillRect(0,0,W,H);
        const mat=this.roomMaterials[type*2+variant];mat.map=this.texture(c,{smooth:true});mat.color.set('#e2d4b4');
      }));
      source.close?.();this.canvas.dataset.texturesReady='true';
    };
    // The picture is decoded off the main thread first; cutting it into rooms is then quick.
    image.onload=()=>{
      if(typeof createImageBitmap!=='function')return cut(image);
      createImageBitmap(image).then(cut,()=>cut(image));
    };
    // WebP is a fifth of the PNG. The PNG stays for a browser that cannot read WebP.
    image.onerror=()=>{if(image.src.endsWith('.webp')){image.src='/assets/silo-atrium.png';return;}this.canvas.dataset.texturesReady='missing';};
    image.src='/assets/silo-atrium.webp';
  }
  // lazy: hand back an empty strip now and let a worker paint it, instead of painting it on the main thread.
  atlasFor(look,lazy=false){
    let atlas=this.atlasTextures.get(look.key);
    if(atlas&&!lazy&&atlasPending(look.key)){residentAtlas(look);this.atlasReady(look.key);}
    if(!atlas){
      let canvas;if(lazy){const r=reserveAtlas(look);canvas=r.canvas;if(!r.ready)this.atlasQueue.push(look);}else canvas=residentAtlas(look);
      atlas=new T.CanvasTexture(canvas);atlas.colorSpace=T.SRGBColorSpace;atlas.magFilter=T.NearestFilter;atlas.minFilter=T.NearestFilter;atlas.generateMipmaps=false;this.atlasTextures.set(look.key,atlas);this.ownedTextures.push(atlas);}
    return atlas;
  }
  labelFor(name){
    let map=this.labelCache.get(name);
    if(!map){map=this.signTexture(name.toUpperCase(),{color:'#f4dca2',bg:'#121a13',border:'#c49a58'});this.labelCache.set(name,map);}
    return map;
  }

  // ---------- post effects ----------
  setupPost(){
    this.post=null;this.canvas.dataset.post='off';
    try{
      const r=this.renderer;if(!r.capabilities.isWebGL2)return;
      const half=r.extensions.has('EXT_color_buffer_float')||r.extensions.has('EXT_color_buffer_half_float'),type=half?T.HalfFloatType:T.UnsignedByteType;
      const sceneTarget=new T.WebGLRenderTarget(4,4,{type,samples:4,depthBuffer:true,stencilBuffer:true});
      const targets=[0,1,2,3].map(()=>new T.WebGLRenderTarget(4,4,{type,depthBuffer:false,minFilter:T.LinearFilter,magFilter:T.LinearFilter,generateMipmaps:false}));
      const make=(fragmentShader,uniforms)=>{const mat=new T.ShaderMaterial({vertexShader:POST_VERTEX,fragmentShader,uniforms,depthTest:false,depthWrite:false,toneMapped:false});this.materials.push(mat);return mat;};
      const bright=make(BRIGHT_FRAGMENT,{tMap:{value:null},uTexel:{value:new T.Vector2()},uThreshold:{value:0}});
      const blur=make(BLUR_FRAGMENT,{tMap:{value:null},uDir:{value:new T.Vector2()}});
      const final=make(FINAL_FRAGMENT,{tScene:{value:sceneTarget.texture},tBloomA:{value:targets[0].texture},tBloomB:{value:targets[2].texture},uRes:{value:new T.Vector2(1,1)},uTime:{value:0},uCrt:{value:this.crtLevel},uExposure:{value:1.35},uBloom:{value:.85}});
      const quad=new T.Mesh(this.geometry(new T.PlaneGeometry(2,2)),final);quad.frustumCulled=false;
      const scene=new T.Scene();scene.add(quad);
      this.post={sceneTarget,targets,bright,blur,final,quad,scene,camera:new T.OrthographicCamera(-1,1,1,-1,0,1),threshold:half?1.1:.82};
      r.debug.onShaderError=(gl,program)=>{console.warn('A shader failed to compile, post effects are off.',gl.getProgramInfoLog(program));this.postFailed=true;};
      this.canvas.dataset.post=half?'hdr':'ldr';
    }catch(error){console.warn('Post effects are not available.',error);this.dropPost();}
  }
  // Compile every material up front so the first trip outside or to the bottom does not stall.
  precompile(){
    const saved=[this.outside.visible,this.bottomGroup.visible,...this.chunks.map(c=>c.visible)];
    try{this.outside.visible=this.bottomGroup.visible=true;for(const c of this.chunks)c.visible=true;this.renderer.setRenderTarget(this.post?.sceneTarget||null);
      // The GPU driver links the shaders in the background (KHR_parallel_shader_compile). The first frame waits for
      // them instead of stalling the page while they link; after 2.5 s it draws anyway.
      // (Sending the pictures to the GPU ahead of time, a few per task, was tried and made the first frame slower.)
      if(this.renderer.compileAsync){this.shadersReady=false;const ready=()=>{this.shadersReady=true;};this.renderer.compileAsync(this.scene,this.camera).then(ready,ready);setTimeout(ready,2500);}
      else this.renderer.compile(this.scene,this.camera);}
    catch(error){console.warn('Shader warm-up skipped.',error);}
    finally{this.renderer.setRenderTarget(null);this.outside.visible=saved[0];this.bottomGroup.visible=saved[1];this.chunks.forEach((c,i)=>{c.visible=saved[i+2];});}
  }
  dropPost(){if(!this.post)return;this.post.sceneTarget.dispose();for(const t of this.post.targets)t.dispose();this.post=null;this.canvas.dataset.post='off';}
  resizePost(){
    if(!this.post)return;const size=this.renderer.getDrawingBufferSize(new T.Vector2()),w=Math.max(1,size.x),h=Math.max(1,size.y),p=this.post;
    p.sceneTarget.setSize(w,h);const qw=Math.max(1,Math.round(w/4)),qh=Math.max(1,Math.round(h/4)),ew=Math.max(1,Math.round(w/8)),eh=Math.max(1,Math.round(h/8));
    p.targets[0].setSize(qw,qh);p.targets[1].setSize(qw,qh);p.targets[2].setSize(ew,eh);p.targets[3].setSize(ew,eh);p.final.uniforms.uRes.value.set(w,h);
  }
  // The shadow map is drawn again only when it would come out different: the key light follows the camera's level,
  // levels and props come and go. Otherwise last frame's map is the same picture, so the shadow pass is skipped.
  // Once a second it is drawn anyway, in case something else changed.
  shadowsDue(){
    const k=this.key.position;
    let key=k.x+','+k.y+','+k.z+'|'+(this.detailMeshes[0]?.visible?1:0)+(this.bottomGroup.visible?1:0)+(this.outside.visible?1:0);
    for(const c of this.chunks)key+=c.visible?1:0;
    if(key===this.shadowKey&&++this.shadowAge<60)return false;
    this.shadowKey=key;this.shadowAge=0;return true;
  }
  draw(seconds){
    const r=this.renderer;r.shadowMap.needsUpdate=this.shadowsDue();
    if(this.postFailed)this.dropPost();
    const p=this.post;
    if(!p){r.setRenderTarget(null);r.render(this.scene,this.camera);return;}
    const pass=(material,target)=>{p.quad.material=material;r.setRenderTarget(target);r.render(p.scene,p.camera);};
    const [a,b,c,d]=p.targets,bright=p.bright.uniforms,blur=p.blur.uniforms;
    r.setRenderTarget(p.sceneTarget);r.render(this.scene,this.camera);
    bright.tMap.value=p.sceneTarget.texture;bright.uTexel.value.set(1/p.sceneTarget.width,1/p.sceneTarget.height);bright.uThreshold.value=p.threshold;pass(p.bright,a);
    blur.tMap.value=a.texture;blur.uDir.value.set(1/a.width,0);pass(p.blur,b);blur.tMap.value=b.texture;blur.uDir.value.set(0,1/a.height);pass(p.blur,a);
    bright.tMap.value=a.texture;bright.uTexel.value.set(1/a.width,1/a.height);bright.uThreshold.value=0;pass(p.bright,c);
    for(const s of [1,2]){blur.tMap.value=c.texture;blur.uDir.value.set(s/c.width,0);pass(p.blur,d);blur.tMap.value=d.texture;blur.uDir.value.set(0,s/c.height);pass(p.blur,c);}
    const f=p.final.uniforms;f.uTime.value=seconds%1000;f.uCrt.value=this.crtLevel;
    pass(p.final,null);
  }
  setCrt(on){this.crt=!!on;this.canvas.dataset.crt=this.crt?'on':'off';}

  // ---------- residents ----------
  removePerson(id){const entry=this.people.get(id);if(!entry)return;this.scene.remove(entry.sprite);if(entry.bubble)this.scene.remove(entry.bubble);entry.material.dispose();entry.through.dispose();entry.map.dispose();this.people.delete(id);}
  update(agents,selected,paused){
    this.agents=agents;this.selected=selected;this.paused=paused;
    const ids=new Set(agents.map(a=>a.id));for(const id of [...this.people.keys()])if(!ids.has(id))this.removePerson(id);
    const peers=new Map();
    for(const agent of agents){
      const level=clamp(agent.level||SECTORS[agent.floor]?.home||1,1,LEVELS),index=peers.get(level)||0;peers.set(level,index+1);
      const look=appearanceFor(agent);let entry=this.people.get(agent.id);
      if(entry&&entry.lookKey!==look.key){this.removePerson(agent.id);entry=null;}
      if(!entry){
        const map=this.atlasFor(look,true).clone();map.repeat.set(1/FRAMES,1);
        if(atlasPending(look.key)){let list=this.atlasWaiting.get(look.key);if(!list)this.atlasWaiting.set(look.key,list=[]);list.push(map);}
        const material=new T.SpriteMaterial({map,alphaTest:.5,transparent:false,color:new T.Color(1.25,1.2,1.1)});
        const sprite=new T.Sprite(material);sprite.center.set(.5,0);sprite.scale.set(1.25,1.84,1);sprite.userData.agentId=agent.id;this.scene.add(sprite);
        // Behind a parapet a resident is drawn again where the parapet hides them (depth farther, stencil marked), so they
        // stay readable through the concrete but not through floors or walls. It rides on the sprite and shares its frames.
        const through=new T.SpriteMaterial({map,alphaTest:.5,transparent:true,opacity:.9,depthWrite:false,depthFunc:T.GreaterDepth,stencilWrite:true,stencilWriteMask:0,stencilRef:1,stencilFunc:T.EqualStencilFunc});
        const seen=new T.Sprite(through);seen.center.set(.5,0);seen.renderOrder=3;seen.raycast=()=>{};sprite.add(seen);
        entry={sprite,material,through,seen,map,lookKey:look.key,frame:-1,flip:null};this.people.set(agent.id,entry);
      }
      Object.assign(entry,{agent,level,index});
      entry.material.color.copy(agent.provider==='demo'?this.demoTint:this.liveTint);entry.through.color.copy(entry.material.color).multiply(this.throughTint);
    }
    this.sprites=[...this.people.values()].map(e=>e.sprite).concat(this.terminalSigns);
    this.paintQueued();
  }
  // A strip just got painted: every copy of its texture must be sent to the GPU again.
  atlasReady(key){
    const atlas=this.atlasTextures.get(key);if(atlas)atlas.needsUpdate=true;
    for(const map of this.atlasWaiting.get(key)||[])map.needsUpdate=true;this.atlasWaiting.delete(key);
  }
  // Hundreds of residents take about half a second to paint. Workers with an OffscreenCanvas do it in parallel,
  // off the main thread, and residents appear in batches while the world is already moving.
  paintQueued(){
    const looks=this.atlasQueue.splice(0);if(!looks.length)return;
    if(typeof OffscreenCanvas==='undefined'||!window.Worker){this.paintSlowly(looks);return;}
    const count=Math.max(1,Math.min(4,(navigator.hardwareConcurrency||2)-1,Math.ceil(looks.length/40)));
    for(let w=0;w<count;w++){
      const part=looks.filter((_,i)=>i%count===w);let worker;
      const finish=()=>{worker?.terminate();this.atlasWorkers.delete(worker);if(this.alive!==false)this.paintSlowly(part.filter(l=>atlasPending(l.key)));};
      try{worker=new Worker(new URL('./atlas-worker.js',import.meta.url),{type:'module'});}catch{worker=null;finish();continue;}
      this.atlasWorkers.add(worker);
      worker.onmessage=e=>{
        for(const {key,bitmap} of e.data?.done||[]){if(this.alive!==false&&fillAtlas(key,bitmap))this.atlasReady(key);bitmap.close?.();}
        if(e.data?.end)finish();
      };
      worker.onerror=finish;
      worker.postMessage({looks:part});
    }
  }
  // Without a worker: a few strips per frame, never more than about 8 ms at a time.
  paintSlowly(looks){
    let i=0;
    const step=()=>{
      if(this.alive===false)return;
      const end=performance.now()+8;
      while(i<looks.length&&performance.now()<end){const look=looks[i++];if(atlasPending(look.key)){residentAtlas(look);this.atlasReady(look.key);}}
      if(i<looks.length)requestAnimationFrame(step);
    };
    if(looks.length)requestAnimationFrame(step);
  }

  // ---------- activity ----------
  // map: agentId -> {state,detail,verified,until}. Comes from the server with every state refresh.
  setActivity(map){this.activity=map||{};}
  busy(id){const a=this.activity?.[id];return !!a&&BUSY.has(a.state);}
  iconFor(entry){
    const a=this.activity?.[entry.agent.id];
    if(a&&!(a.until&&Date.now()>a.until))return this.icons[a.state==='done'?(a.verified?'verified':'unverified'):a.state]||null;
    return entry.agent.status==='working'?this.icons.thinking:null;
  }

  // ---------- task trails ----------
  // The path one piece of work takes from resident to resident, over bridges and the stair, across floors.
  // steps: [{agentId,status}] in order; status is done, running, waiting, failed or skipped.
  setTrail(trail,{focus=true}={}){
    this.clearTrail();
    const steps=(trail?.steps||[]).filter(x=>this.people.has(x.agentId));
    if(!steps.length)return false;
    const group=new T.Group();this.scene.add(group);
    const signs=new Map();
    steps.forEach((x,i)=>{let sg=signs.get(x.agentId);if(!sg){sg={agentId:x.agentId,nums:[]};signs.set(x.agentId,sg);}sg.nums.push(i+1);});
    for(const sg of signs.values()){
      const text=(sg.nums.join('+')+' '+this.people.get(sg.agentId).agent.name).toUpperCase(),map=this.signTexture(text,{color:'#fff1c8',bg:'#1a1408',border:'#f2c46f'});
      const k=this.ownedTextures.indexOf(map);if(k>=0)this.ownedTextures.splice(k,1);
      const sprite=new T.Sprite(new T.SpriteMaterial({map,depthTest:false,toneMapped:false,fog:false,sizeAttenuation:false}));sprite.scale.set(.15,.0375,1);sprite.renderOrder=6;group.add(sprite);sg.sprite=sprite;
    }
    const points=new T.Points(new T.BufferGeometry(),new T.PointsMaterial({size:.3,vertexColors:true,transparent:true,opacity:.95,depthTest:false,depthWrite:false,toneMapped:false,fog:false}));
    points.frustumCulled=false;points.renderOrder=4;group.add(points);
    this.trail={name:trail.name||'',steps,group,signs,points,built:0};this.buildTrail();
    if(focus){const first=steps.find(x=>x.status==='running')||steps.find(x=>x.status==='waiting')||steps[0];this.focusLevel(this.people.get(first.agentId).level);}
    return true;
  }
  clearTrail(){
    const tr=this.trail;if(!tr)return;this.trail=null;this.scene.remove(tr.group);
    tr.points.geometry.dispose();tr.points.material.dispose();for(const sg of tr.signs.values()){sg.sprite.material.map.dispose();sg.sprite.material.dispose();}
  }
  trailSpot(id){const e=this.people.get(id),p=e?.pose||e?.home;return p&&{level:e.visit?.level??e.level,angle:p.angle,radius:p.radius,pose:p};}
  buildTrail(){
    const tr=this.trail;if(!tr)return;tr.built=performance.now();
    const pos=[],col=[],c=new T.Color();
    tr.steps.forEach((x,i)=>{
      const to=this.trailSpot(x.agentId);if(!to)return;c.set(TRAIL_TONE[x.status]||TRAIL_TONE.waiting);
      const prev=i>0?tr.steps[i-1]:null,from=prev&&prev.agentId!==x.agentId?this.trailSpot(prev.agentId):null;
      if(from){
        // Walk the same route a courier takes and drop a dot every few steps.
        const walker={legs:this.routeLegs(from,to),leg:0,t:0};
        walker.legs.forEach((leg,j)=>{
          const len=leg.kind==='stair'?Math.abs(leg.ds)*40:leg.kind==='bridge'?Math.abs(leg.r1-leg.r0):Math.abs(leg.a1-leg.a0)*leg.r,n=Math.max(2,Math.ceil(len/.8));
          for(let k=0;k<=n;k++){walker.leg=j;walker.t=leg.time*k/n;this.placeCourier(walker);pos.push(walker.pose.x,walker.pose.y+.3,walker.pose.z);col.push(c.r,c.g,c.b);}
        });
      }
      for(let k=0;k<12;k++){const a=k/12*TAU;pos.push(to.pose.x+Math.sin(a)*.7,to.pose.y+.08,to.pose.z+Math.cos(a)*.7);col.push(c.r,c.g,c.b);}
    });
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('color',new T.Float32BufferAttribute(col,3));
    tr.points.geometry.dispose();tr.points.geometry=g;
  }
  tickTrail(people){
    const tr=this.trail;if(!tr)return;
    tr.group.visible=people&&this.mode!=='outside';if(!tr.group.visible)return;
    if(performance.now()-tr.built>1500)this.buildTrail();
    for(const sg of tr.signs.values()){const p=this.trailSpot(sg.agentId);sg.sprite.visible=!!p;if(p)sg.sprite.position.set(p.pose.x,p.pose.y+2.95,p.pose.z);}
  }

  // ---------- couriers ----------
  // A courier carries the folder from the resident who finished a step to the one who works on the next:
  // along the gallery to the bridge, over it to the spiral stair, up or down, then over the other bridge to the resident.
  dispatchCourier({fromId,toId,label,delay=0}={}){
    const to=this.people.get(toId);if(!to||fromId===toId)return null;
    while(this.couriers.size>=12)this.removeCourier(this.couriers.keys().next().value);
    const id='courier-'+(++this.courierSeq),look=appearanceFor({id:'courier-'+(this.courierSeq%5),floor:4,color:'#8c6b3e'});
    const map=this.atlasFor(look).clone();map.repeat.set(1/FRAMES,1);
    const material=new T.SpriteMaterial({map,alphaTest:.5,transparent:false,color:new T.Color(1.25,1.2,1.1)});
    const sprite=new T.Sprite(material);sprite.center.set(.5,0);sprite.scale.set(1.2,1.78,1);sprite.visible=false;this.scene.add(sprite);
    const folder=new T.Sprite(this.folderMaterial);folder.scale.set(.46,.32,1);folder.visible=false;this.scene.add(folder);
    // A faint amber outline drawn over walls and the stair core, so the courier stays readable behind them.
    const ghost=new T.Sprite(new T.SpriteMaterial({map,transparent:true,opacity:.42,depthTest:false,depthWrite:false,toneMapped:false,fog:false,color:new T.Color(2.2,1.3,.35),alphaTest:.5}));ghost.center.set(.5,0);ghost.scale.copy(sprite.scale);ghost.renderOrder=4;ghost.visible=false;this.scene.add(ghost);
    const tag=new T.Sprite(new T.SpriteMaterial({map:this.labelFor(label||('Folder for '+to.agent.name)),depthTest:false,toneMapped:false,fog:false,sizeAttenuation:false}));tag.scale.set(.15,.0375,1);tag.renderOrder=5;tag.visible=false;this.scene.add(tag);
    const from=this.people.get(fromId),walk=11,legs=[];
    const pose=to.pose||spatialResidentPose(to.level,to.index,this.motion.get(toId)||0),end=to.level;
    const arc=(level,r,a0,a1)=>legs.push({kind:'arc',level,r,a0,a1,time:clamp(Math.abs(a1-a0)*r/walk,.4,4.5)});
    const bridge=(level,r0,r1)=>legs.push({kind:'bridge',level,r0,r1,time:Math.abs(r1-r0)/walk});
    let start;
    if(from){
      const p=from.pose||spatialResidentPose(from.level,from.index,this.motion.get(fromId)||0);start=from.level;
      if(start===end){arc(start,p.radius,p.angle,p.angle+wrapAngle(pose.angle-p.angle));}
      else{arc(start,p.radius,p.angle,p.angle+wrapAngle(Math.PI-p.angle));bridge(start,p.radius,6.2);}
    }else start=1;
    if(start!==end||!from){
      const ds=end-start;if(ds)legs.push({kind:'stair',level:start,ds,time:clamp(Math.abs(ds)*.9,1.2,14)});
      bridge(end,6.2,pose.radius);arc(end,pose.radius,Math.PI,Math.PI+wrapAngle(pose.angle-Math.PI));
    }
    legs.push({kind:'hand',level:end,time:1.8});if(delay>0)legs.unshift({kind:'wait',level:start,time:delay});
    const entry={id,sprite,material,map,folder,tag,ghost,toId,fromId,legs,leg:0,t:0,walked:0,frame:-1,flip:null,level:start,pose:null,courier:true,finalArc:legs.map(l=>l.kind).lastIndexOf('arc')};
    this.couriers.set(id,entry);this.placeCourier(entry);return id;
  }
  removeCourier(id){
    const c=this.couriers.get(id);if(!c)return;
    this.scene.remove(c.sprite);this.scene.remove(c.folder);this.scene.remove(c.tag);this.scene.remove(c.ghost);c.material.dispose();c.map.dispose();c.tag.material.dispose();c.ghost.material.dispose();
    this.couriers.delete(id);
    // The camera rides on with the next courier that leaves from this resident, else it stays with the resident.
    if(this.followId===id){const next=[...this.couriers.values()].find(n=>n.fromId===c.toId);if(next)this.followId=next.id;else if(this.people.has(c.toId))this.followId=c.toId;else this.leaveFollow();}
  }
  followCourier(id){const c=this.couriers.get(id);if(!c)return false;if(this.mode==='outside')this.goInside(c.level);this.followId=id;this.target.focusY=physicalFloorY(c.level);this.setMode('follow');this.emitZoom();this.reportLevel();return true;}
  courierList(){return [...this.couriers.values()].map(c=>({id:c.id,toId:c.toId,fromId:c.fromId,level:c.level}));}
  // A walk from one spot on a gallery to another: along the gallery, over the bridge, the stair, the other bridge.
  routeLegs(from,to,walk=11,{arcMax=4.5,perLevel=.9,stairMax=14}={}){
    const legs=[],arc=(level,r,a0,a1)=>legs.push({kind:'arc',level,r,a0,a1,time:clamp(Math.abs(a1-a0)*r/walk,.4,arcMax)}),bridge=(level,r0,r1)=>legs.push({kind:'bridge',level,r0,r1,time:Math.abs(r1-r0)/walk});
    if(from.level===to.level){arc(from.level,from.radius,from.angle,from.angle+wrapAngle(to.angle-from.angle));return legs;}
    arc(from.level,from.radius,from.angle,from.angle+wrapAngle(Math.PI-from.angle));bridge(from.level,from.radius,6.2);
    legs.push({kind:'stair',level:from.level,ds:to.level-from.level,time:clamp(Math.abs(to.level-from.level)*perLevel,1.2,stairMax)});
    bridge(to.level,6.2,to.radius);arc(to.level,to.radius,Math.PI,Math.PI+wrapAngle(to.angle-Math.PI));
    return legs;
  }
  // Where a walk ends right now. Residents keep moving, so the last stretch aims at where they are.
  routeTarget(c,leg){
    if(c.courier){const p=this.people.get(c.toId)?.pose;return p&&{angle:p.angle-Math.sign(leg.a1-leg.a0||1)*.05,radius:p.radius};}
    if(c.visitor){
      if(c.back){const p=this.people.get(c.ownerId)?.home;return p&&{angle:p.angle,radius:p.radius};}
      const host=this.people.get(c.hostId),p=host?.visit?.pose||host?.pose;return p&&{angle:p.angle+c.slot,radius:Math.max(29.7,p.radius-.25)};
    }
    return null;
  }
  // Councils: residents asked for help walk to the asking resident and stand around them until they have answered.
  setMeetings(list){
    this.meetings=Array.isArray(list)?list:[];this.meetingsRetry=false;
    const want=new Map();
    for(const m of this.meetings)m.members.forEach((mid,i)=>want.set(mid,{hostId:m.hostId,slot:(i%2?1:-1)*(.075+Math.floor(i/2)*.06)}));
    for(const [pid,entry] of this.people){
      const w=want.get(pid),v=entry.visit;
      const here=v?.pose?{level:v.level,angle:v.pose.angle,radius:v.pose.radius}:entry.pose?{level:entry.level,angle:entry.pose.angle,radius:entry.pose.radius}:null;
      if(w&&v&&!v.back&&v.hostId===w.hostId)v.leaving=false;
      if(w&&(!v||v.back||v.hostId!==w.hostId)){
        const host=this.people.get(w.hostId);if(!host?.pose||!here){this.meetingsRetry=true;continue;}
        const hp=host.visit?.pose||host.pose,hl=host.visit?.level||host.level;
        const legs=[...this.routeLegs(here,{level:hl,angle:hp.angle+w.slot,radius:Math.max(29.7,hp.radius-.25)},16,{arcMax:2.6,perLevel:.45,stairMax:7}),{kind:'stay',level:hl,time:Infinity}];
        entry.visit={visitor:true,ownerId:pid,hostId:w.hostId,slot:w.slot,legs,leg:0,t:0,walked:0,level:here.level,pose:null,back:false,finalArc:legs.map(l=>l.kind).lastIndexOf('arc')};
        this.placeCourier(entry.visit);
      }else if(!w&&v&&!v.back){
        // A visitor stays at the table a few seconds after answering, so a short council is still seen.
        if(v.legs[v.leg]?.kind!=='stay'||v.t<3){v.leaving=true;continue;}
        const home=entry.home||entry.pose;if(!home||!here){delete entry.visit;continue;}
        const legs=this.routeLegs(here,{level:entry.level,angle:home.angle,radius:home.radius},16,{arcMax:2.6,perLevel:.45,stairMax:7});
        Object.assign(v,{legs,leg:0,t:0,back:true,finalArc:legs.map(l=>l.kind).lastIndexOf('arc')});
      }
    }
  }
  tickVisits(dt){
    for(const entry of this.people.values()){
      const v=entry.visit;if(!v)continue;
      if(!this.paused){v.t+=dt;v.walked+=dt;}
      while(v.leg<v.legs.length&&v.t>=v.legs[v.leg].time){v.t-=v.legs[v.leg].time;v.leg++;}
      if(v.leg>=v.legs.length){delete entry.visit;continue;}
      if(v.leaving&&!v.back&&v.legs[v.leg].kind==='stay'&&v.t>=3){v.leaving=false;this.setMeetings(this.meetings);}
      this.placeCourier(v);
      // Standing at the table, a visitor faces the host.
      const p=v.pose;if(!p.moving){const host=this.people.get(v.hostId)?.pose;if(host){p.dx=host.x-p.x;p.dz=host.z-p.z;}}
      entry.pose={...p,velocity:0};
    }
  }
  // The pulse of the silo: work makes the generator run faster, spending dims the lights, failures sound the alarm.
  setPulse(p){
    if(!p)return;this.pulse=p;const t=p.alarm?.time||0;
    if(this.alarmSeen!==undefined&&t&&t!==this.alarmSeen)this.alarmUntil=this.clock+9;
    this.alarmSeen=t;
    this.sectorPower=p.power||[1,1,1,1,1,1];
    const dt=p.dispatch?.time||0;
    if(this.dispatchSeen!==undefined&&dt&&dt!==this.dispatchSeen&&p.dispatch?.fromId&&p.dispatch?.toId)this.dispatchCourier({fromId:p.dispatch.fromId,toId:p.dispatch.toId,label:'Letter for '+(p.dispatch.toName||'resident')});
    this.dispatchSeen=dt;
    if(p.weather&&this.fogOutside){
      const c=clamp(p.weather.clarity??.5,0,1),green=p.weather.mode==='green'?1:smooth(.65,1,c);
      this.fogOutside.set('#7a6c55').lerp(new T.Color('#8ab4c4'),c);
      this.outsideSkyMat?.color.set('#ffffff').lerp(new T.Color('#8fd0f2'),c*.65);
      this.outsideTerrainMat?.color.set('#ffffff').lerp(new T.Color('#69a85f'),green*.75);
    }
  }
  // Where the courier is now: position, facing and the level it walks on.
  placeCourier(c){
    if(c.legs[c.leg].kind==='wait'){const leg=c.leg;c.leg++;const t=c.t;c.t=0;this.placeCourier(c);c.leg=leg;c.t=t;c.pose.moving=false;return;}
    const leg=c.legs[c.leg],f=leg.time?clamp(c.t/leg.time,0,1):1,to=this.people.get(c.toId);
    let x,y,z,dx=0,dz=0,level=leg.level;
    if(leg.kind==='arc'){
      let a1=leg.a1,r1=leg.r;const goal=c.leg===c.finalArc?this.routeTarget(c,leg):null;
      if(goal){a1=leg.a0+wrapAngle(goal.angle-leg.a0);r1=goal.radius;}
      const a=leg.a0+(a1-leg.a0)*f,r=leg.r+(r1-leg.r)*f;
      x=Math.sin(a)*r;z=Math.cos(a)*r;y=physicalFloorY(level)+FLOOR_TOP;const sgn=Math.sign(a1-leg.a0)||1;dx=Math.cos(a)*sgn;dz=-Math.sin(a)*sgn;
    }else if(leg.kind==='bridge'){
      const r=leg.r0+(leg.r1-leg.r0)*f;x=0;z=-r;y=physicalFloorY(level)+FLOOR_TOP;dz=leg.r1>leg.r0?-1:1;
    }else if(leg.kind==='stair'){
      // Smooth start and stop, quick in the middle.
      const e=f*f*(3-2*f),u=leg.ds*e,theta=Math.PI+(leg.level-1+u)*TAU;
      x=Math.sin(theta)*6.2;z=Math.cos(theta)*6.2;y=physicalFloorY(leg.level)-u*FLOOR_HEIGHT+FLOOR_TOP;level=levelAt(y-.5);
      const sgn=Math.sign(leg.ds);dx=Math.cos(theta)*sgn;dz=-Math.sin(theta)*sgn;
    }else{
      const prev=c.pose||{x:0,y:physicalFloorY(level)+FLOOR_TOP,z:-30};x=prev.x;y=prev.y;z=prev.z;
    }
    c.level=level;c.pose={x,y,z,angle:Math.atan2(x,z),radius:Math.hypot(x,z),dx,dz,moving:leg.kind!=='hand'&&leg.kind!=='stay'};
  }
  // An amber ring and a sign around a resident who holds a council.
  tickCouncils(lo,hi,people){
    const live=new Set();
    for(const m of this.meetings){
      const host=this.people.get(m.hostId);if(!host?.pose)continue;live.add(m.id);
      let mark=this.councilMarks.get(m.id);
      if(!mark){
        const ring=this.mesh(new T.RingGeometry(1.5,1.62,48),new T.MeshBasicMaterial({color:new T.Color(2.4,1.5,.4),transparent:true,opacity:.8,depthWrite:false,side:T.DoubleSide,toneMapped:false}));ring.rotation.x=-Math.PI/2;
        const label=new T.Sprite(new T.SpriteMaterial({map:this.labelFor('Council / '+(m.hostName||'')),depthTest:false,toneMapped:false,fog:false,sizeAttenuation:false}));label.scale.set(.17,.0425,1);label.renderOrder=5;
        this.scene.add(ring);this.scene.add(label);mark={ring,label};this.councilMarks.set(m.id,mark);
      }
      const p=host.visit?.pose||host.pose,lv=host.visit?.level??host.level,show=people&&lv>=lo&&lv<=hi;
      mark.ring.visible=mark.label.visible=show;if(!show)continue;
      mark.ring.position.set(p.x,p.y+.03,p.z);mark.ring.scale.setScalar(1+.04*Math.sin(this.clock*3));
      mark.label.position.set(p.x,p.y+3.05,p.z);
    }
    for(const [mid,mark] of this.councilMarks)if(!live.has(mid)){this.scene.remove(mark.ring);this.scene.remove(mark.label);mark.ring.material.dispose();mark.ring.geometry.dispose();mark.label.material.dispose();this.councilMarks.delete(mid);}
  }
  tickCouriers(dt,lo,hi,people,right){
    for(const c of [...this.couriers.values()]){
      if(!this.paused){c.t+=dt;c.walked+=dt;}
      while(c.leg<c.legs.length&&c.t>=c.legs[c.leg].time){c.t-=c.legs[c.leg].time;c.leg++;}
      if(c.leg>=c.legs.length){this.removeCourier(c.id);continue;}
      this.placeCourier(c);const p=c.pose,show=people&&c.level>=lo&&c.level<=hi&&c.legs[c.leg].kind!=='wait'&&this.clipPlane.distanceToPoint(p)>=0;
      c.sprite.visible=show;c.folder.visible=show;
      c.sprite.position.set(p.x,p.y,p.z);c.ghost.position.copy(c.sprite.position);
      const near=show&&this.camPos.distanceTo(c.sprite.position)<70;c.tag.visible=near;c.ghost.visible=near;
      if(!show)continue;
      const still=!p.moving||this.reduced,frame=still?FRAMES-1:Math.floor(c.walked*9)%4;
      const flip=still?(c.flip??false):(p.dx*right.x+p.dz*right.z)<0;
      if(frame!==c.frame||flip!==c.flip){c.frame=frame;c.flip=flip;c.map.repeat.x=(flip?-1:1)/FRAMES;c.map.offset.x=(flip?frame+1:frame)/FRAMES;}
      const leg=c.legs[c.leg];
      if(leg.kind==='hand'){
        // The folder moves from the courier's hands over to the resident.
        const to=this.people.get(c.toId)?.pose,k=smooth(.2,1.2,c.t);
        const tx=to?to.x:p.x,ty=to?to.y:p.y,tz=to?to.z:p.z;c.folder.position.set(mix(p.x,tx,k),mix(p.y+1.05,ty+1.9,k)+Math.sin(k*Math.PI)*.5,mix(p.z,tz,k));
        c.folder.material.opacity=1;c.folder.visible=c.t<1.5;
      }else c.folder.position.set(p.x+(flip?-.3:.3)*right.x,p.y+1.0+Math.abs(Math.sin(c.walked*9))*.05,p.z+(flip?-.3:.3)*right.z);
      c.tag.position.set(p.x,p.y+2.35,p.z);
    }
  }

  // ---------- input ----------
  installControls(){
    this.handlers={
      wheel:e=>this.onWheel(e),
      pointerdown:e=>{
        e.preventDefault();this.canvas.focus({preventScroll:true});this.canvas.setPointerCapture(e.pointerId);this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
        this.drag={x:e.clientX,y:e.clientY,yaw:this.target.yaw,focus:this.target.focusY,outY:this.target.outY,moved:false};
        if(this.pointers.size===2){const p=[...this.pointers.values()];this.pinch={distance:Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)||1};this.drag.moved=true;}
      },
      pointermove:e=>this.pointerMove(e),pointerup:e=>this.pointerUp(e),
      pointercancel:e=>{this.pointers.delete(e.pointerId);this.drag=null;this.pinch=null;},
      pointerleave:()=>{this.hover=null;},
      dblclick:e=>this.onDoubleClick(e)
    };
    for(const [name,handler] of Object.entries(this.handlers))this.canvas.addEventListener(name,handler,{passive:false});
  }
  onWheel(e){
    e.preventDefault();
    const unit=e.deltaMode===1?16:e.deltaMode===2?400:1,dy=clamp(e.deltaY*unit,-240,240),dx=clamp(e.deltaX*unit,-240,240);
    if(e.ctrlKey||e.metaKey){this.zoomBy(Math.exp(-dy*.0016));return;}
    if(Math.abs(dx)>Math.abs(dy)*1.5){this.rotateBy(dx*.003);return;}
    if(this.mode==='outside'){const s=Math.max(1,this.target.outDist/80);this.target.outY=clamp(this.target.outY-dy*.03*s,EARTH_BOTTOM+40,GROUND_Y+30);this.reportLevel();return;}
    this.leaveFollow();this.target.focusY=clamp(this.target.focusY-dy*.03,BOTTOM_Y,0);this.reportLevel();
  }
  pointerMove(e){
    if(this.drag){
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(this.pointers.size===2&&this.pinch){const p=[...this.pointers.values()],distance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)||1;this.zoomBy(distance/this.pinch.distance);this.pinch.distance=distance;return;}
      if(!this.drag.moved){
        if(Math.abs(e.clientX-this.drag.x)+Math.abs(e.clientY-this.drag.y)<=5)return;
        this.drag.moved=true;this.leaveFollow();Object.assign(this.drag,{x:e.clientX,y:e.clientY,yaw:this.target.yaw,focus:this.target.focusY,outY:this.target.outY});
      }
      const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;
      this.target.yaw=this.drag.yaw-dx*.005;
      if(this.mode==='outside')this.target.outY=clamp(this.drag.outY+dy*.05*Math.max(1,this.target.outDist/80),EARTH_BOTTOM+40,GROUND_Y+30);
      else this.target.focusY=clamp(this.drag.focus+dy*.05,BOTTOM_Y,0);
      this.reportLevel();
    }else{
      if(performance.now()-(this.lastHover||0)<90)return;this.lastHover=performance.now();
      const hit=this.pick(e);this.canvas.style.cursor=hit?'pointer':'grab';this.hover=hit?.userData.agentId||null;
    }
  }
  pointerUp(e){
    this.pointers.delete(e.pointerId);if(!this.drag)return;
    if(!this.drag.moved){const hit=this.pick(e);if(hit?.userData.view)this.onTerminal?.(hit.userData.view);else if(hit){const a=this.agents.find(a=>a.id===hit.userData.agentId);if(a)this.onSelect?.(a);}}
    if(this.pointers.size<2)this.pinch=null;
    if(!this.pointers.size){this.drag=null;return;}
    // One finger left after a pinch: continue the drag from where that finger is now.
    const p=[...this.pointers.values()][0];Object.assign(this.drag,{x:p.x,y:p.y,yaw:this.target.yaw,focus:this.target.focusY,outY:this.target.outY,moved:true});
  }
  onDoubleClick(e){
    e.preventDefault();
    const hit=this.pick(e);
    if(hit?.userData.agentId){const a=this.agents.find(a=>a.id===hit.userData.agentId);if(a){this.onSelect?.(a);this.focusAgent(a);}return;}
    const level=this.pickLevel(e);if(!level)return;
    if(this.mode==='outside')this.goInside(level);else this.focusLevel(level);
  }
  setPointer(e){
    const r=this.canvas.getBoundingClientRect();let u=(e.clientX-r.left)/r.width,v=1-(e.clientY-r.top)/r.height;
    if(this.post&&this.crtLevel>0){const k=.1*this.crtLevel,cx=u-.5,cy=v-.5,f=(1+k*(cx*cx+cy*cy))/(1+k*.5);u=.5+cx*f;v=.5+cy*f;}
    this.pointer.set(u*2-1,v*2-1);this.raycaster.setFromCamera(this.pointer,this.camera);
  }
  unclipped(p){return this.clipC>1e4||this.clipDir.x*p.x+this.clipDir.z*p.z<=this.clipC+.05;}
  shown(o){return o.visible&&(o.parent===this.scene||o.parent?.visible!==false);}
  pick(e){
    if(this.drag?.moved)return null;
    this.setPointer(e);this.raycaster.far=this.camR>33?6000:110;
    const hit=this.raycaster.intersectObjects(this.sprites.filter(s=>s.visible),false).find(h=>this.unclipped(h.point));
    if(!hit){this.raycaster.far=Infinity;return null;}
    this.raycaster.far=Math.max(0,hit.distance-.1);
    const person=!!hit.object.userData.agentId,blocked=this.raycaster.intersectObjects(this.occluders.filter(o=>this.shown(o)&&!(person&&o.userData.seeThrough)),false).some(h=>this.unclipped(h.point));
    this.raycaster.far=Infinity;return blocked?null:hit.object;
  }
  pickLevel(e){
    this.setPointer(e);this.raycaster.far=this.camR>33?6000:160;
    const hit=this.raycaster.intersectObjects(this.floorMeshes.filter(f=>this.shown(f)),false).find(h=>this.unclipped(h.point));
    this.raycaster.far=Infinity;return hit?.object.userData.level||0;
  }

  // ---------- camera ----------
  get zoom(){return this.target?.zoom??1;}
  transition(seconds=1.4){this.blend=seconds;this.blendMax=seconds;}
  setMode(mode){if(this.mode!==mode){this.mode=mode;this.transition();}this.canvas.dataset.cameraMode=mode;}
  emitZoom(){this.onZoom?.(this.mode==='outside'?(this.target.outDist>700?'SILO':'OUT'):this.mode==='follow'?'CLOSE':Math.round(this.target.zoom*100));}
  reportLevel(force=false){
    const level=levelAt(this.mode==='outside'?this.target.outY:this.target.focusY);
    if(level===this.level&&!force)return;this.level=level;this.onLevel?.(level);
    const floor=sectorForLevel(level);if(floor!==this.floor||force){this.floor=floor;this.onFloor?.(floor);}
  }
  leaveFollow(){
    if(this.mode!=='follow')return;
    const yaw=Math.atan2(this.camPos.x,this.camPos.z),entry=this.people.get(this.followId)||this.couriers.get(this.followId);
    this.view.yaw=this.target.yaw=this.view.yaw+wrapAngle(yaw-this.view.yaw);
    if(entry)this.view.focusY=this.target.focusY=physicalFloorY(entry.level);
    this.view.zoom=this.target.zoom=2.2;this.followId=null;this.setMode('orbit');this.emitZoom();
  }
  goOutside(distance=OUT_NEAR){
    this.leaveFollow();
    if(this.mode!=='outside'){this.target.outY=this.view.outY=this.view.focusY+1.5;this.view.outDist=Math.max(OUT_MIN,this.camR);}
    this.target.outDist=clamp(distance,OUT_MIN,OUT_MAX);this.setMode('outside');this.emitZoom();this.reportLevel(true);
  }
  goInside(level){
    level=clamp(Math.round(level||levelAt(this.target.outY)),1,LEVELS);
    this.target.focusY=this.view.focusY=physicalFloorY(level);this.target.zoom=ZOOM_MIN+.2;this.view.zoom=ZOOM_MIN;
    this.setMode('orbit');this.emitZoom();this.reportLevel(true);
  }
  zoomBy(factor){
    if(!(factor>0)||factor===1)return;
    const now=performance.now();if(now-this.pushAt>500)this.push=0;this.pushAt=now;
    if(this.mode==='outside'){
      if(factor>1&&this.target.outDist<=OUT_MIN*1.02){this.push+=Math.log(factor);if(this.push>.2){this.push=0;this.goInside();}return;}
      this.push=0;this.target.outDist=clamp(this.target.outDist/factor,OUT_MIN,OUT_MAX);this.emitZoom();return;
    }
    this.leaveFollow();
    if(factor<1&&this.target.zoom<=ZOOM_MIN*1.01){this.push-=Math.log(factor);if(this.push>.2){this.push=0;this.goOutside();}return;}
    this.push=0;this.target.zoom=clamp(this.target.zoom*factor,ZOOM_MIN,ZOOM_MAX);this.emitZoom();
  }
  setZoom(zoom){if(this.mode==='outside')this.goInside();this.leaveFollow();this.target.zoom=clamp(zoom,ZOOM_MIN,ZOOM_MAX);this.emitZoom();}
  rotateBy(angle){this.leaveFollow();this.target.yaw+=angle;}
  release(){if(this.mode==='follow'){this.leaveFollow();return true;}if(this.mode==='outside'){this.goInside();return true;}return false;}
  focusLevel(level){
    level=clamp(Math.round(level),1,LEVELS);
    if(this.mode==='outside'){this.goInside(level);return;}
    this.leaveFollow();this.target.focusY=physicalFloorY(level);this.reportLevel();
  }
  focus(f){this.focusLevel(SECTORS[f].home);}
  focusAgent(agent){
    if(!this.people.has(agent.id))return;
    this.followId=agent.id;this.target.focusY=physicalFloorY(clamp(agent.level||SECTORS[agent.floor]?.home||1,1,LEVELS));
    this.setMode('follow');this.emitZoom();this.reportLevel();
  }
  reset(){
    if(this.mode==='outside')this.goInside(4);this.leaveFollow();
    this.target.yaw=this.view.yaw+wrapAngle(.2-this.view.yaw);this.target.zoom=1;this.target.focusY=physicalFloorY(4);this.emitZoom();this.reportLevel();
  }
  overview(){
    if(this.mode==='outside'&&this.target.outDist>700){this.goInside();return;}
    if(this.mode==='outside'){this.target.outDist=OUT_FAR;this.emitZoom();return;}
    this.goOutside(OUT_FAR);
  }

  // ---------- frame ----------
  tick(dt){
    const V=this.view,G=this.target,k=1-Math.exp(-dt*8);
    V.focusY+=(G.focusY-V.focusY)*k;V.yaw+=(G.yaw-V.yaw)*k;V.zoom+=(G.zoom-V.zoom)*k;V.outY+=(G.outY-V.outY)*k;
    V.outDist=Math.exp(Math.log(V.outDist)+(Math.log(G.outDist)-Math.log(V.outDist))*k);
    for(const entry of this.people.values()){entry.t=this.motion.get(entry.agent.id)||0;entry.pose=entry.home=spatialResidentPose(entry.level,entry.index,entry.t);}
    if(this.meetingsRetry)this.setMeetings(this.meetings);
    this.tickVisits(dt);

    // Where the camera wants to be in the current mode.
    const want=this.wantPos,look=this.wantLook;let fov,anchorY;
    let followEntry=this.mode==='follow'?this.people.get(this.followId)||this.couriers.get(this.followId):null;
    if(this.mode==='follow'&&!followEntry){this.followId=null;this.setMode('orbit');this.emitZoom();}
    if(this.mode==='follow'){
      // Travel down the open shaft first, then step onto the gallery next to the resident.
      const p=followEntry.pose,near=smooth(16,3,Math.abs(this.camPos.y-(p.y+1.9)));
      if(followEntry.courier&&p.radius<24){
        // On the bridge or the stair: watch from the open shaft without circling with the stair.
        const yaw=Math.atan2(this.camPos.x,this.camPos.z),r=p.radius<9?16:clamp(p.radius-6,15,22);
        want.set(Math.sin(yaw)*r,p.y+2.6,Math.cos(yaw)*r);
      }else{const angle=p.angle-.16,radius=mix(22.5,p.radius-.4,near);want.set(Math.sin(angle)*radius,p.y+1.9,Math.cos(angle)*radius);}
      look.set(p.x,p.y+1,p.z);fov=52;anchorY=p.y;
    }else if(this.mode==='outside'){
      // Close: level with the chosen floor. Far: above the plain, looking down at the cut and the other silos.
      const d=V.outDist,f=smooth(260,1100,d),h=mix(Math.cos(.2)*d,d*.94,f),y=mix(V.outY+Math.sin(.2)*d,GROUND_Y+d*.1,f),ly=mix(V.outY,-420,f);
      want.set(Math.sin(V.yaw)*h,y,Math.cos(V.yaw)*h);look.set(0,ly,0);fov=mix(50,54,f);anchorY=V.outY;
    }else{
      const z=V.zoom,radius=z<1?clamp(23/z,23,27.2):23;
      fov=z>1?2*T.MathUtils.radToDeg(Math.atan(Math.tan(T.MathUtils.degToRad(32))/z)):64+(1-z)*40;
      // Circling the shaft the camera passes over a walled bridge for a few degrees: it rises over the walls there
      // and looks down the bridge instead of along the inside of it.
      const bridge=Math.cos(V.yaw)<0?smooth(2.8,1.2,Math.abs(Math.sin(V.yaw)*radius)):0;
      want.set(Math.sin(V.yaw)*radius,V.focusY+7.2+bridge*2.4,Math.cos(V.yaw)*radius);
      look.set(-Math.sin(V.yaw)*(z-1)*4,V.focusY-5.5+(Math.min(z,3)-1)*2.2,-Math.cos(V.yaw)*(z-1)*4);anchorY=V.focusY;
    }
    if(!this.camReady){this.camPos.copy(want);this.camLook.copy(look);this.camFov=fov;this.camReady=true;}
    else{
      this.blend=Math.max(0,this.blend-dt);const b=this.blend/this.blendMax,rate=mix(this.mode==='follow'?7:16,2.4,b*b),a=1-Math.exp(-dt*rate);
      this.camPos.lerp(want,a);this.camLook.lerp(look,a);this.camFov+=(fov-this.camFov)*a;
    }
    const cam=this.camera,camR=this.camR=Math.hypot(this.camPos.x,this.camPos.z),outside=camR>33;
    cam.position.copy(this.camPos);cam.lookAt(this.camLook);
    const near=outside?clamp(camR*.012,.1,14):.1,far=outside?9000:1400;
    if(Math.abs(cam.fov-this.camFov)>.01||cam.near!==near||cam.far!==far){cam.fov=this.camFov;cam.near=near;cam.far=far;cam.updateProjectionMatrix();}
    cam.updateMatrixWorld();

    // Cutaway: once the camera leaves the shaft, everything between it and the cut is removed.
    if(outside){this.clipDir.set(this.camPos.x/camR,0,this.camPos.z/camR);this.clipC=clamp(34.4-(camR-33)*.32,0,34.4);}else this.clipC=1e5;
    this.clipPlane.normal.set(-this.clipDir.x,0,-this.clipDir.z);this.clipPlane.constant=this.clipC;
    this.outside.visible=outside;this.updateCap();

    // Air, fog and light change between the galleries, the machine hall and the surface.
    const anchorLevel=this.anchorLevel=levelAt(anchorY),o=smooth(33,90,camR),deep=smooth(118,141,anchorLevel);
    const fog=this.scene.fog;fog.color.copy(this.fogInside).lerp(this.fogBottom,deep*(1-o)).lerp(this.fogOutside,o);
    fog.density=mix(mix(.0105,.012,deep),.00024,o)*mix(1,.5,smooth(400,1400,camR));this.scene.background.copy(fog.color).multiplyScalar(mix(.7,1,o));
    this.sun.intensity=2.4*o;this.key.intensity=1.6*(1-o*.5);

    // Chunks near the camera are drawn. From far outside everything is drawn without small props.
    let lo,hi;
    if(outside){if(camR>FAR_VIEW){lo=1;hi=LEVELS;}else{const span=Math.ceil(camR*.5/FLOOR_HEIGHT)+5;lo=anchorLevel-span;hi=anchorLevel+span;}}
    else{const camLevel=levelAt(this.camPos.y-FLOOR_HEIGHT);lo=camLevel-6;hi=camLevel+30;}
    for(const chunk of this.chunks)chunk.visible=chunk.userData.last>=lo&&chunk.userData.first<=hi;
    const detail=camR<FAR_VIEW&&!this.background&&!this.lowQuality;for(const mesh of this.detailMeshes)mesh.visible=detail;
    this.bottomGroup.visible=hi>=LEVELS-12;

    // Lamp pools follow the camera: real light sources snapped to the nearest wall lamps.
    const camYaw=Math.atan2(this.camPos.x,this.camPos.z);
    this.lampLights.forEach((light,i)=>{const lv=clamp(anchorLevel+(i%2),1,LEVELS),offset=(Math.floor(i/2)-1.5)*.62,raw=camYaw+Math.PI+offset,snapped=Math.round(raw/TAU*BAYS)/BAYS*TAU;light.userData.sector=sectorForLevel(lv);light.position.set(Math.sin(snapped)*31.4,physicalFloorY(lv)+3.2,Math.cos(snapped)*31.4);light.color.copy(this.lampColor).lerp(this.lampWarm,deep);});
    this.stairLights.forEach((light,i)=>{const a=camYaw+(i-1)*1.9;light.position.set(Math.sin(a)*9.5,anchorY+1.5-i*4,Math.cos(a)*9.5);});
    this.key.position.set(10,anchorY+34,8);this.key.target.position.set(0,anchorY-10,0);this.key.target.updateMatrixWorld();

    // Residents.
    const right=new T.Vector3().setFromMatrixColumn(cam.matrixWorld,0),people=camR<FAR_VIEW;
    let shadowCount=0,ringCount=0;const hoverId=this.hover,selectedId=this.selected;let selectedPose=null,hoverPose=null;
    for(const entry of this.people.values()){
      const {agent,sprite,map,pose,t}=entry,lv=entry.visit?.level??entry.level;
      // A resident whose feet are in the cut-away half has no floor under them there: hide them, sprite and all.
      const visible=people&&lv>=lo&&lv<=hi&&!!pose&&this.clipPlane.distanceToPoint(pose)>=0;sprite.visible=visible;
      if(visible){
        sprite.position.set(pose.x,pose.y,pose.z);
        // Seen from under their floor, the parapet would let a resident show through the slab as well: no ghost then.
        const above=cam.position.y>pose.y+.3;entry.seen.visible=above;
        const still=((agent.status==='working'||this.busy(agent.id))&&!entry.visit)||this.paused||this.reduced||!pose.moving;
        const frame=still?FRAMES-1:Math.floor(t*6)%4;
        const tx=pose.dx??Math.cos(pose.angle)*Math.sign(pose.velocity||1),tz=pose.dz??-Math.sin(pose.angle)*Math.sign(pose.velocity||1);
        const flip=still?(entry.flip??false):(tx*right.x+tz*right.z)<0;
        if(frame!==entry.frame||flip!==entry.flip){entry.frame=frame;entry.flip=flip;map.repeat.x=(flip?-1:1)/FRAMES;map.offset.x=(flip?frame+1:frame)/FRAMES;}
        // Floor decals sit on top of the slab; from under it their depth offset would let them show through.
        if(above&&shadowCount<MAX_PEOPLE){this.dummy.position.set(pose.x,pose.y+.004,pose.z);this.dummy.rotation.set(0,0,0);this.dummy.scale.set(1,1,1);this.dummy.updateMatrix();this.shadows.setMatrixAt(shadowCount++,this.dummy.matrix);}
        if(above&&agent.provider!=='demo'&&ringCount<MAX_PEOPLE){this.dummy.position.set(pose.x,pose.y+.008,pose.z);this.dummy.rotation.set(0,0,0);this.dummy.scale.set(1,1,1);this.dummy.updateMatrix();this.liveRings.setMatrixAt(ringCount++,this.dummy.matrix);}
        const icon=this.iconFor(entry);
        if(icon){
          if(!entry.bubble){entry.bubble=new T.Sprite(icon);this.scene.add(entry.bubble);}
          if(entry.bubble.material!==icon)entry.bubble.material=icon;
          // Waiting for you pulses, so it is the first thing you notice.
          const k=icon===this.icons.approval?1+.16*Math.sin(this.clock*6):1;entry.bubble.scale.set(.66*k,.44*k,1);
          entry.bubble.visible=true;entry.bubble.position.set(pose.x,pose.y+2.3+Math.sin(this.clock*4)*.05,pose.z);
        }else if(entry.bubble)entry.bubble.visible=false;
      }else if(entry.bubble)entry.bubble.visible=false;
      if(agent.id===selectedId)selectedPose=visible?pose:null;
      if(agent.id===hoverId)hoverPose=visible?pose:null;
    }
    this.tickCouriers(dt,lo,hi,people,right);
    this.tickCouncils(lo,hi,people);
    this.tickTrail(people);
    this.liveRings.count=ringCount;this.liveRings.instanceMatrix.needsUpdate=true;
    for(const c of this.couriers.values())if(c.sprite.visible&&cam.position.y>c.pose.y+.3&&shadowCount<MAX_PEOPLE){this.dummy.position.set(c.pose.x,c.pose.y+.004,c.pose.z);this.dummy.rotation.set(0,0,0);this.dummy.scale.set(1,1,1);this.dummy.updateMatrix();this.shadows.setMatrixAt(shadowCount++,this.dummy.matrix);}
    this.shadows.count=shadowCount;this.shadows.instanceMatrix.needsUpdate=true;
    const mark=(marker,label,pose,id)=>{
      marker.visible=!!pose;label.visible=!!pose;if(!pose)return;
      marker.position.set(pose.x,pose.y+.01,pose.z);label.position.set(pose.x,pose.y+2.55,pose.z);
      const ag=this.people.get(id)?.agent,name=ag?(ag.provider==='demo'?ag.name+' / demo':ag.name):'';const map=this.labelFor(name);if(label.material.map!==map){label.material.map=map;label.material.needsUpdate=true;}
    };
    mark(this.selectMarker,this.selectLabel,selectedPose,selectedId);
    mark(this.hoverMarker,this.hoverLabel,hoverId!==selectedId?hoverPose:null,hoverId);

    // The machine hall: engine, beacon, alarm, steam. Lights fade out when the camera is far from the bottom.
    const hall=this.bottomGroup.visible?smooth(108,132,anchorLevel)*(1-smooth(500,900,camR)*.5):0,time=this.clock;
    this.beaconLight.intensity=hall*170;this.alarmLight.intensity=hall*(16+14*Math.sin(time*2.2));for(const heat of this.heats)heat.intensity=hall*heat.userData.power;
    const sweep=time*2.4;this.beaconLight.target.position.set(this.beaconAt.x+Math.sin(sweep)*12,BOTTOM_Y,this.beaconAt.z+Math.cos(sweep)*12);this.beaconLight.target.updateMatrixWorld();
    this.beaconMaterial.color.setRGB(4,2.4,.6).multiplyScalar(.55+.45*Math.max(0,Math.sin(sweep*2)));
    this.alarmMaterial.color.copy(this.alarmBase).multiplyScalar(.45+.55*(.5+.5*Math.sin(time*2.2)));this.alarmGlow.opacity=.35+.4*(.5+.5*Math.sin(time*2.2));
    this.coilMaterial.color.copy(this.coilBase).multiplyScalar((.75+.25*Math.sin(time*3.1)+.06*Math.sin(time*17))*(.7+this.load*.9));
    // Spending near the limit: the silo saves power. Lamps dim, and flicker in the last tenth.
    const budget=this.pulse?.budget||0,flick=budget>.9&&Math.sin(time*23)*Math.sin(time*7.3)>.55;
    const power=(1-.55*smooth(.7,1,budget))*(flick?.35:1),alarm=this.alarmUntil>time;
    for(const light of this.lampLights){const sp=this.sectorPower?.[light.userData.sector||0]??1;light.intensity=38*power*(sp?1:.18);}
    this.stairLights.forEach((light,i)=>{if(alarm){light.color.setRGB(1,.12,.05);light.intensity=60*(.5+.5*Math.sin(time*9+i));}else{light.color.set('#ffc27a');light.intensity=26*power;}});
    if(alarm){this.alarmLight.intensity=Math.max(this.alarmLight.intensity,90*(.5+.5*Math.sin(time*9)));}
    this.blinker.color.copy(this.blinkerBase).multiplyScalar(Math.sin(time*3)>.4?1:.08);

    // Ambient motion.
    if(!this.paused&&!this.reduced){
      const pl=this.pulse||{},want=clamp(Math.log10(1+(pl.tpm||0))/4.2+(pl.working||0)*.035,0,1);this.load+=(want-this.load)*(1-Math.exp(-dt*.7));
      const speed=.35+2.1*this.load;
      for(const ray of this.rays)ray.material.map.offset.x+=dt*ray.userData.speed*3/TAU;
      if(this.bottomGroup.visible){
        this.flywheel.rotation.y+=dt*1.2*speed;
        const arr=this.steam.geometry.attributes.position.array,src=this.steamSources;
        for(let i=0;i<this.steamLife.length;i++){
          let life=this.steamLife[i]+dt*(.1+(i%7)*.012);if(life>1)life-=1;this.steamLife[i]=life;
          const s=src[i%src.length],tall=i%src.length<1?22:7,drift=(random(i*3.1)-.5)*6;
          arr[i*3]=s[0]+drift*life+Math.sin(time*.7+i)*.4*life;arr[i*3+1]=s[1]+life*tall;arr[i*3+2]=s[2]+(random(i*5.7)-.5)*4*life;
        }
        this.steam.geometry.attributes.position.needsUpdate=true;
      }
      if(!outside){
        const pos=this.dust.geometry.attributes.position,arr=pos.array;
        for(let i=0;i<arr.length/3;i++){arr[i*3+1]-=dt*(.12+(i%5)*.03);arr[i*3]+=Math.sin(this.clock*.3+this.dustSeed[i])*dt*.05;if(arr[i*3+1]<-48)arr[i*3+1]+=48;}
        pos.needsUpdate=true;
      }
    }
    this.dust.position.y=anchorY+10;this.dust.visible=!outside;
    this.crtLevel+=((this.crt?1:0)-this.crtLevel)*Math.min(1,dt*6);
    this.canvas.dataset.cameraState=this.camPos.distanceTo(want)>.3?'travelling':'settled';
  }
  // ---------- surveillance cameras ----------
  // A camera spec: {kind:'gallery'|'shaft'|'hall'|'outside', level, angle, pan, tilt, zoom}.
  feedPose(spec){
    const level=clamp(Math.round(spec.level||1),1,LEVELS),a=spec.angle||0,pan=spec.pan||0,tilt=spec.tilt||0,pos=new T.Vector3();
    let heading,pitch,fov,lo=level-1,hi=level+3,outside=false;
    if(spec.kind==='outside'){pos.copy(this.lensWorld).add(new T.Vector3(Math.sin(this.lensHeading)*.4,0,Math.cos(this.lensHeading)*.4));heading=this.lensHeading+.12+pan;pitch=.025+tilt;fov=46;outside=true;lo=hi=0;}
    else if(spec.kind==='shaft'){pos.set(Math.sin(a)*27.3,physicalFloorY(level)+5.2,Math.cos(a)*27.3);heading=a+Math.PI+pan;pitch=-.62+tilt;fov=62;hi=level+22;}
    else if(spec.kind==='hall'){const y=physicalFloorY(LEVELS-3)+4.4;pos.set(Math.sin(a)*27.2,y,Math.cos(a)*27.2);const dx=-pos.x,dy=BOTTOM_Y+4-y,dz=15-pos.z;heading=Math.atan2(dx,dz)+pan;pitch=Math.atan2(dy,Math.hypot(dx,dz))+tilt;fov=58;lo=LEVELS-5;hi=LEVELS;}
    else{const rad=spec.radius||32;pos.set(Math.sin(a)*rad,physicalFloorY(level)+4.5,Math.cos(a)*rad);heading=a+Math.PI+1+(spec.turn||0)+pan;pitch=-.3+tilt;fov=68;}
    pitch=clamp(pitch,-1.45,1.2);
    const look=pos.clone().add(new T.Vector3(Math.sin(heading)*Math.cos(pitch),Math.sin(pitch),Math.cos(heading)*Math.cos(pitch)));
    return {pos,look,fov:fov/clamp(spec.zoom||1,1,4),outside,lo:Math.max(1,lo),hi:Math.min(LEVELS,hi),level:spec.kind==='hall'?LEVELS:level};
  }
  aimFeed(P,aspect){const cam=this.feedCamera;cam.fov=P.fov;cam.aspect=aspect;cam.near=P.outside?.4:.1;cam.far=P.outside?9000:420;cam.updateProjectionMatrix();cam.position.copy(P.pos);cam.lookAt(P.look);cam.updateMatrixWorld();return cam;}
  // Renders one camera into a small target and returns its pixels (bottom row first).
  // Restores all mutated scene state in finally so pointer/raycast interactions between frames see the main view.
  captureFeed(spec,w,h,async=false){
    const r=this.renderer,P=this.feedPose(spec),key=w+'x'+h;
    let slot=this.feedTargets.get(key);
    if(!slot){slot={target:new T.WebGLRenderTarget(w,h,{type:T.UnsignedByteType,depthBuffer:true,stencilBuffer:true}),pixels:new Uint8Array(w*h*4)};this.feedTargets.set(key,slot);}
    const cam=this.aimFeed(P,w/h);
    const fog=this.scene.fog,markers=this.feedMarkers||=[this.selectMarker,this.hoverMarker,this.selectLabel,this.hoverLabel];
    // The scene state the camera changes is kept in buffers reused from capture to capture, so a camera running many
    // times a second with many residents makes no garbage. Only what is there now is stored: lengths are set each time.
    const saved=this.feedSaved||={chunkVis:[],detailVis:[],markers:[],councils:[],heatInts:[],lamps:[],stairs:[],people:[],couriers:[],fogColor:new T.Color(),bgColor:new T.Color()};
    saved.clipConstant=this.clipPlane.constant;saved.outsideVisible=this.outside.visible;saved.bottomVisible=this.bottomGroup.visible;saved.dustVisible=this.dust.visible;
    saved.fogColor.copy(fog.color);saved.fogDensity=fog.density;saved.bgColor.copy(this.scene.background);
    saved.sunInt=this.sun.intensity;saved.keyInt=this.key.intensity;saved.beaconInt=this.beaconLight.intensity;saved.alarmInt=this.alarmLight.intensity;saved.autoShadow=r.shadowMap.autoUpdate;
    saved.chunkVis.length=0;for(const c of this.chunks)saved.chunkVis.push(c.visible);
    saved.detailVis.length=0;for(const m of this.detailMeshes)saved.detailVis.push(m.visible);
    saved.markers.length=0;for(const o of markers)saved.markers.push(o.visible);
    saved.heatInts.length=0;for(const ht of this.heats)saved.heatInts.push(ht.intensity);
    this.lampLights.forEach((l,i)=>{const s=saved.lamps[i]||={pos:new T.Vector3(),col:new T.Color()};s.pos.copy(l.position);s.col.copy(l.color);});
    this.stairLights.forEach((l,i)=>{(saved.stairs[i]||=new T.Vector3()).copy(l.position);});
    let n=0;for(const m of this.councilMarks.values()){const s=saved.councils[n++]||={};s.m=m;s.ring=m.ring.visible;s.label=m.label.visible;}saved.councilCount=n;
    n=0;for(const e of this.people.values()){const s=saved.people[n++]||={pos:new T.Vector3(),bPos:new T.Vector3()};s.e=e;s.vis=e.sprite.visible;s.pos.copy(e.sprite.position);s.bVis=e.bubble?e.bubble.visible:false;if(e.bubble)s.bPos.copy(e.bubble.position);}saved.peopleCount=n;
    n=0;for(const c of this.couriers.values()){const s=saved.couriers[n++]||={};s.c=c;s.sVis=c.sprite.visible;s.fVis=c.folder.visible;s.tVis=c.tag.visible;s.gVis=c.ghost.visible;}saved.courierCount=n;
    let read=null;
    try{
      this.clipPlane.constant=1e5;this.outside.visible=P.outside;
      for(const c of this.chunks)c.visible=!P.outside&&c.userData.last>=P.lo&&c.userData.first<=P.hi;
      for(const mesh of this.detailMeshes)mesh.visible=!this.lowQuality;
      this.bottomGroup.visible=!P.outside&&P.hi>=LEVELS-12;this.dust.visible=false;
      for(const o of markers)o.visible=false;
      for(const m of this.councilMarks.values()){if(P.outside){m.ring.visible=false;m.label.visible=false;}}
      const deep=smooth(118,141,P.level);
      if(P.outside){fog.color.copy(this.fogOutside);fog.density=.00028;}else{fog.color.copy(this.fogInside).lerp(this.fogBottom,deep);fog.density=mix(.009,.011,deep);}
      this.scene.background.copy(fog.color);this.sun.intensity=P.outside?2.4:0;this.key.intensity=P.outside?.8:1.6;
      const yaw=Math.atan2(P.pos.x,P.pos.z),anchorY=physicalFloorY(P.level);
      this.lampLights.forEach((light,i)=>{const lv=clamp(P.level+(i===7?1:0),1,LEVELS),raw=yaw+(i<5?.35-i*.35:Math.PI+(i-6)*.5),snapped=Math.round(raw/TAU*BAYS)/BAYS*TAU;light.position.set(Math.sin(snapped)*31.4,physicalFloorY(lv)+3.2,Math.cos(snapped)*31.4);light.color.copy(this.lampColor).lerp(this.lampWarm,deep);});
      this.stairLights.forEach((light,i)=>{const s=yaw+(i-1)*1.9;light.position.set(Math.sin(s)*9.5,anchorY+1.5-i*4,Math.cos(s)*9.5);});
      const hall=this.bottomGroup.visible?smooth(108,132,P.level):0;this.beaconLight.intensity=hall*170;this.alarmLight.intensity=hall*(16+14*Math.sin(this.clock*2.2));for(const heat of this.heats)heat.intensity=hall*heat.userData.power;
      for(const e of this.people.values()){
        const elv=e.visit?.level??e.level,show=!P.outside&&!!e.pose&&elv>=P.lo&&elv<=P.hi;e.sprite.visible=show;
        if(show)e.sprite.position.set(e.pose.x,e.pose.y,e.pose.z);
        if(e.bubble){e.bubble.visible=show&&!!this.iconFor(e);if(e.bubble.visible)e.bubble.position.set(e.pose.x,e.pose.y+2.3,e.pose.z);}
      }
      for(const c of this.couriers.values()){const show=!P.outside&&!!c.pose&&c.level>=P.lo&&c.level<=P.hi&&c.legs[c.leg]?.kind!=='wait';c.sprite.visible=show;c.folder.visible=show&&c.legs[c.leg]?.kind!=='hand';c.tag.visible=false;c.ghost.visible=false;}
      r.shadowMap.autoUpdate=false;
      r.setRenderTarget(slot.target);r.render(this.scene,cam);
      // The async read copies into a GPU buffer now and hands the pixels over a few milliseconds later, so the frame never stalls.
      if(async&&this.asyncRead!==false&&r.readRenderTargetPixelsAsync)read=r.readRenderTargetPixelsAsync(slot.target,0,0,w,h,slot.pixels).then(()=>slot.pixels,error=>{console.warn('Async camera read is not available, using the direct read.',error);this.asyncRead=false;return null;});
      else r.readRenderTargetPixels(slot.target,0,0,w,h,slot.pixels);
    }finally{
      r.setRenderTarget(null);r.shadowMap.autoUpdate=saved.autoShadow;
      this.clipPlane.constant=saved.clipConstant;
      this.outside.visible=saved.outsideVisible;
      this.bottomGroup.visible=saved.bottomVisible;
      this.dust.visible=saved.dustVisible;
      this.chunks.forEach((c,i)=>{c.visible=saved.chunkVis[i];});
      this.detailMeshes.forEach((m,i)=>{m.visible=saved.detailVis[i];});
      markers.forEach((o,i)=>{o.visible=saved.markers[i];});
      for(let i=0;i<saved.councilCount;i++){const {m,ring,label}=saved.councils[i];m.ring.visible=ring;m.label.visible=label;}
      fog.color.copy(saved.fogColor);fog.density=saved.fogDensity;
      this.scene.background.copy(saved.bgColor);
      this.sun.intensity=saved.sunInt;this.key.intensity=saved.keyInt;
      this.beaconLight.intensity=saved.beaconInt;this.alarmLight.intensity=saved.alarmInt;
      this.heats.forEach((ht,i)=>{ht.intensity=saved.heatInts[i];});
      this.lampLights.forEach((l,i)=>{l.position.copy(saved.lamps[i].pos);l.color.copy(saved.lamps[i].col);});
      this.stairLights.forEach((l,i)=>{l.position.copy(saved.stairs[i]);});
      for(let i=0;i<saved.peopleCount;i++){const p=saved.people[i];p.e.sprite.visible=p.vis;p.e.sprite.position.copy(p.pos);if(p.e.bubble){p.e.bubble.visible=p.bVis;p.e.bubble.position.copy(p.bPos);}}
      for(let i=0;i<saved.courierCount;i++){const c=saved.couriers[i];c.c.sprite.visible=c.sVis;c.c.folder.visible=c.fVis;c.c.tag.visible=c.tVis;c.c.ghost.visible=c.gVis;}
      // References are let go, so removed residents are not kept alive by the buffers.
      for(let i=0;i<saved.peopleCount;i++)saved.people[i].e=null;for(let i=0;i<saved.courierCount;i++)saved.couriers[i].c=null;for(let i=0;i<saved.councilCount;i++)saved.councils[i].m=null;
    }
    this.feedsThisFrame++;this.lastFeedPose=P;
    return async?(read||Promise.resolve(slot.pixels)):slot.pixels;
  }
  // Where a resident appears in the picture of the last captured camera, from 0 to 1.
  feedProject(agentId){
    const e=this.people.get(agentId),P=this.lastFeedPose;if(!e?.pose||!P||P.outside||e.level<P.lo||e.level>P.hi)return null;
    const foot=new T.Vector3(e.pose.x,e.pose.y,e.pose.z).project(this.feedCamera),head=new T.Vector3(e.pose.x,e.pose.y+1.9,e.pose.z).project(this.feedCamera);
    if(foot.z>1||head.z>1||Math.abs(foot.x)>1.05||foot.y<-1.4||head.y>1.4)return null;
    return {x:(foot.x+1)/2,top:(1-head.y)/2,bottom:(1-foot.y)/2};
  }
  // How far a camera has to turn to look at a resident (pan and tilt, in radians).
  feedBearing(spec,agentId){
    const e=this.people.get(agentId);if(!e?.pose)return null;const P=this.feedPose({...spec,pan:0,tilt:0}),base=P.look.clone().sub(P.pos);
    const dx=e.pose.x-P.pos.x,dy=e.pose.y+1-P.pos.y,dz=e.pose.z-P.pos.z;
    return {pan:wrapAngle(Math.atan2(dx,dz)-Math.atan2(base.x,base.z)),tilt:Math.atan2(dy,Math.hypot(dx,dz))-Math.asin(clamp(base.y,-1,1)),level:e.level,angle:Math.atan2(e.pose.x,e.pose.z)};
  }
  // The resident closest to a click on a camera picture, if any is near it.
  pickFeed(spec,u,v,aspect=4/3){
    const P=this.feedPose(spec);if(P.outside)return null;const cam=this.aimFeed(P,aspect);let best=null,bestD=.07;
    for(const e of this.people.values()){
      if(!e.pose||e.level<P.lo||e.level>P.hi)continue;
      const c=new T.Vector3(e.pose.x,e.pose.y+.95,e.pose.z).project(cam);if(c.z>1)continue;
      const d=Math.hypot(((c.x+1)/2-u)*aspect,(1-c.y)/2-v);if(d<bestD){bestD=d;best=e.agent;}
    }
    return best;
  }
  get lensGrime(){return clamp((Date.now()-this.lensCleanedAt)/(8*3600e3),0,1)*.92;}
  cleanLens(){this.lensCleanedAt=Date.now();try{localStorage.setItem('silo-lens-cleaned',String(this.lensCleanedAt));}catch{}}
  // The cafeteria screen only refreshes while the camera is near the top of the silo.
  updateWallScreen(seconds){
    if(!this.wallCtx||this.wallPending||this.camR>33||(this.anchorLevel??99)>9||seconds-(this.wallAt||0)<.45)return;
    this.wallAt=seconds;this.wallPending=true;
    this.captureFeed({kind:'outside'},192,108,true).then(pixels=>{
      this.wallPending=false;if(!pixels||!this.wallCtx||!this.alive)return;
      const w=this.pulse?.weather,clarity=w?.clarity??.5;
      paintFeed(this.wallCtx,pixels,192,108,{palette:'surface',exposure:1.15+clarity*.35,noise:Math.max(.015,.07-clarity*.05),grime:this.lensGrime*(1-clarity*.3),time:seconds});
      const ctx=this.wallCtx,alarm=this.alarmUntil>this.clock;
      ctx.fillStyle=alarm?'rgba(90,14,10,.72)':'rgba(10,16,12,.58)';ctx.fillRect(0,0,192,13);ctx.fillRect(0,95,192,13);
      ctx.font='bold 8px Consolas,monospace';ctx.textBaseline='middle';
      ctx.fillStyle=alarm?'#ff9b85':'#d8e6c3';ctx.textAlign='left';
      ctx.fillText(`SURFACE · ${String(w?.mode||'auto').toUpperCase()}`,5,7);
      ctx.textAlign='right';ctx.fillText(`CLARITY ${Math.round(clarity*100)}%`,187,7);
      ctx.textAlign='left';
      const wh=this.pulse?.whisper&&Date.now()-this.pulse.whisper.time<45000?`L${String(this.pulse.whisper.level).padStart(3,'0')} ${this.pulse.whisper.from}: ${this.pulse.whisper.text}`:'';
      const bot=alarm?`ALARM · ${this.pulse?.alarm?.title||'CHECK SIGNALS'}`:wh||`AT WORK ${this.pulse?.working||0} · ${this.pulse?.tpm||0} TOK/MIN`;
      ctx.fillText(bot.slice(0,32).toUpperCase(),5,102);
      this.wallTexture.needsUpdate=true;
    },()=>{this.wallPending=false;});
  }
  // Frame times for profiling. record() starts, record(false) stops and returns, for every drawn frame, the time since
  // the frame before (gap) and what each part took (tick, draw, feeds), in ms.
  // Where the browser allows it (EXT_disjoint_timer_query_webgl2), also what the graphics card itself took for the
  // drawing and the cameras of each frame (gpu); the answers come a few frames later. Many browsers leave it out.
  record(on=true){
    if(on){this.rec={gap:[],tick:[],draw:[],feeds:[],gpu:[],queries:[],low:0,prev:0};return null;}
    const r=this.rec;this.rec=null;
    if(r){this.gpuTimerPoll(r);const gl=this.renderer.getContext();for(const q of r.queries)gl.deleteQuery(q);}
    return r&&{gap:r.gap,tick:r.tick,draw:r.draw,feeds:r.feeds,gpu:r.gpu,gpuTimer:!!this.gpuTimer(),lowFrames:r.low,throttle:this.background?50:0,ratio:this.renderer.getPixelRatio(),size:[Math.round(this.width||0),Math.round(this.height||0)]};
  }
  gpuTimer(){if(this.timerExt===undefined){const gl=this.renderer.getContext();this.timerExt=(gl instanceof WebGL2RenderingContext&&gl.getExtension('EXT_disjoint_timer_query_webgl2'))||null;}return this.timerExt;}
  gpuTimerBegin(){const ext=this.gpuTimer();if(!ext)return null;const gl=this.renderer.getContext();this.gpuTimerPoll(this.rec);const q=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,q);return q;}
  gpuTimerEnd(q){const gl=this.renderer.getContext();gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);if(this.rec)this.rec.queries.push(q);else gl.deleteQuery(q);}
  gpuTimerPoll(rec){
    const gl=this.renderer.getContext(),ext=this.timerExt;if(!ext||!rec)return;
    while(rec.queries.length&&gl.getQueryParameter(rec.queries[0],gl.QUERY_RESULT_AVAILABLE)){
      const q=rec.queries.shift(),ns=gl.getQueryParameter(q,gl.QUERY_RESULT);gl.deleteQuery(q);
      // A disjoint period (the card was switched or reset) makes the number meaningless: it is left out.
      if(!gl.getParameter(ext.GPU_DISJOINT_EXT))rec.gpu.push(ns/1e6);
    }
  }
  // gap: time since the frame before. The best gap seen is the screen's own rhythm (16.7 ms at 60 Hz).
  // A weak graphics card makes frames of several hundred ms while the code takes a few: such frames count (as 250 ms),
  // and the check runs every 90 frames or 1.5 seconds, whichever comes first, so the picture gets lighter within seconds.
  adaptSharpness(gap){
    if(gap<=0)return;gap=Math.min(gap,250);
    this.gapAvg=this.gapAvg?this.gapAvg*.94+gap*.06:gap;this.gapBest=Math.max(6,Math.min(this.gapBest,this.gapAvg));
    // Held back by the card: under 25 frames a second while the simulation uses less than a tenth of each frame. Drawing
    // counts as the card's time, since a driver may block the draw call until the card is done. An absolute measure,
    // since on a card that is slow from the start the best gap seen is slow too.
    this.gpuSlow=this.gapAvg>40&&(this.tickAvgMs||0)<this.gapAvg/10;
    const now=performance.now();
    if(++this.scaleCheck<90&&now-(this.scaleAt||0)<1500)return;this.scaleCheck=0;this.scaleAt=now;
    const pr=this.renderer.getPixelRatio(),step=.25;
    // Below the screen's own sharpness only for a card that cannot keep up: a softer picture beats a slide show.
    const late=this.gapAvg>this.gapBest*1.35||this.frameAvgMs>22||this.gpuSlow,onTime=this.gapAvg<this.gapBest*1.1&&this.frameAvgMs<9,floor=this.gpuSlow?Math.max(.5,this.ratioMin*.6):this.ratioMin;
    let next=pr;
    if(late&&pr>floor){next=Math.max(floor,pr-step);if(now-this.ratioChanged<6000&&this.lastRaise===pr)this.ratioMax=next;}
    else if(onTime&&pr<this.ratioMax&&now-this.ratioChanged>4000){next=Math.min(this.ratioMax,pr+step);this.lastRaise=next;}
    if(next!==pr){this.renderer.setPixelRatio(next);this.ratioChanged=now;this.resize();this.canvas.dataset.sharpness=next.toFixed(2);}
  }
  resize(){const r=this.canvas.getBoundingClientRect();if(!r.width||!r.height)return;this.width=r.width;this.height=r.height;this.renderer.setSize(r.width,r.height,false);this.camera.aspect=r.width/r.height;this.camera.updateProjectionMatrix();this.resizePost();}
  destroy(){
    this.alive=false;cancelAnimationFrame(this.raf);for(const w of this.atlasWorkers)w.terminate();this.atlasWorkers.clear();this.resizeObserver.disconnect();
    for(const [name,handler] of Object.entries(this.handlers))this.canvas.removeEventListener(name,handler);this.canvas.removeEventListener('webglcontextlost',this.onContextLost);this.canvas.removeEventListener('webglcontextrestored',this.onContextBack);
    for(const id of [...this.people.keys()])this.removePerson(id);
    for(const id of [...this.couriers.keys()])this.removeCourier(id);
    this.clearTrail();
    for(const slot of this.feedTargets?.values()||[])slot.target.dispose();
    this.dropPost();
    this.scene.traverse(o=>{if(o.geometry)o.geometry.dispose();});for(const g of this.geometries)g.dispose();
    for(const m of this.materials)m.dispose();for(const t of this.ownedTextures)t.dispose();this.renderer.dispose();
  }
}
window.SiloWorld=class{constructor(canvas,options){try{return new SiloWorld3D(canvas,options);}catch(error){console.warn('3D renderer unavailable, using the 2D world.',error);const replacement=canvas.cloneNode(false);canvas.replaceWith(replacement);replacement.dataset.renderer='2d-fallback';return new FallbackWorld(replacement,options);}}};
