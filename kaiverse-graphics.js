// KAIVERSE Graphics & Shaders
// Extracted to keep kaiverse.js clean

function nsMakeAtmosphere(radius, hex){
  // Realistic atmospheric SHELL: a sphere just larger than the planet whose glow
  // concentrates at the LIMB via a fresnel/rim term and fades across the disc.
  const g=new THREE.SphereGeometry(radius*1.05, 96, 64);
  const sky=new THREE.Color(hex).lerp(new THREE.Color(0xbfe0ff), 0.5);
  const m=new THREE.ShaderMaterial({
    uniforms:{
      uCol:{value:new THREE.Vector3(sky.r,sky.g,sky.b)},
      uSun:{value:new THREE.Vector3(0.4,0.7,0.55)},
      uFade:{value:1.0}
    },
    vertexShader:`
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vWorldNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = -mvPosition.xyz;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader:`
      uniform vec3 uCol;
      uniform float uFade;
      varying vec3 vNormal;
      varying vec3 vViewPosition;
      varying vec3 vWorldNormal;
      void main() {
        vec3 normal = normalize(vNormal);
        vec3 viewDir = normalize(vViewPosition);
        float rim = 1.0 - max(dot(viewDir, normal), 0.0);
        // smooth edge thickness - sharper and pushed to the absolute edge
        float alpha = smoothstep(0.5, 1.0, pow(rim, 5.0));
        
        float sunIntensity = 1.0; 
        
        // Additive rim glow, heavily faded so it doesn't obscure the planet
        gl_FragColor = vec4(uCol * sunIntensity, alpha * uFade * 0.4);
      }
    `,
    transparent:true, blending:THREE.AdditiveBlending, side:THREE.FrontSide, depthWrite:false
  });
  return new THREE.Mesh(g,m);
}

function nsMakeClouds(radius){
  // Clouds at 1.18× radius — well above the terrain displacement (~1.022×) so
  // they float visibly in the atmosphere rather than clipping through hills.
  const g=new THREE.SphereGeometry(radius*1.18, 64, 48);
  const tex=nsMakePlanetTexture('clouds-'+Math.random(), 'gas'); // repurpose gas noise for clouds
  const m=new THREE.MeshStandardMaterial({
    map: tex,
    transparent: true,
    opacity: 0.35,
    blending: THREE.NormalBlending,
    depthWrite: false,
    color: 0xffffff,
    roughness: 1.0
  });
  return new THREE.Mesh(g, m);
}

function nsMakeCloudTexture(seed){
  if(!NS._cloudTexCache) NS._cloudTexCache={};
  const key=(seed>>>0)%64; if(NS._cloudTexCache[key]) return NS._cloudTexCache[key];
  const rng=nsSeededRng((seed>>>0)||7);
  const W=1024,H=512, c=document.createElement('canvas'); c.width=W; c.height=H; const ctx=c.getContext('2d');
  ctx.clearRect(0,0,W,H);
  const img=ctx.createImageData(W,H), d=img.data;
  const TAU=6.28318530718, ph=[]; for(let i=0;i<8;i++) ph.push(rng()*TAU);
  // seamless longitude fbm (integer harmonics so the wrap has no seam) + latitude detail
  function fbm(lon,lat){ let v=0,a=0.55,f=1; for(let o=0;o<6;o++){ const fi=Math.max(1,Math.round(f));
    v+=a*Math.sin(TAU*fi*lon+ph[o%8]+Math.sin(TAU*Math.max(1,Math.round(f*0.6))*lat*0.5+ph[(o+3)%8])*1.1); a*=0.55; f*=1.95; }
    return v*0.5+0.5; }
  const cover=0.62+rng()*0.12;
  for(let y=0;y<H;y++){ const lat=y/H;
    for(let x=0;x<W;x++){ const lon=x/W;
      const wx=(fbm(lon+0.13,lat+0.27)-0.5)*0.05;
      let v=fbm(lon+wx,lat); v=(v-0.5)*1.7+0.5; v=v<0?0:(v>1?1:v);
      const cov=v<cover?0:((v-cover)/(1-cover));
      const a=Math.round(cov*cov*255);
      const i=(y*W+x)*4; d[i]=d[i+1]=d[i+2]=255; d[i+3]=a;
    }
  }
  ctx.putImageData(img,0,0);
  const tex=new THREE.CanvasTexture(c); tex.wrapS=THREE.RepeatWrapping;
  NS._cloudTexCache[key]=tex; return tex;
}

function nsMakeTerrainTexture(seed){
  if(!NS._terrainTexCache) NS._terrainTexCache={};
  const key=(seed>>>0)%64; if(NS._terrainTexCache[key]) return NS._terrainTexCache[key];
  const sd=(seed>>>0)||13, rng=nsSeededRng(sd);
  const W=1024,H=512, c=document.createElement('canvas'); c.width=W; c.height=H; const ctx=c.getContext('2d');
  const img=ctx.createImageData(W,H), d=img.data;
  const TAU=6.28318530718, ph=[]; for(let i=0;i<10;i++) ph.push(rng()*TAU);
  // one base octave of seamless sine noise in -1..1 (integer longitude harmonics -> no seam)
  function onoise(lon,lat,o){ const fi=Math.max(1,Math.round(Math.pow(1.97,o)));
    return Math.sin(TAU*fi*lon+ph[o%10]+Math.sin(TAU*Math.max(1,Math.round(fi*0.65))*lat*0.5+ph[(o+4)%10])*1.15); }
  // smooth fbm for lowlands / oceans (0..1)
  function fbm(lon,lat){ let v=0,a=0.55; for(let o=0;o<6;o++){ v+=a*onoise(lon,lat,o); a*=0.55; } return v*0.5+0.5; }
  // RIGID MULTI-FRACTAL (Musgrave): (1-|n|)^2, gain-weighted -> sharp ridges, peaks, canyons (NMS-style)
  function ridged(lon,lat){ let sum=0,amp=0.5,weight=1; for(let o=0;o<6;o++){ let nn=1.0-Math.abs(onoise(lon,lat,o)); nn*=nn; nn*=weight; weight=Math.min(1,nn*2.0); sum+=nn*amp; amp*=0.5; } return sum; }
  const hsl=(h,sat,l)=>{ sat/=100; l/=100; const k=n=>(n+h/30)%12, a=sat*Math.min(l,1-l);
    const f=n=>l-a*Math.max(-1,Math.min(Math.min(k(n)-3,9-k(n)),1)); return [255*f(0),255*f(8),255*f(4)]; };
  const types=['earth','ocean','desert','ice','lava','rock','gas'];
  const type=types[(sd>>>3)%types.length];
  const sea=0.45+rng()*0.07, baseHue=rng()*360, bands=5+((sd>>>4)%6);
  const sharp=0.55+rng()*0.9, warp=0.05+rng()*0.06;   // per-planet ridge sharpness + domain-warp strength
  for(let y=0;y<H;y++){ const lat=y/H, polar=Math.abs(lat-0.5)*2;
    for(let x=0;x<W;x++){ const lon=x/W;
      const wx=(fbm(lon+0.21,lat+0.11)-0.5)*warp;        // domain-warp the coords -> organic, alien continents
      const base=fbm(lon+wx, lat), mtn=ridged(lon+wx, lat);
      let h=base*0.55 + mtn*0.55*sharp; h=h<0?0:(h>1?1:h);   // smooth lowlands + sharp ridged mountains
      let r,g,b;
      if(type==='gas'){
        const band=Math.sin(lat*Math.PI*bands + (fbm(lon,lat*2.2)-0.5)*5.0);
        const t=band*0.5+0.5; const col=hsl((baseHue+t*45)%360, 42-18*t, 26+40*t); r=col[0];g=col[1];b=col[2];
      } else if(type==='lava'){
        const cr=Math.pow(1-h,1.7);
        if(h>0.6){ const col=hsl(18,14,18+16*(h-0.6)); r=col[0];g=col[1];b=col[2]; }
        else { r=Math.min(255,255*(0.5+0.5*cr)); g=Math.min(220,140*cr+25); b=30*cr; }
      } else if(type==='ice'){
        const col=hsl(198+24*h, 8+14*h, Math.min(97,72+22*h)); r=col[0];g=col[1];b=col[2];
      } else if(type==='desert'){
        const col=hsl(28+18*h, 48-16*h, 38+30*h); r=col[0];g=col[1];b=col[2];
      } else if(type==='rock'){
        const col=hsl(18+34*h, 9+9*h, 26+34*h); r=col[0];g=col[1];b=col[2];
      } else if(type==='ocean'){
        if(h<sea+0.14){ const dep=(sea+0.14-h); const col=hsl(205,62,12+26*(1-dep)); r=col[0];g=col[1];b=col[2]; }
        else { const land=h-(sea+0.14); const col=hsl(125,40,32+30*land); r=col[0];g=col[1];b=col[2]; }
      } else {
        if(h<sea){ const dep=(sea-h)/sea; const col=hsl(205,55,15+24*(1-dep)); r=col[0];g=col[1];b=col[2]; }
        else { const land=(h-sea)/(1-sea); let hue,sat,lig;
          if(land<0.10){ hue=48; sat=42; lig=58; }
          else if(land<0.55){ hue=95+20*land; sat=44-12*land; lig=30+20*land; }
          else if(land<0.82){ hue=30; sat=22; lig=36+12*land; }
          else { hue=210; sat=6; lig=80+12*land; }
          if(polar>0.82){ lig=Math.min(94,lig+24); sat*=0.5; }
          const col=hsl(hue,sat,lig); r=col[0];g=col[1];b=col[2];
        }
      }
      const i=(y*W+x)*4; d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
  const tex=new THREE.CanvasTexture(c); tex.wrapS=THREE.RepeatWrapping;
  if(THREE.sRGBEncoding!==undefined){ try{ tex.encoding=THREE.sRGBEncoding; }catch(_){} }
  NS._terrainTexCache[key]=tex; return tex;
}

function nsMakeDetailTexture(seed){
  if(!NS._detailTexCache) NS._detailTexCache={};
  const key=(seed>>>0)%32; if(NS._detailTexCache[key]) return NS._detailTexCache[key];
  const rng=nsSeededRng((seed>>>0)||17);
  const W=512, H=512, c=document.createElement('canvas'); c.width=W; c.height=H;
  const ctx=c.getContext('2d');
  const img=ctx.createImageData(W,H), d=img.data;
  // Determine style from seed (same types as nsPlanetDNA)
  const types=['earth','ocean','desert','ice','lava','rock','gas'];
  const type=types[((seed>>>0)>>>3)%types.length];
  // 3D value noise for seamless tiling
  function hash2(ix,iy){ let n=((ix*374761393+iy*668265263)>>>0); n=((n^(n>>>13))*1274126177)>>>0; return (n^(n>>>16))>>>0; }
  function vnoise(x,y){ const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
    const u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);
    const a=hash2(xi&511,yi&511)/4294967295, b=hash2((xi+1)&511,yi&511)/4294967295;
    const cc=hash2(xi&511,(yi+1)&511)/4294967295, dd=hash2((xi+1)&511,(yi+1)&511)/4294967295;
    return a+(b-a)*u + (cc-a+(a-b-cc+dd)*u)*v; }
  function fbm(x,y,oct){ let v=0,a=0.5,f=1; for(let o=0;o<oct;o++){ v+=a*vnoise(x*f,y*f); a*=0.5; f*=2.17; } return v; }
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const nx=x/W*8, ny=y/H*8;   // tile frequency
      let v;
      if(type==='rock' || type==='earth'){
        // rocky cracks + gravel
        const n1=fbm(nx+rng()*100, ny+rng()*100, 6);
        const crack=Math.abs(vnoise(nx*3.1+rng()*50, ny*3.1+rng()*50)*2-1);
        v = n1*0.7 + crack*0.3;
      } else if(type==='desert'){
        // sand ripples
        const ripple=Math.sin(nx*12 + fbm(nx,ny,3)*4)*0.5+0.5;
        v = fbm(nx,ny,5)*0.4 + ripple*0.6;
      } else if(type==='lava'){
        // lava veins — bright cracks in dark rock
        const base=fbm(nx,ny,4)*0.4;
        const vein=1-Math.pow(Math.abs(vnoise(nx*2.5, ny*2.5)*2-1), 0.3);
        v = base + vein*0.6;
      } else if(type==='ice'){
        // ice crystals — bright with subtle fracture lines
        const base=0.7+fbm(nx,ny,5)*0.3;
        const fracture=Math.pow(Math.abs(vnoise(nx*4, ny*4)*2-1), 2);
        v = base - fracture*0.15;
      } else if(type==='ocean'){
        // seafloor / coral texture
        const base=fbm(nx,ny,5);
        v = base*0.6+0.4;
      } else if(type==='gas'){
        // swirling bands
        const band=Math.sin(ny*6 + fbm(nx*0.5,ny*0.5,4)*8)*0.5+0.5;
        v = band*0.5+0.5;
      } else {
        v = fbm(nx,ny,5);
      }
      v=Math.max(0,Math.min(1,v));
      const lum=Math.round(v*255);
      const i=(y*W+x)*4; d[i]=lum; d[i+1]=lum; d[i+2]=lum; d[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
  const tex=new THREE.CanvasTexture(c);
  tex.wrapS=THREE.RepeatWrapping; tex.wrapT=THREE.RepeatWrapping;
  // Kill the high-frequency tiling shimmer ("pixel dancing"): max anisotropic filtering.
  try{ var _mx=(NS.renderer&&NS.renderer.capabilities&&NS.renderer.capabilities.getMaxAnisotropy)?NS.renderer.capabilities.getMaxAnisotropy():8; tex.anisotropy=_mx||8; tex.generateMipmaps=true; tex.needsUpdate=true; }catch(_){}
  NS._detailTexCache[key]=tex; return tex;
}

function nsMakeDetailNormalTexture(seed){
  if(!NS._detailNrmCache) NS._detailNrmCache={};
  const key=(seed>>>0)%32; if(NS._detailNrmCache[key]) return NS._detailNrmCache[key];
  const dt=nsMakeDetailTexture(seed); const src=dt&&dt.image; if(!src||!src.getContext) return null;
  const W=src.width, H=src.height; const sctx=src.getContext("2d"); const sd=sctx.getImageData(0,0,W,H).data;
  const c=document.createElement("canvas"); c.width=W; c.height=H; const ctx=c.getContext("2d");
  const out=ctx.createImageData(W,H), od=out.data;
  const L=(x,y)=>{ x=(x+W)%W; y=(y+H)%H; return sd[(y*W+x)*4]/255; };
  const st=2.4;
  for(let y=0;y<H;y++){ for(let x=0;x<W;x++){
    const dx=(L(x+1,y)-L(x-1,y))*st, dy=(L(x,y+1)-L(x,y-1))*st;
    let nx=-dx, ny=-dy, nz=1.0; const il=1/Math.sqrt(nx*nx+ny*ny+nz*nz); nx*=il; ny*=il; nz*=il;
    const i=(y*W+x)*4; od[i]=Math.round((nx*0.5+0.5)*255); od[i+1]=Math.round((ny*0.5+0.5)*255); od[i+2]=Math.round((nz*0.5+0.5)*255); od[i+3]=255;
  } }
  ctx.putImageData(out,0,0);
  const tex=new THREE.CanvasTexture(c); tex.wrapS=THREE.RepeatWrapping; tex.wrapT=THREE.RepeatWrapping;
  try{ var mx=(NS.renderer&&NS.renderer.capabilities&&NS.renderer.capabilities.getMaxAnisotropy)?NS.renderer.capabilities.getMaxAnisotropy():8; tex.anisotropy=mx||8; tex.generateMipmaps=true; tex.needsUpdate=true; }catch(_){}
  NS._detailNrmCache[key]=tex; return tex;
}

