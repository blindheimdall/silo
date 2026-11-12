export const FLOOR_HEIGHT=6;
export const INNER_RADIUS=28;
export const OUTER_RADIUS=34;
export const FLOOR_TOP=.025;
export const RESIDENT_MIN_RADIUS=29.6;
const GOLDEN_ANGLE=2.399963229728653;
const hash=(a,b)=>{const v=Math.sin(a*12.9898+b*78.233)*43758.5453;return v-Math.floor(v);};
export const physicalFloorY=level=>-(level-1)*FLOOR_HEIGHT;
// Residents patrol a short arc of their gallery. Positions stay on the solid annulus,
// between the inner railing and the room fronts, and the foot pivot equals the slab top.
export function spatialResidentPose(level,index,seconds){
  const r1=hash(level,index),r2=hash(index+3.1,level*.7);
  const home=level*1.37+index*GOLDEN_ANGLE+r2*.5;
  const speed=.07+r1*.06,swing=.22+r2*.22,phase=r1*Math.PI*2+index;
  const s=seconds*speed+phase;
  const angle=home+Math.sin(s)*swing;
  const velocity=Math.cos(s)*swing*speed;
  const radius=RESIDENT_MIN_RADIUS+((index*7+level)%5)*.5;
  return {x:Math.sin(angle)*radius,y:physicalFloorY(level)+FLOOR_TOP,z:Math.cos(angle)*radius,angle,radius,velocity,moving:Math.abs(Math.cos(s))>.18};
}
export function spatialStairPoint(level,u,radius=6.2){const theta=Math.PI+(level-1+u)*Math.PI*2;return{x:Math.sin(theta)*radius,y:physicalFloorY(level)-u*FLOOR_HEIGHT,z:Math.cos(theta)*radius};}
