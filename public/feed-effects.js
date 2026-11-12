// Turns raw camera pixels into the picture of an old silo monitor.
// 'green' is the phosphor look of the security room, 'surface' is the washed out color of the cafeteria screen.
const luts=new Map(),masks=new Map(),images=new WeakMap();
const clamp01=v=>v<0?0:v>1?1:v;
const LITTLE=new Uint8Array(new Uint32Array([1]).buffer)[0]===1,tables=new Map(),views=new WeakMap();
// Four packed RGBA tables per exposure: plain row, scanline row, and both inside the rolling bright band.
function packedFor(exposure){
  const key=exposure.toFixed(2);if(tables.has(key))return tables.get(key);
  const base=lutFor('green',exposure),t=new Uint32Array(1024);
  for(let v=0;v<4;v++){const f=(v&1?.8:1)*(v&2?1.07:1);for(let i=0;i<256;i++){const c=k=>Math.min(255,Math.round(base[i*3+k]*f));t[v*256+i]=((255<<24)|(c(2)<<16)|(c(1)<<8)|c(0))>>>0;}}
  tables.set(key,t);return t;
}

function tone(v,exposure){const t=v*exposure;return Math.pow(clamp01(1-Math.exp(-t*1.9)),1/1.8);}
function lutFor(palette,exposure){
  const key=palette+exposure.toFixed(2);if(luts.has(key))return luts.get(key);
  const lut=new Uint8ClampedArray(256*3);
  for(let i=0;i<256;i++){
    const v=tone(i/255,exposure);
    if(palette==='green'){
      // Black glass, phosphor green, a pale core where it burns brightest.
      const g=v<.62?[1+v/.62*62,6+v/.62*162,2+v/.62*58]:[63+(v-.62)/.38*172,168+(v-.62)/.38*87,60+(v-.62)/.38*150];
      lut.set(g.map(Math.round),i*3);
    }else{const u=Math.round(v*255);lut.set([u,u,u],i*3);}
  }
  luts.set(key,lut);return lut;
}
// Dirt on the lens: soft blobs, heavier near the edges, plus a few streaks. Values from 0 to 1.
function maskFor(w,h){
  const key=w+'x'+h;if(masks.has(key))return masks.get(key);
  const m=new Float32Array(w*h);let seed=7;const rnd=()=>{seed=(seed*16807)%2147483647;return seed/2147483647;};
  const blobs=Array.from({length:46},()=>({x:rnd()*w,y:rnd()*h,r:(.04+rnd()*.16)*w,a:.25+rnd()*.6}));
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const ex=Math.abs(x/w-.5)*2,ey=Math.abs(y/h-.5)*2;let v=Math.pow(Math.max(ex,ey),3)*.55;
    for(const b of blobs){const dx=x-b.x,dy=(y-b.y)*1.15,d=(dx*dx+dy*dy)/(b.r*b.r);if(d<1)v+=b.a*(1-d)*(1-d);}
    v+=Math.max(0,Math.sin(x*.21+y*.03)*Math.sin(y*.05))*.12;
    m[y*w+x]=clamp01(v);
  }
  masks.set(key,m);return m;
}

// pixels: RGBA rows from WebGL (bottom row first). Paints into ctx at its full size.
export function paintFeed(ctx,pixels,w,h,{palette='green',exposure=2.2,noise=.07,grime=0,time=0}={}){
  let img=images.get(ctx);if(!img||img.width!==w||img.height!==h){img=ctx.createImageData(w,h);images.set(ctx,img);}
  const out=img.data,lut=lutFor(palette,exposure),mask=grime>0?maskFor(w,h):null,n=noise*255;
  let seed=(time*1000)|0||1;
  const roll=((time*.09)%1.3-.15)*h;
  if(palette==='green'&&LITTLE){
    let out32=views.get(img);if(!out32){out32=new Uint32Array(out.buffer);views.set(img,out32);}
    const table=packedFor(exposure),gk=noise*.42;
    for(let y=0;y<h;y++){
      const src=(h-1-y)*w*4,row=y*w,off=((y&1)|(Math.abs(y-roll)<h*.06?2:0))*256;
      for(let x=0;x<w;x++){
        const i=src+x*4;let L=(pixels[i]*54+pixels[i+1]*183+pixels[i+2]*19)>>8;
        if(mask){const g=mask[row+x]*grime;L=L*(1-g*.8)+g*24;}
        seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;L=(L+((seed&255)-128)*gk)|0;
        out32[row+x]=table[off+(L<0?0:L>255?255:L)];
      }
    }
    ctx.putImageData(img,0,0);return;
  }
  for(let y=0;y<h;y++){
    const src=(h-1-y)*w*4,scan=y&1?.8:1,band=Math.abs(y-roll)<h*.06?1.07:1,row=y*w;
    for(let x=0;x<w;x++){
      const i=src+x*4,o=(row+x)*4;
      seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;const grain=((seed&255)/255-.5)*n;
      if(palette==='green'){
        let L=(pixels[i]*54+pixels[i+1]*183+pixels[i+2]*19)>>8;
        if(mask){const g=mask[row+x]*grime;L=L*(1-g*.8)+g*24;}
        const k=(L|0)*3,f=scan*band;
        out[o]=(lut[k]+grain*.4)*f;out[o+1]=(lut[k+1]+grain)*f;out[o+2]=(lut[k+2]+grain*.4)*f;
      }else{
        let r=lut[pixels[i]*3],g=lut[pixels[i+1]*3],b=lut[pixels[i+2]*3];
        const gray=(r*.3+g*.59+b*.11);r=gray+(r-gray)*.5;g=gray+(g-gray)*.5;b=gray+(b-gray)*.5;
        if(mask){const d=mask[row+x]*grime;r=r*(1-d*.75)+d*70;g=g*(1-d*.78)+d*58;b=b*(1-d*.82)+d*40;}
        const f=scan*band;out[o]=(r*1.02+grain)*f;out[o+1]=(g*.96+grain)*f;out[o+2]=(b*.84+grain)*f;
      }
      out[o+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
}

// Text burned into the corner of the picture, CCTV style.
export function feedOverlay(ctx,w,h,{label='',time=0,rec=true,color='#d8ffc8',small=false}={}){
  const s=small?9:12,pad=small?5:8,clock=new Date();
  ctx.font=`bold ${s}px 'Lucida Console',Consolas,monospace`;ctx.textBaseline='top';ctx.lineWidth=3;ctx.strokeStyle='#000a';ctx.fillStyle=color;
  const text=(t,x,y)=>{ctx.shadowBlur=0;ctx.strokeText(t,x,y);ctx.shadowColor=color;ctx.shadowBlur=5;ctx.fillText(t,x,y);};
  text(label,pad,pad);
  const stamp=clock.toLocaleTimeString('en-GB',{hour12:false});ctx.textAlign='right';text(stamp,w-pad,h-pad-s);ctx.textAlign='left';
  if(rec&&Math.floor(time*1.6)%2===0){ctx.fillStyle='#ff4b36';ctx.shadowColor='#ff4b36';ctx.beginPath();ctx.arc(w-pad-s*2.6,pad+s*.45,s*.32,0,Math.PI*2);ctx.fill();ctx.fillText('REC',w-pad-s*2.1,pad);}
  ctx.shadowBlur=0;
}
