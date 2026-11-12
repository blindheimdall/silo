// Shared deterministic geometry: drawing, resident motion and tests use the same surfaces.
export const WIDTH=1536;
export const LEVEL_COUNT=144;
export const PITCH=176;
export const HEIGHT=LEVEL_COUNT*PITCH+240;
export const SECTORS=[{start:1,end:12,home:1},{start:13,end:24,home:14},{start:25,end:72,home:48},{start:73,end:108,home:84},{start:109,end:132,home:112},{start:133,end:144,home:144}];
export const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export const sectorForLevel=level=>SECTORS.findIndex(s=>level>=s.start&&level<=s.end);
export const levelBase=level=>(level-1)*PITCH+180;
export function surfaceY(level,x){
  const distance=x<=WIDTH/2?x:WIDTH-x;
  const points=[[0,39],[160,11],[320,-10],[480,-24],[600,-31]];
  const d=clamp(distance,0,600);
  for(let i=1;i<points.length;i++)if(d<=points[i][0]){const [x0,y0]=points[i-1],[x1,y1]=points[i];return levelBase(level)+y0+(y1-y0)*(d-x0)/(x1-x0);}
  return levelBase(level)-31;
}
export function residentPose(level,index,time,working=false){
  const side=(index+level)%2===0?'left':'right';
  const phase=index*2.31+level*.91;
  const slot=Math.floor(index/2),center=230+(slot%3)*125;
  const travel=working?0:Math.sin(time*.17+phase)*54;
  const left=clamp(center+travel,105,435),x=side==='left'?left:WIDTH-left;
  const feetY=surfaceY(level,x);
  return {x,feetY,side,scale:1.45,direction:Math.cos(time*.17+phase)*(side==='left'?1:-1),moving:!working&&Math.abs(Math.cos(time*.17+phase))>.12};
}
export function stairPoint(level,u,radius=205){
  const theta=(level-1+u)*Math.PI;
  return {x:WIDTH/2+Math.cos(theta)*radius,y:levelBase(level)+u*PITCH+Math.sin(theta)*radius*.22,front:Math.sin(theta)>=0};
}
export function visibleLevels(cameraY,height,scale){return {first:clamp(Math.floor((cameraY-height/(2*scale)-230)/PITCH)+1,1,LEVEL_COUNT),last:clamp(Math.ceil((cameraY+height/(2*scale)+230)/PITCH)+1,1,LEVEL_COUNT)};}
