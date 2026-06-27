/* ============================================================================
   kaiverse.js  --  KAIVERSE 3D cosmic explorer, extracted from oracle.html.
   Loaded by oracle.html via <script src="kaiverse.js"> right before </body>,
   AFTER the main dashboard script, so it can read shared globals (allOps, $,
   esc, api, ...). Defines the thin interface the dashboard calls: nsActivate(),
   nsIngestOps(ops). Region 1 = 3D engine; Region 2 = activation + touch glue.
   To edit the 3D world, edit THIS file -- the dashboard cannot be truncated by it.
   ============================================================================ */

/* ══════════════════════════════════════════════════════════════════════
   KAIVERSE  —  3D WebGL cosmic explorer (Three.js r128)  · replaces the flat
   2D nervous-system graph. A navigable starfield: CORE at centre, the 9 bots
   as orbiting PLANETS, the ACTIVE providers (gemini/groq/ollama) as glowing
   STAR bodies (silenced ones dim), a CHANNELS cluster, and a LATTICE NEBULA
   particle cloud whose density scales with the REAL live cell + synapse counts.
   Edges reflect the ACTUAL routing; /api/operations events spawn 3D pulses.
   HUD reads REAL engine stats (/api/status + /api/synapse/status + /api/session);
   stats the engine does NOT expose are honestly labelled "n/a".
   Lazy-inits on view-enter; fully disposes on view-leave (no GPU leak).
   ══════════════════════════════════════════════════════════════════════ */
/* ── VAST-SCALE FACTOR (tunable) ───────────────────────────────────────────
   Multiplies the whole universe — node spread, orbit radii, provider/channel
   distances, body radii, nebula + starfield extent, camera distances and the
   near/far clip planes. Bump this to make the cosmos feel bigger/smaller.
   window.KAIVERSE_SCALE can override it before this script runs. ───────────── */
const NS_SCALE = (typeof window!=='undefined' && +window.KAIVERSE_SCALE) || 16;
/* ── VASTNESS / SCALE MODEL (owner overhaul) ───────────────────────────────
   Two independent multipliers so spacing and body-size decouple (the owner's
   complaint was "planets huge, space cramped"):
     NS_SPREAD — multiplies ALL inter-body DISTANCES (positions, orbit radii,
                 cosmos half-extent, camera distances). Big → vast emptiness.
     NS_BODY   — multiplies all body RADII. Small → bodies read as specks at
                 distance. real-space feel = NS_BODY << NS_SPREAD.
   Net: distances grow ~6x, bodies shrink ~3.4x, so a body that used to fill a
   third of the screen when "zoomed out" is now a point. ──────────────────── */
const NS_SPREAD     = 80.0;   // orbital radii multiplier (vast distances)
const NS_BODY       = 1.8;    // body radii multiplier (huge planets)

// ── LY READOUT MAPPING ── world-units → light-years for ALL HUD distance text
// (position readout, dist-from-core, compass). Calibrated so the AI cluster edge
// reads ~CLUSTER and a fully-pulled-back view reads in the 100k–500k LY band that
// the owner asked for. distance(units)/NS_SCALE * NS_LY_PER_UNIT = light-years.
const NS_LY_PER_UNIT = 4.0;
// ── CLICKABILITY (owner #1: "planets move too fast to click") ──────────────
// Global multipliers that GENTLY slow every moving/clickable body so they glide
// and are easy to spot + click. Motion stays alive, just calm. Bots were the
// worst offenders (orbSpeed 0.018–0.042); 0.18 makes them drift ~5.5x slower.
const NS_ORBIT_SLOW = 0.01;   // orbital/drift angular velocity multiplier (drastically slowed down so planets don't run away)
const NS_SPIN_SLOW  = 0.0005;  // body self-spin multiplier (drastically slowed down so landing is easy)
function nsUnitsToLy(distUnits){ return (distUnits/NS_SCALE)*NS_LY_PER_UNIT; }
// Surface-relative distance with adaptive units so sitting ON a body reads ~0 (km),
// not tens of light-years. ly when far → AU when sub-light-year → km when close → "surface".
function nsFmtDist(distUnits, radiusUnits){
  var r = radiusUnits||0;
  var rawDist = Math.max(0, distUnits - r);
  var km = rawDist * 0.5; // 1 cosmic unit = 0.5 physical km
  
  // SOLAR SYSTEM SCALE: keep it in km/AU if under 50 Billion km so we don't
  // print absurd "500 Million LY" labels for local planets.
  if(km < 50000000000){
    if(km < 0.5) return 'surface';
    if(km < 1000) return Math.round(km).toLocaleString()+' km';
    if(km < 1e6)  return (km/1000).toFixed(km<1e5?1:0)+'k km';
    if(km < 1e9)  return (km/1e6).toFixed(2)+'M km';
    // over 1B km, switch to AU to look realistic (1 AU = 150M km)
    var auLocal = km / 150000000;
    return auLocal.toFixed(2)+' AU';
  }
  
  // FAR: true cosmic scale — light-years (only triggers for deep space > 50 Billion km)
  var ly = nsUnitsToLy(rawDist);
  if(ly >= 1) return Math.round(ly).toLocaleString()+' ly';
  var au = ly * 63241;
  if(au >= 1) return (au>=10 ? Math.round(au).toLocaleString() : au.toFixed(1))+' AU';
  return 'approaching';
}
const NS = {
  active:false,
  keys:{},
  wasmHeightMap: null, // Holds the Rust WASM function
  _l:null,
  built:false, raf:null,
  nodes:[], nodeById:{}, edges:[], edgeKey:{},
  pulses:[],                       // active travelling 3D particles
  seen:new Set(), seenOrder:[],    // dedupe ops we've already turned into pulses
  signalStamps:[], errStamps:[],   // rolling timestamps for /min counters
  recentErrors:[],                 // latest REAL errors (status==='error') for the RECENT ERRORS readout
  // three.js handles
  three:null, renderer:null, scene:null, camera:null, raycaster:null,
  nebula:null, nebulaBaseSpread:1, born:0,
  // camera state — orbit (theta/phi/radius around target) is the default;
  // free-fly (WASD) drives camera.position + a free-look yaw/pitch directly.
  cam:{ target:new THREE_V0(), radius:1800*NS_SCALE*NS_SPREAD, theta:0.7, phi:1.05,
        tRadius:1800*NS_SCALE*NS_SPREAD, tTheta:0.7, tPhi:1.05, tTargetX:0, tTargetY:0, tTargetZ:0,
        // free-fly: explicit position + look yaw/pitch (radians)
        pos:new THREE_V0(), yaw:0.7, pitch:0.0,
        mode:'orbit',          // 'orbit' | 'fly'
        vel:new THREE_V0(),    // current fly velocity (for inertia + speed illusion)
        speed:0 },             // smoothed scalar speed (drives star-streak + FOV)
  keys:{}, fly:null,           // pressed-key map + free-look drag state
  flyTo:null,                  // active accelerated fly-to-node animation
  baseFov:55, baseFar:4000000*NS_SCALE*NS_SPREAD,   // far plane reaches the vast cosmos shell
  drag:null, pinch:null, focusNid:null, hoverNid:null,
  lastFrame:0, statSnap:{},
  failed:false, paused:false, ctxLost:false,
};
// lightweight Vector3 placeholder so the const above doesn't throw before THREE loads
function THREE_V0(){ return (typeof THREE!=='undefined') ? new THREE.Vector3() : {x:0,y:0,z:0}; }
// ── SAVE / RESTORE camera spawn (localStorage) ──────────────────────────────
function nsSaveSpawn(){
  try{
    var cam=NS.camera, c=NS.cam; if(!cam||!c) return;
    var d={ mode:c.mode, yaw:c.yaw, pitch:c.pitch, throttle:NS.throttleT!=null?NS.throttleT:0.3 };
    if(cam.position){ d.px=cam.position.x; d.py=cam.position.y; d.pz=cam.position.z; }
    if(c.target){ d.tx=c.target.x; d.ty=c.target.y; d.tz=c.target.z; }
    d.theta=c.theta; d.phi=c.phi; d.radius=c.radius;
    if(NS._walkPlanet) d.walkPlanet=NS._walkPlanet.id||'';
    localStorage.setItem('kv_spawn', JSON.stringify(d));
  }catch(_){}
}
function nsRestoreSpawn(){
  try{
    var raw=localStorage.getItem('kv_spawn'); if(!raw) return false;
    var d=JSON.parse(raw), cam=NS.camera, c=NS.cam; if(!cam||!c) return false;
    // Sanity check: if saved position is absurdly far from origin, discard the save
    if(d.px!=null){
      var _dist=Math.sqrt(d.px*d.px+d.py*d.py+d.pz*d.pz);
      var _maxR=(typeof COSMOS!=='undefined'?COSMOS:38400000)*0.8;
      if(_dist>_maxR){ console.log('[KAIVERSE] Saved position too far ('+(_dist|0)+'), resetting'); localStorage.removeItem('kv_spawn'); return false; }
      if(_dist < 2000000) { console.log('[KAIVERSE] Saved position is on the Core, resetting for new default spawn'); localStorage.removeItem('kv_spawn'); return false; }
    }
    if(d.px!=null) cam.position.set(d.px, d.py, d.pz);
    if(d.tx!=null) c.target.set(d.tx, d.ty, d.tz);
    if(d.mode==='fly'||d.mode==='walk') c.mode=d.mode;
    if(d.yaw!=null) c.yaw=d.yaw;
    if(d.pitch!=null) c.pitch=d.pitch;
    if(d.theta!=null){ c.theta=d.theta; c.tTheta=d.theta; }
    if(d.phi!=null){ c.phi=d.phi; c.tPhi=d.phi; }
    if(d.radius!=null){ c.radius=d.radius; c.tRadius=d.radius; }
    if(d.throttle!=null) NS.throttleT=d.throttle;
    // Zero velocity so you don't spawn flying at warp speed
    c.vel.set(0,0,0); c.speed=0;
    // Init 3rd-person tracking from restored position
    if(d.px!=null && d.mode==='fly'){
      NS._shipPos=cam.position.clone();
      NS._chasePos=null;
    }
    console.log('[KAIVERSE] Restored spawn position');
    return true;
  }catch(_){ return false; }
}
// Force-clear any stale deep-space save from before the sanity check existed
try{ var _ck=localStorage.getItem('kv_spawn'); if(_ck){ var _cd=JSON.parse(_ck); if(_cd.px!=null){ var _dd=Math.sqrt(_cd.px*_cd.px+(_cd.py||0)*(_cd.py||0)+(_cd.pz||0)*(_cd.pz||0)); if(_dd>30000000) localStorage.removeItem('kv_spawn'); } } }catch(_){}
NS._thirdPerson=false;   // V key toggles 3rd-person ship view (default: 1st person)
if(typeof window!=='undefined') window.addEventListener('beforeunload', nsSaveSpawn);
// provider display-name (AI_CONFIG) → provider STATUS key (sysStats.providers)
const NS_PROVIDER_KEY = {
  'anthropic':'zen', 'google':'gemini', 'groq':'groq', 'xai':'xai',
  'perplexity':'zen', 'openai':'zen', 'elevenlabs':'zen', 'ollama':'ollama',
};
// the six real provider status keys + label/icon
const NS_PROVIDERS = [
  {key:'ollama',   label:'ollama'},
  {key:'gemini',   label:'gemini'},
  {key:'groq',     label:'groq'},
  {key:'xai',      label:'xai'},
  {key:'moonshot', label:'moonshot'},
  {key:'zen',      label:'zen'},
];
function nsStatusColor(s){ return s==='error'?'#f87171':(s==='warn'?'#fbbf24':'#4ade80'); }
const NS_GREEN='#4ade80', NS_YELLOW='#fbbf24', NS_RED='#f87171', NS_IDLE='#475263';

// ACTIVE providers (engine currently routes through these) vs silenced ones.
// moonshot/xai/zen/openai are removed/silenced → shown dim/idle.
const NS_ACTIVE_PROV = new Set(['gemini','groq','ollama']);
function nsHexToColor(h){ return new THREE.Color(h); }
function nsCssVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'; }
// resolve a bot's --c-* css var to a real hex for three.js
function nsBotHex(a){
  const v=a.color||''; if(v.startsWith('var(')){ const k=v.slice(4,-1).trim(); return nsCssVar(k)||'#22d9e6'; } return v||'#22d9e6';
}

/* ── build the node registry + 3D positions + structural edges ──────────── */
function nsBuild(){
  NS.nodes=[]; NS.nodeById={}; NS.edges=[]; NS.edgeKey={};
  const add=(o)=>{ o.pos=new THREE.Vector3(o.px,o.py,o.pz); NS.nodes.push(o); NS.nodeById[o.id]=o; return o; };

  const S=NS_SCALE;   // vast-scale multiplier applied to every position + radius
  // ── SRHT-GROUNDED PLACEMENT ────────────────────────────────────────────────
  // The owner's #1 complaint: bodies clumped in one small region. We now spread
  // the whole AI constellation across a MUCH larger loose volume using KAI's own
  // math: the golden angle (137.5°, from PHI) gives a Fibonacci-spiral-sphere
  // distribution so nodes never bunch; per-node radius rides φ-spiral shells so
  // they fan OUT through space instead of sitting on one ring. Deterministic.
  const PHI=(1+Math.sqrt(5))/2, GOLD=Math.PI*(3-Math.sqrt(5));   // golden angle
  const SP=S*NS_SPREAD, BR=S*NS_BODY;   // SP = distance scale, BR = body-radius scale
  // ── COLLISION-FREE PLACEMENT (rejection sampling) ──────────────────────────
  // Track every placed body's centre + radius; reject any candidate that comes
  // within MINSEP*(rA+rB) of an existing body so NOTHING spawns inside anything
  // (owner: "things spawning in things"). MINSEP >> 1 → real empty gaps.
  const placedBodies=[];   // {p:Vector3, r}
  const MINSEP=5;          // min gap = 5x sum-of-radii (no overlap, but packs within the star field)
  function bodyClear(p, r){ for(const q of placedBodies){ if(p.distanceTo(q.p) < MINSEP*(r+q.r)) return false; } return true; }
  function placeBody(dir, baseR, r){
    // push the candidate outward along its direction until it clears all others
    let R=baseR;
    for(let t=0;t<40;t++){ const p=dir.clone().multiplyScalar(R); if(bodyClear(p,r)){ placedBodies.push({p,r}); return p; } R*=1.18; }
    const p=dir.clone().multiplyScalar(R); placedBodies.push({p,r}); return p;
  }
  // CORE — glowing central body at the origin (small relative to the vast volume)
  add({id:'core', kind:'core', name:'KAI / ORACLE CORE', sub:'lattice root',
       px:0,py:0,pz:0, r:60000*BR, color:'#fff2d0'});
  placedBodies.push({p:new THREE.Vector3(0,0,0), r:60000*BR});

  // PLANETS — the 9 bots spread on a Fibonacci sphere at VARIED golden-shell radii.
  // Distances ride NS_SPREAD (vast); radii ride NS_BODY (small specks).
  const bots = AGENTS;            // 9 agents (Oracle is the core)
  const N=bots.length;
  bots.forEach((a,i)=>{
    // SOLAR SYSTEM: order planets inner->outer on a near-flat ECLIPTIC disc orbiting the CORE
    // "sun" (was a scattered sphere). Each rides a wider, slower orbit (Kepler-ish).
    const baseR = (150000 + i*180000) * SP;                    // MATHEMATICALLY CORRECT vast distances; ordered inner->outer
    const ang   = GOLD*i + 0.6;                            // golden-angle fan around the disc
    const incl  = (i%2?1:-1)*(0.05+0.045*((i*PHI)%1));     // gentle tilt off the ecliptic
    const r=8000*BR;
    const dir=new THREE.Vector3(Math.cos(ang), Math.sin(incl), Math.sin(ang)).normalize();
    const p=placeBody(dir, baseR, r);
    add({id:'bot:'+a.name, kind:'bot', name:a.name, sub:a.role, botName:a.name,
         px:p.x,py:p.y,pz:p.z, r, color:nsBotHex(a),
         orbR:p.length(), orbA:Math.atan2(p.z,p.x), orbSpeed:(0.03/Math.sqrt(1+i*0.6))*NS_ORBIT_SLOW, orbIncl:incl, orbY:p.y});
  });

  // ENGINE — a body offset from the core (Rust core broker), pulled out further
  {
    const r=9000*BR, p=placeBody(new THREE.Vector3(120,300,-90).normalize(), 20000*SP, r);
    add({id:'engine', kind:'engine', name:'KAI ENGINE', sub:'Rust core · :3334',
         px:p.x,py:p.y,pz:p.z, r, color:'#22d9e6'});
  }

  // PROVIDERS — distant STAR / gas bodies in their OWN far sector, golden-angle
  // spread + big radius variance so they are scattered, not ringed together.
  NS_PROVIDERS.forEach((p,i)=>{
    const ph=GOLD*i + 0.7;
    const baseR=(30000 + (i%3)*10000 + ((i*PHI)%1)*8000)*SP;   // much further than bots
    const yk=1-(i/(NS_PROVIDERS.length-1||1))*2;
    const active=NS_ACTIVE_PROV.has(p.key);
    const r=(active?16:9)*BR;
    const dir=new THREE.Vector3(Math.cos(ph), yk*0.55, Math.sin(ph)).normalize();
    const pos=placeBody(dir, baseR, r);
    add({id:'prov:'+p.key, kind:'provider', name:p.label, sub:active?'active provider':'silenced',
         provKey:p.key, active, px:pos.x, py:pos.y, pz:pos.z,
         r, color:active?'#ffd27a':'#3a4456'});
  });

  // CHANNELS cluster — Discord lattice body off in a distinct far sector
  {
    const r=16*BR, p=placeBody(new THREE.Vector3(-1100,-380,760).normalize(), 1400*SP, r);
    add({id:'channels', kind:'channels', name:'CHANNELS', sub:'Discord lattice',
         px:p.x,py:p.y,pz:p.z, r, color:'#5865F2'});
  }
  NS._aiClusterR = placedBodies.reduce((m,q)=>Math.max(m,q.p.length()), 0);   // outer cluster radius

  // ── STRUCTURAL EDGES (the REAL routing) ──
  const edge=(a,b)=>{
    const key=a+'|'+b; if(NS.edgeKey[key]) return NS.edgeKey[key];
    const A=NS.nodeById[a], B=NS.nodeById[b]; if(!A||!B) return null;
    const e={a,b,key, health:'idle', healthV:0, lastTs:0, recent:[]};
    NS.edges.push(e); NS.edgeKey[key]=e;
    NS.edgeKey[b+'|'+a]=e;                          // reverse index for from/to either way
    return e;
  };
  edge('core','engine');
  bots.forEach(a=>{
    edge('core','bot:'+a.name);                     // bot <-> core
    edge('bot:'+a.name,'channels');                 // bot <-> channels
    // bot <-> the provider the engine ACTUALLY routes it through
    const disp=((AI_CONFIG[a.name]||{}).provider||'').toLowerCase();
    const pk=NS_PROVIDER_KEY[disp];
    if(pk && NS.nodeById['prov:'+pk]) edge('bot:'+a.name,'prov:'+pk);
  });
  // engine <-> ACTIVE providers only (brokered calls)
  NS_PROVIDERS.forEach(p=>{ if(p.key==='ollama'||p.key==='gemini'||p.key==='groq') edge('engine','prov:'+p.key); });

  NS.built=true;
}

/* ── alias-tolerant mapping: an op from/to string → a node id ──────────── */
function nsResolve(raw){
  if(!raw) return null;
  let n=String(raw).toLowerCase().trim();
  if(!n) return null;
  // core / oracle / moderator / root
  if(/(^|\b)(oracle|core|moderator|root|lattice)(\b|$)/.test(n) && !n.includes('coder')) return 'core';
  // engine / rust / codex
  if(/(engine|rust|codex|3334|kai-core|kaicore)/.test(n)) return 'engine';
  // providers (status keys + common aliases)
  if(/(ollama|local-?llm)/.test(n)) return 'prov:ollama';
  // 'gemini-live' is the multimodal provider stream (not the Gemini bot)
  if(/gemini-?live/.test(n)) return 'prov:gemini';
  // channel ids are long numeric snowflakes, or names with #, or 'chan'/'voice'
  if(/^\d{6,}$/.test(n) || n.startsWith('#') || /(channel|chan:|voice|discord|stage|bridge)/.test(n)) return 'channels';
  // a real channel id in the live catalog → channels cluster
  if(channels.some(c=>String(c.id)===String(raw) || (c.name||'').toLowerCase()===n)) return 'channels';
  // bot by exact name / discord alias
  const alias=DISCORD_ALIASES[n];
  const botName = (b)=> 'bot:'+b.name;
  // exact bot
  let b=botByName(raw); if(b && b.name!=='Oracle') return botName(b);
  // alias → bot
  if(alias){
    if(alias==='oracle') return 'core';
    const ab=AGENTS.find(a=>a.name.toLowerCase()===alias || a.name.toLowerCase().replace(' ','')===alias.replace(' ',''));
    if(ab) return 'bot:'+ab.name;
  }
  // contains a bot name
  for(const a of AGENTS){
    const an=a.name.toLowerCase();
    if(n===an || n.includes(an) || an.includes(n)) return 'bot:'+a.name;
  }
  if(n.includes('coder')) return 'bot:Kai Coder';
  // provider status keys / cloud names
  if(/(groq)/.test(n)) return 'prov:groq';
  if(/(xai|grok)/.test(n)) return 'prov:xai';
  if(/(moonshot|kimi)/.test(n)) return 'prov:moonshot';
  if(/(zen|anthropic|claude|openai|gpt|perplexity|sonar)/.test(n)) return 'prov:zen';
  if(/(gemini)/.test(n)) return 'prov:gemini';
  // human / system → core (they speak to the lattice through Oracle)
  if(/(ryan|nastermodx|revry|user|system|you)/.test(n)) return 'core';
  return null;
}

/* ── ingest the ops feed: spawn a pulse for each genuinely NEW event ────── */
function nsIngestOps(ops){
  if(!ops || !ops.length || !NS.built) return;
  // server returns newest-first; replay oldest→newest so pulses fire in order
  const list = ops.slice().reverse();
  for(const o of list){
    const sig = (o.ts||'')+'|'+(o.from||o.who||'')+'|'+(o.to||'')+'|'+(o.type||'')+'|'+((o.detail||'').slice(0,24));
    if(NS.seen.has(sig)) continue;
    NS.seen.add(sig); NS.seenOrder.push(sig);
    if(NS.seenOrder.length>800){ NS.seen.delete(NS.seenOrder.shift()); }
    const fromId = nsResolve(o.from || o.who);
    const toId   = nsResolve(o.to);
    // record signal-rate counters for ANY recognized event
    const now=Date.now();
    NS.signalStamps.push(now);
    // ERRORS/MIN + RECENT ERRORS readout count ONLY true 'error' status (handled 429s
    // are 'warn' now, so they no longer inflate the number or appear as red sources).
    if(o.status==='error'){
      NS.errStamps.push(now);
      NS.recentErrors.unshift({
        ts:o.ts, who:o.who, from:o.from||o.who, to:o.to||'engine',
        detail:o.detail||'', full:o.full||o.detail||'', raw:o.raw||'',
        type:o.type||'', fromId, toId
      });
      if(NS.recentErrors.length>40) NS.recentErrors.length=40;
      // PRUNER / ERROR = BLACK HOLE: procedurally spawn a void at the failing
      // node's position (deterministic placement from the op signature so the
      // same error lands in the same place — reproducible, but live-driven).
      if(NS.three && (NS.three.cosmosPlanets||NS.scene)){
        const src=(fromId&&NS.nodeById[fromId])||(toId&&NS.nodeById[toId]);
        const h=nsHashStr(sig), jr=nsSeededRng(h);
        let at;
        if(src && src.pos){ var _bd=new THREE.Vector3(jr()*2-1,jr()*2-1,jr()*2-1); if(_bd.lengthSq()<1e-6)_bd.set(1,0,0); _bd.normalize().multiplyScalar((src.r||NS_SCALE*1000)*(8.0+jr()*6.0)); at=src.pos.clone().add(_bd); }   // place the void OUTSIDE the planet (was inside it -> z-fight + wasted GPU)
        else { at=new THREE.Vector3((jr()*2-1)*COSMOS*0.4,(jr()*2-1)*COSMOS*0.3,(jr()*2-1)*COSMOS*0.4); }
        at=nsPlaceAwayFromCamera(at, jr);   // never spawn on top of the owner; fade-in (item 4)
        const sev=/(429|timeout|crash|fatal|panic)/i.test((o.detail||'')+(o.type||''))?1.6:0.7;
        var _near=null, _dmin=(src&&src.r?src.r*14:COSMOS*0.06);
        for(var _bi=0;_bi<NS.blackHoles.length;_bi++){ var _bh=NS.blackHoles[_bi]; if(_bh&&_bh.pos&&_bh.pos.distanceTo(at)<_dmin){ _near=_bh; break; } }
        if(_near){ _near.born=performance.now(); }   // refresh the existing void instead of piling a new one
        else if(performance.now()-(NS._lastBH||0) > 7000){ NS._lastBH=performance.now(); nsSpawnBlackHole(at, sev, h); }
      }
    }
    // DATA-DRIVEN WHITE HOLES — recoveries / new-memory / consolidation events
    // eject a bright core (the inverse of the error black hole). Throttled.
    if(NS.three && o.status!=='error'){
      const blob=((o.type||'')+' '+(o.detail||'')).toLowerCase();
      if(/(recover|recovered|memory|consolidat|new[- ]?cell|learn|insight|wake|reconnect|online)/.test(blob)){
        const now2=Date.now();
        if(!NS._lastWhite || now2-NS._lastWhite>4000){   // throttle to keep it ambient
          NS._lastWhite=now2;
          const src=(fromId&&NS.nodeById[fromId])||(toId&&NS.nodeById[toId]);
          const h=nsHashStr(sig), jr=nsSeededRng(h);
          let at = src&&src.pos ? src.pos.clone().add(new THREE.Vector3((jr()*2-1)*80*NS_SCALE*NS_SPREAD,(jr()*2-1)*80*NS_SCALE*NS_SPREAD,(jr()*2-1)*80*NS_SCALE*NS_SPREAD))
                                  : new THREE.Vector3((jr()*2-1)*COSMOS*0.4,(jr()*2-1)*COSMOS*0.3,(jr()*2-1)*COSMOS*0.4);
          at=nsPlaceAwayFromCamera(at, jr);   // keep recoveries off the camera too
          nsSpawnWhiteHole(at, 1.0, false, h);
        }
      }
      // DATA-DRIVEN WORMHOLES — a cross-channel / bridge / relay link opens a
      // transient portal pair between the two endpoints' positions. Throttled.
      if(/(bridge|relay|cross[- ]?channel|forward|route|portal|link)/.test(blob) && fromId && toId && fromId!==toId){
        const A=NS.nodeById[fromId], B=NS.nodeById[toId];
        const now3=Date.now();
        if(A&&B&&A.pos&&B.pos && (!NS._lastWorm || now3-NS._lastWorm>6000)){
          NS._lastWorm=now3; nsSpawnWormhole(A.pos.clone(), B.pos.clone(), false);
        }
      }
    }
    if(!fromId || !toId || fromId===toId) continue;
    const e = NS.edgeKey[fromId+'|'+toId];
    if(!e) continue;
    // update edge health from this signal's status
    nsBumpEdge(e, o.status, o);
    // spawn the travelling pulse (respect direction)
    NS.pulses.push({ e, fromId, toId, t:0,
      speed: 0.34 + Math.random()*0.16,         // per-second progress
      color: nsStatusColor(o.status), status:o.status||'ok', born:now });
    // cap concurrent pulses so animation stays smooth (recycle dropped sprites)
    if(NS.pulses.length>140){ const drop=NS.pulses.splice(0, NS.pulses.length-140); drop.forEach(d=>{ if(d.spr){ d.spr.visible=false; nsPulsePool.push(d.spr); } }); }
  }
  nsUpdateCounters();
}

/* ── edge health: bump on signal, decay back toward green/idle over time ── */
function nsBumpEdge(e, status, op){
  e.lastTs=Date.now();
  if(status==='error'){ e.health='error'; e.healthV=1; }
  else if(status==='warn'){ if(e.health!=='error'||e.healthV<0.4){ e.health='warn'; } e.healthV=Math.max(e.healthV,0.85); }
  else { if(e.healthV<0.25){ e.health='ok'; } e.healthV=Math.max(e.healthV,0.55); }
  e.recent.unshift({ts:op.ts, status:status||'ok', who:op.who||op.from, detail:op.detail||'', type:op.type||''});
  if(e.recent.length>30) e.recent.length=30;
}

/* ── recolor nodes from CURRENT vitals + provider status ───────────────── */
function nsNodeStatus(node){
  if(node.kind==='core' || node.kind==='engine'){
    return session ? 'ok' : 'error';                     // engine reachability = /api/session
  }
  if(node.kind==='bot'){
    const b=botByName(node.botName)||{};
    if(!b.online) return 'error';
    const lat=(typeof b.latencyMs==='number')?b.latencyMs:null;
    const en=(typeof b.energy==='number')?b.energy:null;
    if((lat!=null && lat>=160) || (en!=null && en<40)) return 'warn';   // high latency / low energy = tense
    return 'ok';
  }
  if(node.kind==='provider'){
    const ss=sysStats||{};
    const p=(Array.isArray(ss.providers)?ss.providers:[]).find(x=>x.provider===node.provKey);
    if(!p) return 'idle';
    if(p.status==='OK') return 'ok';
    if(p.status==='COOLDOWN'||p.status==='STANDBY') return 'warn';
    if(p.status==='OFFLINE'||p.status==='DOWN'||p.status==='ERROR') return 'error';
    return 'idle';
  }
  if(node.kind==='channels'){ return session ? 'ok' : 'idle'; }
  return 'idle';
}
function nsStatusToColor(s){ return s==='error'?NS_RED:(s==='warn'?NS_YELLOW:(s==='ok'?NS_GREEN:NS_IDLE)); }
function nsRefreshHealth(){
  if(!NS.built || !NS.active || !NS.three) return;
  NS.nodes.forEach(n=>{
    n.status=nsNodeStatus(n); n.statusColor=nsStatusToColor(n.status);
    if(n.halo){ n.halo.material.color.set(n.statusColor); }
  });
  nsRebuildEdgeColors();
}

/* ══ THREE.JS SCENE ════════════════════════════════════════════════════ */
function nsInitThree(){
  const wrap=$('ns-wrap'), cvs=$('kv-canvas'), fb=$('kv-fallback');
  if(!wrap||!cvs) return false;
  if(typeof THREE==='undefined'){
    NS.failed=true; if(fb){ fb.style.display='flex'; $('kv-fb-sub').textContent='Three.js failed to load from the CDN. Check your connection and reload.'; }
    return false;
  }
  let renderer;
  try{
    // alpha:FALSE — opaque canvas so the page's blue body-gradient + lattice grid
    // can NEVER show through (that was the real "blue background" the owner saw).
    // ── HARDWARE SAFETY: powerPreference:'high-performance' asks the browser to
    //    select the DISCRETE NVIDIA RTX 4050, NOT the AMD Radeon iGPU (GPU1) which
    //    FREEZES this HP Victus. failIfMajorPerformanceCaveat:false so it still
    //    runs if the browser would otherwise refuse a software/fallback context.
    //    NOTE: powerPreference is only a HINT. The OS-level GUARANTEE is:
    //    Windows Settings → System → Display → Graphics → add the browser exe →
    //    Options → "High performance (NVIDIA)". Do that or the AMD iGPU may freeze.
    // NOTE: logarithmicDepthBuffer was tried for the ~500,000 LY span but the
    // custom raw ShaderMaterials (stars/holes/boids) don't include r128's
    // logdepthbuf GLSL chunks, so log depth made them z-fight the standard-material
    // bodies. Reverted to linear depth — the point fields use depthWrite:false/
    // additive and the solid bodies are spread far apart in depth, so the large
    // near/far ratio doesn't z-fight in practice.
    renderer=new THREE.WebGLRenderer({canvas:cvs, antialias:true, alpha:false,
      powerPreference:'high-performance', failIfMajorPerformanceCaveat:false});
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }catch(err){
    NS.failed=true; if(fb){ fb.style.display='flex'; $('kv-fb-sub').textContent='WebGL is unavailable or disabled in this browser.'; }
    return false;
  }
  renderer.setClearColor(0x010205, 1);   // true near-black space (#010205), opaque
  try{ if(THREE.sRGBEncoding!==undefined) renderer.outputEncoding=THREE.sRGBEncoding; if(THREE.ACESFilmicToneMapping!==undefined){ renderer.toneMapping=THREE.ACESFilmicToneMapping; renderer.toneMappingExposure=1.1; } }catch(_){}
  const scene=new THREE.Scene();
  scene.background=new THREE.Color(0x000000);   // true pitch black space
  scene.fog=new THREE.FogExp2(0x0a0e16, 0.0);   // ATMOSPHERIC HAZE: density driven by altitude (0 in space)
  // near/far scaled with the universe so we can pull WAY back AND fly far in
  // near plane rides NS_BODY so small bodies stay crisp up close; far rides NS_SPREAD
  const camera=new THREE.PerspectiveCamera(NS.baseFov, 1, Math.max(0.6, 0.5*NS_SCALE*NS_BODY), NS.baseFar);
  // Lower ambient so the SUN does the shading (a real lit/dark terminator) instead
  // of everything self-glowing flat. Keep a little fill so dark sides aren't black.
  scene.add(new THREE.AmbientLight(0xffffff, 0.11));
  const pl=new THREE.PointLight(0xffe9c8, 8.5, 0, 0); pl.position.set(0,0,0); scene.add(pl); NS._sunPL=pl;   // was 0.35 — massively increased for the blinding star effect
  
  // BLOOM: Add an massive additive plane to simulate a blinding core flare
  const bloomMat = new THREE.SpriteMaterial({ map: nsMakeGlowTexture(), color: 0xffeedd, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.9 });
  const bloomSprite = new THREE.Sprite(bloomMat);
  bloomSprite.scale.set(60000*NS_SCALE*NS_BODY*12, 60000*NS_SCALE*NS_BODY*12, 1);
  scene.add(bloomSprite);
  // SUN: a directional key light from a fixed angle → planets get a real LIT side
  // and a DARK side. Direction is normalized; we feed the same vector to each
  // atmosphere's uSun so the air brightens on the sun-facing limb.
  const sun=new THREE.DirectionalLight(0xfff0dc, 1.2);
  NS._sunDir=new THREE.Vector3(0.45,0.78,0.55).normalize();
  sun.position.copy(NS._sunDir).multiplyScalar(1000*NS_SCALE);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 4096;
  sun.shadow.mapSize.height = 4096;
  const sd = 50000 * NS_SCALE;
  sun.shadow.camera.left = -sd;
  sun.shadow.camera.right = sd;
  sun.shadow.camera.top = sd;
  sun.shadow.camera.bottom = -sd;
  sun.shadow.camera.near = 100 * NS_SCALE;
  sun.shadow.camera.far = 200000 * NS_SCALE;
  sun.shadow.bias = -0.0005;
  scene.add(sun); NS._sun=sun;

  NS.three={renderer,scene,camera, meshes:[], hits:[], glows:[], lines:null, lineGeo:null, starfield:null, sprites:[], starGeo:null, starBase:null};
  NS.renderer=renderer; NS.scene=scene; NS.camera=camera;
  NS.raycaster=new THREE.Raycaster();

  // --- PHASE 3: WASM & WEB WORKER INTEGRATION ---
  if (typeof window !== 'undefined') {
    // 1. Load WASM for the main thread (for synchronous collision/height checks)
    import('./kaiverse-wasm/pkg/kaiverse_wasm.js').then(wasm => {
      wasm.default().then(() => {
        NS.wasmHeightMap = wasm.ns_terrain_height_wasm;
      }).catch(e => console.error(e));
    }).catch(e => console.error(e));

    // 2. Spawn the background Web Worker for DataTexture generation
    NS.worker = new Worker('kaiverse_worker.js');
    NS.workerReady = false;
    NS.workerCallbacks = {};
    
    NS.worker.onmessage = function(e) {
      if (e.data.type === 'READY') {
        NS.workerReady = true;
        console.log("🚀 Kaiverse Web Worker Ready! DataTextures are hardware-accelerated.");
      } else if (e.data.type === 'RESULT') {
        const { id, data } = e.data;
        if (NS.workerCallbacks[id]) {
          NS.workerCallbacks[id](data);
          delete NS.workerCallbacks[id];
        }
      }
    };
  }
  // ---------------------------------
  // bind WebGL context-loss handlers so a tab return rebuilds GL resources
  nsWireContextEvents(cvs);

  nsBuildStarfield();
  nsBuildBodies();
  nsBuildEdges();
  nsBuildNebula();
  nsInitGravity();      // N-body: seed velocities so massive bodies DRIFT (owner #2)
  nsBuildShips();       // AI inhabitants as spaceships that fly planet→planet (owner #3)
  nsBuildPlayerShip();  // player's own ship (3rd person flight)
  nsResize();
  if(!nsRestoreSpawn()){
    // Default spawn: orbiting the first agent planet (e.g. Gemini) instead of the Core sun
    const firstBot=NS.nodes.find(n=>n.kind==='bot');
    if(firstBot){
      NS.cam.tTargetX=firstBot.pos.x; NS.cam.tTargetY=firstBot.pos.y; NS.cam.tTargetZ=firstBot.pos.z;
      NS.cam.target.copy(firstBot.pos);
      NS.cam.tRadius=(firstBot.r||1)*4; NS.cam.radius=NS.cam.tRadius;
      NS.camera.position.set(firstBot.pos.x+NS.cam.tRadius, firstBot.pos.y, firstBot.pos.z);
    }
  }
  if(fb) fb.style.display='none';
  // Fade out loading overlay after a short delay (let first frame render)
  var _le=$('kv-loading'); if(_le) setTimeout(function(){ _le.style.opacity='0'; setTimeout(function(){ _le.remove(); },700); }, 200);
  return true;
}
/* ── WebGL context lifecycle: survive a tab switch / GPU context loss ─────── */
function nsWireContextEvents(cvs){
  if(cvs._nsCtxWired) return; cvs._nsCtxWired=true;
  cvs.addEventListener('webglcontextlost', (e)=>{
    e.preventDefault();          // REQUIRED so the browser will fire 'restored'
    NS.ctxLost=true;
    if(NS.raf){ cancelAnimationFrame(NS.raf); NS.raf=null; }
  }, false);
  cvs.addEventListener('webglcontextrestored', ()=>{
    // GPU resources were wiped — rebuild the whole scene from scratch, then resume.
    NS.ctxLost=false;
    nsRebuildAfterContextLoss();
  }, false);
}
// tear down dead GL objects and re-init the scene in place (no double-init)
function nsRebuildAfterContextLoss(){
  try{
    if(NS.three){
      const t=NS.three;
      const d=(o)=>{ if(!o) return; if(o.geometry)o.geometry.dispose&&o.geometry.dispose(); if(o.material){ if(o.material.map)o.material.map.dispose&&o.material.map.dispose(); o.material.dispose&&o.material.dispose(); } };
      (t.meshes||[]).forEach(d);(t.hits||[]).forEach(d);(t.glows||[]).forEach(d);(t.sprites||[]).forEach(d);(t.pulseSprites||[]).forEach(d);
      (t.cosmosPlanets||[]).forEach(d);(t.gasClouds||[]).forEach(d);(t.structLabels||[]).forEach(d);
      (t.instanced||[]).forEach(d);
      (NS.blackHoles||[]).forEach(nsDisposeBlackHole);
      (NS.whiteHoles||[]).forEach(nsDisposeWhiteHole);
      (NS.wormholes||[]).forEach(nsDisposeWormhole);
      (NS.pulsars||[]).forEach(nsDisposePulsar);          // pulsars (owner #2)
      if(NS_PULSAR_GEO){ NS_PULSAR_GEO.dispose&&NS_PULSAR_GEO.dispose(); NS_PULSAR_GEO=null; }
      if(NS_PULSAR_BEAMGEO){ NS_PULSAR_BEAMGEO.dispose&&NS_PULSAR_BEAMGEO.dispose(); NS_PULSAR_BEAMGEO=null; }
      nsDisposeBoids();
      nsDisposeShips();   // AI spaceships + trails (rebuilt fresh by nsInitThree below)
      NS.nodes.forEach(n=>{ if(n.atmo) d(n.atmo); if(n.halo) d(n.halo); });
      d(t.lines);d(t.starfield);d(t.debris);d(NS.nebula);d(t.warp);
      for(const k in nsPlanetTexCache){ try{ nsPlanetTexCache[k].dispose(); }catch(_){} delete nsPlanetTexCache[k]; }
    }
  }catch(_){}
  if(NS._glowTex){ try{NS._glowTex.dispose();}catch(_){ } NS._glowTex=null; }
  if(NS._gasTex){ try{NS._gasTex.dispose();}catch(_){ } NS._gasTex=null; } NS._gasPuffs=null;
  nsDisposeSectors();   // tear down all live procedural sectors so they rebuild fresh
  nsPulsePool.length=0; NS.pulses=[]; NS.blackHoles=[]; NS.whiteHoles=[]; NS.wormholes=[]; NS.pulsars=[]; NS.cosmosPlanets=null; NS._structPts=[]; NS._lodFields=[];
  NS_GRAV.bodies=[]; NS_GRAV._acc=null; NS.ships=[]; NS._shipObs=null; NS._boidHoles=null;
  NS.three=null; NS.renderer=null; NS.scene=null; NS.camera=null; NS.nebula=null;
  NS.nodes.forEach(n=>{ n.mesh=n.halo=n.label=n.atmo=n.hit=null; });
  NS.built=false;
  // re-init only if still on the Nervous System view
  if(NS.active){
    if(!NS.built) nsBuild();
    if(nsInitThree()){
      nsRefreshHealth(); nsScaleNebula();
      if(allOps && allOps.length) nsIngestOps(allOps);
      NS.lastFrame=0; NS.paused=false;
      if(!NS.raf) NS.raf=requestAnimationFrame(nsTick);
    }
  }
}

/* ══ PROCEDURAL COSMOS ════════════════════════════════════════════════════
   The 9 AI nodes are a SMALL central cluster (radii ~150*S). Around & beyond
   them we build a VAST procedural field so even fully zoomed out the cluster
   is a tiny region. Everything below is SEEDED + deterministic (reproducible)
   but COUNTS are scaled from REAL lattice stats (cells/synapses) and live
   error stream (black holes). The vast field is GPU-cheap: instanced Points
   for stars/debris/gas; only a capped number of full-mesh "cosmos planets"
   beyond the AI cluster.
   COSMOS = half-extent of the vast volume; ~12x the AI cluster radius so the
   cluster reads as a small bright knot in a huge dark space. ───────────────*/
const COSMOS = 3000000*NS_SCALE*NS_SPREAD;         // vast half-extent: now ENCOMPASSES the spread-out planets so stars surround everything
// deterministic PRNG (mulberry32) so the cosmos is identical every restart
function nsSeededRng(seed){ let a=seed>>>0; return function(){ a|=0; a=(a+0x6D2B79F5)|0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }
function nsHashStr(s){ let h=2166136261>>>0; s=String(s); for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }

// vast procedural cosmos backdrop + warp field. counts scale from REAL stats.
function nsBuildStarfield(){
  const S=NS_SCALE, rng=nsSeededRng(nsHashStr('KAIVERSE-COSMOS'));

  // 0) PROCEDURAL GALACTIC SKYBOX (The Milky Way Band)
  // A giant inner sphere attached to the camera, rendering a volumetric galaxy band behind everything.
  const skyGeo = new THREE.SphereGeometry(30000 * S * NS_SPREAD, 64, 64);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 } },
    side: THREE.BackSide,
    depthWrite: false,
    transparent: true,
    opacity: 1.0,
    vertexShader: [
      'varying vec3 vWorldPosition;',
      'void main() {',
      '  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );',
      '  vWorldPosition = worldPosition.xyz;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform float uT;',
      'varying vec3 vWorldPosition;',
      '// Simple 3D noise function',
      'vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x, 289.0);}',
      'vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314 * r;}',
      'float snoise(vec3 v){ ',
      '  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;',
      '  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);',
      '  vec3 i  = floor(v + dot(v, C.yyy) );',
      '  vec3 x0 = v - i + dot(i, C.xxx) ;',
      '  vec3 g = step(x0.yzx, x0.xyz);',
      '  vec3 l = 1.0 - g;',
      '  vec3 i1 = min( g.xyz, l.zxy );',
      '  vec3 i2 = max( g.xyz, l.zxy );',
      '  vec3 x1 = x0 - i1 + 1.0 * C.xxx;',
      '  vec3 x2 = x0 - i2 + 2.0 * C.xxx;',
      '  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;',
      '  i = mod(i, 289.0); ',
      '  vec4 p = permute( permute( permute( ',
      '             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))',
      '           + i.y + vec4(0.0, i1.y, i2.y, 1.0 )) ',
      '           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));',
      '  float n_ = 1.0/7.0; // N=7',
      '  vec3  ns = n_ * D.wyz - D.xzx;',
      '  vec4 j = p - 49.0 * floor(p * ns.z *ns.z);  //  mod(p,N*N)',
      '  vec4 x_ = floor(j * ns.z);',
      '  vec4 y_ = floor(j - 7.0 * x_ );    // mod(j,N)',
      '  vec4 x = x_ *ns.x + ns.yyyy;',
      '  vec4 y = y_ *ns.x + ns.yyyy;',
      '  vec4 h = 1.0 - abs(x) - abs(y);',
      '  vec4 b0 = vec4( x.xy, y.xy );',
      '  vec4 b1 = vec4( x.zw, y.zw );',
      '  vec4 s0 = floor(b0)*2.0 + 1.0;',
      '  vec4 s1 = floor(b1)*2.0 + 1.0;',
      '  vec4 sh = -step(h, vec4(0.0));',
      '  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;',
      '  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;',
      '  vec3 p0 = vec3(a0.xy,h.x);',
      '  vec3 p1 = vec3(a0.zw,h.y);',
      '  vec3 p2 = vec3(a1.xy,h.z);',
      '  vec3 p3 = vec3(a1.zw,h.w);',
      '  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));',
      '  p0 *= norm.x;',
      '  p1 *= norm.y;',
      '  p2 *= norm.z;',
      '  p3 *= norm.w;',
      '  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);',
      '  m = m * m;',
      '  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3) ) );',
      '}',
      'float fbm(vec3 x) {',
      '  float v = 0.0;',
      '  float a = 0.5;',
      '  vec3 shift = vec3(100.0);',
      '  for (int i = 0; i < 5; ++i) {',
      '    v += a * snoise(x);',
      '    x = x * 2.0 + shift;',
      '    a *= 0.5;',
      '  }',
      '  return v;',
      '}',
      'void main() {',
      '  vec3 dir = normalize(vWorldPosition);',
      '  // The galactic plane is tilted slightly',
      '  float tilt = 0.3;',
      '  float galacticY = dir.y * cos(tilt) - dir.z * sin(tilt);',
      '  // Base intensity falls off with distance from the galactic plane',
      '  float planeDist = abs(galacticY);',
      '  float baseIntensity = exp(-planeDist * 8.0);',
      '  // Add swirling noise',
      '  vec3 noiseScale = dir * 12.0;',
      '  float n1 = fbm(noiseScale + uT * 0.005);',
      '  float n2 = fbm(noiseScale * 2.0 - uT * 0.003);',
      '  float cloud = smoothstep(0.0, 1.0, n1 * 0.5 + 0.5) * smoothstep(-0.2, 0.8, n2 * 0.5 + 0.5);',
      '  float intensity = baseIntensity * cloud * 1.2;',
      '  // Color mapping: edge is dark purple, mid is blue/magenta, core is gentle teal/blue',
      '  vec3 colEdge = vec3(0.02, 0.0, 0.08);',
      '  vec3 colMid  = vec3(0.05, 0.2, 0.45);',
      '  vec3 colCore = vec3(0.2, 0.6, 0.7);',
      '  vec3 color = mix(colEdge, colMid, smoothstep(0.0, 0.4, intensity));',
      '  color = mix(color, colCore, smoothstep(0.4, 0.9, intensity));',
      '  color += vec3(0.6, 0.9, 1.0) * smoothstep(0.7, 1.0, intensity) * 0.5;',
      '  // Add subtle star dust in the band',
      '  float starNoise = snoise(dir * 150.0);',
      '  float stars = smoothstep(0.85, 1.0, starNoise * 0.5 + 0.5) * baseIntensity;',
      '  color += vec3(1.0) * stars * 0.5;',
      '  gl_FragColor = vec4(color, clamp(intensity * 1.2, 0.0, 1.0));',
      '}'
    ].join('\n')
  });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.renderOrder = -9999;
  NS.scene.add(skyMesh);
  NS._skyboxMat = skyMat;
  NS._skyboxMesh = skyMesh;
  // count tuning from REAL lattice stats (set into statSnap before activate;
  // falls back to floor if not yet polled — re-scaled later by nsScaleCosmos)
  const cells=Number(NS.statSnap.cells)||50000;
  const syn=Number(NS.statSnap.synapses)||500000;
  // log-scaled star density: more cells → denser cosmos (instanced Points, capped)
  const starN=Math.min(60000, Math.max(14000, Math.round(Math.log10(cells+10)*9000)));
  const debrisN=Math.min(9000, Math.max(2500, Math.round(Math.log10(syn+10)*1500)));

  // 1) VAST STARFIELD — lattice-cell stars spread across the whole volume.
  //    Two shells: a far backdrop sphere + an inner volumetric scatter so the
  //    AI cluster sits embedded in a deep field (not a flat dome behind it).
  const pos=new Float32Array(starN*3), scol=new Float32Array(starN*3);
  const starHues=[[0.62,0.78,1.0],[1.0,0.95,0.85],[1.0,0.8,0.6],[0.8,0.85,1.0],[1.0,1.0,1.0]];
  for(let i=0;i<starN;i++){
    // 60% volumetric (spherical), 40% far shell → real depth
    let r, t, p, x, y, z;
    if(rng()<0.6){ 
      r = Math.cbrt(rng())*COSMOS; 
      t = rng()*Math.PI*2; 
      p = Math.acos(2*rng()-1); 
      x = r*Math.sin(p)*Math.cos(t); 
      y = r*Math.cos(p)*0.7; // slightly flattened galaxy
      z = r*Math.sin(p)*Math.sin(t); 
    }
    else { 
      r = (0.7+rng()*0.5)*COSMOS; 
      t = rng()*Math.PI*2; 
      p = Math.acos(2*rng()-1); 
      x = r*Math.sin(p)*Math.cos(t); 
      y = r*Math.cos(p); 
      z = r*Math.sin(p)*Math.sin(t); 
    }
    pos[i*3]=x; pos[i*3+1]=y; pos[i*3+2]=z;
    const h=starHues[(rng()*starHues.length)|0], b=0.5+rng()*0.5;
    scol[i*3]=h[0]*b; scol[i*3+1]=h[1]*b; scol[i*3+2]=h[2]*b;
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color', new THREE.BufferAttribute(scol,3));
  // per-star random phase for twinkle (GPU shader)
  const sph=new Float32Array(starN); for(let i=0;i<starN;i++) sph[i]=Math.random()*6.28;
  g.setAttribute('aPhase', new THREE.BufferAttribute(sph,1));
  // GPU STAR SHADER — size attenuation + soft round point + subtle twinkle.
  // additive blending so dense regions glow like real star fields. r128-safe.
  const m=new THREE.ShaderMaterial({
    uniforms:{ uT:{value:0}, uSize:{value:2.4*Math.sqrt(S)*15.0} },
    vertexShader:[
      'uniform float uT; uniform float uSize; attribute float aPhase;',
      'varying vec3 vC; varying float vTw;',
      'void main(){ vC=color; vTw=0.6+0.4*sin(uT*2.0+aPhase);',
      ' vec4 mv=modelViewMatrix*vec4(position,1.0);',
      ' gl_PointSize=uSize*vTw/max(1.0,-mv.z*0.0025+1.0);',
      ' gl_Position=projectionMatrix*mv; }'].join('\n'),
    fragmentShader:[
      'varying vec3 vC; varying float vTw;',
      'void main(){ vec2 d=gl_PointCoord-0.5; float r=length(d);',
      ' float a=smoothstep(0.5,0.0,r);',
      ' gl_FragColor=vec4(vC*(0.7+0.6*vTw), a*0.9); }'].join('\n'),
    vertexColors:true, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false
  });
  const pts=new THREE.Points(g,m); pts.frustumCulled=false; NS.scene.add(pts); NS.three.starfield=pts;
  NS.three.starGeo=g; NS.three.starCap=starN; NS.three.starMat=m;

  // 2) SPACE DEBRIS FIELDS — dimmer, clumped scatter (synapse-scaled). A few
  //    debris belts at random orbital bands so it reads as structure not noise.
  const dpos=new Float32Array(debrisN*3);
  const belts=4+((nsHashStr('debris')%4));
  for(let i=0;i<debrisN;i++){
    const belt=(i*belts/debrisN)|0;
    const bandR=(0.18+belt*0.2)*COSMOS*(0.8+rng()*0.4);
    const t=rng()*Math.PI*2, jitter=(rng()*2-1)*COSMOS*0.06, yj=(rng()*2-1)*COSMOS*0.05;
    dpos[i*3]=Math.cos(t)*bandR+jitter; dpos[i*3+1]=yj+(rng()*2-1)*COSMOS*0.03; dpos[i*3+2]=Math.sin(t)*bandR+jitter;
  }
  const dg=new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dpos,3));
  const dm=new THREE.PointsMaterial({map:nsMakeGlowTexture(), color:0x7a8295, size:1.5*Math.sqrt(S), sizeAttenuation:true, transparent:true, opacity:0.42, depthWrite:false});
  const dbr=new THREE.Points(dg,dm); dbr.frustumCulled=false; NS.scene.add(dbr); NS.three.debris=dbr;

  // 3) WARP FIELD — capped, reusable LineSegments that streak SUBTLY with speed.
  //    Streaks are now far fewer + much shorter (owner: "too many lines").
  const WN=320; NS.warpCount=WN; NS.warpBox=520*S*NS_SPREAD;   // fewer stars, bigger cube (rides spread)
  const wpos=new Float32Array(WN*6), wbase=new Float32Array(WN*3);
  for(let i=0;i<WN;i++){
    const bx=(rng()*2-1)*NS.warpBox, by=(rng()*2-1)*NS.warpBox, bz=(rng()*2-1)*NS.warpBox;
    wbase[i*3]=bx; wbase[i*3+1]=by; wbase[i*3+2]=bz;
    wpos[i*6]=bx; wpos[i*6+1]=by; wpos[i*6+2]=bz; wpos[i*6+3]=bx; wpos[i*6+4]=by; wpos[i*6+5]=bz;
  }
  const wg=new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.BufferAttribute(wpos,3));
  const wm=new THREE.LineBasicMaterial({color:0xaecaff, transparent:true, opacity:0.0, blending:THREE.AdditiveBlending, depthWrite:false});
  const warp=new THREE.LineSegments(wg,wm); warp.frustumCulled=false; warp.visible=false; // owner: hide non-data streak lines (data shows as pulse lasers)
  NS.scene.add(warp); NS.three.warp=warp; NS.three.warpGeo=wg; NS.three.warpBase=wbase;

  // 4) GAS / NEBULA CLOUDS + COSMOS PLANETS + ASTEROIDS + BOIDS + HOLES
  NS._structPts=[];                 // shared min-spacing accumulator (sector spread)
  nsBuildGasClouds(rng);
  nsBuildCosmosPlanets(rng);        // RARE full-mesh worlds
  nsBuildAsteroids(rng);            // ABUNDANT instanced rocks/debris/belts (after planets)
  nsBuildBoids(rng);                // ambient boids flock (data motes) — item 11
  nsSpawnGalacticCenter();          // supermassive black hole at the galactic centre (~10M ly out)
  nsBuildExoticStructures(rng);     // ambient white holes + wormholes (discoverable)
  NS.blackHoles=[]; NS.three.blackHoles=[];   // black holes spawned live from errors
}

/* ── BOIDS ENGINE AMBIENT FIELD (owner #11, grounded in KAI's RSHL) ─────────
   The engine's real boid pass (src/core/boid_engine.rs) flocks lattice cells
   with separation+alignment+cohesion all weighted 1.5, a neighbour-similarity
   CAP of 0.85 (MAX_NEIGHBOR_SIM), and field modulators: chi→separation,
   r_val→alignment, phi_g→cohesion. We mirror those exact knobs here so the
   ambient "data motes" drift as flocks the same way KAI's beliefs do. They are
   rendered as a single Points cloud (one draw call) with subtle vector trails;
   occasionally pulled into a black hole / ejected by a white hole. Sparse +
   vast → hard to spot, which is intended. No per-frame allocation: fixed typed
   arrays, integrated in place. */
const NS_BOID = {
  // mirrors boid_engine.rs BoidSettings::default() + MAX_NEIGHBOR_SIM
  sep:1.5, align:1.5, coh:1.5, simCap:0.85,
  // field modulators (start neutral; live field nudges them, item 12)
  chi:0.0, rVal:0.6, phiG:0.4,
  neighborR:0, count:900, maxSpeed:0
};
function nsBuildBoids(rng){
  const S=NS_SCALE, N=NS_BOID.count;
  NS_BOID.neighborR=COSMOS*0.10; NS_BOID.maxSpeed=COSMOS*0.020;
  const pos=new Float32Array(N*3), vel=new Float32Array(N*3);
  for(let i=0;i<N;i++){
    const r=Math.cbrt(rng())*COSMOS*0.85, t=rng()*6.28, p=Math.acos(2*rng()-1);
    pos[i*3]=r*Math.sin(p)*Math.cos(t); pos[i*3+1]=r*Math.cos(p)*0.7; pos[i*3+2]=r*Math.sin(p)*Math.sin(t);
    vel[i*3]=(rng()*2-1)*NS_BOID.maxSpeed*0.3; vel[i*3+1]=(rng()*2-1)*NS_BOID.maxSpeed*0.3; vel[i*3+2]=(rng()*2-1)*NS_BOID.maxSpeed*0.3;
  }
  // trail = a second segment endpoint per boid (LineSegments) — subtle vector trail
  const tpos=new Float32Array(N*6);
  for(let i=0;i<N;i++){ tpos[i*6]=pos[i*3];tpos[i*6+1]=pos[i*3+1];tpos[i*6+2]=pos[i*3+2];tpos[i*6+3]=pos[i*3];tpos[i*6+4]=pos[i*3+1];tpos[i*6+5]=pos[i*3+2]; }
  const pg=new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pos,3));
  const pm=new THREE.PointsMaterial({map:nsMakeGlowTexture(), color:0x37e0a0, size:2.2*Math.sqrt(S), sizeAttenuation:true, transparent:true, opacity:0.55, blending:THREE.AdditiveBlending, depthWrite:false});
  const pts=new THREE.Points(pg,pm); pts.frustumCulled=false; NS.scene.add(pts);
  const tg=new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(tpos,3));
  const tm=new THREE.LineBasicMaterial({color:0x2bbf88, transparent:true, opacity:0.18, blending:THREE.AdditiveBlending, depthWrite:false});
  const trails=new THREE.LineSegments(tg,tm); trails.frustumCulled=false; trails.visible=false; NS.scene.add(trails);
  NS.boids={ pos, vel, tpos, geo:pg, trailGeo:tg, points:pts, trails, n:N,
             // reusable scratch vectors (no per-frame alloc)
             _acc:new Float32Array(3) };
  NS.three.boidObjs=[pts, trails];
}
// one boids integration step (separation / alignment / cohesion + hole forces).
// Throttled neighbour scan: each frame only a slice of boids re-evaluates its
// flock (round-robin) so it stays O(N) not O(N^2) at 900 boids.
function nsStepBoids(dt, t){
  if(NS._nearPlanet) return;   // PERF: motes are irrelevant on a surface
  const B=NS.boids; if(!B) return;
  const N=B.n, pos=B.pos, vel=B.vel, tpos=B.tpos;
  // camera position + forward (for the off-screen-only wrap, item #3 teleport fix)
  const cam=NS.camera; let bcx=0,bcy=0,bcz=0,bfx=0,bfy=0,bfz=-1;
  if(cam){ cam.updateMatrixWorld(); bcx=cam.position.x;bcy=cam.position.y;bcz=cam.position.z;
    const m=cam.matrixWorld.elements; bfx=-m[8];bfy=-m[9];bfz=-m[10]; }
  const nr=NS_BOID.neighborR, nr2=nr*nr, maxS=NS_BOID.maxSpeed;
  // live field modulators (boid_engine.rs: chi→sep, r_val→align, phi_g→coh)
  const sepW=NS_BOID.sep*(1+NS_BOID.chi*2.0), alignW=NS_BOID.align*(1+NS_BOID.rVal), cohW=NS_BOID.coh*(1+NS_BOID.phiG);
  const slice=180, start=(NS._boidCursor||0)%N; NS._boidCursor=(start+slice)%N;
  for(let s=0;s<slice;s++){
    const i=(start+s)%N, ix=i*3;
    let sx=0,sy=0,sz=0, ax=0,ay=0,az=0, cx=0,cy=0,cz=0, nc=0;
    // sample a sparse neighbour set (every 7th boid) — cheap flock estimate
    for(let j=0;j<N;j+=7){ if(j===i) continue; const jx=j*3;
      const dx=pos[ix]-pos[jx], dy=pos[ix+1]-pos[jx+1], dz=pos[ix+2]-pos[jx+2];
      const d2=dx*dx+dy*dy+dz*dz; if(d2>nr2||d2<1e-3) continue;
      const inv=1/Math.sqrt(d2);
      sx+=dx*inv; sy+=dy*inv; sz+=dz*inv;                 // separation (push apart)
      ax+=vel[jx]; ay+=vel[jx+1]; az+=vel[jx+2];          // alignment (match heading)
      cx+=pos[jx]; cy+=pos[jx+1]; cz+=pos[jx+2];          // cohesion (toward centre)
      nc++;
    }
    if(nc>0){
      vel[ix]   += (sx*sepW + (ax/nc-vel[ix])*alignW*0.02 + (cx/nc-pos[ix])*cohW*1e-5)*dt;
      vel[ix+1] += (sy*sepW + (ay/nc-vel[ix+1])*alignW*0.02 + (cy/nc-pos[ix+1])*cohW*1e-5)*dt;
      vel[ix+2] += (sz*sepW + (az/nc-vel[ix+2])*alignW*0.02 + (cz/nc-pos[ix+2])*cohW*1e-5)*dt;
    }
  }
  // integrate ALL boids every frame (cheap), apply hole forces, wrap to volume.
  // reuse a cached holes array (no per-frame allocation).
  const holes=NS._boidHoles||(NS._boidHoles=[]); holes.length=0;
  if(NS.blackHoles) for(const b of NS.blackHoles){ if(b.pos) holes.push({p:b.pos, k:1}); }   // pull in
  if(NS.whiteHoles) for(const w of NS.whiteHoles){ if(w.pos) holes.push({p:w.pos, k:-1}); }  // eject
  if(NS.pulsars) for(const p of NS.pulsars){ if(p.pos) holes.push({p:p.pos, k:-0.6}); }       // pulsars REPEL (push)
  for(let i=0;i<N;i++){ const ix=i*3;
    for(const h of holes){ if(!h.p) continue;
      const dx=h.p.x-pos[ix], dy=h.p.y-pos[ix+1], dz=h.p.z-pos[ix+2];
      const d2=dx*dx+dy*dy+dz*dz, d=Math.sqrt(d2)||1; const pull=COSMOS*0.0006;
      if(d<COSMOS*0.22){ const f=h.k*pull/(0.2+d/(COSMOS*0.1)); vel[ix]+=dx/d*f; vel[ix+1]+=dy/d*f; vel[ix+2]+=dz/d*f;
        if(h.k>0 && d<COSMOS*0.012){ // consumed → respawn far away (recycle)
          const r=COSMOS*0.8, tt=Math.random()*6.28, pp=Math.acos(2*Math.random()-1);
          pos[ix]=r*Math.sin(pp)*Math.cos(tt); pos[ix+1]=r*Math.cos(pp)*0.7; pos[ix+2]=r*Math.sin(pp)*Math.sin(tt);
          vel[ix]=vel[ix+1]=vel[ix+2]=0;
        } }
    }
    // clamp speed
    let vx=vel[ix],vy=vel[ix+1],vz=vel[ix+2]; const sp=Math.sqrt(vx*vx+vy*vy+vz*vz);
    if(sp>maxS){ const k=maxS/sp; vx*=k;vy*=k;vz*=k; vel[ix]=vx;vel[ix+1]=vy;vel[ix+2]=vz; }
    // trail tail = previous position, head = new
    tpos[i*6]=pos[ix]; tpos[i*6+1]=pos[ix+1]; tpos[i*6+2]=pos[ix+2];
    pos[ix]+=vx*dt; pos[ix+1]+=vy*dt; pos[ix+2]+=vz*dt;
    tpos[i*6+3]=pos[ix]; tpos[i*6+4]=pos[ix+1]; tpos[i*6+5]=pos[ix+2];
    // soft toroidal wrap so the flock stays in the volume — but ONLY when the
    // boid is BEHIND the camera (off-screen). Same teleport fix as the dust field:
    // a boid never visibly jumps. If it's out of bounds but still in front, it is
    // left alone this frame and simply drifts back (or wraps once it passes behind).
    const lim=COSMOS*0.98;
    const oob = pos[ix]>lim||pos[ix]<-lim||pos[ix+1]>lim||pos[ix+1]<-lim||pos[ix+2]>lim||pos[ix+2]<-lim;
    if(oob){
      const ddx=pos[ix]-bcx, ddy=pos[ix+1]-bcy, ddz=pos[ix+2]-bcz;
      const behind = (ddx*bfx+ddy*bfy+ddz*bfz) < 0;   // off-screen (behind view dir)
      if(behind){
        if(pos[ix]>lim)pos[ix]-=2*lim; else if(pos[ix]<-lim)pos[ix]+=2*lim;
        if(pos[ix+1]>lim)pos[ix+1]-=2*lim; else if(pos[ix+1]<-lim)pos[ix+1]+=2*lim;
        if(pos[ix+2]>lim)pos[ix+2]-=2*lim; else if(pos[ix+2]<-lim)pos[ix+2]+=2*lim;
      }
    }
  }
  B.geo.attributes.position.needsUpdate=true;
  B.trailGeo.attributes.position.needsUpdate=true;
}
function nsDisposeBoids(){
  const B=NS.boids; if(!B) return;
  [B.points, B.trails].forEach(o=>{ if(!o)return; NS.scene&&NS.scene.remove(o); if(o.geometry)o.geometry.dispose&&o.geometry.dispose(); if(o.material)o.material.dispose&&o.material.dispose(); });
  NS.boids=null;
}

/* ── INFINITE STREAMING AMBIENT FIELD (owner #10) ──────────────────────────
   "if i zoom out and out forever it should keep showing fresh space, not an
   empty skybox edge." The star + debris + dust fields are TOROIDALLY WRAPPED
   around the camera: any point that falls farther than half-box from the camera
   on an axis is re-emitted on the opposite side (mod arithmetic). The field
   therefore tiles infinitely and always surrounds the viewer — no edge, no
   finite skybox — while staying cheap (typed-array writes, no allocation). We
   process all points (24k+9k) but only the position buffer; flagged once/frame.
   Each axis half-extent = COSMOS so the cell the owner is in always reads full. */
function nsStreamAmbient(){
  const t3=NS.three, cam=NS.camera; if(!t3||!cam) return;
  const half=COSMOS, span=2*half;
  // ── TELEPORT FIX (owner #3) ── the owner saw dust "teleport time and location"
  // because a point could wrap while still on-screen/in-front. A reposition must
  // NEVER be visible. So a point is only recycled when it is BOTH:
  //   (a) FAR from the camera (offset magnitude past the wrap edge), AND
  //   (b) OFF-SCREEN — its offset points BEHIND the view direction (dot<0), so it
  //       is outside the forward frustum and cannot be seen when it jumps.
  // Camera forward (world) is read once per frame from its matrix — no per-point
  // projection, no allocation. NAMED/structural bodies are never touched here.
  const cx=cam.position.x, cy=cam.position.y, cz=cam.position.z;
  // forward = -Z of the camera world matrix (THREE convention). Ensure it's the
  // CURRENT frame's transform (render() hasn't run yet this tick).
  cam.updateMatrixWorld();
  const m=cam.matrixWorld.elements;
  const fx=-m[8], fy=-m[9], fz=-m[10];
  const wrap=(geo)=>{
    if(!geo||!geo.attributes||!geo.attributes.position) return;
    const a=geo.attributes.position.array, n=a.length/3;
    let changed=false;
    for(let i=0;i<n;i++){ const ix=i*3;
      const dx=a[ix]-cx, dy=a[ix+1]-cy, dz=a[ix+2]-cz;
      // only consider points that are BEHIND the camera (off-screen). A small
      // negative bias (<-0.15) keeps anything near the screen edge eligible to
      // stay put, so the wrap is well out of view.
      const fdot=dx*fx+dy*fy+dz*fz;
      if(fdot >= -0.15*Math.sqrt(dx*dx+dy*dy+dz*dz)) continue;   // in front / near view → do NOT move
      if(dx>half){a[ix]-=span;changed=true;} else if(dx<-half){a[ix]+=span;changed=true;}
      if(dy>half){a[ix+1]-=span;changed=true;} else if(dy<-half){a[ix+1]+=span;changed=true;}
      if(dz>half){a[ix+2]-=span;changed=true;} else if(dz<-half){a[ix+2]+=span;changed=true;}
    }
    if(changed) geo.attributes.position.needsUpdate=true;
  };
  // amortise: alternate which field we wrap each frame so we never pay for both
  // 33k points in the same frame (still wraps fast enough that no edge appears).
  NS._streamFlip=!NS._streamFlip;
  if(NS._streamFlip){ if(t3.starGeo) wrap(t3.starGeo); }
  else { if(t3.debris&&t3.debris.geometry) wrap(t3.debris.geometry); }
}

/* ══ INFINITE PROCEDURAL SECTORS (owner #1 — "2,000,000 LY away and I see
   nothing still") ══════════════════════════════════════════════════════════
   The home region (named bots / core / holes / nebulae) is a bounded knot. The
   old toroidal-wrap field only refilled space BEHIND the camera, so flying
   FORWARD for millions of LY emptied the view → void. This REPLACES that with a
   true chunk/sector grid that follows the camera ANYWHERE:

     • Space is divided into cubic SECTORS of side NS_SECT.size. The sector that
       contains world-point P is floor(P / size).
     • Each frame we compute the camera's sector and ensure every sector within
       NS_SECT.radius (Chebyshev) is GENERATED; sectors outside radius+1 are
       FREED (GL disposed). So wherever the owner is — 2M LY, 2B LY — the
       surrounding cells are always populated. There is no global extent.
     • A sector's contents are DETERMINISTIC: seeded from hash(sx,sy,sz) so the
       same coordinates always look identical. Contents = one Points cloud of
       stars + faint dust + occasional asteroid speckle, plus a rare soft gas
       puff sprite or asteroid-belt accent. (Full-mesh planets/holes stay home.)
     • PERFORMANCE: generation is AMORTISED — at most NS_SECT.budget sectors are
       built per frame (the rest wait for following frames). Active sectors are
       CAPPED (a 5×5×5 shell ≈ 125 max). Each sector reuses fixed typed arrays;
       freeing disposes geometry+material. No per-frame allocation in the steady
       state (only the throttled build/free touches GL). nsDisposeSectors tears
       down every live sector (called from nsDeactivate AND the context-loss
       rebuild) so it restarts cleanly. ──────────────────────────────────────*/
const NS_SECT = {
  size:   0,           // sector side (world units) — set at first step from scale
  radius: 2,           // generate sectors within this Chebyshev ring (5×5×5=125)
  budget: 3,           // max sectors generated per frame (amortised)
  map:    null,        // Map<"sx,sy,sz", sectorObj>
  starsPer: 340,       // star points per sector
  dustPer:  220,       // faint dust points per sector
  _v:     null,        // scratch THREE.Vector3
  _curKey:'',          // last camera sector key (skip recompute when unchanged)
};
function nsSeedHash3(sx,sy,sz){
  // mix three signed ints into a 32-bit seed (order-sensitive, well-spread)
  let h=2166136261>>>0;
  h=Math.imul(h^(sx|0),16777619); h=Math.imul(h^(sy|0),16777619); h=Math.imul(h^(sz|0),16777619);
  h^=h>>>13; h=Math.imul(h,0x5bd1e995); h^=h>>>15; return h>>>0;
}
function nsSectorKey(sx,sy,sz){ return sx+','+sy+','+sz; }
// build ONE sector at integer coords — deterministic from its hash seed.
function nsBuildSector(sx,sy,sz){
  if(!NS.three||!NS.scene) return null;
  const size=NS_SECT.size, rng=nsSeededRng(nsSeedHash3(sx,sy,sz));
  const ox=sx*size, oy=sy*size, oz=sz*size;   // sector origin (min corner)
  const grp=[];                               // GL objects in this sector (for dispose)
  // 1) STARS — additive soft round points (matches the home starfield look)
  const sN=NS_SECT.starsPer, spos=new Float32Array(sN*3), scol=new Float32Array(sN*3);
  const hues=[[0.62,0.78,1.0],[1.0,0.95,0.85],[1.0,0.8,0.6],[0.8,0.85,1.0],[1.0,1.0,1.0]];
  for(let i=0;i<sN;i++){
    spos[i*3]=ox+rng()*size; spos[i*3+1]=oy+rng()*size; spos[i*3+2]=oz+rng()*size;
    const h=hues[(rng()*hues.length)|0], b=0.45+rng()*0.55;
    scol[i*3]=h[0]*b; scol[i*3+1]=h[1]*b; scol[i*3+2]=h[2]*b;
  }
  const sg=new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(spos,3));
  sg.setAttribute('color', new THREE.BufferAttribute(scol,3));
  const sm=new THREE.PointsMaterial({size:2.0*Math.sqrt(NS_SCALE), sizeAttenuation:true,
    vertexColors:true, transparent:true, opacity:0.92, map:nsMakeGlowTexture(),
    blending:THREE.AdditiveBlending, depthWrite:false});
  const sp=new THREE.Points(sg,sm); sp.frustumCulled=false; NS.scene.add(sp); grp.push(sp);
  // 2) DUST — dimmer, denser specks for "always something around you"
  const dN=NS_SECT.dustPer, dpos=new Float32Array(dN*3);
  for(let i=0;i<dN;i++){ dpos[i*3]=ox+rng()*size; dpos[i*3+1]=oy+rng()*size; dpos[i*3+2]=oz+rng()*size; }
  const dg=new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dpos,3));
  const dm=new THREE.PointsMaterial({map:nsMakeGlowTexture(), color:0x8893a8, size:1.3*Math.sqrt(NS_SCALE), sizeAttenuation:true,
    transparent:true, opacity:0.34, depthWrite:false});
  const dp=new THREE.Points(dg,dm); dp.frustumCulled=false; NS.scene.add(dp); grp.push(dp);
  // 3) OCCASIONAL soft GAS puff (rare) — volumetric 3D point cloud nebula
  if(rng()<0.30){
    const puffGrp = new THREE.Group();
    puffGrp.position.set(ox+rng()*size, oy+rng()*size, oz+rng()*size);
    const nPts = 1200 + (rng()*800)|0;
    const ppos = new Float32Array(nPts*3);
    const pcol = new Float32Array(nPts*3);
    const hue = rng();
    const gsz = size*(0.15+rng()*0.15);
    for(let i=0; i<nPts; i++){
      const r = Math.cbrt(rng())*gsz, t = rng()*6.28, p = Math.acos(2*rng()-1);
      ppos[i*3] = r*Math.sin(p)*Math.cos(t);
      ppos[i*3+1] = r*Math.cos(p)*0.6; // slightly flattened
      ppos[i*3+2] = r*Math.sin(p)*Math.sin(t);
      const c = new THREE.Color().setHSL(hue + (rng()*0.1 - 0.05), 0.6, 0.5 + rng()*0.2);
      pcol[i*3]=c.r; pcol[i*3+1]=c.g; pcol[i*3+2]=c.b;
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(ppos,3));
    bg.setAttribute('color', new THREE.BufferAttribute(pcol,3));
    const bm = new THREE.PointsMaterial({map:nsMakeGlowTexture(), size: 15.0*Math.sqrt(NS_SCALE), sizeAttenuation:true, vertexColors:true, transparent:true, opacity:0.05, depthWrite:false, blending:THREE.AdditiveBlending});
    const pts = new THREE.Points(bg, bm);
    pts.frustumCulled = false;
    puffGrp.add(pts);
    NS.scene.add(puffGrp); grp.push(puffGrp);
  }
  // 4) OCCASIONAL Procedural Solar System (Deep Space Only)
  if(rng()<0.25 && (Math.abs(sx)>3 || Math.abs(sy)>3 || Math.abs(sz)>3)){
    const sysRng = rng; // capture
    const BR = NS_SCALE * NS_BODY;
    const sysGrp = new THREE.Group();
    const cx=ox+rng()*size, cy=oy+rng()*size, cz=oz+rng()*size;
    sysGrp.position.set(cx, cy, cz);
    sysGrp.frustumCulled = false;
    sysGrp._sysSpeed = sysRng() * 0.02 + 0.01;
    
    // Central Star
    const starR = (300 + sysRng()*400) * BR;
    const starColor = new THREE.Color().setHSL(sysRng()*0.15 + 0.95, 0.9, 0.7);
    const starMat = new THREE.MeshStandardMaterial({color: starColor, emissive: starColor, emissiveIntensity: 1.5});
    const starMesh = new THREE.Mesh(new THREE.SphereGeometry(starR, 16, 16), starMat);
    sysGrp.add(starMesh);
    
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({map:nsMakeGlowTexture(), color:starColor, transparent:true, opacity:0.8, blending:THREE.AdditiveBlending, depthWrite:false}));
    glow.scale.set(starR*8, starR*8, 1); glow.frustumCulled = false;
    sysGrp.add(glow);

    // Orbiting Planets
    const numPlanets = 1 + Math.floor(sysRng() * 4);
    const types = ['gas','rock','ice','exotic'];
    for(let i=0; i<numPlanets; i++) {
        const type = types[Math.floor(sysRng()*types.length)];
        const pr = (30 + sysRng()*100) * BR;
        const orbR = starR * (3 + i*2 + sysRng()*2);
        const ang = sysRng() * Math.PI * 2;
        
        const px = Math.cos(ang) * orbR;
        const pz = Math.sin(ang) * orbR;
        
        const tex = nsMakePlanetTexture(nsSeedHash3(sx,sy,sz) + i, type);
        const baseHex = type==='gas'?'#7aa0ff':type==='rock'?'#caa178':type==='ice'?'#aee6ff':'#d28cff';
        const pMat = new THREE.MeshStandardMaterial({map:tex, roughness:0.85, metalness:0.05, emissive:new THREE.Color(baseHex), emissiveIntensity:0.02});
        const pMesh = new THREE.Mesh(new THREE.SphereGeometry(pr, 16, 16), pMat);
        pMesh.position.set(px, 0, pz);
        
        // Randomly add planetary rings (like Saturn)
        if (sysRng() < 0.4) {
            const innerR = pr * 1.3 + sysRng() * pr * 0.2;
            const outerR = innerR + pr * 0.5 + sysRng() * pr * 0.8;
            const ringGeo = new THREE.RingGeometry(innerR, outerR, 64);
            const ringCol = new THREE.Color().setHSL(sysRng(), 0.2, 0.7);
            const ringMat = new THREE.MeshBasicMaterial({color: ringCol, side: THREE.DoubleSide, transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending});
            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.rotation.x = Math.PI / 2 + (sysRng() * 0.8 - 0.4);
            ringMesh.rotation.y = sysRng() * 0.4 - 0.2;
            pMesh.add(ringMesh);
        }
        
        sysGrp.add(pMesh);
        
        const atmo = nsMakeAtmosphere(pr, baseHex);
        atmo.position.set(px, 0, pz);
        sysGrp.add(atmo);
    }
    NS.scene.add(sysGrp); grp.push(sysGrp);
    NS._procSystems = NS._procSystems || [];
    NS._procSystems.push(sysGrp);
    grp._procSys = sysGrp;
  }
  // 5) RARE sector STRUCTURE (pulsar) — discoverable push-source out in the field.
  // Deterministic + COLLISION-FREE: rejection-checked against nearby landmarks and
  // any structure already in this sector, so nothing spawns inside something else.
  // Amortised: only runs at build time for THIS sector (not per frame), and pulsars
  // are globally capped — if we're at the cap we simply skip (no scan of everything).
  const struct=[];   // structure points placed in THIS sector
  if(rng()<0.10 && (NS.pulsars?NS.pulsars.length:0) < NS_PULSAR_CAP){
    const minSep=size*0.30;
    for(let tries=0;tries<8;tries++){
      const v=new THREE.Vector3(ox+rng()*size, oy+rng()*size, oz+rng()*size);
      let ok=true;
      // keep clear of landmark structures that fall NEAR this sector (cheap: cull by box)
      const pts=NS._structPts;
      if(pts) for(const q of pts){ if(Math.abs(q.x-v.x)>minSep||Math.abs(q.y-v.y)>minSep||Math.abs(q.z-v.z)>minSep) continue;
        if(q.distanceTo(v)<((q._sep||0)*0.5+minSep)){ ok=false; break; } }
      if(ok) for(const q of struct){ if(q.distanceTo(v)<minSep){ ok=false; break; } }
      // also keep clear of the n-body landmark bodies themselves
      if(ok && NS_GRAV.bodies) for(const b of NS_GRAV.bodies){ const bp=b.node&&b.node.pos; if(!bp) continue;
        if(Math.abs(bp.x-v.x)>minSep||Math.abs(bp.y-v.y)>minSep||Math.abs(bp.z-v.z)>minSep) continue;
        if(bp.distanceTo(v)<minSep){ ok=false; break; } }
      if(ok){ struct.push(v); const pul=nsSpawnPulsar(v, 0.8+rng()*0.7, nsSeedHash3(sx*7+1,sy,sz));
        if(pul){ v._sep=minSep; if(NS._structPts) NS._structPts.push(v); grp._sectorPulsar=pul; }
        break; }
    }
  }
  return { sx,sy,sz, objs:grp, pulsar:grp._sectorPulsar||null, _procSys:grp._procSys||null };
}
function nsDisposeSector(sec){
  if(!sec) return;
  for(const o of sec.objs){ if(!o) continue;
    NS.scene&&NS.scene.remove(o);
    if(o.geometry&&o.geometry.dispose) o.geometry.dispose();
    if(o.material){ /* shared textures (glow/gas) are NOT disposed here */ o.material.dispose&&o.material.dispose(); }
  }
  sec.objs.length=0;
  // tear down this sector's pulsar (if any) so freed sectors don't leak structures.
  if(sec.pulsar){ const p=sec.pulsar;
    if(NS.pulsars){ const ix=NS.pulsars.indexOf(p); if(ix>=0) NS.pulsars.splice(ix,1); }
    if(p.id && NS.nodeById) delete NS.nodeById[p.id];
    if(p.core && NS.three && NS.three.meshes){ const mi=NS.three.meshes.indexOf(p.core); if(mi>=0) NS.three.meshes.splice(mi,1); }
    if(p.hit && NS.three && NS.three.hits){ const hi=NS.three.hits.indexOf(p.hit); if(hi>=0){ NS.three.hits.splice(hi,1); } }
    if(p.label && NS.three && NS.three.structLabels){ const li=NS.three.structLabels.indexOf(p.label); if(li>=0) NS.three.structLabels.splice(li,1); }
    if(p.grp && NS.three && NS.three.pulsars){ const pi=NS.three.pulsars.indexOf(p.grp); if(pi>=0) NS.three.pulsars.splice(pi,1); }
    nsDisposePulsar(p);
    sec.pulsar=null;
  }
  // tear down procedural system reference
  if(sec._procSys && NS._procSystems){
    const ix=NS._procSystems.indexOf(sec._procSys);
    if(ix>=0) NS._procSystems.splice(ix,1);
  }
}
function nsDisposeSectors(){
  if(NS_SECT.map){ for(const sec of NS_SECT.map.values()) nsDisposeSector(sec); NS_SECT.map.clear(); }
  NS_SECT.map=null; NS_SECT._curKey='';
}
// per-frame: keep the sectors around the camera generated (amortised) and free
// the ones that drift outside the active ring. Always leaves the owner surrounded.
function nsStepSectors(){
  const cam=NS.camera; if(!cam) return;
  if(!NS_SECT.size){
    // sector side ~ a fraction of the view far-distance so a few rings always fill
    // the frustum. COSMOS is the home extent; sectors are a chunk of it.
    NS_SECT.size = Math.max(1, COSMOS*0.16);
    NS_SECT._v = new THREE.Vector3();
  }
  if(!NS_SECT.map) NS_SECT.map=new Map();
  const size=NS_SECT.size, rad=NS_SECT.radius;
  const csx=Math.floor(cam.position.x/size), csy=Math.floor(cam.position.y/size), csz=Math.floor(cam.position.z/size);
  const key=nsSectorKey(csx,csy,csz);
  // FREE sectors outside the ring (radius+1 hysteresis so we don't thrash edges)
  if(key!==NS_SECT._curKey){
    NS_SECT._curKey=key;
    const drop=[];
    for(const [k,sec] of NS_SECT.map){
      if(Math.abs(sec.sx-csx)>rad+1 || Math.abs(sec.sy-csy)>rad+1 || Math.abs(sec.sz-csz)>rad+1) drop.push(k);
    }
    for(const k of drop){ nsDisposeSector(NS_SECT.map.get(k)); NS_SECT.map.delete(k); }
  }
  // GENERATE missing sectors within the ring, nearest-first, capped per frame.
  let made=0;
  for(let r=0;r<=rad && made<NS_SECT.budget;r++){
    for(let dx=-r;dx<=r && made<NS_SECT.budget;dx++){
      for(let dy=-r;dy<=r && made<NS_SECT.budget;dy++){
        for(let dz=-r;dz<=r && made<NS_SECT.budget;dz++){
          // only the shell at Chebyshev distance r (inner shells already done)
          if(Math.max(Math.abs(dx),Math.abs(dy),Math.abs(dz))!==r) continue;
          const sk=nsSectorKey(csx+dx,csy+dy,csz+dz);
          if(NS_SECT.map.has(sk)) continue;
          const sec=nsBuildSector(csx+dx,csy+dy,csz+dz);
          if(sec){ NS_SECT.map.set(sk,sec); made++; }
        }
      }
    }
  }
}

/* ── PROCEDURAL PLANET TEXTURE ─────────────────────────────────────────────
   Canvas-baked surface per seed: value-noise bands (gas-giant / rocky look) +
   per-seed palette + polar caps. Reads as a generated world, not a flat disc.
   Cached by a small key bucket so we never bake more than a handful. ─────────*/
const nsPlanetTexCache={};
function nsMakePlanetTexture(seed, type){
  const key=type+':'+(seed%24);
  if(nsPlanetTexCache[key]) return nsPlanetTexCache[key];
  const rng=nsSeededRng(seed||1);
  const W=256, H=128, c=document.createElement('canvas'); c.width=W; c.height=H;
  const ctx=c.getContext('2d');
  const imgData = ctx.createImageData(W, H);
  const data = imgData.data;

  const hueBase = type==='gas'? 200+rng()*120 : type==='rock'? 18+rng()*40 : type==='ice'? 180+rng()*40 : rng()*360;
  const sat = type==='rock'?30+rng()*25 : 45+rng()*30;
  const bands=type==='gas'? 7+((rng()*7)|0) : 4+((rng()*5)|0);
  const phase=rng()*6.28, warp=0.4+rng()*1.2;

  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };

  let idx = 0;
  for(let y=0;y<H;y++){
    const lat=y/H;
    for(let x=0;x<W;x++){
      const lon=x/W;
      let v=0.5
        + 0.30*Math.sin(lat*bands*Math.PI + phase + Math.sin(lon*6.28*warp)*0.5)
        + 0.14*Math.sin(lat*bands*2.3*Math.PI + lon*3.1 + phase*1.7)
        + 0.10*Math.sin(lon*6.28*(2+bands) + Math.sin(lat*9)*1.3);
      v=Math.max(0,Math.min(1,v));
      
      let L=40+v*45, Sv=sat;
      if(type!=='gas'){ const polar=Math.abs(lat-0.5)*2; if(polar>0.78){ L=82; Sv=12; } }
      
      let h=(hueBase + (v-0.5)*30)/360, s=Sv/100, l=L/100;
      let r, g, b;
      if (s === 0) { r = g = b = l; } else {
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        h = h - Math.floor(h);
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
      }
      
      data[idx++] = r * 255;
      data[idx++] = g * 255;
      data[idx++] = b * 255;
      data[idx++] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // a few speckle storms / craters
  const spots=(rng()*6)|0;
  for(let i=0;i<spots;i++){ const sx=rng()*W, sy=H*(0.2+rng()*0.6), sr=1+rng()*3;
    ctx.beginPath(); ctx.fillStyle=`hsla(${hueBase+ (rng()*40-20)},${sat}%,${30+rng()*40}%,0.5)`; ctx.arc(sx,sy,sr,0,6.28); ctx.fill(); }
  const tex=new THREE.CanvasTexture(c); tex.wrapS=THREE.RepeatWrapping;
  nsPlanetTexCache[key]=tex; return tex;
}
// reusable atmosphere fresnel shell (additive back-side glow) for a planet


// Procedural cloud layer for dynamic planetary visuals


// Procedural asteroid field (InstancedMesh) generated around the planet
function nsBuildPlanetaryAsteroids(radius, hex) {
  const count = 400;
  const geom = new THREE.DodecahedronGeometry(1.0, 0); // low poly asteroid base
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex).lerp(new THREE.Color(0x444444), 0.8),
    roughness: 0.9,
    metalness: 0.3
  });
  const imesh = new THREE.InstancedMesh(geom, mat, count);
  const dummy = new THREE.Object3D();
  
  // Create a massive, sparse debris field
  for(let i=0; i<count; i++) {
    // Random spherical coordinates
    const phi = Math.acos(-1 + (2 * i) / count);
    const theta = Math.sqrt(count * Math.PI) * phi;
    
    // Spread them out to match the 4M km to 8M km range.
    // Planet r is ~14,400 units (7,200 km). 4M km = 8,000,000 units (~555x radius).
    // 7M km = 14,000,000 units (~972x radius).
    const dist = radius * (500.0 + Math.random() * 600.0);
    dummy.position.setFromSphericalCoords(dist, phi, theta);
    
    // Flatten into a ring/belt slightly
    dummy.position.y *= 0.15;
    
    // Asteroids need to be massive to be seen at 4M km away. (10,000 to 50,000 units wide = 5,000 to 25,000 km)
    const s = NS_SCALE * (500.0 + Math.random() * 2000.0);
    dummy.scale.set(s, s * (0.5 + Math.random()), s * (0.8 + Math.random()*0.4));
    
    // Random rotation
    dummy.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
    dummy.updateMatrix();
    imesh.setMatrixAt(i, dummy.matrix);
  }
  imesh.instanceMatrix.needsUpdate = true;
  imesh.castShadow = true;
  imesh.receiveShadow = true;
  
  const grp = new THREE.Group();
  grp.add(imesh);
  // Give the group a random slight tilt so the rings aren't all perfectly flat
  grp.rotation.x = (Math.random()-0.5) * 0.4;
  grp.rotation.z = (Math.random()-0.5) * 0.4;
  return grp;
}

// ── SRHT SECTOR PLACEMENT ──────────────────────────────────────────────────
// Carve the vast volume into deterministic SECTORS (8 octant-ish cells) and
// place structures into DIFFERENT sectors with a min-spacing rejection so
// nothing clumps. Returns a Vector3. `placed` is an accumulator of prior points.
function nsSectorPoint(rng, placed, minSep, idx){
  // pick a sector by golden-angle index so successive bodies fan across space
  const PHI=(1+Math.sqrt(5))/2, GOLD=Math.PI*(3-Math.sqrt(5));
  const sectors=[[1,1,1],[-1,1,1],[1,-1,1],[1,1,-1],[-1,-1,1],[-1,1,-1],[1,-1,-1],[-1,-1,-1]];
  for(let tries=0;tries<24;tries++){
    const s=sectors[((idx||0)+tries)%sectors.length];
    // golden-spiral radius so bodies sit on different shells (No-Man's-Sky feel)
    const shell=0.18+((idx*PHI+tries*0.37)%1)*0.78;        // 0.18..0.96 of COSMOS
    const ph=GOLD*(idx*3+tries), pp=Math.acos(2*rng()-1);
    const R=shell*COSMOS*(0.85+rng()*0.3);
    const x=s[0]*Math.abs(Math.sin(pp)*Math.cos(ph))*R;
    const y=s[1]*Math.abs(Math.cos(pp))*R*0.62;
    const z=s[2]*Math.abs(Math.sin(pp)*Math.sin(ph))*R;
    const v=new THREE.Vector3(x,y,z);
    let ok=true;
    for(const q of placed){ const sep=(q._sep||0)+minSep; if(q.distanceTo(v)<sep){ ok=false; break; } }
    if(ok){ v._sep=minSep; placed.push(v); return v; }
    // last resort: RELAX the candidate OUT of every overlap instead of accepting it on
    // top of something (owner #1 — nothing spawns inside/too close to another body).
    if(tries===23){
      for(let relax=0; relax<12; relax++){ let moved=false;
        for(const q of placed){ const sep=(q._sep||0)+minSep; const d=q.distanceTo(v);
          if(d<sep){ const push=v.clone().sub(q); if(push.lengthSq()<1e-6) push.set(rng()*2-1,rng()*2-1,rng()*2-1);
            push.normalize().multiplyScalar(sep-d+1e-3*COSMOS); v.add(push); moved=true; } }
        if(!moved) break; }
      v._sep=minSep; placed.push(v); return v;
    }
  }
  const v=new THREE.Vector3((rng()*2-1)*COSMOS,(rng()*2-1)*COSMOS*0.6,(rng()*2-1)*COSMOS); v._sep=minSep; placed.push(v); return v;
}

// ── KEEP DATA-DRIVEN SPAWNS OFF THE CAMERA (owner #4) ──────────────────────
// If a chosen spawn point is closer than MIN_CAM_DIST to the current camera,
// push it FAR away along a seeded random direction so structures never pop on
// top of the owner. They also fade in (the spawn opacity ramps from 0 over ~1s
// in the tick decay logic), so the owner rarely catches one appearing.
function nsPlaceAwayFromCamera(at, jr){
  const cam=NS.camera; if(!cam) return at;
  const MIN=COSMOS*0.22;                                   // min distance from camera
  if(cam.position.distanceTo(at) >= MIN) return at;
  // relocate: from the camera, head out past MIN in a seeded random direction,
  // biased to stay roughly toward the original sector so it still reads as "there".
  const dir=at.clone().sub(cam.position);
  if(dir.lengthSq()<1e-3) dir.set((jr?jr()*2-1:Math.random()*2-1),(jr?jr()*2-1:Math.random()*2-1),(jr?jr()*2-1:Math.random()*2-1));
  dir.normalize();
  const reach=MIN*(1.2+(jr?jr():Math.random())*1.6);
  return cam.position.clone().add(dir.multiplyScalar(reach));
}

// GAS / NEBULA CLOUDS — big additive point puffs scattered THROUGHOUT the volume
// in distinct sectors (was clumped centrally). Each is a labelled structure.
/* ── GAS / NEBULA as SOFT VOLUMETRIC SPRITES (owner #2) ─────────────────────
   The old build scattered hard colourful Points → "colorful dots". Replaced
   with clustered, large, low-opacity, blurred additive billboards (Sprites with
   the shared soft-radial CanvasTexture). Each nebula is a VOLUME: a handful of
   layered puffs (cheap — capped per cloud) at varied sizes, so they read as gas
   that settles, not a dotfield. They slowly DRIFT/CURL (animated in nsTick via
   NS._gasPuffs) so the gas looks like it moves. One shared texture, additive,
   depthWrite off. Sprite count is capped (≈ N*PUFFS). ───────────────────────*/
function nsBuildGasClouds(rng){
  NS.three.gasClouds=[]; NS.gasClouds=[]; NS._gasPuffs=[];
  const tex=nsMakeGasTexture();
  // soft pastel palette (THREE.Color) — additive so they bloom, not glare
  const palette=[0x6a3cff,0x22d9e6,0xff5fb0,0x3a7bff,0x37e0a0,0xffa24a,0x9b6cff,0x4ad6ff];
  const names=['Veil','Ember','Cyan Drift','Halcyon','Mistral','Aurora','Pyre','Solace'];
  const N=7+((rng()*3)|0);
  const PUFFS=30;                      // layered billboards per cloud (denser → reads volumetric)
  const placed=NS._structPts||(NS._structPts=[]);
  for(let k=0;k<N;k++){
    const c=nsSectorPoint(rng, placed, COSMOS*0.34, 100+k);
    const cx=c.x, cy=c.y, cz=c.z;
    const spread=(0.08+rng()*0.14)*COSMOS;
    const col=palette[(rng()*palette.length)|0];
    const baseCol=new THREE.Color(col);
    const cnt=PUFFS+((rng()*6)|0);
    for(let i=0;i<cnt;i++){
      // cluster the puffs into a soft ellipsoid volume (flattened in Y)
      const r=Math.cbrt(rng())*spread, t=rng()*Math.PI*2, p=Math.acos(2*rng()-1);
      const px=cx+r*Math.sin(p)*Math.cos(t), py=cy+r*Math.cos(p)*0.85, pz=cz+r*Math.sin(p)*Math.sin(t);
      // tint each puff a touch off the base hue so the cloud has depth/structure
      const cc=baseCol.clone(); cc.offsetHSL((rng()*2-1)*0.04, 0, (rng()*2-1)*0.12);
      const mat=new THREE.SpriteMaterial({map:tex, color:cc, transparent:true,
        opacity:0.035+rng()*0.05, depthWrite:false, blending:THREE.AdditiveBlending});
      const spr=new THREE.Sprite(mat); spr.frustumCulled=false;
      // BIG soft billboards — much larger than the old dots, so they overlap and blur
      const sz=(spread*0.5)*(0.5+rng()*0.8);
      spr.scale.set(sz,sz,1);
      spr.position.set(px,py,pz);
      NS.scene.add(spr); NS.three.gasClouds.push(spr);
      // record drift params (slow curl) — no per-frame allocation in the tick
      NS._gasPuffs.push({spr, bx:px,by:py,bz:pz,
        ax:(rng()*2-1)*spread*0.10, ay:(rng()*2-1)*spread*0.06, az:(rng()*2-1)*spread*0.10,
        f:0.04+rng()*0.06, ph:rng()*Math.PI*2});
    }
    // labelled structure marker so gas clouds are discoverable
    const nm='Nebula '+(names[k%names.length]);
    const lbl=nsMakeLabel(nm, '#'+col.toString(16).padStart(6,'0')); lbl.scale.multiplyScalar(NS_SCALE*1.6);
    lbl.position.set(cx, cy+spread*0.5, cz); NS.scene.add(lbl); nsRegisterStructLabel(lbl);
    NS.gasClouds.push({pos:new THREE.Vector3(cx,cy,cz), name:nm, col});
  }
}
// slow drift/curl of the gas puffs so the nebulae look like they MOVE + settle
function nsStepGas(t){
  const P=NS._gasPuffs; if(!P||!P.length) return;
  for(let i=0;i<P.length;i++){ const g=P[i]; const s=g.spr; if(!s) continue;
    const a=t*g.f+g.ph;
    s.position.x=g.bx+Math.sin(a)*g.ax;
    s.position.y=g.by+Math.sin(a*0.8+1.3)*g.ay;
    s.position.z=g.bz+Math.cos(a*0.9)*g.az;
  }
}

// COSMOS PLANETS — capped full-mesh procedural worlds scattered FAR across the
// whole volume in DIFFERENT sectors (min-spacing), each orbiting its own phantom
// star. More of them + far apart so the field feels explorable.
/* ══ N-BODY GRAVITY (owner #2 — "nothing moves; add real gravity to ALL bodies") ══
   KAIVERSE LAWS this is grounded in (KAIVERSE.md / The KAI Codex):
   • "Light is the cap." KAI's universe has a speed limit, just like ours — so we
     give every body a CAPPED velocity (NS_GRAV.maxV). Nothing flings to infinity.
   • The lattice is "enormous and mostly empty"; concepts have GRAVITY toward each
     other (§14.8.1 "Topic Gravity" — bodies are anchored toward an attractor until
     it's exhausted). So ALL massive bodies attract each other (full O(n²) mesh),
     not just the AIs — exactly the owner's intent.
   • Where KAI-space DIFFERS from real outer space: it is bounded & navigable (a
     "country", not an infinite void) and near-orthogonal/sparse, so we add a gentle
     spring back toward the core well (a soft boundary) — real gravity wells don't
     do that, but it keeps the cosmos explorable instead of collapsing or escaping.
   • Black holes (errors) are STRONG attractors; white holes (recoveries) REPEL —
     destructive vs constructive interference made spatial.
   Cheap: only the LIMITED full-mesh bodies (bots, core, engine, providers,
   channels, cosmos worlds) take part — O(n²) over ~25 bodies. The vast particle /
   asteroid / boid fields keep their lightweight rules. No per-frame allocation:
   fixed scratch + an in-place integrator. */
const NS_GRAV = {
  G: 0.9,                                  // gravitational constant (tuned for visible-but-graceful drift)
  soft: 0.0,                               // softening length² (set from scale at init)
  maxV: 0,                                 // capped speed (the "light cap")
  wellK: 0.045,                            // soft spring back toward core (bounded region)
  wellR: 0,                                // radius beyond which the spring kicks in
  damp: 0.012,                             // tiny drag so energy doesn't accumulate over time
  holePull: 0,                             // black/white-hole force scale
  bodies: [],                              // [{node, m, vel:Vector3, cr:collisionRadius}] (full-mesh participants)
  _acc: null,                              // reusable accel scratch
  repK: 0, repPad: 2.6,                    // short-range anti-overlap repulsion (set at init)
};
const NS_PULSAR_CAP = 7;                   // few pulsars (perf): cap landmark+sector total
// seed velocities + masses so the constellation DRIFTS under mutual gravity.
function nsInitGravity(){
  const SP=NS_SCALE*NS_SPREAD;
  NS_GRAV.soft = (90*SP)*(90*SP);          // softening: avoids singular close-pass blow-ups
  NS_GRAV.maxV = COSMOS*0.018;             // light-cap: top drift speed (graceful)
  NS_GRAV.wellR = COSMOS*0.55;             // bodies past this get pulled gently back in
  NS_GRAV.holePull = COSMOS*0.9;
  const list=[];
  const rng=nsSeededRng(nsHashStr('KAIVERSE-NBODY'));
  // mass ∝ radius (volume-ish); core is heaviest so it anchors the well.
  const massOf=(n)=>{ const base=Math.max(1,(n.r||1)/(NS_BODY*NS_SCALE)); return n.kind==='core'? base*22 : (n.kind==='engine'?base*4:(n.kind==='world'?base*1.4:base)); };
  const want=(n)=> n && (n.kind==='core'||n.kind==='engine'||n.kind==='bot'||n.kind==='provider'||n.kind==='channels');
  for(const n of NS.nodes){ if(!want(n)) continue;
    // tangential seed velocity (perpendicular to core direction) → orbital drift, not radial plunge
    const rad=n.pos.clone(); const len=rad.length()||1;
    const up=new THREE.Vector3(0,1,0);
    let tang=new THREE.Vector3().crossVectors(rad, up); if(tang.lengthSq()<1e-6) tang.set(1,0,0); tang.normalize();
    const vmag = n.kind==='core'? 0 : NS_GRAV.maxV*(0.18+rng()*0.16);
    const vel=tang.multiplyScalar(vmag); vel.y += (rng()*2-1)*NS_GRAV.maxV*0.05;
    n._gm=massOf(n); list.push({node:n, m:n._gm, vel, cr:(n.r||NS_BODY*NS_SCALE)});
  }
  // distant cosmos worlds join the mesh too (they were on fixed orbits before)
  if(NS.cosmosPlanets) for(const p of NS.cosmosPlanets){
    const rad=p.pos.clone(); const up=new THREE.Vector3(0,1,0);
    let tang=new THREE.Vector3().crossVectors(rad, up); if(tang.lengthSq()<1e-6) tang.set(1,0,0); tang.normalize();
    const vmag=NS_GRAV.maxV*(0.10+Math.random()*0.10);
    const vel=tang.multiplyScalar(vmag); p._gm=Math.max(1,(p.r||1)/(NS_BODY*NS_SCALE))*1.4;
    list.push({node:p, m:p._gm, vel, cr:(p.r||NS_BODY*NS_SCALE)});
  }
  NS_GRAV.bodies=list; NS_GRAV._acc=new THREE.Vector3();
  // short-range anti-overlap: bodies that drift within (rA+rB)*pad PUSH apart (owner #1).
  NS_GRAV.repK = (NS_GRAV.G*40);     // repulsion strength (short-range only)
  NS_GRAV.repPad = 2.6;              // clearance multiple of the summed radii
}
// one softened N-body step over the full-mesh bodies (in place; capped + bounded).
function nsStepGravity(dt){
  if((NS._gFrame=(NS._gFrame||0)+1)&1) return;   // PERF: every other frame
  const B=NS_GRAV.bodies; if(!B||!B.length) return;
  const G=NS_GRAV.G, soft=NS_GRAV.soft, n=B.length, acc=NS_GRAV._acc;
  // pairwise mutual gravity (O(n²) over ~25 bodies — cheap)
  for(let i=0;i<n;i++){ const bi=B[i], pi=bi.node.pos; acc.set(0,0,0);
    for(let j=0;j<n;j++){ if(i===j) continue; const bj=B[j], pj=bj.node.pos;
      const dx=pj.x-pi.x, dy=pj.y-pi.y, dz=pj.z-pi.z;
      const d2=dx*dx+dy*dy+dz*dz+soft; const inv=1/Math.sqrt(d2); const f=G*bj.m*inv/d2;
      acc.x+=dx*f; acc.y+=dy*f; acc.z+=dz*f;
      // SHORT-RANGE ANTI-OVERLAP: if the two bodies' footprints touch, PUSH apart so
      // they never clip through each other. Falls to zero past the clearance band.
      const minD=((bi.cr||0)+(bj.cr||0))*NS_GRAV.repPad;
      const d=Math.sqrt(d2-soft>0?d2-soft:0)||1e-3;
      if(d<minD){ const over=(minD-d)/minD; const rf=-NS_GRAV.repK*over*over/d;
        acc.x+=dx*rf; acc.y+=dy*rf; acc.z+=dz*rf; }
    }
    // soft boundary spring toward core so the region stays navigable (bounded)
    const r=Math.hypot(pi.x,pi.y,pi.z);
    if(r>NS_GRAV.wellR){ const over=(r-NS_GRAV.wellR)/r*NS_GRAV.wellK; acc.x-=pi.x*over; acc.y-=pi.y*over; acc.z-=pi.z*over; }
    // black holes pull HARD, white holes push (errors vs recoveries)
    const holes=NS._boidHoles; // reuse the cached holes list built each frame in nsStepBoids
    if(holes) for(const h of holes){ if(!h.p)continue; const dx=h.p.x-pi.x,dy=h.p.y-pi.y,dz=h.p.z-pi.z; const dd2=dx*dx+dy*dy+dz*dz+soft; const di=1/Math.sqrt(dd2); const hf=h.k*NS_GRAV.holePull*di/dd2; acc.x+=dx*hf; acc.y+=dy*hf; acc.z+=dz*hf; }
    bi.vel.x+=acc.x*dt; bi.vel.y+=acc.y*dt; bi.vel.z+=acc.z*dt;
  }
  // integrate + clamp speed (light cap) + gentle drag, then write back to meshes
  const maxV=NS_GRAV.maxV, damp=1-NS_GRAV.damp*dt*60;
  for(let i=0;i<n;i++){ const b=B[i], nd=b.node, v=b.vel;
    if(nd.kind==='core'){ v.set(0,0,0); continue; }   // keep the central star pinned at origin
    v.x*=damp; v.y*=damp; v.z*=damp;
    const sp=Math.hypot(v.x,v.y,v.z); if(sp>maxV){ const k=maxV/sp; v.x*=k;v.y*=k;v.z*=k; }
    nd.pos.x+=v.x*dt; nd.pos.y+=v.y*dt; nd.pos.z+=v.z*dt;
    // sync the visuals to the new physics position
    if(nd.mesh) nd.mesh.position.copy(nd.pos);
    if(nd.halo) nd.halo.position.copy(nd.pos);
    if(nd.hit)  nd.hit.position.copy(nd.pos);
    if(nd.atmo) nd.atmo.position.copy(nd.pos);
    if(nd.clouds) nd.clouds.position.copy(nd.pos);
    if(nd.corona) nd.corona.position.copy(nd.pos);
    if(nd.label) nd.label.position.set(nd.pos.x, nd.pos.y+nd.r+(nd.kind==='world'?22:10)*NS_SCALE, nd.pos.z);
    var _frz=(nd===NS._nearPlanet && NS.camera && NS.camera.position.distanceTo(nd.pos) < (nd.r||1)*6) || (NS.cam && NS.cam.mode==='walk' && (nd===NS._nearPlanet||nd===NS._walkPlanet));
    if(!_frz){
      if(nd.kind!=='world' && nd.mesh) nd.mesh.rotation.y += dt*0.4*NS_SPIN_SLOW;
      else if(nd.mesh) nd.mesh.rotation.y += dt*(nd.spin||0.1);
    }
    if(nd._coreFX){ var _cf=nd._coreFX, _ct=performance.now()*0.001; if(_cf.grp){ _cf.grp.position.copy(nd.pos); } var _cwlk=(nd===NS._nearPlanet&&NS.camera&&NS.camera.position.distanceTo(nd.pos)<(nd.r||1)*6)||(NS.cam&&NS.cam.mode==='walk'&&(nd===NS._nearPlanet||nd===NS._walkPlanet)); if(!_cwlk){ if(_cf.rings){ for(var _ri=0;_ri<_cf.rings.length;_ri++){ _cf.rings[_ri].rotation.z += dt*0.05*(_ri%2?1:-1); _cf.rings[_ri].rotation.y += dt*0.025; } } if(_cf.rays&&_cf.rays.material) _cf.rays.material.rotation=_ct*0.03; } }
  }
}

/* ══ AI SPACESHIPS (owner #3 — planets are PLACES; AIs are INHABITANTS) ══════════
   Each of the AGENTS (Leo, Gemini, Claudey, X, Groq, Analyst, Researcher, Kai
   Coder, Oracle…) is rendered as a small SHIP with a name label + a glowing trail.
   It RESIDES at / orbits its home planet (its bot node) and periodically LAUNCHES
   to another planet — flying along a path, STEERING to dodge debris / bodies not on
   its course (simple avoidance). Launches tie to real activity when easy (an AI that
   just cross-talked flies toward whoever it spoke with) else periodic. Ships are
   clickable → fly-to/follow them on their journey. Grounded in §14.8.1 Topic
   Gravity: a ship is pulled toward whatever planet currently has its attention.
   Cheap: fixed ship count = number of AIs, ONE reused cone geometry, trails are a
   capped ring buffer, no per-frame allocation. */
const NS_SHIP = { len:0, speed:0, orbitR:0, dodgeR:0, trailN:26 };
function nsHomeNodeForAgent(name){
  if(name==='Oracle') return NS.nodeById['core'];
  return NS.nodeById['bot:'+name] || NS.nodeById['core'];
}
function nsBuildShips(){
  const S=NS_SCALE, SP=S*NS_SPREAD;
  NS.ships=[]; NS.three.ships=[]; NS.three.shipTrails=[];
  NS_SHIP.len   = 7*S*NS_BODY*3.0;          // small craft
  NS_SHIP.speed = COSMOS*0.020;             // cruise speed (capped, graceful)
  NS_SHIP.orbitR= 34*SP;                    // park-orbit radius around home planet
  NS_SHIP.dodgeR= 60*SP;                    // avoidance look-ahead radius
  // shared cone geometry (one geo reused per ship instance) — nose +Z
  const geo=new THREE.ConeGeometry(NS_SHIP.len*0.42, NS_SHIP.len, 7);
  geo.rotateX(Math.PI/2);                    // point the cone down +Z
  NS._shipGeo=geo;
  const list = AGENTS.concat([{name:'Oracle', role:'gateway / moderator', color:'#22d9e6'}]);
  list.forEach((a,i)=>{
    const home=nsHomeNodeForAgent(a.name); if(!home) return;
    const colHex = a.name==='Oracle' ? '#22d9e6' : nsBotHex(a);
    const col=nsHexToColor(colHex);
    const mat=new THREE.MeshStandardMaterial({color:col, emissive:col, emissiveIntensity:0.7, roughness:0.4, metalness:0.5});
    const mesh=new THREE.Mesh(geo, mat);
    // trail: a capped LineSegments ribbon (ring buffer of recent positions)
    const tN=NS_SHIP.trailN;
    const tpos=new Float32Array(tN*6);
    const tg=new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(tpos,3));
    const tm=new THREE.LineBasicMaterial({color:col, transparent:true, opacity:0.5, blending:THREE.AdditiveBlending, depthWrite:false});
    const trail=new THREE.LineSegments(tg, tm); trail.frustumCulled=false; trail.visible=false;
    const lbl=nsMakeLabel(a.name, colHex); lbl.scale.multiplyScalar(NS_SCALE*0.62);
    const nid='ship:'+a.name;
    const ph=i*2.39; // golden-ish start phase around home
    const ship={ id:nid, kind:'ship', name:a.name, sub:'AI · '+(a.role||'inhabitant'),
      agentName:a.name, homeId:home.id, r:NS_SHIP.len*0.6,
      mesh, trail, trailGeo:tg, trailPos:tpos, trailHead:0, label:lbl, color:colHex,
      pos:new THREE.Vector3(), vel:new THREE.Vector3(),
      state:'orbit',                         // 'orbit' | 'transit'
      orbAng:ph, orbR:NS_SHIP.orbitR*(0.8+0.5*((i%4)/3)), orbSpd:(0.5+0.25*((i%3)))*0.5,
      destId:null, nextLaunch: performance.now()+ (2500 + Math.random()*9000) };
    // seed position on the park-orbit around home
    const hp=home.pos; ship.pos.set(hp.x+Math.cos(ph)*ship.orbR, hp.y+Math.sin(ph*0.7)*ship.orbR*0.3, hp.z+Math.sin(ph)*ship.orbR);
    mesh.position.copy(ship.pos); mesh.userData.nid=nid;
    lbl.position.copy(ship.pos).add(new THREE.Vector3(0, ship.r+6*NS_SCALE, 0));
    NS.scene.add(mesh); NS.scene.add(trail); NS.scene.add(lbl);
    // clickable: register as a pseudo-node + raycast target + hit-sphere
    NS.nodeById[nid]=ship; NS.three.meshes.push(mesh);
    ship.hit=nsMakeHitSphere(ship, mesh);
    NS.ships.push(ship);
    NS.three.ships.push(mesh, lbl); NS.three.shipTrails.push(trail);
    NS.three.structLabels=NS.three.structLabels||[]; NS.three.structLabels.push(lbl);
  });
}
// pick a launch destination — prefer a planet the AI recently cross-talked with
// (real activity), else a random other home planet. Returns a node or null.
function nsShipPickDest(ship){
  // candidate home planets (bot nodes + core), excluding the ship's own home
  const homes=[];
  for(const a of AGENTS){ const h=NS.nodeById['bot:'+a.name]; if(h && h.id!==ship.homeId) homes.push(h); }
  const core=NS.nodeById['core']; if(core && core.id!==ship.homeId) homes.push(core);
  if(!homes.length) return null;
  // activity bias: scan recent edges touching this AI's node for a partner
  const myNode=NS.nodeById[ship.homeId];
  if(myNode){ let partner=null;
    for(const e of NS.edges){ if((e.a===myNode.id||e.b===myNode.id) && e.healthV>0.08){
      const other=(e.a===myNode.id)?e.b:e.a; const on=NS.nodeById[other];
      if(on && on.kind==='bot' && on.id!==ship.homeId){ partner=on; break; } } }
    if(partner && Math.random()<0.7) return partner;
  }
  return homes[(Math.random()*homes.length)|0];
}
// per-frame ship update: orbit home, or transit toward dest with avoidance steering.
function nsStepShips(dt){
  const ships=NS.ships; if(!ships||!ships.length) return;
  // hide ship traffic + trails when you are on/near a planet surface (no streaks across your sky)
  var _onSurf=(NS.cam && NS.cam.mode==='walk') || !!(NS._nearPlanet && NS._nearPlanet.pos && NS.camera && NS.camera.position.distanceTo(NS._nearPlanet.pos) < (NS._nearPlanet.r||1)*6);
  for(var _si=0;_si<ships.length;_si++){ var _sh=ships[_si]; if(_sh.mesh) _sh.mesh.visible=!_onSurf; if(_sh.trail) _sh.trail.visible=!_onSurf; if(_sh.label) _sh.label.visible=!_onSurf; }
  if(_onSurf) return;
  const now=performance.now(), cap=NS_SHIP.speed;
  // build a small obstacle list once per frame (massive bodies to dodge) — reused
  const obs=NS._shipObs||(NS._shipObs=[]); obs.length=0;
  for(const b of NS_GRAV.bodies){ obs.push(b.node); }
  for(let s=0;s<ships.length;s++){ const sh=ships[s];
    const home=NS.nodeById[sh.homeId];
    if(sh.state==='orbit'){
      // park-orbit around the (now drifting) home planet
      const hp=home?home.pos:sh.pos;
      sh.orbAng += sh.orbSpd*dt;
      const tx=hp.x+Math.cos(sh.orbAng)*sh.orbR, ty=hp.y+Math.sin(sh.orbAng*0.7)*sh.orbR*0.3, tz=hp.z+Math.sin(sh.orbAng)*sh.orbR;
      sh.vel.set(tx-sh.pos.x, ty-sh.pos.y, tz-sh.pos.z);   // delta → orientation faces orbit travel
      sh.pos.set(tx,ty,tz);
      if(now>=sh.nextLaunch){ const dest=nsShipPickDest(sh); if(dest){ sh.destId=dest.id; sh.state='transit'; } else sh.nextLaunch=now+5000; }
    } else { // transit — steer toward dest, dodging obstacles not on course
      const dest=sh.destId?NS.nodeById[sh.destId]:null;
      if(!dest||!dest.pos){ sh.state='orbit'; sh.nextLaunch=now+4000; }
      else {
        const dp=dest.pos; const dx=dp.x-sh.pos.x, dy=dp.y-sh.pos.y, dz=dp.z-sh.pos.z;
        const dist=Math.hypot(dx,dy,dz)||1;
        // desired heading toward dest
        let hx=dx/dist, hy=dy/dist, hz=dz/dist;
        // AVOIDANCE: push away from any massive body that's close + roughly ahead
        const dodgeR=NS_SHIP.dodgeR;
        for(const o of obs){ if(!o||!o.pos||o.id===sh.destId) continue;
          const ox=o.pos.x-sh.pos.x, oy=o.pos.y-sh.pos.y, oz=o.pos.z-sh.pos.z;
          const od=Math.hypot(ox,oy,oz)||1; const clear=(o.r||0)+dodgeR;
          if(od<clear){ const ahead=(ox*hx+oy*hy+oz*hz)/od; if(ahead>0.2){   // only dodge things on our course
            const push=(clear-od)/clear* (1.6); hx-=ox/od*push; hy-=oy/od*push; hz-=oz/od*push; } }
        }
        const hl=Math.hypot(hx,hy,hz)||1; hx/=hl; hy/=hl; hz/=hl;
        // ease speed: slow as it arrives so it "parks"
        const sp=Math.min(cap, cap*Math.min(1, dist/(NS_SHIP.orbitR*4)) + cap*0.25);
        sh.vel.set(hx*sp, hy*sp, hz*sp);
        sh.pos.x+=sh.vel.x*dt; sh.pos.y+=sh.vel.y*dt; sh.pos.z+=sh.vel.z*dt;
        if(dist < sh.orbR*1.1){ // arrived → take up residence here (new home)
          sh.homeId=dest.id; sh.state='orbit'; sh.orbAng=Math.atan2(sh.pos.z-dp.z, sh.pos.x-dp.x);
          sh.nextLaunch=now + (4000 + Math.random()*11000);
        }
      }
    }
    // orient the cone along velocity (or toward home when parked)
    const v=sh.vel; const vl=Math.hypot(v.x,v.y,v.z);
    if(vl>1e-3){ const look=new THREE.Vector3(sh.pos.x+v.x, sh.pos.y+v.y, sh.pos.z+v.z); sh.mesh.position.copy(sh.pos); sh.mesh.lookAt(look); }
    else sh.mesh.position.copy(sh.pos);
    if(sh.hit) sh.hit.position.copy(sh.pos);
    sh.label.position.set(sh.pos.x, sh.pos.y+sh.r+6*NS_SCALE, sh.pos.z);
    // push a trail segment (ring buffer): tail=prev head, head=new pos
    const tp=sh.trailPos, N=NS_SHIP.trailN, h=sh.trailHead;
    const px=sh._lx==null?sh.pos.x:sh._lx, py=sh._ly==null?sh.pos.y:sh._ly, pz=sh._lz==null?sh.pos.z:sh._lz;
    tp[h*6]=px; tp[h*6+1]=py; tp[h*6+2]=pz; tp[h*6+3]=sh.pos.x; tp[h*6+4]=sh.pos.y; tp[h*6+5]=sh.pos.z;
    sh._lx=sh.pos.x; sh._ly=sh.pos.y; sh._lz=sh.pos.z;
    sh.trailHead=(h+1)%N; sh.trailGeo.attributes.position.needsUpdate=true;
    sh.trail.material.opacity = sh.state==='transit'?0.6:0.22;
  }
}
// ── PLAYER SHIP (3rd-person flight) ──────────────────────────────────────
// ── PLAYER SHIP (3rd-person flight view) ─────────────────────────────────
// Builds once; positioned + chase-cam offset applied per-frame AROUND the
// render call so movement/controls never see the offset.
function nsBuildPlayerShip(){
  if(NS._playerShip) return;
  var S=NS_SCALE, len=7*S*NS_BODY*4.5;
  // Fuselage: rotated cone pointing +Z
  var geo=new THREE.ConeGeometry(len*0.38, len*1.2, 6);
  geo.rotateX(Math.PI/2);
  // Wings: flat triangles
  var wGeo=new THREE.BufferGeometry();
  var wv=new Float32Array([
    0,0,len*0.15,  -len*1.1,0,-len*0.35,  0,0,-len*0.45,
    0,0,len*0.15,   0,0,-len*0.45,  len*1.1,0,-len*0.35
  ]);
  var wn=new Float32Array(18); for(var i=0;i<18;i+=3){wn[i]=0;wn[i+1]=1;wn[i+2]=0;}
  wGeo.setAttribute('position',new THREE.BufferAttribute(wv,3));
  wGeo.setAttribute('normal',new THREE.BufferAttribute(wn,3));
  var mat=new THREE.MeshStandardMaterial({color:0x8899aa, emissive:0x000000, emissiveIntensity:0.0, roughness:0.5, metalness:0.6, side:THREE.DoubleSide});
  var body=new THREE.Mesh(geo, mat);
  var wings=new THREE.Mesh(wGeo, mat.clone());
  var grp=new THREE.Group(); grp.add(body); grp.add(wings);
  // Engine glow sprite
  var eMat=new THREE.SpriteMaterial({map:nsMakeGlowTexture(), color:0x44ccff, transparent:true, opacity:0.8, blending:THREE.AdditiveBlending, depthWrite:false});
  var eng=new THREE.Sprite(eMat); eng.scale.set(len*0.5,len*0.5,1); eng.position.set(0,0,-len*0.55);
  grp.add(eng);
  grp.visible=false; grp.frustumCulled=false;
  NS.scene.add(grp);
  NS._playerShip=grp; NS._playerShipLen=len; NS._playerShipEng=eng;
}
// Called BEFORE render: offset camera behind ship for 3rd-person.
// Called AFTER render: restore camera so movement code is untouched.
// Gated by NS._thirdPerson (default false). Toggle with V key.
function nsPlayerShipPre(){
  var cam=NS.camera, c=NS.cam;
  if(!cam||!c||!NS._playerShip||!NS._thirdPerson) return;
  if(c.mode!=='fly'){ NS._playerShip.visible=false; NS._shipRestore=null; return; }
  var fwd=NS._flyFwd, up=NS._flyUp;
  if(!fwd||!up) return;
  // Save real position (= ship position from nsUpdateCamera, UNTOUCHED)
  NS._shipRestore=cam.position.clone();
  // Position + orient the ship mesh using the SAME fwd/up as the fly block
  NS._playerShip.position.copy(cam.position);
  NS._playerShip.lookAt(cam.position.clone().add(fwd));
  NS._playerShip.visible=true;
  // Engine glow intensity scales with speed
  if(NS._playerShipEng){
    var spd=c.vel?c.vel.length():0, mx=Math.max(1,(typeof nsThrottleSpeed==='function'?nsThrottleSpeed():1));
    var sf=Math.min(2.5, 0.3+spd/(mx*0.3+1));
    NS._playerShipEng.scale.set(NS._playerShipLen*0.5*sf, NS._playerShipLen*0.5*sf, 1);
    NS._playerShipEng.material.opacity=Math.min(0.9, 0.2+sf*0.3);
  }
  // Chase offset: stiff spring behind + above the ship.
  // Uses fwd (aim direction) so camera stays BEHIND, never swings in front.
  var spd=c.vel?c.vel.length():0, mx=Math.max(1,(typeof nsThrottleSpeed==='function'?nsThrottleSpeed():1));
  var ratio=Math.min(1, spd/mx);
  var chaseD=NS_SCALE*(200+500*ratio);   // further behind when fast
  var chaseH=NS_SCALE*(60+140*ratio);    // higher when fast
  var want=NS._shipRestore.clone().addScaledVector(fwd, -chaseD).addScaledVector(up, chaseH);
  // Stiff spring: dt*10 = snaps behind quickly, no front-facing overshoot
  if(!NS._chasePos) NS._chasePos=want.clone();
  var bl=NS._chaseDt?Math.min(1, NS._chaseDt*10):1;
  NS._chasePos.lerp(want, bl);
  cam.position.copy(NS._chasePos);
  // Look AHEAD of the ship (not at it) — prevents the GTA front-view oscillation
  var lookPt=NS._shipRestore.clone().addScaledVector(fwd, NS_SCALE*40);
  cam.lookAt(lookPt);
  cam.up.copy(up);
}
function nsPlayerShipPost(){
  // Restore real position so next frame's movement starts from the ship, not the chase cam
  if(NS._shipRestore && NS.camera){
    NS.camera.position.copy(NS._shipRestore);
    NS._shipRestore=null;
  }
}
function nsDisposeShips(){
  if(NS.ships){ for(const sh of NS.ships){
    [sh.mesh, sh.trail, sh.label].forEach(o=>{ if(!o)return; NS.scene&&NS.scene.remove(o);
      if(o.geometry && o.geometry!==NS._shipGeo) o.geometry.dispose&&o.geometry.dispose();
      if(o.material){ if(o.material.map)o.material.map.dispose&&o.material.map.dispose(); o.material.dispose&&o.material.dispose(); } });
  } }
  if(NS._shipGeo){ try{NS._shipGeo.dispose();}catch(_){ } NS._shipGeo=null; }
  NS.ships=[]; NS._shipObs=null;
  if(NS._playerShip){ NS.scene&&NS.scene.remove(NS._playerShip); NS._playerShip=null; }
}

function nsBuildCosmosPlanets(rng){
  const S=NS_SCALE, BR=S*NS_BODY; NS.cosmosPlanets=[]; NS.three.cosmosPlanets=[];
  // PLANETS ARE RARE (owner: "planets should be rare; rocks/dust dominate").
  // Far fewer full-mesh worlds, far apart, and SMALL relative to the volume so
  // when zoomed out they are point-like, not "fucking huge".
  const CAP=9, types=['gas','rock','ice','exotic'];
  const placed=NS._structPts||(NS._structPts=[]);
  for(let i=0;i<CAP;i++){
    const seed=nsHashStr('cosmos-planet-'+i);
    const type=types[(rng()*types.length)|0];
    const c=nsSectorPoint(rng, placed, COSMOS*0.30, i);
    const orbR=c.length();                          // orbit radius from its sector point
    const ang=Math.atan2(c.z,c.x), incl=(rng()*2-1)*0.5, y=c.y;
    const r=(34+rng()*120)*BR;                       // small bodies (NS_BODY)
    const tex=nsMakePlanetTexture(seed,type);
    const geo=new THREE.SphereGeometry(r, 28, 28);
    const baseHex = type==='gas'?'#7aa0ff':type==='rock'?'#caa178':type==='ice'?'#aee6ff':'#d28cff';
    const mat=new THREE.MeshStandardMaterial({map:tex, roughness:0.85, metalness:0.05, emissive:new THREE.Color(baseHex), emissiveIntensity:0.06});
    const mesh=new THREE.Mesh(geo,mat);
    mesh.position.copy(c); NS.scene.add(mesh);
    const atmo=nsMakeAtmosphere(r, baseHex); atmo.position.copy(mesh.position); NS.scene.add(atmo);
    const nm='World '+(['Veyra','Oort','Sicille','Hyx','Caldera','Mire','Thrun','Vael','Orun','Lethe','Pyx','Drava','Quell','Ashen','Bryn','Korr','Zephyr','Nyx'][i]||('X'+i));
    // LABEL the world so it's discoverable in the vast field
    const lbl=nsMakeLabel(nm, baseHex); lbl.scale.multiplyScalar(NS_SCALE*1.4);
    lbl.position.copy(c).add(new THREE.Vector3(0, r+22*NS_SCALE, 0)); NS.scene.add(lbl);
    nsRegisterStructLabel(lbl);
    const nid='cosmos:'+i;
    const p={ mesh, atmo, orbR, ang, incl, y, r, seed, type, name:nm, label:lbl, id:nid, kind:'world',
      pos:mesh.position, sub:type+' world', baseHex,
      orbSpeed:(0.0015+rng()*0.004)*(rng()<0.5?1:-1)*NS_ORBIT_SLOW, spin:(0.05+rng()*0.2)*NS_SPIN_SLOW };
    NS.cosmosPlanets.push(p); NS.three.cosmosPlanets.push(mesh, atmo);
    // register as a clickable pseudo-node so click→fly-to→FOLLOW works on worlds
    mesh.userData.nid=nid; NS.nodeById[nid]=p; NS.three.meshes.push(mesh);
    p.hit=nsMakeHitSphere(p, mesh);   // generous invisible hit-sphere for clicking
  }
}
// track structure labels for follow-position-update + dispose
function nsRegisterStructLabel(spr){ if(!NS.three.structLabels) NS.three.structLabels=[]; NS.three.structLabels.push(spr); }

/* ── ABUNDANT SMALL BODIES — INSTANCED asteroids / rocks / belts (owner #5) ──
   "i should see a LOT of asteroids and other things ... rocks and debris and
   asteroid belts." Real space is mostly small rubble, so SMALL bodies DOMINATE
   and planets are rare. All of it is ONE InstancedMesh per family (single draw
   call, no per-frame allocation) so thousands of rocks stay cheap. Each rock is
   a low-poly icosahedron; per-instance matrix = position * random rotation *
   random small scale → varied lumps. Belts are ring distributions around the
   core + a couple of cosmos planets. Deterministic from the cosmos seed.       */
function nsBuildAsteroids(rng){
  const S=NS_SCALE, BR=S*NS_BODY;
  NS.three.instanced=NS.three.instanced||[];
  NS._lodFields=NS._lodFields||[];        // LOD-streamed far fields (asteroids/debris/belts/blobs)
  const dummy=new THREE.Object3D();
  // shared low-poly rock geometry (cheap) — slight irregular look via flat shading
  const rockGeo=new THREE.IcosahedronGeometry(1, 0);
  // DETERMINISTIC hashed pseudo-random in [0,1) from an integer index + salt — stable
  // across frames/sessions (positions never re-randomize). Cheap integer hashing.
  const hsh=(i,salt)=>{ let h=(nsHashStr(salt)^Math.imul(i+1,2654435761))>>>0; h^=h>>>15; h=Math.imul(h,0x2c1b3c6d)>>>0; h^=h>>>13; return (h>>>0)/4294967296; };
  // register an object for LOD fade-in: full opacity within `near`, → 0 past `far`,
  // measured from camera to `center`. baseOp is the object's natural max opacity.
  const lodReg=(obj, center, near, far, baseOp)=>{ NS._lodFields.push({obj, center:center.clone(), near, far, baseOp}); };
  // shared softened opacity start = 0 so EVERYTHING fades in (no pop at spawn)
  const mkField=(count, color, sizeMin, sizeMax, place, salt, lod)=>{
    const mat=new THREE.MeshStandardMaterial({color, roughness:0.95, metalness:0.03, flatShading:true, transparent:true, opacity:lod?0:1});
    const inst=new THREE.InstancedMesh(rockGeo, mat, count);
    inst.frustumCulled=false;
    for(let i=0;i<count;i++){
      const v=place(i, count, (k)=>hsh(i, salt+k));         // place() pulls deterministic randoms
      const s=(sizeMin+hsh(i,salt+'sz')*(sizeMax-sizeMin))*BR;
      dummy.position.copy(v);
      dummy.rotation.set(hsh(i,salt+'rx')*6.28, hsh(i,salt+'ry')*6.28, hsh(i,salt+'rz')*6.28);
      dummy.scale.set(s, s*(0.6+hsh(i,salt+'sy')*0.7), s*(0.7+hsh(i,salt+'sz2')*0.6));  // lumpy
      dummy.updateMatrix(); inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate=true;
    NS.scene.add(inst); NS.three.instanced.push(inst);
    if(lod) lodReg(inst, lod.c, lod.near, lod.far, 1);
    return inst;
  };
  // soft round POINTS field (cheap: one Points object, many verts) for fine debris/dust.
  const mkPoints=(count, color, size, op, place, salt, lod)=>{
    const pos=new Float32Array(count*3);
    for(let i=0;i<count;i++){ const v=place(i, count, (k)=>hsh(i, salt+k)); pos[i*3]=v.x; pos[i*3+1]=v.y; pos[i*3+2]=v.z; }
    const g=new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos,3));
    const m=new THREE.PointsMaterial({map:nsMakeGlowTexture(), color, size:size*Math.sqrt(S), sizeAttenuation:true, transparent:true, opacity:lod?0:op, depthWrite:false});
    const pts=new THREE.Points(g,m); pts.frustumCulled=false; NS.scene.add(pts);
    NS.three.instanced.push(pts);                            // tracked for dispose
    if(lod) lodReg(pts, lod.c, lod.near, lod.far, op);
    return pts;
  };
  // LOD band sizes for the GLOBAL far fields (centered at origin but spanning all of
  // COSMOS): keep them visible across a HUGE near band, fade gently at the far edge.
  const GN=COSMOS*1.35, GF=COSMOS*2.6;     // global field near/far (always mostly on)
  const O=new THREE.Vector3(0,0,0);
  // 1) SCATTERED ASTEROID ROCKS — instanced low-poly, spread across the FULL volume
  mkField(7000, 0x8b8472, 0.6, 4.0, (i,n,r)=>{
    const rad=Math.cbrt(r(0))*COSMOS*0.99, t=r(1)*6.28, p=Math.acos(2*r(2)-1);
    return new THREE.Vector3(rad*Math.sin(p)*Math.cos(t), rad*Math.cos(p)*0.8, rad*Math.sin(p)*Math.sin(t));
  }, 'astro-rock', {c:O, near:GN, far:GF});
  // 2) FINE DEBRIS POINTS — very numerous soft specks filling the whole volume cheaply
  mkPoints(16000, 0x8893a8, 1.4, 0.5, (i,n,r)=>{
    const rad=Math.cbrt(r(0))*COSMOS*1.0, t=r(1)*6.28, p=Math.acos(2*r(2)-1);
    return new THREE.Vector3(rad*Math.sin(p)*Math.cos(t), rad*Math.cos(p)*0.85, rad*Math.sin(p)*Math.sin(t));
  }, 'debris-pts', {c:O, near:GN, far:GF});
  // 3) DUST MOTES POINTS — even denser, dimmer, smaller — "always rubble around you"
  mkPoints(20000, 0x6f7484, 1.0, 0.34, (i,n,r)=>{
    const rad=Math.cbrt(r(0))*COSMOS*1.0, t=r(1)*6.28, p=Math.acos(2*r(2)-1);
    return new THREE.Vector3(rad*Math.sin(p)*Math.cos(t), rad*Math.cos(p)*0.9, rad*Math.sin(p)*Math.sin(t));
  }, 'dust-pts', {c:O, near:GN, far:GF});
  // 4) CLUMPED RUBBLE BLOBS — several deterministic clump centres scattered far out,
  //    each a dense local Points cloud that LOD-fades in as you approach IT specifically.
  const NBLOB=14;
  for(let cl=0; cl<NBLOB; cl++){
    const cx=(hsh(cl,'blobX')*2-1)*COSMOS*0.9, cy=(hsh(cl,'blobY')*2-1)*COSMOS*0.7, cz=(hsh(cl,'blobZ')*2-1)*COSMOS*0.9;
    const ctr=new THREE.Vector3(cx,cy,cz), spr=COSMOS*(0.05+hsh(cl,'blobS')*0.06);
    const col=[0x9a8d78,0x7f8497,0xa08a6e,0x8b8472][cl%4];
    mkPoints(4200, col, 2.2, 0.45, (i,n,r)=>{
      const rad=Math.cbrt(r(0))*spr*0.8, t=r(1)*6.28, p=Math.acos(2*r(2)-1);
      return new THREE.Vector3(cx+rad*Math.sin(p)*Math.cos(t), cy+rad*Math.cos(p)*0.6, cz+rad*Math.sin(p)*Math.sin(t));
    }, 'blobpts'+cl, {c:ctr, near:spr*3.0, far:spr*9.0});
    // a few instanced ROCKS inside each blob for parallax/solidity
    mkField(260, col, 0.6, 3.2, (i,n,r)=>{
      const rad=Math.cbrt(r(0))*spr*0.9, t=r(1)*6.28, p=Math.acos(2*r(2)-1);
      return new THREE.Vector3(cx+rad*Math.sin(p)*Math.cos(t), cy+rad*Math.cos(p)*0.6, cz+rad*Math.sin(p)*Math.sin(t));
    }, 'blobrock'+cl, {c:ctr, near:spr*3.0, far:spr*9.0});
  }
  // 5) ASTEROID BELTS — distinct ring-shaped point bands at varied radii/orientations,
  //    around the core + a couple of cosmos planets + 3 free-floating belts far out.
  const beltCentres=[ {p:new THREE.Vector3(0,0,0), R:(NS._aiClusterR? NS._aiClusterR*1.7 : COSMOS*0.18)} ];
  if(NS.cosmosPlanets){ for(let k=0;k<2 && k<NS.cosmosPlanets.length;k++){ beltCentres.push({p:NS.cosmosPlanets[k].pos.clone(), R:COSMOS*0.07}); } }
  for(let fb=0; fb<3; fb++){
    const bp=new THREE.Vector3((hsh(fb,'beltX')*2-1)*COSMOS*0.6,(hsh(fb,'beltY')*2-1)*COSMOS*0.45,(hsh(fb,'beltZ')*2-1)*COSMOS*0.6);
    beltCentres.push({p:bp, R:COSMOS*(0.10+hsh(fb,'beltR')*0.10)});
  }
  beltCentres.forEach((bc,bi)=>{
    const ctr=bc.p, ringR=bc.R*(1+bi*0.12);
    const tiltX=(hsh(bi,'beltTX')*2-1)*1.1, tiltZ=(hsh(bi,'beltTZ')*2-1)*0.7;
    const cx=Math.cos(tiltX), sx=Math.sin(tiltX), cz=Math.cos(tiltZ), sz=Math.sin(tiltZ);
    const tilt=(v)=>{ let y=v.y,z=v.z; const y2=y*cx - z*sx, z2=y*sx + z*cx; let x=v.x; const x2=x*cz - y2*sz, y3=x*sz + y2*cz; return new THREE.Vector3(ctr.x+x2, ctr.y+y3, ctr.z+z2); };
    // bright instanced rocks forming the belt body
    mkField(2000, 0x9a8d76, 0.4, 2.6, (i,n,r)=>{
      const a=r(0)*6.28, rr=ringR*(0.92+r(1)*0.18), yj=(r(2)*2-1)*ringR*0.045;
      return tilt(new THREE.Vector3(Math.cos(a)*rr, yj, Math.sin(a)*rr));
    }, 'belt'+bi, {c:ctr, near:ringR*2.4, far:ringR*7.0});
    // a faint point haze on the same ring so the band reads even from afar
    mkPoints(3000, 0xb6a98a, 1.3, 0.5, (i,n,r)=>{
      const a=r(0)*6.28, rr=ringR*(0.9+r(1)*0.22), yj=(r(2)*2-1)*ringR*0.06;
      return tilt(new THREE.Vector3(Math.cos(a)*rr, yj, Math.sin(a)*rr));
    }, 'belthaze'+bi, {c:ctr, near:ringR*2.4, far:ringR*7.0});
  });
}
// LOD STREAMING — every frame, drive each far-field/structure material's opacity from
// camera distance to the field's region centre: full inside `near`, smoothstep down to
// 0 by `far`. Gradual (no pop) and cheap (a handful of distance checks + opacity sets).
function nsUpdateFieldLOD(){
  const cam=NS.camera; if(!cam) return;
  const cp=cam.position;
  const sstep=(e0,e1,x)=>{ if(e1<=e0) return x<=e0?1:0; let t=(x-e0)/(e1-e0); t=t<0?0:(t>1?1:t); return t*t*(3-2*t); };
  // 1) asteroid / debris / blob / belt fields
  const F=NS._lodFields;
  if(F) for(let i=0;i<F.length;i++){ const f=F[i]; const m=f.obj&&f.obj.material; if(!m) continue;
    const d=cp.distanceTo(f.center);
    const a=1 - sstep(f.near, f.far, d);     // 1 inside near band → 0 beyond far band
    m.opacity=f.baseOp*a; if(m.opacity<0.002){ if(f.obj.visible) f.obj.visible=false; } else if(!f.obj.visible) f.obj.visible=true;
  }
  // 2) gas-cloud puffs — fade each puff by distance to its cloud-region centre
  const G=NS.gasClouds, P=NS._gasPuffs;
  if(G&&G.length&&P&&P.length){
    // bucket: each puff carries no centre, so fade by nearest cloud centre cheaply.
    for(let i=0;i<P.length;i++){ const g=P[i]; if(!g.spr) continue; if(g._base===undefined) g._base=g.spr.material.opacity||0.06;
      // distance to this puff's own (drifting) position is fine + cheap
      const d=cp.distanceTo(g.spr.position);
      const a=1 - sstep(COSMOS*0.5, COSMOS*1.4, d);
      g.spr.material.opacity=g._base*a;
    }
  }
  // 3) cosmos planets + atmospheres — keep solid up close, fade the FAR ones out so
  //    they pop into view as you approach (atmo fades; mesh stays opaque but hides far).
  const CP=NS.cosmosPlanets;
  if(CP) for(let i=0;i<CP.length;i++){ const p=CP[i]; if(!p.mesh) continue;
    const d=cp.distanceTo(p.pos);
    const a=1 - sstep(COSMOS*0.7, COSMOS*1.8, d);
    if(p.atmo&&p.atmo.material){ if(p.atmo._base===undefined) p.atmo._base=p.atmo.material.opacity; p.atmo.material.opacity=p.atmo._base*a; }
    const vis=a>0.01; if(p.mesh.visible!==vis) p.mesh.visible=vis; if(p.atmo&&p.atmo.visible!==vis) p.atmo.visible=vis;
  }
}

// BLACK HOLE — pruner/error void. Dark sphere + bright accretion ring + lensing
// halo. Spawned LIVE from the real error stream; decays out over ~30s.
function nsSpawnGalacticCenter(){
  if(NS._galacticDone || !NS.three || !NS.scene) return; NS._galacticDone=true;
  const dir=new THREE.Vector3(0.58,0.16,-0.80); dir.normalize();
  const at=dir.multiplyScalar(40000000);          // ~10M ly out: the galaxy's central black hole
  try{ nsSpawnBlackHole(at, 280, 0xC0FFE1); }catch(_){ return; }
  const bh=NS.blackHoles && NS.blackHoles[NS.blackHoles.length-1];
  if(bh){ bh.life=1e12; bh._persistent=true; bh._galactic=true;
    if(bh.label){ try{ bh.label.scale.multiplyScalar(60); }catch(_){} } }
}
function nsSpawnBlackHole(at, severity, seed){
  if(!NS.three || !NS.scene) return;
  if(!NS.blackHoles) NS.blackHoles=[];
  if(NS.blackHoles.length>=3){ let _i=NS.blackHoles.findIndex(b=>!b._persistent); if(_i<0)_i=0; const old=NS.blackHoles.splice(_i,1)[0]; if(old) nsDisposeBlackHole(old); }
  // ── PROCEDURAL PER-INSTANCE VARIATION (owner #6: "not all the same") ──
  // seeded RNG → each hole gets its own size, accretion-disk radius/thickness,
  // tilt, colour temperature, lensing-halo strength. No two look identical.
  const jr=nsSeededRng((seed>>>0)||((Math.random()*1e9)>>>0));
  // MASSIVE warped object: a large pure-black event horizon that OCCLUDES (depthWrite
  // on), girdled by a bright additive accretion/lensing TORUS, a thin inner photon
  // ring, and a faint outer distortion halo. Much bigger than rocks/planets.
  const S=NS_SCALE, BR=S*NS_BODY*10.0;   // ~3x bigger than before — reads enormous
  const r=(60+severity*40)*BR*(0.8+jr()*1.1);            // event-horizon radius (bigger, imposing)
  const diskIn=1.25+jr()*0.30, diskOut=2.4+jr()*1.6;     // varied accretion-disk size
  // colour temperature: cool violet → hot orange/white, per-seed
  const diskHue=[0xff7a2a,0xffb347,0xff4d6d,0xffd27a,0xff8c42][(jr()*5)|0];
  const haloHue=[0x8aa0ff,0x6f86d8,0xa9b6ff,0x7d93e6][(jr()*4)|0];
  const lens=0.35+jr()*0.5;                              // lensing-halo strength
  // EVENT HORIZON — pure black, depthWrite ON so it truly occludes what's behind it
  // (renders as a void). Starts opaque-black but invisible-small; we fade via scale.
  const core=new THREE.Mesh(new THREE.SphereGeometry(r,28,28),
    new THREE.MeshBasicMaterial({color:0x000000, transparent:true, opacity:1, depthWrite:true}));
  core.position.copy(at); core.scale.setScalar(0.001);   // grows in (no pop)
  // ACCRETION RING — a large bright additive TORUS (real 3D depth, not a flat ring)
  const tube=r*(diskOut-diskIn)*0.5, tmid=r*(diskIn+diskOut)*0.5;
  const ring=new THREE.Mesh(new THREE.TorusGeometry(tmid, tube, 18, 64),
    new THREE.MeshBasicMaterial({color:diskHue, transparent:true, opacity:0, blending:THREE.AdditiveBlending, depthWrite:false}));
  ring.position.copy(at); ring.rotation.x=Math.PI/2*(0.4+jr()*0.7); ring.rotation.y=jr()*6.28; ring.rotation.z=jr()*6.28;
  // INNER PHOTON RING — thin bright disc hugging the horizon (lensing read)
  const photon=new THREE.Mesh(new THREE.RingGeometry(r*1.02, r*1.22, 64),
    new THREE.MeshBasicMaterial({color:0xffffff, side:THREE.DoubleSide, transparent:true, opacity:0, blending:THREE.AdditiveBlending, depthWrite:false}));
  photon.position.copy(at); photon.quaternion.copy(ring.quaternion);
  // OUTER DISTORTION HALO — soft additive glow suggesting bent light
  const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:nsMakeGlowTexture(), color:haloHue, transparent:true, opacity:0, depthWrite:false, blending:THREE.AdditiveBlending}));
  const hsz=r*(2.0+lens*1.0); halo.scale.set(hsz,hsz,1); halo.position.copy(at);
  // LABEL the void so the owner sees WHERE an error opened a black hole
  const lbl=nsMakeLabel('● Black Hole', '#ff7a2a'); lbl.scale.multiplyScalar(NS_SCALE*2.2);
  lbl.position.copy(at).add(new THREE.Vector3(0, r*2.4, 0));
  [core,ring,photon,halo,lbl].forEach(function(o){ if(o) o.frustumCulled=false; });   // never cull (was vanishing when looked at dead-center)
  NS.scene.add(core); NS.scene.add(ring); NS.scene.add(photon); NS.scene.add(halo); NS.scene.add(lbl);
  NS.blackHoles.push({core, ring, photon, halo, label:lbl, pos:at.clone(), born:performance.now(), life:90, r, spin:(0.4+jr()*1.2)*(jr()<0.5?1:-1), lens});
}
function nsDisposeBlackHole(b){ if(!b) return; [b.core,b.ring,b.photon,b.halo,b.label].forEach(o=>{ if(!o)return; NS.scene&&NS.scene.remove(o); if(o.geometry)o.geometry.dispose&&o.geometry.dispose(); if(o.material){ if(o.material.map)o.material.map.dispose&&o.material.map.dispose(); o.material.dispose&&o.material.dispose(); } }); }

/* ── WHITE HOLE — a bright EJECTING core (the inverse of a black hole). GPU
   ShaderMaterial: a pulsing radial-burst additive disc + an ejection particle
   jet. Spawned LIVE on recoveries / new-memory events, and a few ambient ones
   scattered as discoverable structures. r128-compatible (raw GLSL strings). ──*/
function nsMakeWhiteHole(at, scale, seed){
  // procedural per-instance: size, colour temperature, ejection intensity, ray count
  const jr=nsSeededRng((seed>>>0)||((Math.random()*1e9)>>>0));
  const S=NS_SCALE, BR=S*NS_BODY*3.4;
  const r=(16+ (scale||1)*12)*BR*(0.7+jr()*1.0);
  const cols=[0xeaf4ff,0xcfe6ff,0xfff2cf,0xd6fff0,0xe9d6ff];
  const ejCol=cols[(jr()*cols.length)|0];
  const rays=8.0+Math.floor(jr()*12), eject=0.4+jr()*0.9;   // varied ray count + ejection intensity
  // ejecting disc — radial burst shader
  const g=new THREE.PlaneGeometry(r*5, r*5, 1, 1);
  const mat=new THREE.ShaderMaterial({
    uniforms:{ uT:{value:0}, uCol:{value:new THREE.Color(ejCol)}, uRays:{value:rays}, uEj:{value:eject} },
    vertexShader:'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader:[
      'uniform float uT; uniform vec3 uCol; uniform float uRays; uniform float uEj; varying vec2 vUv;',
      'void main(){',
      ' vec2 p=vUv-0.5; float d=length(p)*2.0; float a=atan(p.y,p.x);',
      // bright core + ejecting rays + outward pulse (ray count + ejection vary per hole)
      ' float core=smoothstep(0.5,0.0,d);',
      ' float rays=0.5+0.5*sin(a*uRays - uT*4.0)*uEj;',
      ' float pulse=0.5+0.5*sin(d*18.0 - uT*6.0);',
      ' float i=core + (1.0-d)*rays*pulse*0.5; i*=smoothstep(1.0,0.2,d);',
      ' gl_FragColor=vec4(uCol*i*1.6, i);',
      '}'].join('\n'),
    transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide
  });
  const disc=new THREE.Mesh(g,mat); disc.position.copy(at);
  const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:nsMakeGlowTexture(), color:0xcfe6ff, transparent:true, opacity:0.7, depthWrite:false, blending:THREE.AdditiveBlending}));
  halo.scale.set(r*9,r*9,1); halo.position.copy(at);
  NS.scene.add(disc); NS.scene.add(halo);
  return {disc, halo, mat, pos:at.clone(), r, kind:'whitehole'};
}
function nsSpawnWhiteHole(at, scale, ambient, seed){
  if(!NS.three||!NS.scene) return;
  if(!NS.whiteHoles) NS.whiteHoles=[];
  if(NS.whiteHoles.length>=12){ const old=NS.whiteHoles.shift(); nsDisposeWhiteHole(old); }
  const w=nsMakeWhiteHole(at, scale||1, seed);
  w.born=performance.now(); w.life=ambient?1e9:26; w.ambient=!!ambient;
  w.name='White Hole'; NS.whiteHoles.push(w);
  if(!NS.three.whiteHoles) NS.three.whiteHoles=[]; NS.three.whiteHoles.push(w.disc, w.halo);
  // LABEL (ambient ones get a persistent marker; transient ones too — disposed with the hole)
  const lbl=nsMakeLabel('⊕ White Hole', '#cfe6ff'); lbl.scale.multiplyScalar(NS_SCALE*1.5);
  lbl.position.copy(at).add(new THREE.Vector3(0, w.r*4, 0)); NS.scene.add(lbl);
  w.label=lbl; if(ambient) nsRegisterStructLabel(lbl); else { if(!NS.three.whiteHoles) NS.three.whiteHoles=[]; }
  return w;
}
function nsDisposeWhiteHole(w){ if(!w) return; [w.disc,w.halo,w.label].forEach(o=>{ if(!o)return; NS.scene&&NS.scene.remove(o); if(o.geometry)o.geometry.dispose&&o.geometry.dispose(); if(o.material){ if(o.material.map)o.material.map.dispose&&o.material.map.dispose(); o.material.dispose&&o.material.dispose(); } }); }

/* ── PULSAR — a spinning neutron star (owner #2 PUSH structure). A small bright
   core with TWO rotating beams/jets that sweep around. On each rotation it emits
   a periodic PUSH PULSE: a short-range outward IMPULSE that shoves nearby bodies
   (n-body mesh) + a visible expanding SHOCK RING. It has its OWN MASS too, so it
   weakly attracts at range but REPELS in pulses — an attractor/repulsor hybrid.
   r128: beams are additive cones; shock ring is a reused billboard sprite scaled
   per pulse. Geometry is shared across instances (cap is small). No per-frame alloc. */
let NS_PULSAR_GEO=null, NS_PULSAR_BEAMGEO=null;
function nsMakePulsar(at, scale, seed){
  const jr=nsSeededRng((seed>>>0)||((Math.random()*1e9)>>>0));
  const S=NS_SCALE, BR=S*NS_BODY*3.0;
  const r=(9+(scale||1)*6)*BR*(0.8+jr()*0.6);              // compact core
  const tilt=(jr()*2-1)*1.2, spin=(2.4+jr()*2.2)*(jr()<0.5?1:-1);
  const grp=new THREE.Group(); grp.position.copy(at);
  // shared geometries (built once, reused — cheap)
  if(!NS_PULSAR_GEO) NS_PULSAR_GEO=new THREE.SphereGeometry(1,16,16);
  if(!NS_PULSAR_BEAMGEO){ NS_PULSAR_BEAMGEO=new THREE.ConeGeometry(0.5,1,10,1,true); NS_PULSAR_BEAMGEO.translate(0,0.5,0); }
  // bright core
  const coreMat=new THREE.MeshBasicMaterial({color:0xdff0ff});
  const core=new THREE.Mesh(NS_PULSAR_GEO, coreMat); core.scale.setScalar(r); grp.add(core);
  // glow halo
  const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:nsMakeGlowTexture(), color:0x9fd0ff, transparent:true, opacity:0.85, depthWrite:false, blending:THREE.AdditiveBlending}));
  halo.scale.set(r*7,r*7,1); grp.add(halo);
  // TWO opposed beams (jets) — additive cones reaching far out, rotating with the star
  const beamMat=new THREE.MeshBasicMaterial({color:0x8fd8ff, transparent:true, opacity:0.32, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide});
  const beamLen=r*16, beamW=r*2.4;
  const beams=new THREE.Group(); beams.rotation.z=tilt;
  const b1=new THREE.Mesh(NS_PULSAR_BEAMGEO, beamMat); b1.scale.set(beamW,beamLen,beamW); beams.add(b1);
  const b2=new THREE.Mesh(NS_PULSAR_BEAMGEO, beamMat); b2.scale.set(beamW,beamLen,beamW); b2.rotation.x=Math.PI; beams.add(b2);
  grp.add(beams);
  // reusable SHOCK RING sprite (scaled/faded per pulse) — soft glow billboard
  const ring=new THREE.Sprite(new THREE.SpriteMaterial({map:nsMakeGlowTexture(), color:0xbfe6ff, transparent:true, opacity:0.0, depthWrite:false, blending:THREE.AdditiveBlending}));
  ring.scale.set(r*2,r*2,1); grp.add(ring);
  NS.scene.add(grp);
  const period=1.6+jr()*1.4;                               // seconds between pulses
  const pushR=r*22, pushK=(NS_GRAV?NS_GRAV.G:0.9)*70*(0.8+jr()*0.6);  // short-range push impulse
  return { grp, core, halo, beams, beamMat, ring, mat:coreMat, pos:at.clone(), r, kind:'pulsar',
           spin, tilt, period, _t:jr()*period, pushR, pushK,
           m:Math.max(1,(r/(NS_BODY*NS_SCALE)))*3.0,        // its own gravitational mass (attracts weakly)
           _shock:0 };
}
function nsSpawnPulsar(at, scale, seed){
  if(!NS.three||!NS.scene) return;
  if(!NS.pulsars) NS.pulsars=[];
  if(NS.pulsars.length>=NS_PULSAR_CAP){ const old=NS.pulsars.shift(); nsDisposePulsar(old); }
  const p=nsMakePulsar(at, scale||1, seed);
  p.name='Pulsar'; NS.pulsars.push(p);
  if(!NS.three.pulsars) NS.three.pulsars=[]; NS.three.pulsars.push(p.grp);
  const lbl=nsMakeLabel('✦ Pulsar', '#bfe6ff'); lbl.scale.multiplyScalar(NS_SCALE*1.5);
  lbl.position.copy(at).add(new THREE.Vector3(0, p.r*5, 0)); NS.scene.add(lbl);
  p.label=lbl; nsRegisterStructLabel(lbl);
  // clickable pseudo-node (discoverable / labelled like other structures)
  const nid='pulsar:'+(NS.pulsars.length-1); p.id=nid; p.sub='neutron star · pulse-push';
  p.mesh=p.core; p.core.userData.nid=nid; NS.nodeById[nid]=p; NS.three.meshes.push(p.core);
  p.hit=nsMakeHitSphere(p, p.core);
  return p;
}
function nsDisposePulsar(p){ if(!p) return;
  // dispose only per-instance materials/sprites; SHARED core/beam geo are kept alive.
  const km=(o)=>{ if(!o)return; if(o.material){ if(o.material.map)o.material.map.dispose&&o.material.map.dispose(); o.material.dispose&&o.material.dispose(); } };
  km(p.halo); km(p.ring); km(p.core); km(p.beams&&p.beams.children[0]);
  if(p.hit){ NS.scene&&NS.scene.remove(p.hit); if(p.hit.geometry)p.hit.geometry.dispose&&p.hit.geometry.dispose(); km(p.hit); }
  if(p.label){ NS.scene&&NS.scene.remove(p.label); if(p.label.material){ if(p.label.material.map)p.label.material.map.dispose&&p.label.material.map.dispose(); p.label.material.dispose&&p.label.material.dispose(); } }
  if(p.grp) NS.scene&&NS.scene.remove(p.grp);
}
// per-frame: spin the beams, fire the periodic PUSH pulse (impulse on nearby n-body
// bodies), and animate the expanding shock ring. Amortised — pulsars are few (cap).
function nsStepPulsars(dt){
  const P=NS.pulsars; if(!P||!P.length) return;
  const B=NS_GRAV.bodies;
  for(let i=0;i<P.length;i++){ const p=P[i];
    if(p.beams) p.beams.rotation.y += dt*p.spin;          // sweep the beams
    p._t+=dt;
    if(p._t>=p.period){ p._t-=p.period; p._shock=1;        // FIRE a pulse
      // outward PUSH impulse on every n-body body within pushR (short-range only)
      if(B) for(let j=0;j<B.length;j++){ const b=B[j], nd=b.node; if(!nd||nd.kind==='core') continue;
        const dx=nd.pos.x-p.pos.x, dy=nd.pos.y-p.pos.y, dz=nd.pos.z-p.pos.z;
        const d=Math.sqrt(dx*dx+dy*dy+dz*dz)||1e-3; if(d>p.pushR) continue;
        const fall=(1-d/p.pushR); const imp=p.pushK*fall*fall/d*dt*60;
        // capped impulse so nothing flings to infinity (stability)
        const cap=NS_GRAV.maxV*0.5, k=Math.min(imp, cap*d)/d;
        b.vel.x+=dx*k; b.vel.y+=dy*k; b.vel.z+=dz*k; }
    }
    // shock ring expands + fades after each pulse
    if(p._shock>0){ p._shock=Math.max(0,p._shock-dt*1.6);
      const grow=1+(1-p._shock)*8; const op=p._shock*0.55;
      if(p.ring){ const s=p.r*2*grow; p.ring.scale.set(s,s,1); p.ring.material.opacity=op; } }
    // gentle core twinkle in time with the beam
    if(p.halo) p.halo.material.opacity=0.6+0.3*Math.abs(Math.sin(p._t*Math.PI/p.period));
  }
}

/* ── WORMHOLE — a PAIR of portal rings joined by a faint tunnel. GPU swirl
   shader on each ring (rotating portal vortex). Spawned on cross-channel links
   + a few ambient. Both endpoints are labelled. ────────────────────────────*/
function nsMakePortalRing(at, hex){
  // TRUE 3D portal: a fat additive TORUS (the mouth) + a short TUNNEL of stacked,
  // shrinking rings receding behind it — so it has real depth and reads as a 3D
  // portal from ANY angle, not a camera-facing decal. A faint swirling disc fills
  // the throat. Grouped under one Object3D so the whole portal moves/aims together.
  const S=NS_SCALE, r=(22+Math.random()*12)*S;
  const col=new THREE.Color(hex);
  const grp=new THREE.Group(); grp.position.copy(at);
  // swirling throat disc (the vortex you'd fall into) — uses the original swirl shader
  const discGeo=new THREE.CircleGeometry(r*1.9, 48);
  const mat=new THREE.ShaderMaterial({
    uniforms:{ uT:{value:0}, uCol:{value:new THREE.Vector3(col.r,col.g,col.b)} },
    vertexShader:'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader:[
      'uniform float uT; uniform vec3 uCol; varying vec2 vUv;',
      'void main(){',
      ' vec2 p=vUv-0.5; float d=length(p)*2.0; float a=atan(p.y,p.x);',
      ' float swirl=0.5+0.5*sin(a*6.0 + d*22.0 - uT*5.0);',
      ' float ring=smoothstep(1.0,0.86,d)*smoothstep(0.55,0.78,d);',
      ' float throat=smoothstep(0.0,0.55,d);',
      ' float i=ring + swirl*throat*(1.0-smoothstep(0.8,1.0,d))*0.7;',
      ' if(d>1.0) discard;',
      ' gl_FragColor=vec4(uCol*i*1.5, i*0.92);',
      '}'].join('\n'),
    transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide
  });
  const disc=new THREE.Mesh(discGeo, mat); disc.position.z=-r*0.05; grp.add(disc);
  // the MOUTH — a fat glowing torus around the throat
  const mouthMat=new THREE.MeshBasicMaterial({color:hex, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.9});
  const mouth=new THREE.Mesh(new THREE.TorusGeometry(r*1.9, r*0.28, 16, 48), mouthMat); grp.add(mouth);
  // TUNNEL — a few stacked rings receding behind the mouth (gives the portal depth)
  const tunnelMats=[];
  const RINGS=6;
  for(let k=1;k<=RINGS;k++){
    const f=1 - k/(RINGS+1);                 // shrink + recede
    const rr=r*1.9*f;
    const tm=new THREE.MeshBasicMaterial({color:hex, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0.5*f});
    const tr=new THREE.Mesh(new THREE.TorusGeometry(rr, rr*0.10+r*0.04, 10, 40), tm);
    tr.position.z=-r*1.1*k; tr.rotation.z=k*0.5;   // staggered swirl
    grp.add(tr); tunnelMats.push({mesh:tr, mat:tm, base:0.5*f});
  }
  grp.lookAt(0,0,0);   // aim the portal mouth core-ward once (3D — no per-frame billboard)
  NS.scene.add(grp);
  return {ring:grp, mat, r, mouthMat, mouth, disc, tunnelMats};
}
function nsSpawnWormhole(a, b, ambient){
  if(!NS.three||!NS.scene) return;
  if(!NS.wormholes) NS.wormholes=[];
  if(NS.wormholes.length>=8){ const old=NS.wormholes.shift(); nsDisposeWormhole(old); }
  const hue=[0x9a6cff,0x22d9e6,0xff6cc4][(Math.random()*3)|0];
  const pa=nsMakePortalRing(a, hue), pb=nsMakePortalRing(b, hue);
  // faint tunnel line between the two mouths
  const lg=new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([a.x,a.y,a.z,b.x,b.y,b.z]),3));
  const lm=new THREE.LineBasicMaterial({color:hue, transparent:true, opacity:0.28, blending:THREE.AdditiveBlending, depthWrite:false});
  const tunnel=new THREE.Line(lg,lm); NS.scene.add(tunnel);
  const mid=a.clone().add(b).multiplyScalar(0.5);
  const lbl=nsMakeLabel('◎ Wormhole', '#9a6cff'); lbl.scale.multiplyScalar(NS_SCALE*1.5);
  lbl.position.copy(a).add(new THREE.Vector3(0, pa.r*3, 0)); NS.scene.add(lbl);
  const w={pa, pb, tunnel, label:lbl, posA:a.clone(), posB:b.clone(), born:performance.now(),
           life:ambient?1e9:1e9, ambient:!!ambient, name:'Wormhole', kind:'wormhole', pos:mid};
  NS.wormholes.push(w);
  if(ambient) nsRegisterStructLabel(lbl);
  if(!NS.three.wormholes) NS.three.wormholes=[]; NS.three.wormholes.push(pa.ring, pb.ring, tunnel);
  return w;
}
function nsDisposeWormhole(w){ if(!w) return; [w.pa&&w.pa.ring, w.pb&&w.pb.ring, w.tunnel, w.label].forEach(o=>{ if(!o)return; NS.scene&&NS.scene.remove(o);
  // portal rings are now Groups (mouth + tunnel rings + swirl disc): dispose children too
  if(o.traverse){ o.traverse(c=>{ if(c.geometry)c.geometry.dispose&&c.geometry.dispose(); if(c.material){ if(c.material.map)c.material.map.dispose&&c.material.map.dispose(); c.material.dispose&&c.material.dispose(); } }); }
  if(o.geometry)o.geometry.dispose&&o.geometry.dispose(); if(o.material){ if(o.material.map)o.material.map.dispose&&o.material.map.dispose(); o.material.dispose&&o.material.dispose(); } }); }

// scatter a few AMBIENT white holes + wormholes across sectors (discoverable),
// deterministic from the cosmos seed. Called once during starfield build.
function nsBuildExoticStructures(rng){
  NS.whiteHoles=[]; NS.three.whiteHoles=[]; NS.wormholes=[]; NS.three.wormholes=[];
  NS.pulsars=[]; NS.three.pulsars=[];
  const placed=NS._structPts||(NS._structPts=[]);
  // 3 ambient white holes in distinct sectors (each seeded → all look different)
  for(let i=0;i<3;i++){ const p=nsSectorPoint(rng, placed, COSMOS*0.3, 200+i); nsSpawnWhiteHole(p, 1.2+rng(), true, nsHashStr('white-'+i)); }
  // 3 ambient wormhole pairs (mouths in different sectors)
  for(let i=0;i<3;i++){ const a=nsSectorPoint(rng, placed, COSMOS*0.28, 300+i*2), b=nsSectorPoint(rng, placed, COSMOS*0.28, 301+i*2); nsSpawnWormhole(a, b, true); }
  // 3 ambient PULSARS as landmarks (push structures) — collision-free placement (owner #2)
  for(let i=0;i<3;i++){ const p=nsSectorPoint(rng, placed, COSMOS*0.32, 400+i); nsSpawnPulsar(p, 1.0+rng(), nsHashStr('pulsar-'+i)); }
}

// planets / stars / core / channels — simple spheres + glow halo sprites
function nsMakeGlowTexture(){
  if(NS._glowTex) return NS._glowTex;
  const S=256, c=document.createElement('canvas'); c.width=c.height=S; const x=c.getContext('2d');
  const g=x.createRadialGradient(S/2,S/2,0,S/2,S/2,S/2);
  // bright tight core + long SOFT falloff -> reads like a real star glow, not a hard toy dot
  g.addColorStop(0.00,'rgba(255,255,255,1)');
  g.addColorStop(0.05,'rgba(255,255,255,0.95)');
  g.addColorStop(0.13,'rgba(255,255,255,0.5)');
  g.addColorStop(0.28,'rgba(255,255,255,0.2)');
  g.addColorStop(0.50,'rgba(255,255,255,0.07)');
  g.addColorStop(0.78,'rgba(255,255,255,0.018)');
  g.addColorStop(1.00,'rgba(255,255,255,0)');
  x.fillStyle=g; x.fillRect(0,0,S,S);
  const t=new THREE.CanvasTexture(c); t.minFilter=THREE.LinearFilter;
  NS._glowTex=t; return NS._glowTex;
}
function nsOccluded(camPos, target, P, R){
  var dx=target.x-camPos.x, dy=target.y-camPos.y, dz=target.z-camPos.z;
  var L2=dx*dx+dy*dy+dz*dz; if(L2<1e-6) return false;
  var t=((P.x-camPos.x)*dx+(P.y-camPos.y)*dy+(P.z-camPos.z)*dz)/L2;
  if(t<=0.02||t>=0.99) return false;
  var cx=camPos.x+dx*t-P.x, cy=camPos.y+dy*t-P.y, cz=camPos.z+dz*t-P.z;
  return (cx*cx+cy*cy+cz*cz) < R*R;
}
function nsInitBloom(){
  if(NS._bloom||!NS.renderer||typeof THREE==='undefined') return;
  try{
    var optO={minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,depthBuffer:true,stencilBuffer:false};
    var optH={minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,depthBuffer:false,stencilBuffer:false};
    var b={ W:0,H:0,hw:2,hh:2,
      scene:new THREE.WebGLRenderTarget(2,2,optO),
      a:new THREE.WebGLRenderTarget(2,2,optH),
      bb:new THREE.WebGLRenderTarget(2,2,optH),
      cam:new THREE.OrthographicCamera(-1,1,1,-1,0,1),
      qscene:new THREE.Scene() };
    var VS='varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }';
    b.bright=new THREE.ShaderMaterial({uniforms:{tDiffuse:{value:null},uThresh:{value:0.72}},vertexShader:VS,
      fragmentShader:'uniform sampler2D tDiffuse; uniform float uThresh; varying vec2 vUv; void main(){ vec3 c=texture2D(tDiffuse,vUv).rgb; float l=max(c.r,max(c.g,c.b)); float k=max(0.0,l-uThresh)/(1.0-uThresh+1e-4); gl_FragColor=vec4(c*k*k,1.0); }',depthTest:false,depthWrite:false});
    b.blur=new THREE.ShaderMaterial({uniforms:{tDiffuse:{value:null},uDir:{value:new THREE.Vector2(1,0)},uRes:{value:new THREE.Vector2(1,1)}},vertexShader:VS,
      fragmentShader:'uniform sampler2D tDiffuse; uniform vec2 uDir; uniform vec2 uRes; varying vec2 vUv; void main(){ vec2 o=uDir/uRes; vec3 s=texture2D(tDiffuse,vUv).rgb*0.227027; s+=texture2D(tDiffuse,vUv+o*1.3846).rgb*0.316216; s+=texture2D(tDiffuse,vUv-o*1.3846).rgb*0.316216; s+=texture2D(tDiffuse,vUv+o*3.2308).rgb*0.070270; s+=texture2D(tDiffuse,vUv-o*3.2308).rgb*0.070270; gl_FragColor=vec4(s,1.0); }',depthTest:false,depthWrite:false});
    b.copy=new THREE.ShaderMaterial({uniforms:{tDiffuse:{value:null}},vertexShader:VS,fragmentShader:'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ gl_FragColor=vec4(texture2D(tDiffuse,vUv).rgb,1.0); }',depthTest:false,depthWrite:false});
    b.add=new THREE.ShaderMaterial({uniforms:{tDiffuse:{value:null},uStrength:{value:0.5}},vertexShader:VS,fragmentShader:'uniform sampler2D tDiffuse; uniform float uStrength; varying vec2 vUv; void main(){ gl_FragColor=vec4(texture2D(tDiffuse,vUv).rgb*uStrength,1.0); }',transparent:true,blending:THREE.AdditiveBlending,depthTest:false,depthWrite:false});
    b.quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2), b.copy); b.quad.frustumCulled=false; b.qscene.add(b.quad);
    NS._bloom=b;
  }catch(e){ NS._bloom=null; NS._bloomFail=true; }
}
// ── VOLUMETRIC FOG ── two-layer system: a subtle deep-space base fog for depth
//    perception (very distant objects fade into the void) PLUS the atmospheric
//    entry haze that ramps up as you descend into a planet. The deep-space fog
//    is extremely subtle (just enough for distant star dimming). Tunable/disable:
//    window.KAIVERSE_FOG (multiplier, default 1; set 0 to disable, 2 for thicker).
function nsUpdateAtmoFog(dt){
  var f=NS.scene&&NS.scene.fog, cam=NS.camera; if(!f||!cam||!NS.nodes||typeof THREE==='undefined') return;
  var mult=(typeof window!=='undefined' && window.KAIVERSE_FOG!=null) ? +window.KAIVERSE_FOG : 1;
  var best=null, bestSurf=Infinity, bestR=1;
  for(var i=0;i<NS.nodes.length;i++){ var n=NS.nodes[i]; if(!n||!n.pos) continue;
    if(!(n.kind==='bot'||n.kind==='engine')) continue;
    var r=n.r||1, surf=cam.position.distanceTo(n.pos)-r;
    if(surf<bestSurf){ bestSurf=surf; best=n; bestR=r; } }
  var atmoTop=bestR*0.6;
  var t=(best && mult>0) ? (1.0-Math.max(0,Math.min(1, bestSurf/Math.max(1e-3,atmoTop)))) : 0;
  t=t*t;
  NS._nearT=t;
  // Deep-space baseline fog: extremely subtle depth cueing
  var deepSpaceBase = 0.0000008 * mult;
  var atmoTarget=t*(3.0/Math.max(1,bestR))*mult;
  var target = Math.max(deepSpaceBase, atmoTarget);
  var k=Math.min(1,(dt||0.016)*3.0);
  f.density += (target-f.density)*k;
  if(f.density<1e-9) f.density=0;
  try{
    if(best && t>0.003 && typeof nsColorOf==='function'){
      var c=new THREE.Color(nsColorOf(best)); c.multiplyScalar(0.5);
      f.color.lerp(c, k*0.5*t);
    } else if(f.color && f.color.lerp){ f.color.lerp(new THREE.Color(0x050810), k*0.4); }
  }catch(_){}
}
function nsRenderBloom(){
  var R=NS.renderer; if(!R) return;
  if(NS._bloomOn===false){ R.setRenderTarget(null); R.render(NS.scene,NS.camera); return; }
  // ── HQ BLOOM: prefer the real UnrealBloomPass (EffectComposer) when the lib is
  //    loaded (vendored/CDN). Falls back to the hand-rolled bloom below, then to a
  //    plain render. Tunable: window.KAIVERSE_BLOOM_STRENGTH / _RADIUS / _THRESH. ──
  if(!NS._composerFail && typeof THREE!=='undefined' && typeof THREE.EffectComposer==='function'
     && typeof THREE.UnrealBloomPass==='function' && typeof THREE.RenderPass==='function'){
    try{
      var _sz=new THREE.Vector2(); R.getDrawingBufferSize(_sz);
      var _cw=Math.max(2,_sz.x|0), _ch=Math.max(2,_sz.y|0);
      if(!NS._composer){
        var _comp=new THREE.EffectComposer(R);
        _comp.addPass(new THREE.RenderPass(NS.scene,NS.camera));
        
        // --- SSAO DISABLED: kernelRadius=12 on scenes spanning 100k+ units
        // causes GPU stalls / context loss. The depth precision is too low for
        // the KAIVERSE scale. Bloom + cinematic pass are sufficient. ---

        var _str=(typeof window!=='undefined'&&+window.KAIVERSE_BLOOM_STRENGTH)||1.1;
        var _rad=(typeof window!=='undefined'&&+window.KAIVERSE_BLOOM_RADIUS)||0.5;
        var _thr=(typeof window!=='undefined'&&window.KAIVERSE_BLOOM_THRESH!=null)?+window.KAIVERSE_BLOOM_THRESH:1.0;   // raised to 1.0: only explicitly glowing objects (sun, engines) will bloom.
        var _bp=new THREE.UnrealBloomPass(new THREE.Vector2(_cw,_ch),_str,_rad,_thr);
        _comp.addPass(_bp);
        if (typeof THREE.ShaderPass === 'function') {
           const myCinematicShader = {
             uniforms: { tDiffuse: { value: null }, time: { value: 0.0 } },
             vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
             fragmentShader: "uniform sampler2D tDiffuse; uniform float time; varying vec2 vUv; float rand(vec2 n){return fract(sin(dot(n,vec2(12.9898,4.1414)))*43758.5453);} void main() { vec4 tex = texture2D(tDiffuse, vUv); vec2 uv = (vUv - 0.5) * 1.0; float dist = dot(uv, uv); tex.rgb *= smoothstep(0.8, 0.2 * 0.799, dist * 1.5 + 0.1); tex.rgb += (rand(vUv * time) - 0.5) * 0.04; gl_FragColor = tex; }"
           };
           var _cp = new THREE.ShaderPass(myCinematicShader);
           _comp.addPass(_cp);
           NS._composerCinematic = _cp;
        }
        NS._composer=_comp; NS._composerBloom=_bp; NS._composerW=_cw; NS._composerH=_ch; NS._bloomBaseStr=_str;
      }
      if(_cw!==NS._composerW||_ch!==NS._composerH){ NS._composer.setSize(_cw,_ch); NS._composerW=_cw; NS._composerH=_ch; }
      // PROXIMITY-TAMED BLOOM: drop bloom strength as you approach a surface so the
      // atmosphere shell / planet limb doesn't blow out up close (distant stars keep full glow).
      if(NS._composerBloom && NS._bloomBaseStr!=null){ var _np=NS._nearT||0; NS._composerBloom.strength=NS._bloomBaseStr*(1.0-0.72*_np); }
      if(NS._composerCinematic) { NS._composerCinematic.uniforms.time.value = performance.now()*0.001; }
      R.setRenderTarget(null); NS._composer.render(); return;
    }catch(_e){ NS._composerFail=true; try{ R.setRenderTarget(null); R.autoClear=true; }catch(__){} }
  }
  if(NS._bloomFail){ R.setRenderTarget(null); R.render(NS.scene,NS.camera); return; }
  if(!NS._bloom) nsInitBloom();
  var b=NS._bloom; if(!b){ R.setRenderTarget(null); R.render(NS.scene,NS.camera); return; }
  try{
    var sz=new THREE.Vector2(); R.getDrawingBufferSize(sz); var w=Math.max(2,sz.x|0), h=Math.max(2,sz.y|0);
    if(w!==b.W||h!==b.H){ b.W=w; b.H=h; b.scene.setSize(w,h); b.hw=Math.max(2,w>>1); b.hh=Math.max(2,h>>1); b.a.setSize(b.hw,b.hh); b.bb.setSize(b.hw,b.hh); }
    R.setRenderTarget(b.scene); R.clear(); R.render(NS.scene,NS.camera);
    b.quad.material=b.bright; b.bright.uniforms.tDiffuse.value=b.scene.texture; R.setRenderTarget(b.a); R.clear(); R.render(b.qscene,b.cam);
    for(var i=0;i<2;i++){
      b.quad.material=b.blur; b.blur.uniforms.uRes.value.set(b.hw,b.hh);
      b.blur.uniforms.tDiffuse.value=b.a.texture; b.blur.uniforms.uDir.value.set(1,0); R.setRenderTarget(b.bb); R.clear(); R.render(b.qscene,b.cam);
      b.blur.uniforms.tDiffuse.value=b.bb.texture; b.blur.uniforms.uDir.value.set(0,1); R.setRenderTarget(b.a); R.clear(); R.render(b.qscene,b.cam);
    }
    R.setRenderTarget(null); R.autoClear=false; R.clear();
    b.quad.material=b.copy; b.copy.uniforms.tDiffuse.value=b.scene.texture; R.render(b.qscene,b.cam);
    b.quad.material=b.add; b.add.uniforms.tDiffuse.value=b.a.texture; R.render(b.qscene,b.cam);
    R.autoClear=true;
  }catch(e){ NS._bloomFail=true; R.autoClear=true; R.setRenderTarget(null); R.render(NS.scene,NS.camera); }
}
/* ── SOFT GAS SPRITE TEXTURE (owner #2 — "gas, not dots") ───────────────────
   A big, blurred, very-soft radial falloff baked once into a CanvasTexture and
   shared by every nebula billboard. Smooth multi-stop gradient → no hard edge,
   so layered additive sprites read as volumetric cloud, not points. Cached +
   disposed with the rest of the GL resources. ─────────────────────────────── */
function nsMakeGasTexture(){
  if(NS._gasTex) return NS._gasTex;
  const S=128, c=document.createElement('canvas'); c.width=c.height=S; const x=c.getContext('2d');
  const g=x.createRadialGradient(S/2,S/2,0,S/2,S/2,S/2);
  // very gentle falloff with a soft core so the billboard is a fuzzy puff
  g.addColorStop(0.00,'rgba(255,255,255,0.55)');
  g.addColorStop(0.25,'rgba(255,255,255,0.32)');
  g.addColorStop(0.55,'rgba(255,255,255,0.12)');
  g.addColorStop(0.80,'rgba(255,255,255,0.03)');
  g.addColorStop(1.00,'rgba(255,255,255,0.00)');
  x.fillStyle=g; x.fillRect(0,0,S,S);
  NS._gasTex=new THREE.CanvasTexture(c); return NS._gasTex;
}
function nsMakeLabel(text,color){
  const c=document.createElement('canvas'); const pad=8; const fs=44;
  const ctx=c.getContext('2d'); ctx.font=`700 ${fs}px Outfit, sans-serif`;
  const w=ctx.measureText(text).width;
  c.width=Math.ceil(w)+pad*2; c.height=fs+pad*2;
  const x=c.getContext('2d'); x.font=`700 ${fs}px Outfit, sans-serif`; x.textBaseline='middle';
  x.fillStyle=color; x.shadowColor='rgba(0,0,0,0.8)'; x.shadowBlur=6; x.fillText(text, pad, c.height/2);
  const tex=new THREE.CanvasTexture(c);
  const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:tex, transparent:true, depthTest:false, depthWrite:false}));
  spr.scale.set(c.width/c.height*14, 14, 1);
  return spr;
}
// Invisible, slightly-larger sphere that rides a body so a click NEAR a small or
// distant body still picks it. Raycasting targets THESE (a generous radius), and
// they copy the live mesh position every frame, so the pick is always current.
function nsMakeHitSphere(node, mesh){
  // hit radius: a healthy multiple of body radius + a flat floor so even far,
  // sub-pixel bodies present a clickable target. Bigger for tiny bots/worlds.
  const grow = node.kind==='core' ? 1.8 : (node.kind==='bot' ? 4.5 : 3.2);
  const hr = Math.max(node.r*grow, node.r + 9*NS_SCALE);
  const hgeo=new THREE.SphereGeometry(hr, 8, 8);
  const hmat=new THREE.MeshBasicMaterial({visible:false, depthWrite:false});
  const hit=new THREE.Mesh(hgeo, hmat);
  hit.position.copy(mesh.position); hit.userData.nid=node.id; hit.renderOrder=-1;
  NS.scene.add(hit); NS.three.hits.push(hit);
  return hit;
}
// ── COSMIC CORE MANDALA: face-on god-rays + concentric glowing rings + zodiac symbol ring,
//    the galactic heart of the KAIVERSE. Billboards so it reads face-on from any angle; the
//    body loop slowly counter-rotates each layer. Built once for the core node.
function nsMakeRaysTex(){
  var c=document.createElement('canvas'); c.width=c.height=512; var x=c.getContext('2d'); var cx=256,cy=256;
  var cols=['255,240,200','120,220,255','150,255,210','255,205,140'];
  for(var i=0;i<110;i++){ var a=Math.random()*Math.PI*2, len=120+Math.random()*135, w=0.4+Math.random()*2.4, col=cols[i%cols.length];
    x.save(); x.translate(cx,cy); x.rotate(a);
    var g=x.createLinearGradient(0,0,len,0); g.addColorStop(0,'rgba('+col+',0)'); g.addColorStop(0.07,'rgba('+col+',0.5)'); g.addColorStop(1,'rgba('+col+',0)');
    x.fillStyle=g; x.fillRect(0,-w,len,w*2); x.restore(); }
  return new THREE.CanvasTexture(c);
}
function nsMakeRingsTex(){
  var c=document.createElement('canvas'); c.width=c.height=1024; var x=c.getContext('2d'); var cx=512,cy=512;
  var g0=x.createRadialGradient(cx,cy,0,cx,cy,150); g0.addColorStop(0,'rgba(190,245,255,0.95)'); g0.addColorStop(1,'rgba(60,160,255,0)'); x.fillStyle=g0; x.beginPath(); x.arc(cx,cy,150,0,7); x.fill();
  var rings=[[210,'120,220,255',6],[300,'150,255,210',4],[395,'255,225,140',5],[465,'200,150,255',3]];
  for(var k=0;k<rings.length;k++){ var rad=rings[k][0],col=rings[k][1],lw=rings[k][2]; x.beginPath(); x.arc(cx,cy,rad,0,Math.PI*2); x.lineWidth=lw; x.strokeStyle='rgba('+col+',0.85)'; x.shadowBlur=20; x.shadowColor='rgba('+col+',0.9)'; x.stroke(); }
  x.shadowBlur=0; for(var i=0;i<320;i++){ var a=Math.random()*7, rad=190+Math.random()*300; x.fillStyle='rgba(255,255,255,'+(0.18+Math.random()*0.6).toFixed(2)+')'; x.beginPath(); x.arc(cx+Math.cos(a)*rad, cy+Math.sin(a)*rad, 0.7+Math.random()*1.8,0,7); x.fill(); }
  return new THREE.CanvasTexture(c);
}
function nsMakeZodiacTex(){
  var c=document.createElement('canvas'); c.width=c.height=1024; var x=c.getContext('2d'); var cx=512,cy=512, R=438;
  var syms=['♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓'];
  x.font='52px serif'; x.textAlign='center'; x.textBaseline='middle'; x.fillStyle='rgba(205,238,255,0.92)'; x.shadowBlur=16; x.shadowColor='rgba(120,220,255,0.95)';
  for(var i=0;i<12;i++){ var a=i/12*Math.PI*2 - Math.PI/2; x.fillText(syms[i], cx+Math.cos(a)*R, cy+Math.sin(a)*R); }
  x.shadowBlur=8; x.beginPath(); x.arc(cx,cy,R+36,0,7); x.lineWidth=2; x.strokeStyle='rgba(150,220,255,0.45)'; x.stroke();
  x.beginPath(); x.arc(cx,cy,R-44,0,7); x.lineWidth=1.5; x.strokeStyle='rgba(150,220,255,0.35)'; x.stroke();
  return new THREE.CanvasTexture(c);
}
function nsBuildCoreFX(n){
  if(!NS.scene) return; var r=n.r||1;
  var grp=new THREE.Group(); grp.position.copy(n.pos); grp.frustumCulled=false;
  var defs=[[r*1.45,0x4fe0ff,0.055],[r*1.95,0x7affc8,0.05],[r*2.55,0xffe08a,0.05],[r*3.2,0xc89bff,0.045]];
  var rings=[];
  for(var i=0;i<defs.length;i++){ var d=defs[i];
    var ring=new THREE.Mesh(new THREE.TorusGeometry(d[0], d[0]*d[2], 24, 180),
      new THREE.MeshBasicMaterial({color:d[1], transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, depthWrite:false}));
    ring.rotation.x=Math.PI*(0.18+i*0.16); ring.rotation.y=i*0.7; ring.frustumCulled=false; grp.add(ring); rings.push(ring); }
  var rays=new THREE.Sprite(new THREE.SpriteMaterial({map:nsMakeRaysTex(), color:0x9fe8ff, transparent:true, opacity:0.45, depthWrite:false, blending:THREE.AdditiveBlending}));
  rays.scale.set(r*5,r*5,1); rays.frustumCulled=false; grp.add(rays);
  NS.scene.add(grp); n._coreFX={ grp:grp, rings:rings, rays:rays };
}
function nsBuildBodies(){
  const glowTex=nsMakeGlowTexture();
  NS.nodes.forEach(n=>{
    const col=nsHexToColor(n.color);
    const segs = (n.kind==='core'||n.kind==='bot')?112:(n.kind==='engine'?80:18);
    const geo=new THREE.SphereGeometry(n.r, segs, segs);
    // BAKE seed-driven relief into the base mesh so every planet has a real, slightly rugged
    // silhouette from ANY distance (not a perfect ball); the close-up descent adds big mountains.
    if((n.kind==='bot'||n.kind==='core'||n.kind==='engine') && typeof nsTerrainHeightJS==='function' && typeof nsPlanetDNA==='function'){
      try{ const _d=nsPlanetDNA(n), _a=(_d.type==='gas'?0:n.r*0.022), pa=geo.attributes.position, vv=new THREE.Vector3();
        for(let i=0;i<pa.count;i++){ vv.fromBufferAttribute(pa,i); const ln=vv.length(); if(ln<1e-6) continue; vv.multiplyScalar(1/ln);
          const hh=nsTerrainHeightJS(vv.x,vv.y,vv.z,_d.sharpness,_d.sea)*_a;
          vv.multiplyScalar(ln+hh); pa.setXYZ(i,vv.x,vv.y,vv.z); }
        pa.needsUpdate=true; geo.computeVertexNormals(); }catch(_){}
    }
    let mat;
    if(n.kind==='bot' || n.kind==='channels'){
      // bots read as PROCEDURAL WORLDS: noise-texture surface tinted to bot color
      const tex=nsMakePlanetTexture(nsHashStr(n.name), n.kind==='channels'?'exotic':'rock');
      mat=new THREE.MeshStandardMaterial({map:tex, bumpMap:tex, bumpScale:22.0, color:col, roughness:0.85, metalness:0.04, emissive:col, emissiveIntensity:0.08});
      // atmosphere rim glow in the body's color + dynamic clouds
      const atmo=nsMakeAtmosphere(n.r, n.color); atmo.position.copy(n.pos); NS.scene.add(atmo); n.atmo=atmo;
      const clouds=nsMakeClouds(n.r); clouds.position.copy(n.pos); NS.scene.add(clouds); n.clouds=clouds;
      const asteroids=nsBuildPlanetaryAsteroids(n.r, n.color); asteroids.position.copy(n.pos); NS.scene.add(asteroids); n.asteroids=asteroids;
    } else if(n.kind==='provider'){
      const tex=nsMakePlanetTexture(nsHashStr('prov-'+n.name), 'gas');
      mat=new THREE.MeshStandardMaterial({map:tex, bumpMap:tex, bumpScale:12.0, color:col, emissive:col, emissiveIntensity:n.active?0.5:0.12, roughness:0.4, metalness:0.1});
      if(!n.active){ mat.opacity=0.55; mat.transparent=true; }
      else { const atmo=nsMakeAtmosphere(n.r, n.color); atmo.position.copy(n.pos); NS.scene.add(atmo); n.atmo=atmo; }
    } else {
      // core / engine — bright stellar bodies
      mat=new THREE.MeshStandardMaterial({color:col, emissive:(n.kind==='core'?new THREE.Color(0xfff2d0):col), emissiveIntensity:(n.kind==='core'?10.0:0.5), roughness:0.4, metalness:0.1});
      if(n.kind==='core'){
        const halo=new THREE.Mesh(new THREE.SphereGeometry(n.r*1.6, 64, 48), new THREE.MeshBasicMaterial({color:0x46d6ff, transparent:true, opacity:0.35, blending:THREE.AdditiveBlending, side:THREE.BackSide, depthWrite:false}));
        halo.position.copy(n.pos); NS.scene.add(halo); n.atmo=halo;
        const corona=new THREE.Mesh(new THREE.SphereGeometry(n.r*2.6, 48, 32), new THREE.MeshBasicMaterial({color:0x2f86ff, transparent:true, opacity:0.16, blending:THREE.AdditiveBlending, side:THREE.BackSide, depthWrite:false}));
        corona.position.copy(n.pos); NS.scene.add(corona); n.corona=corona;
        try{ nsBuildCoreFX(n); }catch(_){}
      }
    }
    if(n.kind==='bot'||n.kind==='channels'||n.kind==='provider'){ 
      try{ nsAttachReliefNormal(mat, nsHashStr(n.name||n.id||'planet'), n); }catch(_){}
      
      // --- PHASE 3: WEB WORKER & DATA TEXTURE DEFORMATION ---
      if (typeof nsApplyDisplacement === 'function' && typeof nsPlanetDNA === 'function') {
        const _d = nsPlanetDNA(n);
        const _amp = (_d.type === 'gas' ? 0 : n.r * 0.022);
        
        // Request the hardware-accelerated DataTexture from the background Web Worker
        if (NS.workerReady && _amp > 0) {
          NS.workerCallbacks[n.id] = (data) => {
            const tex = new THREE.DataTexture(data, 512, 512, THREE.RGBAFormat, THREE.FloatType);
            tex.needsUpdate = true;
            nsApplyDisplacement(mat, _d, _amp, tex);
          };
          NS.worker.postMessage({ type: 'GENERATE_TERRAIN', id: n.id, seed: nsHashStr(n.name||n.id), size: 512, sharp: _d.sharpness, sea: _d.sea });
        } else {
           // Fallback to pure procedural GPU math if worker isn't ready
           nsApplyDisplacement(mat, _d, _amp, null);
        }
      }
      // --------------------------------------------------------
    }
    const mesh=new THREE.Mesh(geo,mat); mesh.position.copy(n.pos); mesh.userData.nid=n.id;
    if(n.kind !== 'core' && n.kind !== 'engine') {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    NS.scene.add(mesh); n.mesh=mesh; NS.three.meshes.push(mesh);
    // Real equirectangular surface texture if one exists at /textures/<name>.jpg
    // (dropped in by the texture-sourcing task). Falls back silently to procedural.
    if((n.kind==='bot'||n.kind==='core'||n.kind==='engine') && THREE.TextureLoader){
      const tname=String(n.name||n.id||'').toLowerCase().replace(/[^a-z0-9]+/g,'');
      if(tname){
        const _TL=new THREE.TextureLoader();
        _TL.load('/textures/'+tname+'.jpg', function(tx){      // COLOR / albedo
          try{ if(THREE.sRGBEncoding!==undefined) tx.encoding=THREE.sRGBEncoding; }catch(_){}
          mesh.material.map=tx; mesh.material.color.set(0xffffff); try{var _a=(NS.renderer&&NS.renderer.capabilities&&NS.renderer.capabilities.getMaxAnisotropy)?NS.renderer.capabilities.getMaxAnisotropy():8;tx.anisotropy=_a||8;}catch(_){}
          if(mesh.material.emissive){ mesh.material.emissive.set(0x0a0a0a); mesh.material.emissiveIntensity=0.0; }
          mesh.material.needsUpdate=true; n._realTex=true;
        }, undefined, function(){});
        // NORMAL map → real lit relief (mountains/craters catch light, not a flat decal)
        _TL.load('/textures/'+tname+'_normal.jpg', function(nx){ n._realNormal=nx; try{var _a=(NS.renderer&&NS.renderer.capabilities&&NS.renderer.capabilities.getMaxAnisotropy)?NS.renderer.capabilities.getMaxAnisotropy():8;nx.anisotropy=_a||8;}catch(_){} mesh.material.normalMap=nx; mesh.material.needsUpdate=true; }, undefined, function(){});
        // HEIGHT map → real GPU geometric displacement (NMS style)
        _TL.load('/textures/'+tname+'_height.jpg', function(hx){ n._realHeight=hx; }, undefined, function(){});
        // CLOUD map (alpha PNG) → realistic cloud shell on descent
        _TL.load('/textures/'+tname+'_clouds.png', function(cx){ n._realClouds=cx; }, undefined, function(){});
      }
    }
    // invisible HIT-SPHERE (owner #1: "hard to click small/distant bodies"). A
    // larger transparent sphere riding the same position so a click NEAR the body
    // still selects it. Raycast targets these (current-frame position), not stale.
    n.hit=nsMakeHitSphere(n, mesh);
    // status halo (sprite glow, recolored by health)
    const halo=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex, color:col, transparent:true, opacity:n.active===false?0.08:0.24, depthWrite:false, blending:THREE.AdditiveBlending}));
    const hs=n.r*(n.kind==='core'?2.8:1.35); halo.scale.set(hs,hs,1); halo.position.copy(n.pos);
    NS.scene.add(halo); n.halo=halo; NS.three.glows.push(halo);
    // label sprite (scaled up so it reads at the new vast distances)
    const lbl=nsMakeLabel(n.name, n.color); lbl.scale.multiplyScalar(NS_SCALE*0.9);
    lbl.position.copy(n.pos).add(new THREE.Vector3(0, n.r+10*NS_SCALE, 0));
    NS.scene.add(lbl); n.label=lbl; NS.three.sprites.push(lbl);
  });
}

// structural edges as a single LineSegments object (cheap, one draw call)
function nsBuildEdges(){
  const segs=NS.edges.length, pos=new Float32Array(segs*6), col=new Float32Array(segs*6);
  NS.edges.forEach((e,i)=>{
    const A=NS.nodeById[e.a].pos, B=NS.nodeById[e.b].pos;
    pos.set([A.x,A.y,A.z, B.x,B.y,B.z], i*6);
  });
  const g=new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setAttribute('color', new THREE.BufferAttribute(col,3));
  // CONNECTION BEAM: one additive LineSegments (one draw call). Idle edges are
  // written to ~0 colour so they're invisible; an edge FLARES bright when real
  // traffic bumps its healthV, then fades as healthV decays. The travelling
  // laser-bolt packets ride ON TOP of this beam.
  const m=new THREE.LineBasicMaterial({vertexColors:true, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false});
  const lines=new THREE.LineSegments(g,m); lines.frustumCulled=false; NS.scene.add(lines);
  // Always rendered; visibility is driven ENTIRELY by per-vertex colour (idle≈0).
  lines.visible=false;   // pulse-only: hide static beam (traffic shows via pulse packets)
  NS.three.lines=lines; NS.three.lineGeo=g;
  nsRebuildEdgeColors();
}
function nsRebuildEdgeColors(){
  const g=NS.three&&NS.three.lineGeo; if(!g) return;
  const col=g.attributes.color.array;
  NS.edges.forEach((e,i)=>{
    // IDLE = invisible: no floor. The beam only appears when healthV is non-zero
    // (raised by nsBumpEdge on real traffic) and fades to 0 as it decays.
    const c=new THREE.Color(e.health==='error'?NS_RED:(e.health==='warn'?NS_YELLOW:NS_GREEN));
    const o=e.healthV>0.02 ? Math.pow(Math.min(1,e.healthV),0.7) : 0;   // bright glow ramp, hard 0 when idle
    col.set([c.r*o,c.g*o,c.b*o, c.r*o,c.g*o,c.b*o], i*6);
  });
  g.attributes.color.needsUpdate=true;
}

// LATTICE NEBULA — particle cloud whose count/spread scale with REAL cells+synapses
function nsBuildNebula(){
  const CAP=5000, S=NS_SCALE;
  const pos=new Float32Array(CAP*3);
  for(let i=0;i<CAP;i++){
    // gaussian-ish cloud filling a huge volume around the core (rides NS_SPREAD)
    const r=Math.cbrt(Math.random())*340*S*NS_SPREAD*(0.4+Math.random()*0.6);
    const t=Math.random()*Math.PI*2, p=Math.acos(2*Math.random()-1);
    pos[i*3]=r*Math.sin(p)*Math.cos(t); pos[i*3+1]=r*Math.cos(p)*0.6; pos[i*3+2]=r*Math.sin(p)*Math.sin(t);
  }
  const g=new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setDrawRange(0, 600);  // start small; grows with real cell count
  const m=new THREE.PointsMaterial({color:0x22d9e6, size:1.5*Math.sqrt(S), sizeAttenuation:true, transparent:true, opacity:0.32, blending:THREE.AdditiveBlending, depthWrite:false});
  const neb=new THREE.Points(g,m); NS.scene.add(neb); NS.nebula=neb; NS.nebulaCap=CAP;
}
// scale the nebula + vast star/debris fields from REAL stats. cells → star
// density (more cells = denser cosmos); synapses → debris/link density + nebula
// spread. The geometry is built at a generous cap; we just expose a draw-range
// proportional to the live numbers so the visuals honestly reflect the engine.
function nsScaleNebula(){
  // smoothed values so field density GROWS continuously with KAI (owner #12)
  const _gv=(typeof nsGrowVal==='function')?nsGrowVal:function(_k,v){return v;};  // truncation-loss safe shim
  const cells=_gv('cells', Number(NS.statSnap.cells)||0)||0, syn=_gv('synapses', Number(NS.statSnap.synapses)||0)||0;
  if(NS.nebula){
    const count=Math.max(600, Math.min(NS.nebulaCap, Math.round(Math.log10(cells+10)/Math.log10(20000)*NS.nebulaCap)||600));
    NS.nebula.geometry.setDrawRange(0, count);
    NS.nebulaBaseSpread = 1 + Math.min(0.6, Math.log10(syn+10)/Math.log10(200000)*0.6);
  }
  // vast star field draw-range scales with cells (cap is the built buffer size)
  if(NS.three&&NS.three.starGeo&&NS.three.starCap){
    const frac=Math.max(0.4, Math.min(1, Math.log10(cells+10)/Math.log10(2e6)));
    NS.three.starGeo.setDrawRange(0, Math.round(NS.three.starCap*frac));
  }
}

/* ── /api/operations → 3D pulses (logic unchanged; rendered in nsTick) ──── */
function nsResize(){
  const wrap=$('ns-wrap'); if(!wrap||!NS.renderer) return;
  const r=wrap.getBoundingClientRect();
  const dpr=Math.min(2, window.devicePixelRatio||1);
  NS.renderer.setPixelRatio(dpr);
  NS.renderer.setSize(r.width, r.height, false);
  NS.camera.aspect=r.width/Math.max(1,r.height); NS.camera.updateProjectionMatrix();
}
// Free-fly tunables (scaled to the vast universe). The MAX speed is now a
// THROTTLE-scaled ceiling: scroll sets NS.throttle (0..1) → effective top speed.
// Speeds scale with NS_SPREAD so the vast distances are actually traversable and
// the FULL throttle range is felt. The min..max spread is WIDE (≈20x) so scroll
// genuinely changes how fast WASD moves (owner #7).
const NS_FLY_ACCEL = 20000*NS_SCALE*NS_SPREAD;  // units/s^2 base accel while a key is held
// Top speed balanced: fast enough to cross the system in ~1 minute, but not an instant teleport.
// Cruising open space is controllable via the exponential throttle curve.
const NS_FLY_MAX   = ((typeof window!=='undefined' && +window.KAIVERSE_FLY_MAX) || 25000000)*NS_SCALE*NS_SPREAD;  // ABSOLUTE top speed at 100% throttle
const NS_FLY_MIN   = ((typeof window!=='undefined' && +window.KAIVERSE_FLY_MIN) || 180)*NS_SCALE*NS_SPREAD;   // floor speed at 0% throttle (still moves, but slow)
const NS_FLY_DAMP  = 2.6;            // velocity damping when keys released (smoother)
// throttle: scroll up → faster, scroll down → slower. Smoothed toward target.
NS.throttle = 0.30; NS.throttleT = 0.30;
// GPS waypoint: a node id the owner has selected to navigate TO manually (no
// fast-travel). The compass + edge markers emphasize it; flying is on the owner.
NS.gpsTarget = null;
// effective top speed for the CURRENT throttle setting. Quadratic curve so the
// low end is gentle and the high end is dramatic — the throttle clearly "bites".
function nsThrottleSpeed(){ const tt=NS.throttle*NS.throttle; return NS_FLY_MIN + (NS_FLY_MAX-NS_FLY_MIN)*tt; }

// Camera update. Two modes:
//   'orbit' — classic theta/phi/radius around a tween target (default, click-fly).
//   'fly'   — free-look (yaw/pitch) + WASD/QE thrust moving camera.pos directly.
// An accelerated fly-to-node animation (NS.flyTo) overrides while running.
// ── FLOATING ORIGIN ── the universe moves, you do not. When the camera drifts far from
//    (0,0,0) — where 32-bit float precision crumbles (jitter, flat-looking terrain) — shift
//    EVERYTHING (and the camera) back toward origin by the same vector. Relative positions are
//    preserved, so all distance/collision/gravity logic is unchanged; coordinates just stay
//    small enough to stay precise. This is the foundation that lets planets be genuinely huge
//    and systems spread far without the scene falling apart. Lights + camera are skipped.
function nsFloatingOrigin(){
  const cam=NS.camera; if(!cam||!NS.scene) return;
  const TH=45000;
  if(cam.position.lengthSq() < TH*TH) return;
  const shift=cam.position.clone();
  cam.position.sub(shift);
  const c=NS.cam; if(c && c.target && c.target.sub) c.target.sub(shift);
  const kids=NS.scene.children;
  for(let i=0;i<kids.length;i++){ const o=kids[i];
    if(!o || o===cam || o.isLight || !o.position || !o.position.isVector3) continue;
    o.position.sub(shift); }
  if(NS.nodes) for(let i=0;i<NS.nodes.length;i++){ const nd=NS.nodes[i]; if(nd && nd.pos && nd.pos.sub) nd.pos.sub(shift); }
  // Gas-cloud bases are re-applied every frame from stored ABSOLUTE coords (nsStepGas).
  // Shift those bases on every origin jump too, or the nebulae snap back toward spawn
  // and visually "follow" the camera. (A2 fix — world-anchor the glow clouds.)
  if(NS._gasPuffs) for(let i=0;i<NS._gasPuffs.length;i++){ const g=NS._gasPuffs[i]; if(!g) continue; g.bx-=shift.x; g.by-=shift.y; g.bz-=shift.z; }
  if(NS.gasClouds) for(let i=0;i<NS.gasClouds.length;i++){ const gc=NS.gasClouds[i]; if(gc&&gc.pos&&gc.pos.sub) gc.pos.sub(shift); }
  if(!NS._origin) NS._origin=new THREE.Vector3();
  NS._origin.add(shift);
}
function nsApplyViewRoll(cam, baseUp){
  var c=NS.cam; var roll=(c.roll||0)+(c._autoRoll||0);
  if(Math.abs(roll)<1e-4) return;
  var dir=c.target.clone().sub(cam.position); if(dir.lengthSq()<1e-9) return; dir.normalize();
  var up=baseUp.clone(); up.applyAxisAngle(dir, roll);
  if(up.lengthSq()>1e-9) cam.up.copy(up.normalize());
}
function nsUpdateCamera(dt){
  const c=NS.cam, cam=NS.camera; if(!cam) return;
  let prevPos = NS._prevCamPos || (NS._prevCamPos=new THREE.Vector3());
  prevPos.copy(cam.position);

  // Dynamic Auto-Throttle: ramps up automatically when thrusting forward or in autopilot.
  const isFwdThrust = NS.keys['w'] || (NS._gpKeys && NS._gpKeys.includes('w')) || NS._autopilot;
  if (isFwdThrust) {
    NS.throttle = Math.min(1.0, NS.throttle + dt * 0.4); // ~2.5s to max
  } else {
    NS.throttle = Math.max(0.02, NS.throttle - dt * 0.6); // quick ramp down
  }
  NS.throttleT = NS.throttle; // Sync for HUD

  // ── accelerated fly-to (slow start → accelerate → ease-in), now FOLLOWS a
  //    moving body: the destination is recomputed each frame from the live node
  //    position so we arrive framed on it even as it orbits. ──
  if(NS.flyTo){
    const f=NS.flyTo; f.t=Math.min(1, f.t + dt/f.dur);
    const e=nsEaseInOutCubic(f.t);
    // re-aim at the live target each frame (it moves) — keeps a constant offset
    const node=f.nid?NS.nodeById[f.nid]:null; const liveTgt=node&&node.pos?node.pos:f.toTgt;
    const liveToPos = liveTgt.clone().add(f.offset);
    cam.position.lerpVectors(f.fromPos, liveToPos, e);
    c.target.lerpVectors(f.fromTgt, liveTgt, e);
    cam.lookAt(c.target);
    if(f.t>=1){
      // arrived → hand to free-fly so the user retains full manual control
      // without being forced into an automatic orbit.
      NS.flyTo=null; c.mode='fly'; NS.followNid=null;
      c.followOff=cam.position.clone().sub(liveTgt);    // keep current framing offset
    }
  } else if(c.mode==='follow'){
    if(NS._playerShip) NS._playerShip.visible=false;
    NS._shipPos=null; NS._chasePos=null;
    // ── FOLLOW-CAM: track the selected moving body, keeping it framed. ──
    // thrust (movement keys or a real stick push) breaks the orbit lock back to free-fly.
    const Kf=NS.keys, breakOrbit = Kf['w']||Kf['s']||Kf['a']||Kf['d']||Kf['e']||Kf['q']||Kf[' ']||Kf['shift']||(NS._gpMag!=null&&NS._gpMag>0.12);
    const node=(!breakOrbit && NS.followNid)?NS.nodeById[NS.followNid]:null;
    if(breakOrbit){ c.mode='fly'; NS.followNid=null; }
    else if(!node||!node.pos){ c.mode='orbit'; }
    else {
      // gentle auto-orbit: slowly drift the framing offset around the body ("in orbit")
      if(c.followOff){ const aa=dt*0.06, ca=Math.cos(aa), sa=Math.sin(aa);
        const ox=c.followOff.x, oz=c.followOff.z; c.followOff.x=ox*ca-oz*sa; c.followOff.z=ox*sa+oz*ca; 
        const _mr = (node.r||1)*1.5; if(c.followOff.lengthSq() < _mr*_mr) c.followOff.setLength(_mr); }
      const want=node.pos.clone().add(c.followOff||new THREE.Vector3(0,0,1));
      cam.position.lerp(want, Math.min(1, dt*3.2));      // smooth chase
      c.target.copy(node.pos); cam.up.set(0,1,0); 
      // Free look override: instead of forcing lookAt(c.target), use yaw/pitch
      const cp=Math.cos(c.pitch), sp=Math.sin(c.pitch), cy=Math.cos(c.yaw), sy=Math.sin(c.yaw);
      const fwd=new THREE.Vector3(cp*cy,sp,cp*sy);
      cam.lookAt(cam.position.clone().add(fwd));
    }
  } else if(c.mode==='fly'){
    // ── free-fly: build basis from yaw/pitch, thrust with keys. Speed EASES IN
    //    toward the throttle ceiling for an illusion of accelerating across the
    //    vast space (No-Man's-Sky feel). ──
    const cp=Math.cos(c.pitch), sp=Math.sin(c.pitch), cy=Math.cos(c.yaw), sy=Math.sin(c.yaw);
    // ── SURFACE-RELATIVE BASIS ── smoothly level horizon ONLY when extremely close
    let _upT=new THREE.Vector3(0,1,0);
    if(NS._nearPlanet && NS._nearPlanet.pos){
      const _rad=cam.position.clone().sub(NS._nearPlanet.pos), _rr=NS._nearPlanet.r||1;
      const _surf=Math.max(0,_rad.length()-_rr);
      // extremely tight handoff band: only start tilting when practically touching the atmosphere (< 2 radii)
      const _t0=_rr*0.05, _t1=_rr*2.0;
      let _bt=(_t1-_surf)/Math.max(1e-6,(_t1-_t0)); _bt=_bt<0?0:(_bt>1?1:_bt); _bt=_bt*_bt*(3-2*_bt); _bt=_bt*_bt;
      const _blMax=0.65; // max 65% influence, allows player to still fight it
      NS._flyTilt = NS._flyTilt==null ? (_bt*_blMax) : (NS._flyTilt + (_bt*_blMax - NS._flyTilt)*Math.min(1,dt*0.1)); // VERY SLOW transition
      const _bl=NS._flyTilt;
      if(_bl>0 && _rad.lengthSq()>1e-9){ _rad.normalize(); _upT=new THREE.Vector3(0,1,0).lerp(_rad,_bl); if(_upT.lengthSq()>1e-9) _upT.normalize(); else _upT.set(0,1,0); }
    } else if(NS._flyTilt!=null && NS._flyTilt>1e-4){
      NS._flyTilt += (0 - NS._flyTilt)*Math.min(1,dt*0.1);
    }
    if(!NS._up) NS._up=_upT.clone();
    NS._up.lerp(_upT,Math.min(1,dt*0.3));   // ease toward target; super slow-moving
    if(NS._up.lengthSq()>1e-9) NS._up.normalize(); else NS._up.set(0,1,0);
    
    // ── SURFACE GRAVITY ROTATION LOCK ──
    // Rotate the camera around the planet center so we move with the surface
    if (NS._nearPlanet && NS._nearPlanet.mesh && NS._surfMin != null && NS._rNear != null && NS._surfMin < NS._rNear * 2.0) {
      const curRot = NS._nearPlanet.mesh.rotation.y;
      if (NS._nearPlanet._lastRot !== undefined) {
         const deltaRot = curRot - NS._nearPlanet._lastRot;
         const rel = cam.position.clone().sub(NS._nearPlanet.pos);
         rel.applyAxisAngle(new THREE.Vector3(0,1,0), deltaRot);
         cam.position.copy(NS._nearPlanet.pos).add(rel);
         if(c.vel) c.vel.applyAxisAngle(new THREE.Vector3(0,1,0), deltaRot);
         c.yaw -= deltaRot; 
      }
      NS._nearPlanet._lastRot = curRot;
    }
    
    const lUp=NS._up;
    const _ref=Math.abs(lUp.y)<0.985?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);
    const _east=new THREE.Vector3().crossVectors(_ref,lUp).normalize();
    const _north=new THREE.Vector3().crossVectors(lUp,_east).normalize();
    const _horiz=_north.clone().multiplyScalar(Math.cos(c.yaw)).add(_east.clone().multiplyScalar(Math.sin(c.yaw)));
    const fwd=_horiz.clone().multiplyScalar(Math.cos(c.pitch)).add(lUp.clone().multiplyScalar(Math.sin(c.pitch)));
    if(fwd.lengthSq()>1e-9) fwd.normalize(); else fwd.set(cp*cy,sp,cp*sy);
    const right=new THREE.Vector3().crossVectors(fwd,lUp).normalize();
    const up=lUp.clone();
    const K=NS.keys; const acc=new THREE.Vector3();
    let fwdAmt = (K['w']?1:0) - (K['s']?1:0);
    if(NS._autopilot) fwdAmt = Math.max(fwdAmt, 1.0); // Autopilot forces forward thrust
    const latAmt = (K['d']?0.1:0) - (K['a']?0.1:0); // Lateral inertia: much weaker force
    const upAmt = (K['e']||K[' ']?0.1:0) - (K['q']||K['shift']?0.1:0);
    
    if(fwdAmt!==0) acc.addScaledVector(fwd, fwdAmt);
    if(latAmt!==0) acc.addScaledVector(right, latAmt);
    if(upAmt!==0) acc.addScaledVector(up, upAmt);
    let topSpeed=nsThrottleSpeed();
    // ── PROXIMITY DECELERATION (sell the scale) ── the closer the camera gets to
    //    a big body's SURFACE, the lower the effective top speed. Ramps smoothly
    //    from full speed (far) down to a few-percent floor right at the surface.
    {
      let surfMin=Infinity, rNear=1;
      for(let i=0;i<NS.nodes.length;i++){
        const nn=NS.nodes[i]; if(!nn||!nn.pos) continue;
        if(!(nn.kind==='core'||nn.kind==='bot'||nn.kind==='engine')) continue;
        const r=nn.r||1, surf=cam.position.distanceTo(nn.pos)-r;
        if(surf<surfMin){ surfMin=surf; rNear=r; }
      }
      NS._surfMin=surfMin; NS._rNear=rNear;
      // ABSOLUTE APPROACH-SPEED CAP: tie real world-speed to distance-from-surface so you
      // genuinely SLOW into a body (km-crawl right at the surface) instead of blowing through
      // at cosmic speed. Far away = full throttle cruise; the proportional band eases you down.
      const cruise=nsThrottleSpeed();
      let cap=cruise;
      if(surfMin<Infinity){
        // Gravity zone slowdown: extend the braking distance significantly
        const startBrakeDist = 45000000;
        const hardStopDist   = 12000000;
        let slow = cruise;
        if (surfMin < startBrakeDist) {
          // Ramp down from cruise to a slow atmospheric speed
          const t = Math.max(0, surfMin) / startBrakeDist;
          // Floor the speed at 0.5% of cruise so you can still fall towards the surface
          slow = Math.max(cruise * 0.005, cruise * t * t); 
        }
        cap = Math.min(cruise, slow);
      }
      
      // Autopilot Aim Assist: gently align vector toward the nearest planet if roughly aimed at it
      if ((NS._autopilot || isFwdThrust) && rNear > 1 && surfMin < 80000000) {
         let nearestPlanet = null;
         let minDist = Infinity;
         for(let i=0;i<NS.nodes.length;i++){
           const nn=NS.nodes[i]; if(!nn||!nn.pos) continue;
           if(!(nn.kind==='core'||nn.kind==='bot'||nn.kind==='engine')) continue;
           const dist = cam.position.distanceTo(nn.pos);
           if (dist < minDist) { minDist = dist; nearestPlanet = nn; }
         }
         if (nearestPlanet) {
            const toPlanet = nearestPlanet.pos.clone().sub(cam.position).normalize();
            // Only assist if we are already pointing roughly towards it (within ~25 degrees)
            if (fwd.dot(toPlanet) > 0.9) {
               // Nudge yaw and pitch towards the planet
               const currentLook = cam.position.clone().add(fwd);
               const targetLook = cam.position.clone().add(toPlanet);
               // Simple trick: we let the physics naturally pull the velocity vector
               acc.addScaledVector(toPlanet, 0.5); 
            }
         }
      }
      NS._absCap = NS._absCap==null ? cap : (NS._absCap + (cap-NS._absCap)*Math.min(1,dt*4));
    }
    const moving=acc.lengthSq()>0;
    // ANALOG throttle from the gamepad stick magnitude (0..1): a light push = low cruise,
    // full push = full speed. Keyboard / idle stick / no pad = full (1).
    const analog=(NS._gpMag!=null && NS._gpMag>0) ? Math.max(0.08, NS._gpMag) : 1;
    if(moving){
      const cur=c.vel.length(), ramp=0.4+0.6*Math.min(1,cur/Math.max(1,topSpeed));
      // EXPONENTIAL ACCELERATION: accel scales with current speed so you ramp up
      // exponentially — crawl near surfaces, warp-speed in open space within seconds.
      const speedBoost = 1.0 + Math.min(50.0, cur / (NS_FLY_ACCEL * 0.5));
      const thrAccel=NS_FLY_ACCEL*(0.25+1.5*NS.throttle*NS.throttle) * speedBoost;
      if (acc.lengthSq() > 1.0) acc.normalize();
      acc.multiplyScalar(thrAccel*ramp*dt*analog);
      c.vel.add(acc);
    }
    const damp=Math.exp(-NS_FLY_DAMP*dt); c.vel.multiplyScalar(damp);
    // top speed = throttle × proximity × analog-stick → a partial push tops out slower
    const effTop = Math.min(NS._absCap!=null?NS._absCap:topSpeed, moving ? topSpeed*analog : topSpeed);
    if(c.vel.length()>effTop) c.vel.setLength(effTop);
    cam.position.addScaledVector(c.vel, dt);
    // ── COLLISION: never pass through a surface — stop at it and kill the inward velocity. ──
    for(let ci=0;ci<NS.nodes.length;ci++){ const cn=NS.nodes[ci]; if(!cn||!cn.pos) continue;
      if(!(cn.kind==='core'||cn.kind==='bot'||cn.kind==='engine')) continue;
      const rel=cam.position.clone().sub(cn.pos), cd=rel.length(); if(cd<=1e-6) continue;
      const dir=rel.multiplyScalar(1/cd);
      let minD=(cn.r||1)*1.001;
      if(cn._terrAmp){ var _sp=(cn.mesh?cn.mesh.rotation.y:0),_cs=Math.cos(-_sp),_sn=Math.sin(-_sp),_rx=dir.x*_cs-dir.z*_sn,_rz=dir.x*_sn+dir.z*_cs; const lh=nsTerrainHeightJS(_rx,dir.y,_rz,cn._terrSharp,cn._terrSea)*cn._terrAmp;
        minD=(cn.r||1)*1.0 + lh + NS_SCALE*0.5; }
      if(cd<minD){ cam.position.copy(cn.pos).addScaledVector(dir, minD);
        const vn=c.vel.dot(dir); if(vn<0) c.vel.addScaledVector(dir, -vn); }
    }
    // Stash fly vectors for the 3rd-person pre-render (before fwd is mutated)
    NS._flyFwd=fwd.clone(); NS._flyUp=up.clone();
    if(!NS._thirdPerson){
      // ── 1ST PERSON: the camera IS the cockpit — no chase ship, no pull-back. ──
      if(NS._playerShip) NS._playerShip.visible=false;
      NS._chasePos=null;
    }
    c.target.copy(cam.position).add(fwd.multiplyScalar(120*NS_SCALE));
    cam.up.copy(up);
    cam.lookAt(c.target);
    // ── GRAVITY WELL ── nearby bodies TUG the camera. You keep full free-flight at
    //    all times (no mode switch); you just feel the pull — thrust out to climb away,
    //    or coast tangentially and the pull curves your path into a natural orbit. Pull
    //    rises ~inverse-square close in (mass scales with radius), fades by ~30 radii.
    {
      let gb=null, gd=Infinity, grn=1;
      for(let i=0;i<NS.nodes.length;i++){ const nn=NS.nodes[i]; if(!nn||!nn.pos) continue;
        if(!(nn.kind==='core'||nn.kind==='bot'||nn.kind==='engine')) continue;
        const d=cam.position.distanceTo(nn.pos); if(d<gd){ gd=d; gb=nn; grn=nn.r||1; } }
      if(gb && gd < grn*7){
        if(gb._g==null){ gb._g=(typeof nsPlanetDNA==='function' && nsPlanetDNA(gb).gravity) || 1.0; }   // per-planet G from Planet DNA
        const toB=gb.pos.clone().sub(cam.position); const dist=Math.max(grn*0.8, toB.length()); toB.normalize();
        const k=Math.min(0.20,(grn*grn)/(dist*dist));        // capped so gravity NEVER dominates your thrust
        const pull=25.0 * k; // GRAVITY ENABLED — gently curves flight paths towards the planet
        c.vel.addScaledVector(toB, pull*dt);                // gravity adds to velocity; thrust still rules
        NS._gravePull=k*gb._g;
      } else NS._gravePull=0;
    }
  } else if(c.mode==='walk'){
    // ── ON-FOOT (1st person) ── glued to the planet surface. Ship hidden.
    if(NS._playerShip) NS._playerShip.visible=false;
    NS._shipPos=null; NS._chasePos=null;
    const planet=NS._walkPlanet||NS._nearPlanet;
    if(!planet || !planet.pos){ c.mode='fly'; }
    else {
      const center=planet.pos, rr=planet.r||1;
      let radv=cam.position.clone().sub(center); let radlen=radv.length(); if(radlen<1e-6){radv.set(0,1,0);radlen=1;}
      const lUp=radv.clone().multiplyScalar(1/radlen);
      const ref=Math.abs(lUp.y)<0.985?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);
      const east=new THREE.Vector3().crossVectors(ref,lUp).normalize();
      const north=new THREE.Vector3().crossVectors(lUp,east).normalize();
      const horiz=north.clone().multiplyScalar(Math.cos(c.yaw)).add(east.clone().multiplyScalar(Math.sin(c.yaw)));
      const fwd=horiz.clone().multiplyScalar(Math.cos(c.pitch)).add(lUp.clone().multiplyScalar(Math.sin(c.pitch)));
      if(fwd.lengthSq()<1e-9) fwd.copy(north); else fwd.normalize();
      const right=new THREE.Vector3().crossVectors(fwd,lUp).normalize();
      const fwdTan=new THREE.Vector3().crossVectors(lUp,right).normalize();
      const K=NS.keys; const wv=new THREE.Vector3();
      if(K['w']) wv.add(fwdTan); if(K['s']) wv.addScaledVector(fwdTan,-1);
      if(K['d']) wv.add(right); if(K['a']) wv.addScaledVector(right,-1);
      const run=(K['shift']?2.6:1);
      if(wv.lengthSq()>0) wv.normalize().multiplyScalar(NS_SCALE*8*run*dt);
      if(planet._isGas){   // GAS WIND: gentle, capped, seeded gust nudges you along the surface
        if(planet._wind==null){ var _ws0=nsSeededRng(nsHashStr((planet.name||planet.id||'gas')+':wind')); planet._wind={ a:_ws0()*6.283, s:0.05+_ws0()*0.10, p:_ws0()*6.283 }; }
        var _wq=planet._wind, _wt=(performance.now()*0.001);
        var _wang=_wq.a+Math.sin(_wt*_wq.s+_wq.p)*0.9, _gust=(0.55+0.45*Math.sin(_wt*_wq.s*0.6+_wq.p*1.7));
        var _wdir=east.clone().multiplyScalar(Math.cos(_wang)).add(north.clone().multiplyScalar(Math.sin(_wang)));
        wv.addScaledVector(_wdir, NS_SCALE*22*_gust*dt);
      }
      cam.position.add(wv);
      let nr=cam.position.clone().sub(center); let nl=nr.length(); if(nl<1e-6){nr.copy(lUp);nl=1;} nr.multiplyScalar(1/nl);
      // Ground height: terrain sphere base + noise displacement + eye offset
      // Ground height via RAYCAST of the VISIBLE terrain mesh -> collision == exactly what you SEE
      // (continuous noise diverges from the coarse faceted mesh on a huge sphere -> the clipping). Falls
      // back to the noise function if the mesh isn't ready (mid-bake / base sphere). Universal: all planets.
      let gh=rr*1.005, _ghHit=false;
      // Raycast against highest-detail visible mesh: patch → terrain → base sphere
      var _rayTargets=[];
      if(planet._descent){
        var _pat=planet._descent.patch, _ter=planet._descent.terrain;
        if(_pat && _pat.visible) _rayTargets.push({m:_pat, off:0});
        if(_ter && _ter.visible) _rayTargets.push({m:_ter, off:0});
      }
      if(planet.mesh && planet.mesh.visible) _rayTargets.push({m:planet.mesh, off:rr*0.005}); // base sphere starts at r, not r*1.005
      if(_rayTargets.length){
        if(!NS._walkRay) NS._walkRay=new THREE.Raycaster();
        var _rayH=rr*1.1; // well above any peak (max ≈ r*1.062 with displacement map)
        NS._walkRay.set(center.clone().addScaledVector(nr, _rayH), nr.clone().negate());
        NS._walkRay.far=_rayH;
        for(var _ti=0;_ti<_rayTargets.length;_ti++){
          _rayTargets[_ti].m.updateMatrixWorld(true);
          var _hh=NS._walkRay.intersectObject(_rayTargets[_ti].m, false);
          if(_hh && _hh.length){
            gh=_hh[0].point.distanceTo(center)+_rayTargets[_ti].off;
            _ghHit=true; break;
          }
        }
      }
      // Fallback formula: same nsTerrainHeightJS the CPU bake uses (single source of truth)
      if(!_ghHit && typeof nsTerrainHeightJS==='function'){
        var _wp=(planet.mesh?planet.mesh.rotation.y:0),_wc=Math.cos(-_wp),_ws=Math.sin(-_wp);
        var _nx=nr.x*_wc-nr.z*_ws,_nz=nr.x*_ws+nr.z*_wc;
        gh+=nsTerrainHeightJS(_nx,nr.y,_nz,planet._terrSharp,planet._terrSea)*(planet._terrAmp||0);
      }
      // Debug: gated by NS._walkDebug — set via console: NS._walkDebug=true
      if(NS._walkDebug){
        var _fh=rr*1.005; if(typeof nsTerrainHeightJS==='function'){var _dwp=(planet.mesh?planet.mesh.rotation.y:0),_dwc=Math.cos(-_dwp),_dws=Math.sin(-_dwp); _fh+=nsTerrainHeightJS(nr.x*_dwc-nr.z*_dws,nr.y,nr.x*_dws+nr.z*_dwc,planet._terrSharp,planet._terrSea)*(planet._terrAmp||0);}
        console.log('[WALK DBG] rayHit='+_ghHit+' gh='+gh.toFixed(1)+' formula='+_fh.toFixed(1)+' camR='+nl.toFixed(1)+' delta='+(gh-_fh).toFixed(2)+' targets='+_rayTargets.length);
      }
      const _moving=wv.lengthSq()>0; NS._walkT=(NS._walkT||0)+(_moving?dt*7:0);
      const eyeH=NS_SCALE*4.5;   // eye height above terrain (~128 units, about human scale relative to the planet)
      const standR=gh+eyeH + (_moving?Math.abs(Math.sin(NS._walkT))*NS_SCALE*0.5:0);   // head-bob while walking
      if(NS._jumpV==null) NS._jumpV=0;
      const grounded = nl<=standR+1.0 && NS._jumpV<=0;
      if((K['e']||K[' ']) && grounded) NS._jumpV=NS_SCALE*22;
      let curR;
      if(NS._jumpV!==0){ NS._jumpV-=NS_SCALE*45*dt; curR=nl+NS._jumpV*dt; if(curR<=standR){curR=standR; NS._jumpV=0;} }
      else curR=Math.max(standR, nl-(nl-standR)*Math.min(1,dt*8));   // smoothly pull down to ground if above
      cam.position.copy(center).addScaledVector(nr, curR);
      // Look-at: slightly above horizontal so you see the horizon, not your feet
      c.target.copy(cam.position).add(fwd.multiplyScalar(200*NS_SCALE)).addScaledVector(lUp, NS_SCALE*2);
      cam.up.copy(lUp); cam.lookAt(c.target);
    }
  } else {
    // ── orbit (tweened) ── ship hidden in orbit view
    if(NS._playerShip) NS._playerShip.visible=false;
    NS._shipPos=null; NS._chasePos=null;
    const k=Math.min(1, dt*3.0);
    c.radius += (c.tRadius-c.radius)*k;
    if(!NS._userTook && !NS.flyTo && !NS.followNid && !(NS._nearPlanet && NS.camera && NS.camera.position.distanceTo(NS._nearPlanet.pos) < (NS._nearPlanet.r||1)*6)){ const _d=dt*0.005; c.theta+=_d; c.tTheta+=_d; }   // gentle real orbit at spawn (NOT near a surface)
    c.theta  += (c.tTheta -c.theta )*k;
    c.phi    += (c.tPhi   -c.phi   )*k;
    c.target.x += (c.tTargetX-c.target.x)*k;
    c.target.y += (c.tTargetY-c.target.y)*k;
    c.target.z += (c.tTargetZ-c.target.z)*k;
    const ph=Math.max(0.18, Math.min(Math.PI-0.18, c.phi));
    const x=c.target.x + c.radius*Math.sin(ph)*Math.cos(c.theta);
    const y=c.target.y + c.radius*Math.cos(ph);
    const z=c.target.z + c.radius*Math.sin(ph)*Math.sin(c.theta);
    cam.position.set(x,y,z); cam.up.set(0,1,0); cam.lookAt(c.target);
  }

  // ── speed tracking (drives star-streak + FOV illusion) ──
  const moved = cam.position.distanceTo(prevPos);
  let instSpeed = dt>0 ? moved/dt : 0;
  // TELEPORT GUARD: spawn placement + floating-origin recenters jump the camera a huge distance in ONE
  // frame; don't let that fake-spike the speed (it fired the warp-streak "flying backwards" on spawn).
  if(instSpeed > NS_FLY_MAX*4) instSpeed = c.speed;
  c.speed += (instSpeed - c.speed) * Math.min(1, dt*6);   // smoothed

  // WARP FOV DISTORTION & CAMERA SHAKE
  const warpRatio = Math.min(1.0, Math.max(0.0, c.speed / (NS_FLY_MAX * 0.5)));
  const targetFov = NS.baseFov + warpRatio * 65.0; // stretches from 55 up to 120
  if(Math.abs(cam.fov - targetFov) > 0.1) {
    cam.fov += (targetFov - cam.fov) * Math.min(1, dt*4.0);
    cam.updateProjectionMatrix();
  }
  
  if (warpRatio > 0.5 && c.mode === 'fly') {
    const shake = (warpRatio - 0.5) * 2.0;
    cam.rotateZ((Math.random() - 0.5) * 0.08 * shake);
    cam.rotateX((Math.random() - 0.5) * 0.04 * shake);
  }
}
function nsEaseInOutCubic(t){ return t<0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2; }

// ── POSITION READOUT (HUD) ── live camera x/y/z + sector + distance-from-core.
// Throttled (every ~0.15s) so it doesn't thrash the DOM each frame.
function nsUpdatePositionHud(){
  const cam=NS.camera; if(!cam) return;
  const p=(NS._origin?cam.position.clone().add(NS._origin):cam.position), U=NS_SCALE;
  const posEl=$('kv-pos');
  if(posEl) posEl.textContent=`${Math.round(p.x/U)} · ${Math.round(p.y/U)} · ${Math.round(p.z/U)}`;
  const distU=p.length();
  // distance-from-core as a vast "ly" figure (mapped through NS_LY_PER_UNIT so it
  // reflects the new 100k–500k LY scale, not raw world units)
  const ly=nsUnitsToLy(distU).toFixed(0);
  // sector label: which octant / how far out (CORE if inside the AI cluster)
  const clusterR=(NS._aiClusterR||200*U*NS_SPREAD)*1.3;
  let sector;
  if(distU<clusterR) sector='CLUSTER';
  else { const sx=p.x>=0?'E':'W', sy=p.y>=0?'U':'D', sz=p.z>=0?'N':'S'; sector=`${sx}${sy}${sz}`; }
  const secEl=$('kv-sector'); if(secEl) secEl.textContent=`${sector} · ${Number(ly).toLocaleString()} ly`;
}

// ── THROTTLE HUD ── reflect NS.throttle (0..1) on the bottom-centre bar.
function nsUpdateThrottleHud(){
  const fill=$('kv-th-fill'), val=$('kv-th-val');
  const pct=Math.round((NS.throttleT!=null?NS.throttleT:NS.throttle)*100);
  if(fill) fill.style.width=pct+'%';
  if(val)  val.textContent=pct+'%';
}

// ── COMPASS → CORE + off-screen edge marker ── always show the owner the way
// home. The compass arrow rotates to point toward the core in SCREEN space; the
// distance text updates; and when the core is off-screen a chevron is pinned to
// the viewport edge in its direction. Re-orients a "lost in space" owner.
function nsUpdateCompass(){
  const cam=NS.camera; if(!cam) return;
  const core=NS.nodeById['core']; const corePos=core&&core.pos?core.pos:new THREE.Vector3(0,0,0);
  const wrap=$('ns-wrap'); if(!wrap) return; const rect=wrap.getBoundingClientRect();
  const W=rect.width, H=rect.height;
  // project core to screen (NDC → pixels)
  const v=corePos.clone().project(cam);
  const onScreen = v.z<1 && v.x>=-1 && v.x<=1 && v.y>=-1 && v.y<=1;
  const sx=(v.x*0.5+0.5)*W, sy=(-v.y*0.5+0.5)*H;
  // distance label
  const dist=nsUnitsToLy(cam.position.distanceTo(corePos));
  const dEl=$('kv-cmp-dist'); if(dEl) dEl.textContent=Math.round(dist).toLocaleString()+' ly';
  // compass arrow: angle from screen-centre toward the core's screen position
  // (if behind us, flip so the arrow points the short way around).
  let ang;
  if(v.z<1){ ang=Math.atan2(sy-H/2, sx-W/2); }
  else { ang=Math.atan2(-(sy-H/2), -(sx-W/2)); }   // behind camera → invert
  const arrow=$('kv-cmp-arrow'); if(arrow) arrow.style.transform=`rotate(${ang+Math.PI/2}rad)`;
  // off-screen edge marker
  const mk=$('kv-coremark');
  if(mk){
    if(onScreen || (v.z<1 && Math.abs(v.x)<0.96 && Math.abs(v.y)<0.96)){
      mk.classList.remove('show');
    } else {
      mk.classList.add('show');
      // clamp the core direction to the viewport border
      let dirX=sx-W/2, dirY=sy-H/2;
      if(v.z>=1){ dirX=-dirX; dirY=-dirY; }              // behind → opposite edge
      const a=Math.atan2(dirY, dirX);
      const pad=22, hw=W/2-pad, hh=H/2-pad;
      let ex,ey; const tx=Math.abs(hw/Math.cos(a)), ty=Math.abs(hh/Math.sin(a));
      const tt=Math.min(tx,ty); ex=W/2+Math.cos(a)*tt; ey=H/2+Math.sin(a)*tt;
      mk.style.left=ex+'px'; mk.style.top=ey+'px';
      mk.style.transform=`rotate(${a+Math.PI/2}rad)`;
    }
  }
}

// ── PROXIMITY INFO (Universe-Sandbox style) ── when the camera gets near a body
// the floating vitals panel fades in anchored to that body; fades out when far.
// Distance-driven, NOT a bottom bar. Click/fly still force it open via focusNid.
function nsUpdateProximity(){
  const cam=NS.camera; if(!cam) return;
  // nearest AI node (these carry full vitals)
  let best=null, bestD=Infinity;
  for(const n of NS.nodes){
    if(!n.pos) continue;
    const d=cam.position.distanceTo(n.pos);
    if(d<bestD){ bestD=d; best=n; }
  }
  // approach radius scales with body size + a vast flat term (rides NS_SPREAD) so
  // proximity panels still trigger now that bodies are tiny specks in a huge volume.
  const near = best ? (best.r*(best.kind==='core'?60:40) + 220*NS_SCALE*NS_SPREAD) : 0;
  // ── PROXIMITY GLOW (owner #3: "a glow of them when i get close enough") ──
  // As the camera nears a body, BRIGHTEN its emissive + swell/brighten its halo so
  // it's obviously highlighted; fade the effect in/out smoothly by distance. Same
  // proximity radius as the info-panel logic. No per-frame allocation (numeric only).
  // We track the previously-glowing node so we can damp it back when we move away.
  nsApplyProximityGlow(best, bestD, near);
  const panel=$('ns-edge-panel');
  if(!panel) return;
  // if user explicitly clicked/flew to a node, that panel stays (focusNid)
  if(NS.focusNid){ return; }
  if(best && bestD<near){
    if(NS._proxNid!==best.id){ NS._proxNid=best.id; }   // owner: proximity no longer auto-opens the panel (click a body to open)
    // fade by distance (closer = more opaque)
    const o=Math.max(0.25, Math.min(1, 1-(bestD/near)));
    panel.style.opacity=o.toFixed(2);
  } else if(NS._proxNid){
    NS._proxNid=null; panel.classList.remove('open'); panel.style.opacity='';
  }
}
// Brighten the nearest body (emissive + halo) by proximity. Restores the prior
// body when the nearest changes. Pure numeric work — no allocation per frame.
function nsApplyProximityGlow(best, bestD, near){
  // gradually relax a previously-glowing body that's no longer nearest/near
  const prev = NS._glowNode;
  const isGlowing = best && near>0 && bestD < near;
  if(prev && (!isGlowing || prev!==best)){
    nsSetBodyGlow(prev, 0);
    NS._glowNode = null;
  }
  if(!isGlowing || !best.mesh){ return; }
  // 0..1 glow strength: ramps up over the approach, then RAMPS BACK DOWN as you
  // reach the surface so the discovery-highlight can't neon-ball the close-up
  // world (the sun light + fresnel atmosphere take over there). Peak ~mid-approach.
  let k = Math.max(0, Math.min(1, (1 - bestD/near) / 0.7));
  const surf = (best.r||1)*5.0;                       // inside here = "at the world"
  if(bestD < surf){ k *= Math.max(0, bestD/surf); }   // fade glow out toward 0 at surface
  nsSetBodyGlow(best, k);
  NS._glowNode = best;
}
function nsSetBodyGlow(n, k){
  if(!n||!n.mesh) return;
  const mat=n.mesh.material;
  const isStar=(n.kind==='core'||n.kind==='engine');
  // When k≈0 (at the surface, or fully relaxed) DON'T touch emissive/halo — let
  // nsUpdateBodyLOD's low self-light + sun shading own the close-up look. We only
  // ADD the approach highlight while k is meaningful.
  if(k>0.002){
    if(mat && mat.emissive && !isStar){
      // ADD relative to whatever LOD set this frame (LOD runs before us), capped so
      // it's a gentle highlight, never a neon ball.
      mat.emissiveIntensity = (mat.emissiveIntensity||0) + k*0.15;
    }
    if(n.halo && n.halo.material){
      if(n._haloBaseS==null) n._haloBaseS = n.halo.scale.x;
      n.halo.material.opacity = Math.min(0.25, k*0.25);
      const s = n._haloBaseS * (1 + k*0.6);
      n.halo.scale.set(s, s, 1);
    }
  } else if(n.halo && n._haloBaseS!=null){
    n.halo.scale.set(n._haloBaseS, n._haloBaseS, 1);   // restore halo size at rest
  }
}

// ── AREA MAP / RADAR (owner #2: "i need that area map showing them") ────────
// A top-down radar in the corner: camera at centre, a wedge showing the look
// direction, dots for nearby bodies (bots/core/engine/providers/channels/worlds)
// colour-coded by type. Range auto-scales so something is always visible. Cheap:
// a single 2D-canvas redraw throttled to ~6fps; we cache the on-screen dot rects
// (NS._radarDots) so a click can map straight back to a node → fly-to.
const NS_RADAR_COLORS={ core:'#22d9e6', engine:'#22d9e6', bot:'#7c3aed', provider:'#ffd27a', channels:'#5865F2', world:'#9aa7bd', ship:'#fff2a8' };
function nsUpdateRadar(){
  var _rdrEl=$('kv-radar'); if(_rdrEl && _rdrEl.style.display!=='none') _rdrEl.style.display='none'; return;   // owner: minimap removed
  const cv=$('kv-radar-cv'); if(!cv) return; const cam=NS.camera; if(!cam) return;
  const ctx=cv.getContext('2d'); if(!ctx) return;
  const W=cv.width, H=cv.height, cx=W/2, cy=H/2, R=Math.min(cx,cy)-4;
  ctx.clearRect(0,0,W,H);
  // camera yaw so the radar rotates with the view (forward = up on the dial)
  const c=NS.cam, fwd=new THREE.Vector3(); cam.getWorldDirection(fwd);
  const yaw=Math.atan2(fwd.x, fwd.z);   // heading in the XZ plane
  // collect candidate bodies (real nodes + cosmos worlds), measure max planar dist
  const dots=NS._radarList||(NS._radarList=[]); dots.length=0;
  let maxd=1;
  const add=(n)=>{ if(!n||!n.pos) return;
    const dx=n.pos.x-cam.position.x, dz=n.pos.z-cam.position.z;
    const d=Math.hypot(dx,dz); if(d>maxd) maxd=d; dots.push({n,dx,dz,d}); };
  for(const n of NS.nodes) add(n);
  if(NS.cosmosPlanets) for(const p of NS.cosmosPlanets) add(p);
  if(NS.ships) for(const s of NS.ships) add(s);   // AI spaceships on the map too
  // range = a touch beyond the nearest cluster so dots aren't all on the rim,
  // but cap so distant worlds don't shrink everything to the centre.
  dots.sort((a,b)=>a.d-b.d);
  const shown=dots.slice(0,28);
  const range=Math.max(maxd*0.18, shown.length?shown[Math.min(shown.length-1,15)].d*1.15:maxd);
  $('kv-radar-rng').textContent=nsUnitsToLy(range).toFixed(0)+' ly';
  // rings — brighter so the dial reads clearly against the dark canvas (owner #1)
  ctx.strokeStyle='rgba(150,180,215,0.26)'; ctx.lineWidth=1;
  for(const f of [0.5,1]){ ctx.beginPath(); ctx.arc(cx,cy,R*f,0,Math.PI*2); ctx.stroke(); }
  ctx.strokeStyle='rgba(150,180,215,0.16)';
  ctx.beginPath(); ctx.moveTo(cx,cy-R); ctx.lineTo(cx,cy+R); ctx.moveTo(cx-R,cy); ctx.lineTo(cx+R,cy); ctx.stroke();
  // view wedge (look direction = straight up after we rotate by -yaw)
  ctx.fillStyle='rgba(34,217,230,0.22)';
  ctx.beginPath(); ctx.moveTo(cx,cy);
  ctx.arc(cx,cy,R, -Math.PI/2-0.42, -Math.PI/2+0.42); ctx.closePath(); ctx.fill();
  // map + draw the dots (rotate world XZ by -yaw so forward points up)
  const cosY=Math.cos(-yaw), sinY=Math.sin(-yaw);
  const out=NS._radarDots||(NS._radarDots=[]); out.length=0;
  for(const o of shown){
    const rr=Math.min(1, o.d/range)*R;
    // screen: forward(+z) → up(−y). rotate (dx,dz) by −yaw, then place radially.
    const rx=o.dx*cosY - o.dz*sinY, rz=o.dx*sinY + o.dz*cosY;
    const len=Math.hypot(rx,rz)||1; const px=cx + (rx/len)*rr, py=cy - (rz/len)*rr;
    const col=NS_RADAR_COLORS[o.n.kind]||'#9aa7bd';
    const isCore=o.n.kind==='core'||o.n.kind==='engine';
    const isShip=o.n.kind==='ship';
    // soft glow under every dot so it pops on the dark dial (owner #1: "too dim")
    ctx.shadowColor=col; ctx.shadowBlur=isCore?7:4;
    if(isShip){
      // ships render as a small diamond (a craft, not a world)
      ctx.fillStyle=col; ctx.globalAlpha=1;
      ctx.beginPath(); ctx.moveTo(px,py-3.4); ctx.lineTo(px+3,py); ctx.lineTo(px,py+3.4); ctx.lineTo(px-3,py); ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(px,py,isCore?4.2:3,0,Math.PI*2);
      ctx.fillStyle=col; ctx.globalAlpha=1; ctx.fill();
    }
    ctx.shadowBlur=0; ctx.globalAlpha=1;
    if(isCore){ ctx.strokeStyle=col; ctx.lineWidth=1.2; ctx.beginPath(); ctx.arc(px,py,6.5,0,Math.PI*2); ctx.stroke(); }
    out.push({x:px,y:py,id:o.n.id,r:isCore?7:5});
  }
  // centre = camera (bright crosshair)
  ctx.fillStyle='#fff'; ctx.shadowColor='#9fe9ff'; ctx.shadowBlur=4;
  ctx.beginPath(); ctx.arc(cx,cy,2.4,0,Math.PI*2); ctx.fill(); ctx.shadowBlur=0;
}
// click a radar dot → fly to that body (owner #2: "make dots clickable")
function nsRadarClick(ev){
  const cv=$('kv-radar-cv'), dots=NS._radarDots; if(!cv||!dots) return;
  const r=cv.getBoundingClientRect();
  const px=(ev.clientX-r.left)*(cv.width/r.width), py=(ev.clientY-r.top)*(cv.height/r.height);
  let best=null, bd=Infinity;
  for(const d of dots){ const dist=Math.hypot(px-d.x,py-d.y); if(dist<=Math.max(d.r,8) && dist<bd){ bd=dist; best=d; } }
  // radar dot → set GPS target + open panel (NO fast-travel; fly there yourself)
  if(best){ NS.gpsTarget=best.id; if(typeof nsOpenNodePanel==='function') nsOpenNodePanel(best.id); }
}
// ── SPEED ILLUSION: motion-proportional star streaks + subtle FOV widen ────
// The warp field is a cube of points anchored AROUND the camera. Each star's
// far vertex is dragged backwards along the camera's travel direction by an
// amount proportional to speed → streaks. Stars that drift outside the cube
// wrap to the other side so the field is effectively infinite. Cheap: one
// LineSegments draw call, fixed geometry, only buffer writes.
function nsUpdateWarp(dt){
  const t3=NS.three; if(!t3||!t3.warp) return;
  const cam=NS.camera, c=NS.cam, box=NS.warpBox, WN=NS.warpCount;
  const pos=t3.warpGeo.attributes.position.array, base=t3.warpBase;
  // travel direction = velocity (fly) or position delta during fly-to
  let dir=NS._warpDir||(NS._warpDir=new THREE.Vector3());
  if(NS._prevCamPos){ dir.copy(cam.position).sub(NS._prevCamPos); }
  if(dir.lengthSq()<1e-8) dir.set(0,0,-1); else dir.normalize();
  // speed → 0..1 intensity. Threshold RAISED + curve softened so slow looks
  // don't smear; only sustained fast travel shows faint short streaks.
  const sp=c.speed, maxv=NS_FLY_MAX;
  const intensity=Math.min(1, Math.max(0, (sp/maxv - 0.30))/0.55);
  if(intensity<=0.001 && cam && Math.abs(cam.fov-(NS.baseFov||55))<0.02){ if(NS.three&&NS.three.warp&&NS.three.warp.material) NS.three.warp.material.opacity=0; return; }   // PERF: not warping -> bail
  const streak=intensity*box*0.18;                // MUCH shorter streaks (was *0.9)
  const camp=cam.position;
  for(let i=0;i<WN;i++){
    // anchor the star relative to the camera and wrap it into the local cube
    let bx=base[i*3], by=base[i*3+1], bz=base[i*3+2];
    let wx=camp.x+bx, wy=camp.y+by, wz=camp.z+bz;
    // wrap base coords so the field follows the camera (toroidal cube)
    base[i*3]   = ((bx+box)%(2*box)+(2*box))%(2*box)-box;
    base[i*3+1] = ((by+box)%(2*box)+(2*box))%(2*box)-box;
    base[i*3+2] = ((bz+box)%(2*box)+(2*box))%(2*box)-box;
    bx=base[i*3]; by=base[i*3+1]; bz=base[i*3+2];
    wx=camp.x+bx; wy=camp.y+by; wz=camp.z+bz;
    // head vertex at the star, tail vertex dragged opposite travel dir
    pos[i*6]=wx; pos[i*6+1]=wy; pos[i*6+2]=wz;
    pos[i*6+3]=wx-dir.x*streak; pos[i*6+4]=wy-dir.y*streak; pos[i*6+5]=wz-dir.z*streak;
  }
  t3.warpGeo.attributes.position.needsUpdate=true;
  t3.warp.material.opacity = intensity*0.35;       // fainter streaks (was 0.85)
  // very subtle FOV widen only at peak speed (was +10°, now +4°)
  const targetFov = NS.baseFov + intensity*4;
  cam.fov += (targetFov - cam.fov)*Math.min(1, dt*3);
  cam.updateProjectionMatrix();
}
// ── DIRECTIONAL MARKERS ── on-screen name+distance label for every "place"
// (CORE + each AI planet); when it's off the screen, an arrow pins to the
// viewport edge pointing toward it. All clickable → fly there. This is how the
// owner finds Leo (or anyone) from anywhere; CORE is just one marker in the set.
// Cheap DOM overlay, one reused element per body.
function nsPaintMarkers(){
  if((NS._mkFrame=(NS._mkFrame||0)+1)%3) return;   // PERF: throttle to every 3rd frame
  if(typeof THREE==='undefined' || !NS.camera || !NS.nodes) return;
  const cam=NS.camera, wrap=$('ns-wrap'); if(!wrap) return;
  let layer=$('kv-markers');
  if(!layer){
    layer=document.createElement('div'); layer.id='kv-markers';
    layer.style.cssText='position:absolute;left:0;top:0;right:0;bottom:0;z-index:7;pointer-events:none;overflow:hidden;';
    wrap.appendChild(layer);
    // force the area-map to a visible layer from JS (no-cached) so it doesn't depend on stale oracle.html CSS
    var rdr=document.getElementById('kv-radar'); if(rdr){ rdr.style.zIndex='30'; rdr.style.right='24px'; rdr.style.bottom='170px'; rdr.style.opacity='0.92'; }
  }
  const rect=wrap.getBoundingClientRect(), W=rect.width, H=rect.height;
  if(!NS._mkEls) NS._mkEls={};
  NS._inOrbitOf = null; // reset every frame
  const seen={}, v=new THREE.Vector3();
  for(let i=0;i<NS.nodes.length;i++){
    const n=NS.nodes[i]; if(!n || !n.pos) continue;
    if(!(n.kind==='core'||n.kind==='bot'||n.kind==='engine'||n.kind==='channels')) continue;
    seen[n.id]=1;
    let el=NS._mkEls[n.id];
    if(!el){
      el=document.createElement('div'); el.className='kv-mk';
      el.style.cssText='position:absolute;pointer-events:auto;cursor:pointer;transform:translate(-50%,-50%);'
        +'font-family:var(--mono,monospace);font-size:10px;white-space:nowrap;padding:2px 7px;border-radius:9px;'
        +'background:rgba(6,12,20,0.5);border:1px solid rgba(120,160,200,0.3);display:flex;align-items:center;gap:5px;'
        +'user-select:none;';
      el._ic=document.createElement('span'); el._nm=document.createElement('b'); el._ds=document.createElement('span');
      el._ds.style.color='#9fb4c8'; el.appendChild(el._ic); el.appendChild(el._nm); el.appendChild(el._ds);
      el._mode=''; el._col=''; el._nmTxt=''; el._dsTxt='';
      (function(id){
        el.addEventListener('pointerdown',function(ev){ ev.stopPropagation(); });
        el.addEventListener('click',function(ev){ ev.stopPropagation(); NS.gpsTarget=id; if(typeof nsOpenNodePanel==='function') nsOpenNodePanel(id); });
      })(n.id);
      layer.appendChild(el); NS._mkEls[n.id]=el;
    }
    const col=n.color||'#bfe3ff';
    const nm=(n.kind==='core')?'CORE':(n.name||n.id||'');
    const dly=Math.round(nsUnitsToLy(cam.position.distanceTo(n.pos)));
    // emphasize the GPS target marker (brighter border + glow) so it's easy to track
    const isGps=(NS.gpsTarget===n.id);
    if(el._gps!==isGps){ el._gps=isGps;
      el.style.border=isGps?('1px solid '+col):'1px solid rgba(120,160,200,0.3)';
      el.style.boxShadow=isGps?('0 0 10px '+col):'none';
      el.style.background=isGps?'rgba(10,18,28,0.8)':'rgba(6,12,20,0.5)';
    }
    
    // ORBIT NOTIFICATION CARD LOGIC
    let orbitCard = document.getElementById('kv-orbit-card');
    if (!orbitCard) {
      orbitCard = document.createElement('div');
      orbitCard.id = 'kv-orbit-card';
      orbitCard.style.cssText = 'position:absolute; right:-300px; top:200px; width:260px; background:rgba(6,12,20,0.85); border-left:4px solid #bfe3ff; border-radius:8px; padding:15px; color:#fff; font-family:var(--mono,monospace); font-size:12px; transition:right 0.4s ease, opacity 1.5s ease; opacity:1; z-index:100; box-shadow:0 0 15px rgba(0,0,0,0.5); backdrop-filter:blur(4px); pointer-events:none;';
      wrap.appendChild(orbitCard);
    }
    
    const distToCenter = cam.position.distanceTo(n.pos);
    const inOrbit = (n.r > 0 && distToCenter < n.r * 1.5);
    if (inOrbit && n.kind !== 'core') {
       NS._inOrbitOf = n; // keep track
       el.style.display = 'none'; // hide floating 3D label
       continue;
    }

    v.copy(n.pos).project(cam);
    const behind=v.z>1;
    let sx=(v.x*0.5+0.5)*W, sy=(-v.y*0.5+0.5)*H;
    let onScreen=!behind && v.x>=-1 && v.x<=1 && v.y>=-1 && v.y<=1;
    var _np=NS._nearPlanet;
    if(onScreen && _np && _np.pos && _np!==n && _np.r && nsOccluded(cam.position, n.pos, _np.pos, _np.r)){ el.style.display='none'; continue; }
    el.style.display='flex';
    if(el._nmTxt!==nm){ el._nm.textContent=nm; el._nmTxt=nm; }
    if(el._col!==col){ el._nm.style.color=col; }
      let etaStr = '';
      if (NS.cam && NS.cam.speed > 0) {
        const d = cam.position.distanceTo(n.pos);
        if (d > n.r * 2) {
          const s = d / Math.max(1, NS.cam.speed);
          if (s < 60) etaStr = ' | ETA: ' + Math.round(s) + 's';
          else if (s < 3600) etaStr = ' | ETA: ' + Math.floor(s/60) + 'm ' + Math.round(s%60) + 's';
          else etaStr = ' | ETA: >1h';
        }
      }
      
      if(onScreen){
        if(el._mode!=='on'||el._col!==col){ el._ic.textContent=''; el._ic.style.cssText='width:7px;height:7px;border-radius:50%;background:'+col+';box-shadow:0 0 6px '+col+';'; el._mode='on'; }
        const dt1=nsFmtDist(cam.position.distanceTo(n.pos), n.r) + etaStr; if(el._dsTxt!==dt1){ el._ds.textContent=dt1; el._dsTxt=dt1; }
        el.style.left=Math.max(40,Math.min(W-40,sx))+'px';
        el.style.top=Math.max(16,Math.min(H-16,sy-20))+'px';
        el.style.opacity='0.95';
      } else {
        let dirX=sx-W/2, dirY=sy-H/2; if(behind){ dirX=-dirX; dirY=-dirY; }
        const a=Math.atan2(dirY,dirX), pad=40, hw=W/2-pad, hh=H/2-pad;
        const tx=Math.abs(hw/Math.cos(a)), ty=Math.abs(hh/Math.sin(a)), tt=Math.min(tx,ty);
        const ex=W/2+Math.cos(a)*tt, ey=H/2+Math.sin(a)*tt;
        if(el._mode!=='off'||el._col!==col){ el._ic.textContent='➜'; el._ic.style.cssText='display:inline-block;color:'+col+';font-size:12px;'; el._mode='off'; }
        el._ic.style.transform='rotate('+a+'rad)';
        const dt2=nsFmtDist(cam.position.distanceTo(n.pos), n.r) + etaStr; if(el._dsTxt!==dt2){ el._ds.textContent=dt2; el._dsTxt=dt2; }
      el.style.left=ex+'px'; el.style.top=ey+'px'; el.style.opacity='0.85';
    }
    el._col=col;
  }
  
  // Orbit Notification Card visibility check & Location Title
  let orbitCard = document.getElementById('kv-orbit-card');
  let locTitle = document.getElementById('kv-location-title');
  if (!locTitle && wrap) {
    locTitle = document.createElement('div');
    locTitle.id = 'kv-location-title';
    locTitle.style.cssText = 'position:absolute; top:80px; left:50%; transform:translateX(-50%); text-align:center; transition:opacity 1s ease; opacity:0; z-index:105; pointer-events:none; font-family:var(--mono,monospace); text-shadow:0 2px 10px rgba(0,0,0,0.8);';
    wrap.appendChild(locTitle);
  }

  let currLoc = NS._inOrbitOf ? (NS._inOrbitOf.name || NS._inOrbitOf.id || 'Planet') : 'Deep Space';
  let pColor = NS._inOrbitOf ? (NS._inOrbitOf.color || '#fff') : '#88ccff';
  
  if (locTitle && NS._lastLoc !== currLoc) {
    NS._lastLoc = currLoc;
    let ms = performance.now();
    let day = Math.floor(ms / 60000) + 1;
    let cycle = (ms % 60000 < 30000) ? 'DAY' : 'NIGHT';
    if (!NS._inOrbitOf) cycle = 'TRANSIT';
    
    locTitle.innerHTML = `<h1 style="margin:0; font-size:36px; font-weight:300; letter-spacing:4px; color:${pColor}; text-transform:uppercase;">${currLoc}</h1>` + 
                         `<div style="font-size:14px; color:#aaa; margin-top:4px; letter-spacing:2px; text-transform:uppercase;">DAY ${day} &nbsp;|&nbsp; ${cycle} CYCLE</div>`;
                         
    locTitle.style.opacity = '1';
    if(locTitle._timeout) clearTimeout(locTitle._timeout);
    locTitle._timeout = setTimeout(() => { locTitle.style.opacity = '0'; }, 4000);
  }

  if (orbitCard) {
    if (NS._inOrbitOf) {
      if (orbitCard._nid !== NS._inOrbitOf.id) {
        orbitCard._nid = NS._inOrbitOf.id;
        let gravity = (9.8 * (0.8 + Math.random()*0.4)).toFixed(2);
        orbitCard.style.borderLeftColor = pColor;
        orbitCard.innerHTML = `<h4 style="margin:0 0 10px 0;color:${pColor};letter-spacing:1px;text-transform:uppercase;">PLANETARY TELEMETRY</h4>` +
          `<div style="color:#9fb4c8;margin-bottom:5px;">Atmosphere: Analyzed</div>` +
          `<div style="color:#9fb4c8;margin-bottom:5px;">Gravity: ${gravity} m/s²</div>` +
          `<div style="color:#9fb4c8;margin-bottom:5px;">Status: Orbit Established</div>`;
        orbitCard.style.right = '20px';
        orbitCard.style.opacity = '1';
        if(orbitCard._timeout) clearTimeout(orbitCard._timeout);
        orbitCard._timeout = setTimeout(() => { orbitCard.style.opacity = '0'; }, 4000);
      }
    } else {
      if (orbitCard._nid !== 'deep_space') {
        orbitCard._nid = 'deep_space';
        orbitCard.style.borderLeftColor = '#88ccff';
        orbitCard.innerHTML = `<h4 style="margin:0 0 10px 0;color:#88ccff;letter-spacing:1px;text-transform:uppercase;">STELLAR TELEMETRY</h4>` +
          `<div style="color:#9fb4c8;margin-bottom:5px;">Environment: Vacuum</div>` +
          `<div style="color:#9fb4c8;margin-bottom:5px;">Gravity: Microgravity</div>` +
          `<div style="color:#9fb4c8;margin-bottom:5px;">Status: Deep Space Transit</div>`;
        orbitCard.style.right = '20px';
        orbitCard.style.opacity = '1';
        if(orbitCard._timeout) clearTimeout(orbitCard._timeout);
        orbitCard._timeout = setTimeout(() => { orbitCard.style.opacity = '0'; }, 4000);
      }
    }
  }

  for(const id in NS._mkEls){ if(!seen[id]) NS._mkEls[id].style.display='none'; }
}

// ── COMPASS BAR (Elder-Scrolls / Skyrim style) ── a horizontal strip across the
// top center. For each place-node, its BEARING relative to where the camera looks
// (forward projected to the horizontal XZ plane vs. camera→node horizontal vector)
// maps to an x position: 0°=center, ±NS_COMPASS_FOV spans to the edges. Bodies
// behind the camera / beyond that arc are hidden. The GPS target renders brighter
// + larger with its distance in ly. Cheap: one cached element per node id, only
// transform/text updated per frame — never an innerHTML rebuild.
function nsPaintCompass(){
  if((NS._cpFrame=(NS._cpFrame||0)+1)%3) return;   // PERF: throttle to every 3rd frame
  if(typeof THREE==='undefined' || !NS.camera || !NS.nodes) return;
  const cam=NS.camera, c=NS.cam, wrap=$('ns-wrap'); if(!wrap||!c) return;
  let bar=$('kv-compass-bar');
  if(!bar){
    bar=document.createElement('div'); bar.id='kv-compass-bar';
    bar.style.cssText='position:absolute;top:10px;left:50%;transform:translateX(-50%);'
      +'width:min(620px,70%);height:26px;pointer-events:none;z-index:12;overflow:hidden;'
      +'font-family:var(--mono,monospace);border-radius:6px;'
      +'background:linear-gradient(rgba(6,12,20,0.0),rgba(6,12,20,0.55) 35%,rgba(6,12,20,0.55) 65%,rgba(6,12,20,0.0));';
    // center "ahead" tick
    const tick=document.createElement('div');
    tick.style.cssText='position:absolute;left:50%;top:2px;bottom:2px;width:1px;'
      +'background:rgba(180,210,240,0.55);transform:translateX(-0.5px);';
    bar.appendChild(tick);
    wrap.appendChild(bar);
  }
  if(!NS._cmpEls) NS._cmpEls={};
  const Wb=bar.clientWidth||620;
  const NS_COMPASS_FOV = (typeof NS_COMPASS_FOV_DEG!=='undefined'?NS_COMPASS_FOV_DEG:70)*Math.PI/180;
  // camera heading = forward direction projected to XZ
  const cp=Math.cos(c.pitch||0), cy=Math.cos(c.yaw||0), sy=Math.sin(c.yaw||0);
  let fx=cp*cy, fz=cp*sy; const fl=Math.hypot(fx,fz)||1; fx/=fl; fz/=fl;
  const seen={};
  for(let i=0;i<NS.nodes.length;i++){
    const n=NS.nodes[i]; if(!n||!n.pos) continue;
    if(!(n.kind==='core'||n.kind==='bot'||n.kind==='engine'||n.kind==='channels')) continue;
    // horizontal vector camera→node
    let dx=n.pos.x-cam.position.x, dz=n.pos.z-cam.position.z;
    const dl=Math.hypot(dx,dz); if(dl<1e-4) continue; dx/=dl; dz/=dl;
    // signed angle between heading and target (atan2 of cross/dot in XZ)
    const dot=fx*dx+fz*dz, cross=fx*dz-fz*dx;   // cross y-component
    const ang=Math.atan2(cross,dot);
    if(Math.abs(ang)>NS_COMPASS_FOV){ const e0=NS._cmpEls[n.id]; if(e0) e0.style.display='none'; continue; }
    seen[n.id]=1;
    let el=NS._cmpEls[n.id];
    if(!el){
      el=document.createElement('div');
      el.style.cssText='position:absolute;top:0;bottom:0;display:flex;align-items:center;gap:4px;'
        +'transform:translateX(-50%);white-space:nowrap;font-size:9px;line-height:1;';
      el._dot=document.createElement('span'); el._tx=document.createElement('span');
      el.appendChild(el._dot); el.appendChild(el._tx);
      el._col=''; el._txt=''; el._gps=null; el._left='';
      bar.appendChild(el); NS._cmpEls[n.id]=el;
    }
    el.style.display='flex';
    const col=n.color||'#bfe3ff';
    const isGps=(NS.gpsTarget===n.id);
    const nm=(n.kind==='core')?'CORE':(n.name||n.id||'');
    let txt=nm;
    if(isGps){ txt=nm+' '+nsFmtDist(cam.position.distanceTo(n.pos), n.r); }
    // x position: 0°→center, ±FOV→edges
    const x=(0.5 + (ang/NS_COMPASS_FOV)*0.5)*Wb;
    const lp=Math.round(x)+'px'; if(el._left!==lp){ el.style.left=lp; el._left=lp; }
    if(el._col!==col){ el._dot.style.cssText='width:5px;height:5px;border-radius:50%;background:'+col+';box-shadow:0 0 4px '+col+';'; el._tx.style.color=col; el._col=col; }
    if(el._gps!==isGps){ el._gps=isGps;
      el._tx.style.fontWeight=isGps?'700':'400';
      el._tx.style.fontSize=isGps?'10px':'9px';
      el._dot.style.transform=isGps?'scale(1.5)':'scale(1)';
      el.style.opacity=isGps?'1':'0.8';
    }
    if(el._txt!==txt){ el._tx.textContent=txt; el._txt=txt; }
  }
  for(const id in NS._cmpEls){ if(!seen[id]) NS._cmpEls[id].style.display='none'; }
}

// ── XBOX / GAMEPAD CONTROL ── polled every frame (standard mapping):
//   Left stick = move · Right stick = look · D-pad U/D = throttle +/- · RB/LB = up/down
//   A = select body at screen centre · B = back to CORE · X = use (reserved) · Y = menu (reserved)
// ── BODY LOD ── the halo is how a body reads from AFAR (its emitted/reflected
// light); up close it fades so the real textured surface shows ("glow → planet").
// Also keeps the open info-panel distance live so it matches the marker readout.
function nsUpdateBodyLOD(){
  const cam=NS.camera; if(!cam) return;
  var _coreP=(NS.nodeById&&NS.nodeById['core']&&NS.nodeById['core'].pos)||null; if(_coreP&&NS._sunPL) NS._sunPL.position.copy(_coreP);
  if(_coreP && NS._sunDir){ NS._sunDir.copy(_coreP).sub(cam.position); if(NS._sunDir.lengthSq()<1e-6) NS._sunDir.set(0,1,0); else NS._sunDir.normalize(); }
  // LOCK the directional sun to a CONSTANT world direction every frame (immune to floating-origin shifts).
  // Without this the light target stays at the old origin and the lit/dark side drifts with your movement.
  if(NS._sun && NS._sunDir){ NS._sun.position.copy(cam.position).addScaledVector(NS._sunDir, 1e7); if(NS._sun.target){ NS._sun.target.position.copy(cam.position); NS._sun.target.updateMatrixWorld(); } }
  for(let i=0;i<NS.nodes.length;i++){
    const n=NS.nodes[i]; if(!n.pos) continue;
    // never frustum-cull the handful of bodies: a bad bounding volume made a planet VANISH
    // when you looked straight at it (visible only in peripheral view). ~10 meshes -> no cost.
    if(n.mesh) n.mesh.frustumCulled=false; if(n.atmo) n.atmo.frustumCulled=false; if(n.halo) n.halo.frustumCulled=false;
    const d=cam.position.distanceTo(n.pos);
    if(n.mesh && n.mesh.material && n.mesh.material.userData && n.mesh.material.userData._reliefShader){ var _rr=(n.r||1); var _ap=(_rr*45.0 - d)/(_rr*40.0); _ap=_ap<0?0:(_ap>1?1:_ap); _ap=_ap*_ap*(3.0-2.0*_ap); var _ru=n.mesh.material.userData._reliefShader.uniforms; if(_ru&&_ru.uApproach) _ru.uApproach.value=_ap; }
    if(n.atmo){
      if(n.kind==='core'){ n.atmo.position.copy(n.pos); n.atmo.visible = d > (n.r||1)*100; }   // core glow ONLY when it is a distant star (not washing the close-up planet)
      else { n.atmo.visible = d < (n.r||1)*14; }
    }
    if(n.corona){ n.corona.position.copy(n.pos); n.corona.visible = d > (n.r||1)*120; }   // blue corona: distant star only -> kills the blue blur over the close planet
    // keep each atmosphere's sun-facing limb lit (world-space sun dir)
    if(n.atmo && n.atmo.material && n.atmo.material.uniforms && n.atmo.material.uniforms.uSun && NS._sunDir){
      n.atmo.material.uniforms.uSun.value.copy(NS._sunDir);
    }
    if(n.halo && n.halo.material){
      // tighter near band: halo is GONE well before the surface/clouds appear,
      // so the discovery glow can never bleed onto the close-up world.
      const near=(n.r||1)*1.6, far=(n.r||1)*6;
      let g=(d-near)/(far-near); g=g<0?0:(g>1?1:g);
      const full=(n.active===false?0.18:0.6);
      // DISTANCE FLOOR: a far planet stays a visible glow DOT (never culls to nothing); small/subtle up close.
      var _hf=Math.max((n.r||1)*1.35, Math.min((n.r||1)*4.0, d*0.005)); n.halo.scale.set(_hf,_hf,1);
      n.halo.material.opacity=Math.max(full*g, d>far*3?0.3:0); n.halo.visible=n.halo.material.opacity>0.01;
      // Stellar bodies (core/engine) STAY bright — they are light sources, not
      // worlds. Only planets (bot/provider/channels) get the emissive cut so the
      // sun shades their surface instead of a painted-on glow.
      const isStar=(n.kind==='core'||n.kind==='engine');
      if(!isStar && n.mesh && n.mesh.material && ('emissiveIntensity' in n.mesh.material)){
        // very low self-light up close → the DIRECTIONAL SUN shades the sphere
        // (tiny floor so the dark side isn't pure black). No painted-on glow.
        if(!n._realTex) n.mesh.material.emissiveIntensity = 0.02 + g*0.14;
      }
    }
  }
  const de=$('ns-ep-dist');
  if(de && NS._panelNode && NS._panelNode.pos && typeof nsUnitsToLy==='function'){
    de.textContent=nsFmtDist(cam.position.distanceTo(NS._panelNode.pos), NS._panelNode.r);
  }
}

/* ── PLANET DESCENT LOD (owner) ─────────────────────────────────────────────
   Turns the NEAREST planet from a glowing sphere into a place you fly down to.
   ONLY the single closest bot/core/engine within build range ever builds the
   heavy cloud+terrain+water layers (perf-critical — never for all ~10 bodies).
   Layers stack & fade by surface distance with smoothstep (no pops), mirroring
   nsUpdateFieldLOD: 1) orbital debris ring (within ~r*9), 2) cloud shell
   (within ~r*3), 3) terrain relief + ocean water sphere (within ~r*1.6).
   All built ONCE per node (cached on n._descent), then per-frame we only set
   opacity / rotation / position — no allocations in the hot path. ──────────── */
// PLANET DNA (Pillar 3): one identity-seed -> every trait, so a planet is fully determined by
// WHO it is and stays consistent forever. Cached on the node. Read by gravity/textures/atmosphere.
function nsPlanetDNA(node){
  if(!node) return null; if(node._dna) return node._dna;
  const seed=nsHashStr(node.name||node.id||'planet'), rng=nsSeededRng(seed);
  const types=['earth','ocean','desert','ice','lava','rock','gas'];
  const hue=rng()*360;
  const aC=(typeof THREE!=='undefined')?new THREE.Color().setHSL(((((hue+(rng()*40-20))%360)+360)%360)/360, 0.5+rng()*0.3, 0.58+rng()*0.18):{r:0.6,g:0.78,b:1};
  const gC=(typeof THREE!=='undefined')?new THREE.Color().setHSL((((hue%360)+360)%360)/360, 0.4+rng()*0.3, 0.42+rng()*0.18):{r:0.4,g:0.4,b:0.4};
  node._dna={ seed:seed, type:types[(seed>>>3)%types.length], sea:0.45+rng()*0.07,
    sharpness:0.55+rng()*0.9, roughness:0.4+rng()*0.5, baseHue:hue,
    cloudCover:0.42+rng()*0.22, gravity:0.4+rng()*1.4, bands:5+((seed>>>4)%6), atmoTint:0.6+rng()*0.3,
    // extended Planet DNA (Pi-style seed->visuals + modular ship grammar) for atmosphere/ships/biomes
    atmoColor:[aC.r,aC.g,aC.b], groundColor:[gC.r,gC.g,gC.b], terrainScale:0.05+rng()*0.08,
    ship:{ cockpit:Math.floor(rng()*5), wing:Math.floor(rng()*8), thrusters:(rng()>0.5?2:1) },
    perfection:Math.floor(rng()*100) };
  return node._dna;
}

// per-planet PROCEDURAL world: distinct types (earth/ocean/desert/ice/lava/rock/gas),
// 6-octave seamless fbm height + domain warp, hi-res — so each AI's planet looks unique.

// CPU 3D value noise + ridged multifractal. Used to BAKE real terrain geometry into the
// descent sphere (guaranteed 3D relief with standard lighting) AND for terrain-following
// collision, so the visible mountains and the thing you can't pass through are the SAME.
function nsNoise3(x,y,z){
  function h(i,j,k){ let nn=((i|0)*374761393+(j|0)*668265263+(k|0)*1274126177)>>>0; nn=((nn^(nn>>>13))*1274126177)>>>0; nn=(nn^(nn>>>16))>>>0; return nn/4294967295*2-1; }
  const xi=Math.floor(x),yi=Math.floor(y),zi=Math.floor(z), xf=x-xi,yf=y-yi,zf=z-zi;
  const u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf),w=zf*zf*(3-2*zf), L=(a,b,t)=>a+(b-a)*t;
  return L(L(L(h(xi,yi,zi),h(xi+1,yi,zi),u),L(h(xi,yi+1,zi),h(xi+1,yi+1,zi),u),v),
           L(L(h(xi,yi,zi+1),h(xi+1,yi,zi+1),u),L(h(xi,yi+1,zi+1),h(xi+1,yi+1,zi+1),u),v),w);
}
function nsRidged3(x,y,z){ let s=0,a=0.5,wt=1,f=1; for(let o=0;o<5;o++){ let nn=1-Math.abs(nsNoise3(x*f,y*f,z*f)); nn*=nn; nn*=wt; wt=Math.min(1,nn*2); s+=nn*a; a*=0.5; f*=2.03; } return s; }
function nsFbm3(x,y,z,oct){ let s=0,a=0.5,f=1,n=0; const O=oct||5; for(let o=0;o<O;o++){ s+=a*nsNoise3(x*f,y*f,z*f); n+=a; a*=0.5; f*=2.0; } return s/n; }
function nsTerrainHeightJS(nx,ny,nz,sharp,sea){
  // --- PHASE 3: HARDWARE ACCELERATION ---
  // If the Rust WASM module is loaded, bypass JavaScript entirely for blistering fast procedural generation
  if (NS.wasmHeightMap) {
    return NS.wasmHeightMap(nx, ny, nz, sharp || 1.0, sea || 0.45, 12345);
  }
  
  // Fallback to JS if WASM is still loading or failed
  const cont=nsFbm3(nx*2.2,ny*2.2,nz*2.2,5)*0.5+0.5;
  const hills=nsFbm3(nx*7.0,ny*7.0,nz*7.0,4)*0.5+0.5;
  const ridge=nsRidged3(nx*5.0,ny*5.0,nz*5.0);
  const h=cont*0.6+hills*0.25+ridge*0.15*(sharp||1);
  return Math.max(0,h-(sea||0.45));
}
// GPU TERRAIN DISPLACEMENT (quadtree step 1): inject rigid-multifractal relief into a
// STANDARD material via onBeforeCompile, so real mountains/canyons rise from the surface as
// you descend, with recomputed normals that catch the sun. Keeps Three's lighting + depth,
// so a GLSL error only leaves the terrain smooth (NOT a black screen like a raw shader would).
function nsApplyDisplacement(material, dna, amp, dispTex){
  const sharp=(dna&&dna.sharpness)||1.0, sea=(dna&&dna.sea)||0.45;
  material.onBeforeCompile=function(shader){
    shader.uniforms.uDispAmp={value:amp};
    shader.uniforms.uSharp={value:sharp};
    shader.uniforms.uSeaLvl={value:sea};
    const emptyData = new Float32Array([0,0,0,0]);
    const emptyTex = new THREE.DataTexture(emptyData, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    emptyTex.needsUpdate = true;
    shader.uniforms.uDispTex={value:dispTex || emptyTex};
    shader.uniforms.uHasTex={value:dispTex ? 1.0 : 0.0};
    const noise=[
      'uniform float uDispAmp; uniform float uSharp; uniform float uSeaLvl;',
      'uniform sampler2D uDispTex; uniform float uHasTex;',
      'vec3 nsHash33(vec3 p){ p=vec3(dot(p,vec3(127.1,311.7,74.7)),dot(p,vec3(269.5,183.3,246.1)),dot(p,vec3(113.5,271.9,124.6))); return -1.0+2.0*fract(sin(p)*43758.5453123); }',
      'float nsVN(vec3 p){ vec3 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);',
      ' return mix(mix(mix(dot(nsHash33(i+vec3(0.,0.,0.)),f-vec3(0.,0.,0.)),dot(nsHash33(i+vec3(1.,0.,0.)),f-vec3(1.,0.,0.)),u.x),',
      '             mix(dot(nsHash33(i+vec3(0.,1.,0.)),f-vec3(0.,1.,0.)),dot(nsHash33(i+vec3(1.,1.,0.)),f-vec3(1.,1.,0.)),u.x),u.y),',
      '         mix(mix(dot(nsHash33(i+vec3(0.,0.,1.)),f-vec3(0.,0.,1.)),dot(nsHash33(i+vec3(1.,0.,1.)),f-vec3(1.,0.,1.)),u.x),',
      '             mix(dot(nsHash33(i+vec3(0.,1.,1.)),f-vec3(0.,1.,1.)),dot(nsHash33(i+vec3(1.,1.,1.)),f-vec3(1.,1.,1.)),u.x),u.y),u.z); }',
      'float nsRidged(vec3 p){ float s=0.,a=0.5,w=1.,fr=1.; for(int o=0;o<5;o++){ float nn=1.0-abs(nsVN(p*fr)); nn*=nn; nn*=w; w=clamp(nn*2.0,0.0,1.0); s+=nn*a; a*=0.5; fr*=2.03; } return s; }',
      'float nsFbm(vec3 p, int oct){ float s=0.0,a=0.5,fr=1.0,nrm=0.0; for(int o=0;o<6;o++){ if(o>=oct) break; s+=a*nsVN(p*fr); nrm+=a; a*=0.5; fr*=2.0; } return s/nrm; }',
      '#define PI 3.14159265359',
      'float nsTerrainH(vec3 dir){',
      '  if (uHasTex > 0.5) {',
      '     vec2 uv = vec2(atan(dir.z, dir.x) / (2.0 * PI) + 0.5, asin(dir.y) / PI + 0.5);',
      '     return texture2D(uDispTex, uv).r * uDispAmp;',
      '  }',
      '  float cont=nsFbm(dir*2.2,5)*0.5+0.5; float hills=nsFbm(dir*7.0,4)*0.5+0.5; float ridge=nsRidged(dir*5.0); float h=cont*0.6+hills*0.25+ridge*0.15*uSharp; return max(0.0,h-uSeaLvl)*uDispAmp;',
      '}'
    ].join('\n');
    shader.vertexShader = shader.vertexShader.replace('void main() {', noise+'\nvoid main() {');
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>',
      ['#include <beginnormal_vertex>',
       '{ vec3 nd=normalize(position); float L=length(position);',
       '  vec3 t1=normalize(cross(nd, abs(nd.y)<0.99?vec3(0.,1.,0.):vec3(1.,0.,0.)));',
       '  vec3 t2=normalize(cross(nd,t1)); float e=0.015;',
       '  vec3 da=normalize(position+t1*e*L), db=normalize(position+t2*e*L);',
       '  vec3 p0=nd*(L+nsTerrainH(nd)), pa=da*(L+nsTerrainH(da)), pb=db*(L+nsTerrainH(db));',
       '  vec3 nn=normalize(cross(pa-p0,pb-p0)); if(dot(nn,nd)<0.0) nn=-nn; objectNormal=nn; }'].join('\n'));
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\n  transformed += normalize(position)*nsTerrainH(normalize(position));');
    material.userData._shader=shader;
  };
  material.needsUpdate=true;
}
// NMS-STYLE DETAIL GROUND TEXTURE: high-frequency procedural texture that tiles many times
// across the surface. Per planet type (rock/sand/lava/ice/grass/gas). Gives close-up grain
// so the surface doesn't collapse to a solid color at walking distance.


function nsAttachReliefNormal(material, seed, n){
  if(!material) return;
  var dN = nsMakeDetailNormalTexture(seed); if(!dN) return;
  var _r=(n&&n.r)||1;
  var _dna=(n&&typeof nsPlanetDNA==='function')?nsPlanetDNA(n):null;
  var _gc=(_dna&&_dna.groundColor)||[0.34,0.36,0.40];
  var _low=new THREE.Vector3(_gc[0],_gc[1],_gc[2]);
  var _high=new THREE.Vector3(Math.min(1,_gc[0]*1.25+0.28),Math.min(1,_gc[1]*1.25+0.28),Math.min(1,_gc[2]*1.2+0.34));
  var _rock=new THREE.Vector3(_gc[0]*0.5+0.05,_gc[1]*0.46+0.05,_gc[2]*0.42+0.05);
  material.onBeforeCompile = function(shader){
    shader.uniforms.uReliefN = { value: dN };
    shader.uniforms.uReliefScale = { value: 0.05 };
    shader.uniforms.uReliefStr = { value: 0.9 };
    shader.uniforms.uReliefC = { value: nsMakeDetailTexture(seed) };
    shader.uniforms.uBaseR = { value: _r };
    shader.uniforms.uBiomeLow = { value: _low };
    shader.uniforms.uBiomeHigh = { value: _high };
    shader.uniforms.uBiomeRock = { value: _rock };
    shader.uniforms.uApproach = { value: 0.0 };
    shader.vertexShader = shader.vertexShader.replace('void main() {','varying vec3 vRpos;\nvarying vec3 vRnrm;\nvoid main() {');
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>','#include <beginnormal_vertex>\n  vRnrm = normalize(objectNormal);');
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\n  vRpos = transformed;');
    shader.fragmentShader = shader.fragmentShader.replace('void main() {','uniform sampler2D uReliefN;\nuniform sampler2D uReliefC;\nuniform float uReliefScale;\nuniform float uReliefStr;\nuniform float uBaseR;\nuniform vec3 uBiomeLow;\nuniform vec3 uBiomeHigh;\nuniform vec3 uBiomeRock;\nuniform float uApproach;\nvarying vec3 vRpos;\nvarying vec3 vRnrm;\nvoid main() {');
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>',
      ['#include <map_fragment>',
       '{',
       '  vec3 bwc = abs(normalize(vRnrm)); bwc = bwc/max(bwc.x+bwc.y+bwc.z,1e-4);',
       '  vec3 tpc = vRpos * (uReliefScale*2.2);',
       '  vec4 gc = texture2D(uReliefC, tpc.yz)*bwc.x + texture2D(uReliefC, tpc.xz)*bwc.y + texture2D(uReliefC, tpc.xy)*bwc.z;',
       '  float gl = dot(gc.rgb, vec3(0.33));',
       '  diffuseColor.rgb *= mix(1.0, gl*0.95+0.5, 0.45*uApproach);',
       '  float _altr = clamp((length(vRpos)/uBaseR - 1.0)/0.015, 0.0, 1.0);',
       '  float _slpr = 1.0 - clamp(dot(normalize(vRnrm), normalize(vRpos)), 0.0, 1.0);',
       '  vec3 _bior = mix(uBiomeLow, uBiomeHigh, smoothstep(0.4,0.92,_altr));',
       '  _bior = mix(_bior, uBiomeRock, smoothstep(0.45,0.85,_slpr));',
       '  vec3 tpr = vRpos * uReliefScale;',
       '  vec3 bwr = abs(normalize(vRnrm)); bwr = bwr/max(bwr.x+bwr.y+bwr.z,1e-4);',
       '  vec3 cX = texture2D(uReliefC, tpr.yz).rgb;',
       '  vec3 cY = texture2D(uReliefC, tpr.xz).rgb;',
       '  vec3 cZ = texture2D(uReliefC, tpr.xy).rgb;',
       '  vec3 detailC = cX*bwr.x + cY*bwr.y + cZ*bwr.z;',
       '  diffuseColor.rgb *= mix(vec3(1.0), _bior*2.6 * (detailC * 1.6 + 0.2), 0.5 + 0.5*uApproach);',
       '}'].join('\n'));
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>',
      ['#include <normal_fragment_maps>',
       '{',
       '  vec3 bwr = abs(normalize(vRnrm)); bwr = bwr/max(bwr.x+bwr.y+bwr.z,1e-4);',
       '  vec3 tpr = vRpos * uReliefScale;',
       '  vec3 rX = texture2D(uReliefN, tpr.yz).xyz*2.0-1.0;',
       '  vec3 rY = texture2D(uReliefN, tpr.xz).xyz*2.0-1.0;',
       '  vec3 rZ = texture2D(uReliefN, tpr.xy).xyz*2.0-1.0;',
       '  vec2 tgr = rX.xy*bwr.x + rY.xy*bwr.y + rZ.xy*bwr.z;',
       '  vec3 Nr = normalize(normal);',
       '  vec3 Trr = normalize(cross(Nr, abs(Nr.y)<0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));',
       '  vec3 Brr = cross(Nr, Trr);',
       '  normal = normalize(Nr + (tgr.x*Trr + tgr.y*Brr)*uReliefStr*(0.35 + 0.95*uApproach));',
       '}'].join('\n'));
    material.userData = material.userData || {}; material.userData._reliefShader = shader;
  };
  material.needsUpdate = true;
}

// ── QUADTREE PLANET CHUNKING (PHASE 2 STUB) ────────────────────────────────
// To replace the monolithic 24k-vertex sphere with true infinite NMS terrain,
// we project a cube onto a sphere and quadtree-subdivide the faces dynamically
// based on camera distance.
class QuadTreeNode {
  constructor(planetR, face, bounds, depth, maxDepth) {
    this.r = planetR;
    this.face = face;         // Which of the 6 cube faces this sits on
    this.bounds = bounds;     // { x, y, width } in face-local space [-1, 1]
    this.depth = depth;
    this.maxDepth = maxDepth;
    this.children = [];
    this.mesh = null;         // The THREE.Mesh chunk for this node
    this.isLeaf = true;
  }
  // Stub for updating LOD based on camera pos
  update(cameraPosLocal) {
    // 1. Calculate distance to this chunk's center
    // 2. If close && depth < maxDepth -> split()
    // 3. If far && !isLeaf -> merge()
    // 4. Update children recursively
  }
  split() {
    this.isLeaf = false;
    // create 4 children...
  }
  merge() {
    this.isLeaf = true;
    // destroy 4 children...
  }
}
class QuadTreePlanet {
  constructor(r, maxLOD) {
    this.r = r;
    this.faces = []; // 6 root nodes for the cube faces
  }
  update(cameraPos) {
    // update all 6 faces...
  }
}
// ───────────────────────────────────────────────────────────────────────────

function nsBuildDescent(n){
  const seed=nsHashStr(n.name||n.id||'planet'), rng=nsSeededRng(seed);
  const r=n.r||1, scn=NS.scene, grp={};
  n._isGas=(nsPlanetDNA(n).type==='gas');   // gas-giant flag: drives floor amp, cloud ceiling, wind
  // ── 1) ORBITAL DEBRIS RING — thin tilted Points ring of specks ──
  const N=2200, posA=new Float32Array(N*3);
  for(let i=0;i<N;i++){ const ang=rng()*6.28, rad=r*(2.4+rng()*1.8), h=(rng()*2-1)*r*0.08;
    posA[i*3]=Math.cos(ang)*rad; posA[i*3+1]=h; posA[i*3+2]=Math.sin(ang)*rad; }
  const rg=new THREE.BufferGeometry(); rg.setAttribute('position',new THREE.BufferAttribute(posA,3));
  const rm=new THREE.PointsMaterial({map:nsMakeGlowTexture(), color:0xb9c2d6, size:r*0.035, sizeAttenuation:true, transparent:true, opacity:0, depthWrite:false, blending:THREE.NormalBlending});
  const debris=new THREE.Points(rg,rm); debris.rotation.x=0.5+rng()*0.6; debris.rotation.z=rng()*0.5; debris.visible=false;
  scn.add(debris); grp.debris=debris;
  // ── 2) CLOUD SHELL — soft semi-transparent cloud sphere, own-axis spin ──
  const cloudMat=new THREE.MeshStandardMaterial({map:(n._realClouds||nsMakeCloudTexture(seed)), color:0xffffff, transparent:true, opacity:0, depthWrite:false, side:THREE.DoubleSide, roughness:1, metalness:0, emissive:0xffffff, emissiveIntensity:0.55});
  const cloud=new THREE.Mesh(new THREE.SphereGeometry(r*1.15, 48, 48), cloudMat); cloud.visible=false; cloud.frustumCulled=false;
  scn.add(cloud); grp.cloud=cloud;
  const cloudMat3=cloudMat.clone(); cloudMat3.opacity=0;
  const cloud3=new THREE.Mesh(new THREE.SphereGeometry(r*1.20, 48, 48), cloudMat3); cloud3.visible=false; cloud3.frustumCulled=false;
  scn.add(cloud3); grp.cloud3=cloud3;
  if(n._isGas){
    const cloudMat2=cloudMat.clone(); cloudMat2.opacity=0; cloudMat2.emissiveIntensity=0.06;
    const cloud2=new THREE.Mesh(new THREE.SphereGeometry(r*1.12, 40, 40), cloudMat2); cloud2.visible=false; cloud2.frustumCulled=false;
    scn.add(cloud2); grp.cloud2=cloud2;
  }
  // ── 3) TERRAIN RELIEF (high-seg surface) — prefers the downloaded texture ──
  const terMap = n._realTex && n.mesh && n.mesh.material && n.mesh.material.map ? n.mesh.material.map : nsMakeTerrainTexture(seed);
  // DETAIL GROUND TEXTURE: a high-frequency procedural texture that tiles many times across
  // the surface. This is the NMS-style close-up ground — rock grains, sand, lava veins etc.
  // Without this, the base texture stretches to a solid color at walking distance.
  const detailTex = nsMakeDetailTexture(seed);
  const detailNrm = nsMakeDetailNormalTexture(seed);
  const _bdna=nsPlanetDNA(n); const _bgc=_bdna.groundColor||[0.34,0.36,0.40];
  const _bLow=new THREE.Vector3(_bgc[0],_bgc[1],_bgc[2]);
  const _bHigh=new THREE.Vector3(Math.min(1,_bgc[0]*1.25+0.28),Math.min(1,_bgc[1]*1.25+0.28),Math.min(1,_bgc[2]*1.2+0.34));
  const _bRock=new THREE.Vector3(_bgc[0]*0.5+0.05,_bgc[1]*0.46+0.05,_bgc[2]*0.42+0.05);
  // PHASE 0 PARITY: NO GPU displacementMap — the CPU bake (nsTerrainHeightJS) is the SOLE
  // height source so the rendered mesh IS the collision mesh. Raycast + walk + fly all agree.
  const terMat=new THREE.MeshStandardMaterial({map:terMap, normalMap:(n._realNormal||null), displacementMap:null, displacementScale:0, color:0xffffff, vertexColors:true, transparent:false, opacity:1.0, side:THREE.FrontSide, roughness:0.92, metalness:0.02, emissive:0x0b0d10, emissiveIntensity:0.0});
  // Inject detail-texture blending via onBeforeCompile: the detail texture tiles at UV*80
  // and blends with the base color in the fragment shader, giving close-up surface grain.
  terMat.userData._detailTex = detailTex;
  terMat.onBeforeCompile = function(shader){
    shader.uniforms.uDetail = { value: detailTex };
    shader.uniforms.uDetailScale = { value: 0.07 };
    shader.uniforms.uDetailN = { value: detailNrm };
    shader.uniforms.uBumpStr = { value: detailNrm ? 0.75 : 0.0 };
    shader.uniforms.uBaseR = { value: r };
    shader.uniforms.uBiomeLow = { value: _bLow };
    shader.uniforms.uBiomeHigh = { value: _bHigh };
    shader.uniforms.uBiomeRock = { value: _bRock };
    // VERTEX: pass object-space position + normal so the fragment can do TRIPLANAR projection.
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      'varying vec3 vTriPos;\nvarying vec3 vTriNrm;\nvarying vec3 vWorldPos;\nvoid main() {'
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n  vTriNrm = normalize(objectNormal);'
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      '#include <worldpos_vertex>\n  vWorldPos = worldPosition.xyz;'
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vTriPos = transformed;'
    );
    // FRAGMENT: triplanar detail — sample the grain on 3 axes, blend by the surface normal,
    // so steep slopes/cliffs get crisp grain instead of a stretched smear (NMS-style).
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'uniform sampler2D uDetail;\nuniform sampler2D uDetailN;\nuniform float uDetailScale;\nuniform float uBumpStr;\nuniform float uBaseR;\nuniform vec3 uBiomeLow;\nuniform vec3 uBiomeHigh;\nuniform vec3 uBiomeRock;\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;\nvarying vec3 vWorldPos;\nvoid main() {'
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      ['#include <map_fragment>',
       '{',
       '  float dist = length(vWorldPos - cameraPosition);',
       '  float lodScale = mix(32.0, 1.0, clamp(dist / (uBaseR*2.0), 0.0, 1.0));',
       '  vec3 bw = abs(normalize(vTriNrm)); bw = bw / max(bw.x+bw.y+bw.z, 0.0001);',
       '  vec3 tp = vTriPos * uDetailScale * lodScale;',
       '  vec3 tp2 = vTriPos * (uDetailScale*4.0 * lodScale);',
       '  vec4 det = texture2D(uDetail, tp.yz)*bw.x + texture2D(uDetail, tp.xz)*bw.y + texture2D(uDetail, tp.xy)*bw.z;',
       '  vec4 fdet = texture2D(uDetail, tp2.yz)*bw.x + texture2D(uDetail, tp2.xz)*bw.y + texture2D(uDetail, tp2.xy)*bw.z;',
       '  float detL = dot(det.rgb, vec3(0.3,0.5,0.2));',
       '  float finL = dot(fdet.rgb, vec3(0.3,0.5,0.2));',
       '  float grain = mix(detL, finL, 0.5);',
       '  diffuseColor.rgb *= mix(vec3(1.0), vec3(grain * 1.1 + 0.4), 0.6);',
       '  float _alt = clamp((length(vTriPos)/uBaseR - 1.0)/0.013, 0.0, 1.0);',
       '  float _slope = 1.0 - clamp(dot(normalize(vTriNrm), normalize(vTriPos)), 0.0, 1.0);',
       '  vec3 _biome = mix(uBiomeLow, uBiomeHigh, smoothstep(0.4,0.92,_alt));',
       '  _biome = mix(_biome, uBiomeRock, smoothstep(0.45,0.85,_slope));',
       '  diffuseColor.rgb *= mix(vec3(1.0), _biome*2.6, 0.45);',
       '}'].join('\n')
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
       ['#include <normal_fragment_maps>',
       '{',
       '  float distN = length(vWorldPos - cameraPosition);',
       '  float lodScaleN = mix(32.0, 1.0, clamp(distN / (uBaseR*2.0), 0.0, 1.0));',
       '  vec3 bwn = abs(normalize(vTriNrm)); bwn = bwn/max(bwn.x+bwn.y+bwn.z,1e-4);',
       '  vec3 tpn = vTriPos * uDetailScale * lodScaleN;',
       '  vec3 nXa = texture2D(uDetailN, tpn.yz).xyz*2.0-1.0;',
       '  vec3 nYa = texture2D(uDetailN, tpn.xz).xyz*2.0-1.0;',
       '  vec3 nZa = texture2D(uDetailN, tpn.xy).xyz*2.0-1.0;',
       '  vec2 tg = nXa.xy*bwn.x + nYa.xy*bwn.y + nZa.xy*bwn.z;',
       '  vec3 Nv = normalize(normal);',
       '  vec3 Tt = normalize(cross(Nv, abs(Nv.y)<0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0)));',
       '  vec3 Bt = cross(Nv, Tt);',
       '  normal = normalize(Nv + (tg.x*Tt + tg.y*Bt)*uBumpStr);',
       '}'].join('\n')
    );
    terMat.userData._shader = shader;
  };
  // CPU-BAKED relief: physically displace the sphere's vertices by the planet's ridged noise
  // (REAL 3D mountains/canyons), recompute normals for lighting. Stash params for collision.
  const _dna=nsPlanetDNA(n), _amp=(n._isGas?(n.r||1)*0.006:(n.r||1)*0.022); n._terrAmp=_amp; n._terrSharp=_dna.sharpness; n._terrSea=_dna.sea;
  // VISIBILITY FLOOR (C2 blue-blob fix): the descent terrain must never go fully dark at the
  // LOD swap, or the planet "vanishes" into the blue atmosphere shell when the bright base
  // sphere hides. Give it a dim self-lit floor tinted to its ground colour; sun light still
  // adds real shading on top, so relief is preserved but the body always reads as solid.
  try{ const _gc=_dna.groundColor||[0.34,0.36,0.40]; const _gl=(_gc[0]*0.3+_gc[1]*0.5+_gc[2]*0.2); terMat.emissive=new THREE.Color(_gl*0.6+0.05,_gl*0.6+0.05,_gl*0.6+0.06); terMat.emissiveIntensity=0.10; }catch(_){ terMat.emissiveIntensity=0.10; }
  const terGeo=new THREE.SphereGeometry(r*1.005, 384, 256);
  // CHUNKED BAKE (perf): the ~24k-vertex displace+colour loop was the per-approach FREEZE.
  // Defer it -> process in slices across frames in nsUpdatePlanetDescent. Build starts at r*26
  // but terrain isn't revealed until r*5, so there is ample time to finish quietly.
  const _bakeCa=new Float32Array(terGeo.attributes.position.count*3);
  terGeo.setAttribute('color',new THREE.BufferAttribute(_bakeCa,3));
  grp._bake={ pa:terGeo.attributes.position, ca:_bakeCa, geo:terGeo, count:terGeo.attributes.position.count, i:0, amp:_amp, sharp:_dna.sharpness, sea:_dna.sea };
  const terrain=new THREE.Mesh(terGeo, terMat); terrain.visible=false; terrain.frustumCulled=false;
  scn.add(terrain); grp.terrain=terrain;
  // ── 3a) LOCAL HIGH-DETAIL PATCH (NMS-style): a small high-res grid that FOLLOWS the player,
  //    displaced by the SAME nsTerrainHeightJS so up-close ground is SHARP and matches collision.
  //    Built once here; placed/displaced per-frame in the update. Vertices live in body-local
  //    (un-spun) space so the triplanar grain + body spin line up with the coarse sphere for free.
  const PATCH_SEG=96;
  const patchGeo=new THREE.PlaneGeometry(1,1,PATCH_SEG,PATCH_SEG);
  patchGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((PATCH_SEG+1)*(PATCH_SEG+1)*3).fill(1), 3));
  const patchMat=terMat.clone();
  patchMat.userData=Object.assign({}, terMat.userData);
  patchMat.polygonOffset=true; patchMat.polygonOffsetFactor=-1; patchMat.polygonOffsetUnits=-1;
  const patch=new THREE.Mesh(patchGeo, patchMat);
  patch.visible=false; patch.frustumCulled=false;
  scn.add(patch); grp.patch=patch;
  grp._patchSeg=PATCH_SEG; grp._patchSide=r*0.02;
  // ── 3b) WATER SPHERE — smooth translucent ocean just below the land ──
  const waterMat=new THREE.MeshStandardMaterial({color:0x1e5fa8, transparent:true, opacity:0, roughness:0.18, metalness:0.5, emissive:0x06203a, emissiveIntensity:0.05});
  const water=new THREE.Mesh(new THREE.SphereGeometry(r*1.0, 48, 48), waterMat); water.visible=false; water.frustumCulled=false;
  scn.add(water); grp.water=water;
  // ── 4) SKY DOME — atmosphere gradient visible when on the surface ──
  // A large inverted sphere tinted to the planet's atmosphere color, fading to black at zenith.
  // Gives a real "sky" instead of raw space when walking on the surface.
  const ac=_dna.atmoColor||[0.6,0.78,1.0];
  const skyMat=new THREE.ShaderMaterial({
    uniforms:{ uCol:{value:new THREE.Vector3(ac[0],ac[1],ac[2])}, uSun:{value:new THREE.Vector3(0.45,0.78,0.55)}, uHorizon:{value:0.0}, uUp:{value:new THREE.Vector3(0,1,0)} },
    vertexShader:'varying vec3 vDir; void main(){ vDir=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader:[
      'uniform vec3 uCol; uniform vec3 uSun; uniform vec3 uUp; uniform float uHorizon; varying vec3 vDir;',
      'void main(){',
      '  vec3 d=normalize(vDir);',
      '  vec3 nUp=normalize(uUp);',
      '  vec3 nSun=normalize(uSun);',
      '  float up=clamp(dot(d, nUp),-1.0,1.0);',
      '  float sunElevation = dot(nUp, nSun);',
      '  float dayLight = smoothstep(-0.15, 0.1, sunElevation);',
      '  float band=smoothstep(-0.05,0.85,up);',
      '  vec3 horizonC=uCol*1.05;',
      '  vec3 zenithC=uCol*vec3(0.35,0.45,0.72)*0.7;',
      '  vec3 col=mix(horizonC, zenithC, band);',
      '  float sd=max(dot(d, nSun), 0.0);',
      '  col += uCol*0.35*pow(sd, 20.0) + vec3(1.0,0.92,0.78)*pow(sd,170.0)*0.5;',
      '  vec3 sunsetCol = vec3(1.0, 0.4, 0.1);',
      '  float sunsetMix = smoothstep(0.1, -0.15, sunElevation) * smoothstep(-0.3, -0.1, sunElevation);',
      '  col = mix(col, col * sunsetCol * 2.0, sunsetMix * (1.0-band));',
      '  float horizonGlow=pow(1.0-abs(up),3.0)*0.35;',
      '  col += uCol*horizonGlow;',
      '  col *= dayLight;',
      '  float aboveFade=smoothstep(0.0,0.15,up);',
      '  float skyAlpha = max(0.0, uHorizon * aboveFade * (dayLight * 0.95 + 0.05));',
      '  gl_FragColor=vec4(col, skyAlpha);',
      '}'
    ].join('\n'),
    transparent:true, side:THREE.BackSide, depthWrite:false, depthTest:true
  });
  const sky=new THREE.Mesh(new THREE.SphereGeometry(r*1.5, 48, 32), skyMat); sky.visible=false; sky.frustumCulled=false; sky.renderOrder=-10;
  scn.add(sky); grp.sky=sky; grp.skyMat=skyMat;
  // ── 5) GROUND SCATTER — small rocks/debris points near the camera on the surface ──
  const SN=1200, sPos=new Float32Array(SN*3), sCol=new Float32Array(SN*3);
  const gc=_dna.groundColor||[0.4,0.4,0.4];
  for(let i=0;i<SN;i++){
    // random positions on a disc around origin (repositioned each frame to follow camera)
    const ang=Math.random()*6.28, rad=Math.random()*r*0.08;
    sPos[i*3]=Math.cos(ang)*rad; sPos[i*3+1]=0; sPos[i*3+2]=Math.sin(ang)*rad;
    const shade=0.6+Math.random()*0.4;
    sCol[i*3]=gc[0]*shade; sCol[i*3+1]=gc[1]*shade; sCol[i*3+2]=gc[2]*shade;
  }
  const sg=new THREE.BufferGeometry(); sg.setAttribute('position',new THREE.BufferAttribute(sPos,3));
  sg.setAttribute('color',new THREE.BufferAttribute(sCol,3));
  const sm=new THREE.PointsMaterial({map:nsMakeGlowTexture(), vertexColors:true, size:r*0.010, sizeAttenuation:true, transparent:true, opacity:0, depthWrite:false});
  const scatter=new THREE.Points(sg,sm); scatter.visible=false;
  scn.add(scatter); grp.scatter=scatter;
  grp.usedReal=!!n._realTex;
  n._descent=grp; return grp;
}

function nsUpdatePlanetDescent(){
  const cam=NS.camera; if(!cam || !NS.nodes) return;
  const cp=cam.position;
  const sstep=(e0,e1,x)=>{ if(e1<=e0) return x<=e0?1:0; let t=(x-e0)/(e1-e0); t=t<0?0:(t>1?1:t); return t*t*(3-2*t); };
  // ── A) find the single NEAREST planet within build range (~r*10 surface) ──
  let near=null, best=1e30;
  for(let i=0;i<NS.nodes.length;i++){ const n=NS.nodes[i];
    if(!n.pos || !(n.kind==='bot'||n.kind==='engine'||n.kind==='core')) continue;
    const r=n.r||1, surf=cp.distanceTo(n.pos)-r;
    if(surf<best){ best=surf; near=n; }
  }
  if(near && best>(near.r||1)*26) near=null;   // out of build range
  NS._nearPlanet=near;
  // ── C) fade out & hide the descent on any OTHER planet that still has one ──
  if(NS._descentPrev && NS._descentPrev!==near && NS._descentPrev._descent){
    const g=NS._descentPrev._descent;
    ['debris','cloud','cloud2','terrain','water'].forEach(k=>{ const o=g[k]; if(o){ if(o.material) o.material.opacity=0; o.visible=false; } });
    if(g.sky) g.sky.visible=false;
    if(g.scatter){ g.scatter.visible=false; g.scatter.material.opacity=0; }
    if(NS._descentPrev.atmo && NS._descentPrev.atmo.material && NS._descentPrev.atmo.material.uniforms && NS._descentPrev.atmo.material.uniforms.uFade) NS._descentPrev.atmo.material.uniforms.uFade.value=1;
    if(NS._descentPrev.mesh) NS._descentPrev.mesh.visible=true;
  }
  NS._descentPrev=near;
  if(!near){ NS._skyProx=0; if(NS.scene&&NS.scene.fog) NS.scene.fog.density=0; var _tn0=document.getElementById("kv-atmo-tint"); if(_tn0) _tn0.style.opacity="0"; return; }
  // ── B) lazily build (once) then fade-by-distance on the near planet ──
  const r=near.r||1, surf=best, g=near._descent || nsBuildDescent(near);
  if(g._bake){ var _bk=g._bake, _end=Math.min(_bk.count,_bk.i+4000), _bv=NS._bakeVv||(NS._bakeVv=new THREE.Vector3());
    for(var _j=_bk.i;_j<_end;_j++){ _bv.fromBufferAttribute(_bk.pa,_j); var _ln=_bv.length(); if(_ln<1e-6){ _bk.ca[_j*3]=_bk.ca[_j*3+1]=_bk.ca[_j*3+2]=1; continue; } _bv.multiplyScalar(1/_ln);
      var _rh=nsTerrainHeightJS(_bv.x,_bv.y,_bv.z,_bk.sharp,_bk.sea), _hh=_rh*_bk.amp; _bv.multiplyScalar(_ln+_hh); _bk.pa.setXYZ(_j,_bv.x,_bv.y,_bv.z);
      var _tt=Math.max(0,Math.min(1,_rh*1.7)), _sh=0.74+_tt*0.5, _sn=Math.max(0,_tt-0.72)/0.28;
      _bk.ca[_j*3]=_sh*(1-_sn)+_sn*1.22; _bk.ca[_j*3+1]=_sh*(1-_sn)+_sn*1.25; _bk.ca[_j*3+2]=_sh*(1-_sn)+_sn*1.32; }
    _bk.i=_end; if(_bk.i>=_bk.count){ _bk.pa.needsUpdate=true; _bk.geo.attributes.color.needsUpdate=true; _bk.geo.computeVertexNormals(); g._bake=null; } }
  if(near.atmo && near.atmo.material && near.atmo.material.uniforms && near.atmo.material.uniforms.uFade){ near.atmo.material.uniforms.uFade.value = sstep(r*0.12, r*2.2, surf); }   // H11: dissolve hard shell on entry
  if(!near._atmoTint){ try{ var _dd=nsPlanetDNA(near); near._atmoTint=(_dd&&_dd.atmoColor)||[0.55,0.72,1.0]; }catch(_){ near._atmoTint=[0.55,0.72,1.0]; } }
  (function(){ var _tn=document.getElementById('kv-atmo-tint');
    if(!_tn){ var _wrap=document.getElementById('ns-wrap'); if(!_wrap) return; _tn=document.createElement('div'); _tn.id='kv-atmo-tint'; _tn.style.cssText='position:absolute;inset:0;z-index:4;pointer-events:none;opacity:0;transition:opacity .25s linear;'; _wrap.appendChild(_tn); }
    var _ac=near._atmoTint, _R=Math.round(_ac[0]*255), _G=Math.round(_ac[1]*255), _B=Math.round(_ac[2]*255);
    var _imm=1-sstep(r*0.04, r*1.8, surf);
    var _deep=1-sstep(r*0.02, r*0.7, surf);   // 0 high up -> 1 at the surface
    var _top=(0.46+0.24*_deep).toFixed(3), _midA=(0.16+0.16*_deep).toFixed(3), _botA=(0.0+0.05*_deep).toFixed(3);
    
    // Day/Night Calculation: dim the sky based on whether we are facing the sun
    var _dirToSun = near.pos.lengthSq() > 1e-6 ? new THREE.Vector3(0,0,0).sub(near.pos).normalize() : new THREE.Vector3(0,1,0);
    if(near.kind==='core') _dirToSun = new THREE.Vector3(0,1,0); // core is always lit
    var _dirToCam = cp.clone().sub(near.pos).normalize();
    var _sunDot = _dirToCam.dot(_dirToSun);
    // mapped from -0.15 (night) to 0.15 (day)
    var _dayLight = Math.max(0.02, Math.min(1.0, (_sunDot + 0.15) / 0.3));
    
    _R = Math.round(_R * _dayLight);
    _G = Math.round(_G * _dayLight);
    _B = Math.round(_B * _dayLight);

    _tn.style.background='linear-gradient(to bottom, rgba('+_R+','+_G+','+_B+','+_top+') 0%, rgba('+_R+','+_G+','+_B+','+_midA+') 46%, rgba('+_R+','+_G+','+_B+','+_botA+') 100%)';
    NS._skyProx=_deep;
    NS._dayLight=_dayLight;
    if(NS.scene && NS.scene.fog){ var _fa=1-sstep(r*0.015, r*0.45, surf); var _ft=near._atmoTint||[0.5,0.6,0.8]; NS.scene.fog.color.setRGB((_ft[0]*0.6+0.25)*_dayLight,(_ft[1]*0.6+0.27)*_dayLight,(_ft[2]*0.55+0.22)*_dayLight); NS.scene.fog.density=_fa*_fa*(7.0/Math.max(1.0,r)); }
    _tn.style.opacity=Math.max(_imm*0.5, _deep*0.62).toFixed(3); })();
  // keep every layer riding the live planet position (planets drift)
  g.debris.position.copy(near.pos); g.cloud.position.copy(near.pos);
  g.terrain.position.copy(near.pos); g.water.position.copy(near.pos);
  if(near.mesh) g.terrain.rotation.y=near.mesh.rotation.y;  // SPIN the surface with the body (continuous through the swap)
  // ── LOCAL PATCH placement + lazy re-displace (rebuild only when you move > 1/3 patch-side) ──
  if(g.patch){
    const _seg=g._patchSeg, _side=g._patchSide, _pamp=near._terrAmp||0, _psh=near._terrSharp, _psea=near._terrSea;
    const _wp=(near.mesh?near.mesh.rotation.y:0), _wc=Math.cos(-_wp), _ws=Math.sin(-_wp);
    let _rv=cp.clone().sub(near.pos); let _rl=_rv.length(); if(_rl<1e-6){_rv.set(0,1,0);_rl=1;} _rv.multiplyScalar(1/_rl);
    let _nrp=new THREE.Vector3(_rv.x*_wc-_rv.z*_ws, _rv.y, _rv.x*_ws+_rv.z*_wc);
    const _moveAng=Math.acos(Math.max(-1,Math.min(1, NS._patchAnchor? NS._patchAnchor.dot(_nrp):-1)));
    const _thAng=(_side/3)/Math.max(1,(r*1.005));
    if(!NS._patchAnchor || NS._patchPlanet!==near || _moveAng>_thAng || NS._patchDirty){
      NS._patchAnchor=(NS._patchAnchor||new THREE.Vector3()).copy(_nrp); NS._patchPlanet=near; NS._patchDirty=false;
      const _ref=Math.abs(_nrp.y)<0.985?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);
      const _east=new THREE.Vector3().crossVectors(_ref,_nrp).normalize();
      const _north=new THREE.Vector3().crossVectors(_nrp,_east).normalize();
      const _pp=g.patch.geometry.attributes.position, _pcol=g.patch.geometry.attributes.color;
      const _base=r*1.005, _dir=NS._patchDir||(NS._patchDir=new THREE.Vector3());
      let _k=0;
      for(let _iy=0;_iy<=_seg;_iy++){ const _v=(_iy/_seg-0.5)*_side;
        for(let _ix=0;_ix<=_seg;_ix++,_k++){ const _u=(_ix/_seg-0.5)*_side;
          _dir.copy(_nrp).addScaledVector(_east,_u/_base).addScaledVector(_north,_v/_base).normalize();
          const _rh=nsTerrainHeightJS(_dir.x,_dir.y,_dir.z,_psh,_psea), _surfR=_base+_rh*_pamp;
          _pp.setXYZ(_k, _dir.x*_surfR, _dir.y*_surfR, _dir.z*_surfR);
          const _tt=Math.max(0,Math.min(1,_rh*1.7)), _sh=0.74+_tt*0.5, _sn=Math.max(0,_tt-0.72)/0.28;
          _pcol.setXYZ(_k, _sh*(1-_sn)+_sn*1.22, _sh*(1-_sn)+_sn*1.25, _sh*(1-_sn)+_sn*1.32);
        }
      }
      _pp.needsUpdate=true; _pcol.needsUpdate=true; g.patch.geometry.computeVertexNormals(); g.patch.geometry.computeBoundingSphere();
    }
    g.patch.position.copy(near.pos); g.patch.rotation.y=_wp;
  }
  // slow independent rotations — STOP debris spin when terrain is active (prevents Z-fight flicker)
  const dt=Math.min(0.05,(performance.now()-(NS._descLast||performance.now()))/1000); NS._descLast=performance.now();
  const aTer=1-sstep(r*1.2, r*5, surf);
  const _showTer = aTer > 0.5;
  if(!_showTer) g.debris.rotation.y += dt*0.006;   // only spin when terrain is NOT showing
  g.cloud.rotation.y += dt*0.012;
  // 1) debris ring — fades OUT well before the terrain swap point to prevent overlap flicker
  const aDebris=1-sstep(r*10, r*22, surf);   // fade out earlier so it never overlays the planet
  g.debris.material.opacity=0.035*aDebris; g.debris.visible=aDebris>0.02 && surf>r*10 && !_showTer;
  // 2) cloud shell
  const aCloud=1-sstep(r*1.8, r*4.2, surf);
  if(near._isGas){
    var _aGas=1-sstep(r*1.2, r*6, surf);   // 0 far -> 1 near the surface
    g.cloud.material.opacity=Math.min(0.92,0.25+0.67*_aGas); g.cloud.visible=_aGas>0.02; g.cloud.material.depthWrite=false;
    if(g.cloud2){ g.cloud2.position.copy(near.pos); g.cloud2.material.opacity=Math.min(0.85,0.18+0.6*_aGas); g.cloud2.visible=_aGas>0.04; g.cloud2.rotation.y+=dt*0.030; }
  } else {
    // LAYERED FLY-THROUGH CLOUDS: each deck fades to nothing as you pass through it (no wall), stays visible above/below
    var _camD=surf+r, _atm=1-sstep(r*0.04, r*2.4, surf);
    var _deck=function(mesh,Rd){ if(!mesh||!mesh.material) return; mesh.position.copy(near.pos); var _dd=Math.abs(_camD-Rd); var _thru=Math.min(1,_dd/(r*0.012)); var _op=_atm*_thru*0.5; mesh.material.opacity=_op; mesh.visible=_op>0.01; };
    _deck(g.cloud, r*1.05); _deck(g.cloud3, r*1.10);
    if(g.cloud3) g.cloud3.rotation.y += dt*0.008;
  }
  // 3) terrain — HARD LOD SWAP: base sphere OR terrain, never both
  var _terReady = !g._bake;   // terrain only reveals once its chunked bake has finished
  g.terrain.visible=_showTer && _terReady;
  if(g.patch){ g.patch.visible = _terReady && _showTer && surf < r*0.6 && !g._bake; }   // patch only near the surface
  g.water.visible=false;
  // when terrain shows, drop the base sphere's glow/emissive so the lit surface shows
  if(near.mesh) {
    near.mesh.visible = true; // KEEP visible (fixes invisible planet ball)
    if(near.mesh.material) {
       if (_showTer && _terReady) {
           near.mesh.material.emissiveIntensity = 0; // fixes glowing dot when close
       } else {
           near.mesh.material.emissiveIntensity = 0.05 + (1-aTer)*0.13;
       }
    }
  }
  // ── 4) SKY DOME — follows the camera, fades in on the surface ──
  if(g.sky){
    const skyFade = 1-sstep(r*0.03, r*0.4, surf);   // sky only when basically landed (no bleed over approach)
    g.sky.position.copy(cp);   // sky dome always centered on camera (floating-origin safe)
    g.sky.visible = skyFade > 0.01;
    if(g.skyMat){
      g.skyMat.uniforms.uHorizon.value = skyFade * 0.7;
      g.skyMat.uniforms.uUp.value.copy(cp).sub(near.pos).normalize();
      if(NS._sunDir){ g.skyMat.uniforms.uSun.value.copy(NS._sunDir); }
    }
  }
  // ── 5) GROUND SCATTER — repositioned near camera on surface ──
  if(g.scatter){
    const scatFade = 1-sstep(r*0.008, r*0.10, surf);
    g.scatter.material.opacity = scatFade * 0.6;
    g.scatter.visible = false;  // DISABLED: rendered as blue blocks + didn't co-rotate; rebuild properly later
    if(g.scatter.visible){
      // position the scatter cloud at camera's projected surface point
      const toCenter = cp.clone().sub(near.pos).normalize();
      g.scatter.position.copy(near.pos).addScaledVector(toCenter, r*1.006);
      // orient scatter so "up" is the radial direction
      g.scatter.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), toCenter);
    }
  }
}


function nsPollGamepad(dt){
  if(typeof navigator==='undefined' || !navigator.getGamepads) return;
  // one-time connect/disconnect feedback so detection is VISIBLE in the status line
  if(!NS._gpListen){ NS._gpListen=true;
    window.addEventListener('gamepadconnected', function(e){ NS._gpName=(e.gamepad&&e.gamepad.id)||'controller';
      var s=document.getElementById('ns-status'); if(s) s.textContent='Controller connected: '+NS._gpName; });
    window.addEventListener('gamepaddisconnected', function(){ NS._gpName=null;
      var s=document.getElementById('ns-status'); if(s) s.textContent='controller disconnected'; });
  }
  if(!NS.active) return;
  const c=NS.cam; if(!c) return;
  const pads=navigator.getGamepads(); let gp=null;
  for(let i=0;i<pads.length;i++){ if(pads[i]){ gp=pads[i]; break; } }   // first non-null (don't require .connected)
  if(!gp){ if(NS._gpKeys && NS.keys){ for(let i=0;i<NS._gpKeys.length;i++) NS.keys[NS._gpKeys[i]]=false; } NS._gpKeys=[]; return; }
  const ax=gp.axes||[], DZ=0.26, dz=(v)=>(Math.abs(v)<DZ?0:v);
  const btn=(i)=> !!(gp.buttons && gp.buttons[i] && gp.buttons[i].pressed);

  // Detect first active press/move for robust connection reporting
  if (!NS._gpSeen && ((gp.buttons && gp.buttons.some(b => b.pressed)) || ax.some(a => Math.abs(a) > 0.1))) {
    NS._gpSeen = true;
    var s=document.getElementById('ns-status'); 
    if(s) s.textContent = 'Controller active: ' + gp.id;
  }

  // Axis mapping fallback
  let axesMap = window.KAIVERSE_PAD_AXES;
  if (!axesMap) {
    axesMap = (gp.mapping === 'standard' || ax.length <= 4) ? [0, 1, 2, 3] : [0, 1, 5, 2];
  }

  // RIGHT STICK = look
  const rx=dz(ax[axesMap[2]]||0), ry=dz(ax[axesMap[3]]||0);
  if(rx||ry){ if(c.mode!=='fly' && c.mode!=='walk'){ c.mode='fly'; NS.flyTo=null; NS.followNid=null; }
    let turnScale = 1.0;
    if (NS.cam && NS.cam.vel) {
      let ratio = Math.min(1.0, NS.cam.vel.length() / (25000000 * 16 * 80));
      turnScale = 1.0 - (ratio * 0.9);
    }
    c.yaw=(c.yaw||0)+rx*2.4*dt*turnScale; c.pitch=Math.max(-1.45,Math.min(1.45,(c.pitch||0)-ry*2.4*dt*turnScale)); }
  // LEFT STICK = move (drives the same NS.keys WASD uses)
  if(!NS.keys) NS.keys={};
  if(NS._gpKeys){ for(let i=0;i<NS._gpKeys.length;i++) NS.keys[NS._gpKeys[i]]=false; }
  NS._gpKeys=[];
  const lx=dz(ax[axesMap[0]]||0), ly=dz(ax[axesMap[1]]||0);

  // Live diagnostic readout
  if(NS._gpSeen && window.KAIVERSE_DEBUG_PAD) {
    var stat=document.getElementById('ns-status'); 
    if(stat) stat.textContent = `PAD: ${gp.mapping||'none'} | L: ${lx.toFixed(2)},${ly.toFixed(2)} | R: ${rx.toFixed(2)},${ry.toFixed(2)}`;
  }

  NS._gpMag=Math.min(1, Math.hypot(lx,ly));   // ANALOG: stick magnitude → proportional thrust (light push = slow cruise)
  if(lx||ly){ if(c.mode!=='fly' && c.mode!=='walk'){ c.mode='fly'; NS.flyTo=null; } NS._autopilot=false; }   // Touch stick cancels autopilot
  if(ly<0){ NS.keys['w']=true; NS._gpKeys.push('w'); } else if(ly>0){ NS.keys['s']=true; NS._gpKeys.push('s'); }
  if(lx<0){ NS.keys['a']=true; NS._gpKeys.push('a'); } else if(lx>0){ NS.keys['d']=true; NS._gpKeys.push('d'); }
  if(btn(5)){ NS.keys['e']=true; NS._gpKeys.push('e'); }   // RB = up
  if(btn(4)){ NS.keys['q']=true; NS._gpKeys.push('q'); }   // LB = down
  if(btn(10)){ NS.keys['shift']=true; NS._gpKeys.push('shift'); }   // L3 (left-stick click) = run
  // Manual throttle removed
  if(!NS._gpPrev) NS._gpPrev={};
  const edge=(i)=>{ const p=btn(i), was=NS._gpPrev[i]; NS._gpPrev[i]=p; return p&&!was; };
  const eA=edge(0), eB=edge(1); edge(2); const eY=edge(3);   // X polled; Y = land/walk
  const eDpadDown=edge(13);
  if(eDpadDown){ NS._autopilot = !NS._autopilot; } // Toggle Autopilot
  if(eA && NS.cam && NS.cam.mode==='walk'){
    if(NS.keys) NS.keys[' ']=true; if(NS._gpKeys) NS._gpKeys.push(' ');   // A = jump on the surface
  } else if(eA && (!NS.cam || NS.cam.mode !== 'fly')){
    try{ const cam=NS.camera, wrap=$('ns-wrap');
      if(cam && wrap){ const r=wrap.getBoundingClientRect(), vv=new THREE.Vector3(); let best=null,bd=1e9;
        for(let i=0;i<NS.nodes.length;i++){ const n=NS.nodes[i]; if(!n.pos) continue;
          if(!(n.kind==='core'||n.kind==='bot'||n.kind==='engine'||n.kind==='channels')) continue;
          vv.copy(n.pos).project(cam); if(vv.z>1) continue;
          const px=(vv.x*0.5+0.5)*r.width, py=(-vv.y*0.5+0.5)*r.height;
          const d=Math.hypot(px-r.width/2,py-r.height/2); if(d<bd){ bd=d; best=n; } }
        if(best){ NS.gpsTarget=best.id; if(typeof nsOpenNodePanel==='function') nsOpenNodePanel(best.id); } } }catch(_){}
  }
  if(eB){   // B = BACK / CANCEL (context-dependent, never teleport-to-core)
    var _bHandled=false;
    // Close quest board if open
    if(NS.Quest && NS.Quest.board && typeof nsQuestCloseBoard==='function'){ nsQuestCloseBoard(); _bHandled=true; }
    // Close node info panel if visible
    if(!_bHandled){ var _ep=document.getElementById('ns-edge-panel'); if(_ep && _ep.style.display!=='none' && _ep.offsetParent!==null){ _ep.style.display='none'; _bHandled=true; } }
    // Otherwise: do nothing (no surprise teleport)
  }
  if(edge(11)){ NS._thirdPerson=!NS._thirdPerson; NS._chasePos=null; var _vs=document.getElementById('ns-status'); if(_vs) _vs.textContent=(NS._thirdPerson?'3rd person':'1st person'); }   // R3 (right-stick click) = toggle view
  if(eY){   // Y = LAND on the surface / take off again
    if(c.mode==='walk'){ c.mode='fly'; NS._jumpV=0; }
    else if(NS._nearPlanet && NS.camera){ const _pd=NS.camera.position.distanceTo(NS._nearPlanet.pos)-(NS._nearPlanet.r||1);
      if(_pd < (NS._nearPlanet.r||1)*0.9){ NS._walkPlanet=NS._nearPlanet; NS._jumpV=0; c.pitch=0; c.mode='walk'; } } }
}

function nsTick(ts){
  if(!NS.active || !NS.three || NS.paused || NS.ctxLost){ NS.raf=null; return; }
  const dt=Math.min(0.05,(ts-(NS.lastFrame||ts))/1000); NS.lastFrame=ts;
  const t=(ts-NS.born)/1000;

  // ── KEPLERIAN ORBITS ── planets and main nodes physically orbit the sun (0,0,0)
  for(let i=0; i<NS.nodes.length; i++) {
    const n = NS.nodes[i];
    if (n && n.pos && (n.kind === 'bot' || n.kind === 'engine' || n.kind === 'provider' || n.kind === 'channels')) {
      const dist = n.pos.length();
      if(dist > 1000) { // Don't orbit the core itself
        const GM = 8e14 * NS_SCALE; // Tuning mass for good visual speeds
        const w = Math.sqrt(GM / Math.pow(dist, 3));
        const angleDelta = w * dt;
        const cosA = Math.cos(angleDelta);
        const sinA = Math.sin(angleDelta);
        const nx = n.pos.x * cosA - n.pos.z * sinA;
        const nz = n.pos.x * sinA + n.pos.z * cosA;
        n.pos.x = nx;
        n.pos.z = nz;
        if(n.mesh) n.mesh.position.copy(n.pos);
        if(n.label) n.label.position.set(n.pos.x, n.pos.y+(n.r||1)+(n.kind==='world'?22:10)*NS_SCALE, n.pos.z);
        if(n.halo) n.halo.position.copy(n.pos);
      }
    }
  }

  // ── N-BODY GRAVITY (owner #2) ── all massive bodies (core/engine/bots/providers/
  // channels + cosmos worlds) now DRIFT under mutual softened gravity instead of
  // fixed orbits. Black holes pull, white holes push. Bounded + speed-capped so the
  // cosmos never collapses to the core or flings to infinity. Stepped AFTER boids
  // below so it can reuse the per-frame hole list (NS._boidHoles).
  // (bodies NOT in the gravity mesh still get a gentle self-spin here)
  for(const n of NS.nodes){ 
    if(n.mesh && n.kind!=='bot' && n.kind!=='core' && n.kind!=='engine' && n.kind!=='provider' && n.kind!=='channels'){ 
      // Do not rotate the planet if the player is currently walking on it (prevents violent spinning camera drift)
      const isWalkingOnThis = NS.cam && NS.cam.mode === 'walk' && (NS._walkPlanet === n || NS._nearPlanet === n);
      if (!isWalkingOnThis) {
        n.mesh.rotation.y += dt*0.15*NS_SPIN_SLOW; 
      }
    } 
  }
  // WHITE HOLES — pulse the ejection shader, decay non-ambient ones out
  if(NS.whiteHoles && NS.whiteHoles.length){
    const keep=[];
    for(const w of NS.whiteHoles){
      const age=(performance.now()-w.born)/1000;
      w.mat.uniforms.uT.value=t;
      if(w.disc&&NS.camera){ w.disc.lookAt(NS.camera.position); }   // billboard the disc
      const fade=w.ambient?1:(age<1?age:(age>w.life-4?Math.max(0,(w.life-age)/4):1));
      w.mat.opacity=fade; if(w.halo) w.halo.material.opacity=0.7*fade;
      if(!w.ambient && age>=w.life){ nsDisposeWhiteHole(w); } else keep.push(w);
    }
    NS.whiteHoles=keep;
  }
  // WORMHOLES — spin the portal swirl + keep rings facing the camera
  if(NS.wormholes && NS.wormholes.length){
    for(const w of NS.wormholes){
      // spin the swirl shader + slowly rotate the 3D mouth/tunnel about its own axis.
      // NO camera billboard — these are real 3D portals now (depth from any angle).
      if(w.pa){ w.pa.mat.uniforms.uT.value=t; if(w.pa.disc) w.pa.disc.rotation.z = t*0.6; if(w.pa.mouth) w.pa.mouth.rotation.z = -t*0.25; }
      if(w.pb){ w.pb.mat.uniforms.uT.value=t; if(w.pb.disc) w.pb.disc.rotation.z = t*0.6; if(w.pb.mouth) w.pb.mouth.rotation.z = -t*0.25; }
    }
  }
  // BLACK HOLES — accretion ring spin + lensing pulse, decay out then dispose
  if(NS.blackHoles && NS.blackHoles.length){
    const keep=[];
    for(const b of NS.blackHoles){
      const age=(performance.now()-b.born)/1000; b.ring.rotation.z += dt*b.spin;
      const fade=age<1?age:(age>b.life-4?Math.max(0,(b.life-age)/4):1);
      // event horizon GROWS in (scale, not opacity — it stays opaque-black to occlude)
      b.core.scale.setScalar(Math.max(0.001, fade));
      b.ring.material.opacity=0.65*fade;
      if(b.photon){ b.photon.quaternion.copy(b.ring.quaternion); b.photon.material.opacity=0.3*fade*(0.85+0.15*Math.sin(t*4)); }
      b.halo.material.opacity=(0.2*(b.lens||0.5)+0.05)*fade*(0.8+0.2*Math.sin(t*3));
      const hp=b.r*(3+(b.lens||0.5)*2.0)*(1+0.05*Math.sin(t*2)); b.halo.scale.set(hp,hp,1);
      if(age>=b.life){ nsDisposeBlackHole(b); } else keep.push(b);
    }
    NS.blackHoles=keep;
  }
  // edges follow the moving planets (rewrite line positions)
  const lg=NS.three.lineGeo;
  if(lg){ const pa=lg.attributes.position.array;
    NS.edges.forEach((e,i)=>{ const A=NS.nodeById[e.a].pos, B=NS.nodeById[e.b].pos; pa.set([A.x,A.y,A.z,B.x,B.y,B.z], i*6); });
    lg.attributes.position.needsUpdate=true;
  }

  // decay edge health (beams flare on traffic, then fade toward invisible)
  for(const e of NS.edges){ if(e.healthV>0){ e.healthV=Math.max(0, e.healthV-dt*0.10); if(e.healthV<0.06 && e.health!=='ok') e.health='ok'; } }

  // CONNECTION BEAMS track live traffic: recompute the per-vertex colour buffer
  // every frame so each link brightens the instant a signal bumps its healthV
  // and fades to invisible as healthV decays. Cheap: one buffer write, one draw call.
  nsRebuildEdgeColors();

  // advance 3D pulses → render each as a LASER BOLT streaking along its curved path
  const alive=[];
  // shared beam buffer: one bright additive segment (tail→head) per active pulse
  if(!NS.three.pulseBeams){
    const cap=140, bg=new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap*6),3));
    bg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap*6),3));
    const bm=new THREE.LineBasicMaterial({vertexColors:true, transparent:true, opacity:0.95, blending:THREE.AdditiveBlending, depthWrite:false});
    const beams=new THREE.LineSegments(bg,bm); beams.frustumCulled=false; NS.scene.add(beams);
    NS.three.pulseBeams=beams; NS.three.pulseBeamGeo=bg;
  }
  const _bgeo=NS.three.pulseBeamGeo, _bpos=_bgeo.attributes.position.array, _bcol=_bgeo.attributes.color.array;
  if(!NS._pulseCol) NS._pulseCol=new THREE.Color();
  let _bi=0;
  for(const p of NS.pulses){
    p.t += p.speed*dt;
    if(p.t>=1){ if(p.spr){ p.spr.visible=false; nsPulsePool.push(p.spr); } continue; }
    alive.push(p);
    const A=NS.nodeById[p.fromId].pos, B=NS.nodeById[p.toId].pos;
    if(!p.spr){ p.spr=nsAcquirePulse(); }
    p.spr.visible=true; p.spr.material.color.set(p.color);
    // CURVED pulse path: quadratic Bezier bowed perpendicular to A→B; bend ∝ distance
    // so long signal paths arc (light bending around mass) while short hops stay near-straight.
    if(p._bx===undefined){
      const dx=B.x-A.x, dy=B.y-A.y, dz=B.z-A.z, dl=Math.hypot(dx,dy,dz)||1;
      let ux=0,uy=1,uz=0; if(Math.abs(dy)>0.9*dl){ ux=1;uy=0;uz=0; }
      let q1x=dy*uz-dz*uy, q1y=dz*ux-dx*uz, q1z=dx*uy-dy*ux; const l1=Math.hypot(q1x,q1y,q1z)||1; q1x/=l1;q1y/=l1;q1z/=l1;
      let q2x=dy*q1z-dz*q1y, q2y=dz*q1x-dx*q1z, q2z=dx*q1y-dy*q1x; const l2=Math.hypot(q2x,q2y,q2z)||1; q2x/=l2;q2y/=l2;q2z/=l2;
      const ang=Math.random()*Math.PI*2;
      p._bx=Math.cos(ang)*q1x+Math.sin(ang)*q2x; p._by=Math.cos(ang)*q1y+Math.sin(ang)*q2y; p._bz=Math.cos(ang)*q1z+Math.sin(ang)*q2z;
    }
    const _dx=B.x-A.x, _dy=B.y-A.y, _dz=B.z-A.z, _dist=Math.hypot(_dx,_dy,_dz);
    const _bend=Math.min(_dist*0.22, 80*NS_SCALE*Math.sqrt(NS_SPREAD));
    const _Mx=(A.x+B.x)*0.5+p._bx*_bend, _My=(A.y+B.y)*0.5+p._by*_bend, _Mz=(A.z+B.z)*0.5+p._bz*_bend;
    const _it=1-p.t, _w0=_it*_it, _w1=2*_it*p.t, _w2=p.t*p.t;
    const hx=A.x*_w0+_Mx*_w1+B.x*_w2, hy=A.y*_w0+_My*_w1+B.y*_w2, hz=A.z*_w0+_Mz*_w1+B.z*_w2;
    p.spr.position.set(hx,hy,hz);
    const s=(p.status==='error'?8:6)*NS_SCALE*Math.sqrt(NS_SPREAD); p.spr.scale.set(s,s,1);
    // LASER BOLT: a bright segment from just behind the head to the head, along the curve
    const tb=Math.max(0,p.t-0.14), ti=1-tb, t0=ti*ti, t1=2*ti*tb, t2=tb*tb;
    const tx=A.x*t0+_Mx*t1+B.x*t2, ty=A.y*t0+_My*t1+B.y*t2, tz=A.z*t0+_Mz*t1+B.z*t2;
    if(_bi<140){
      NS._pulseCol.set(p.color); const o=_bi*6;
      _bpos[o]=tx;_bpos[o+1]=ty;_bpos[o+2]=tz; _bpos[o+3]=hx;_bpos[o+4]=hy;_bpos[o+5]=hz;
      _bcol[o]=NS._pulseCol.r*0.12;_bcol[o+1]=NS._pulseCol.g*0.12;_bcol[o+2]=NS._pulseCol.b*0.12;   // tail dim
      _bcol[o+3]=NS._pulseCol.r;_bcol[o+4]=NS._pulseCol.g;_bcol[o+5]=NS._pulseCol.b;                 // head bright
      _bi++;
    }
  }
  NS.pulses=alive;
  if(NS.three.pulseBeamGeo){ NS.three.pulseBeamGeo.setDrawRange(0,_bi*2);
    NS.three.pulseBeamGeo.attributes.position.needsUpdate=true; NS.three.pulseBeamGeo.attributes.color.needsUpdate=true; }

  // BOIDS ambient flock (data motes) — separation/alignment/cohesion + holes.
  // This builds NS._boidHoles (the live black/white-hole list) which the N-body
  // step below reuses, so run boids FIRST.
  nsStepBoids(dt, t);
  // N-BODY GRAVITY — drift all massive bodies (owner #2). Reuses NS._boidHoles.
  nsStepGravity(dt);
  // PULSARS — spin beams + fire periodic PUSH pulses (impulse on nearby bodies, owner #2)
  nsStepPulsars(dt);
  // AI SPACESHIPS — inhabitants orbit home + fly planet→planet, dodging (owner #3)
  nsStepShips(dt);
  // twinkle the GPU starfield
  if(NS.three.starMat) NS.three.starMat.uniforms.uT.value=t;
  if(NS._skyboxMat) {
    NS._skyboxMat.uniforms.uT.value = t;
    if(NS.camera) NS._skyboxMesh.position.copy(NS.camera.position);
  }
  { var _sp=(NS._skyProx||0) * (NS._dayLight||1.0);   // ATMOSPHERE: fade space (stars+nebula+bg) ONLY during daytime! Nighttime retains the stars.
    if(NS._starOpBase==null && NS.three.starMat) NS._starOpBase=(NS.three.starMat.opacity!=null?NS.three.starMat.opacity:1);
    if(NS.three.starMat && NS._starOpBase!=null) NS.three.starMat.opacity=NS._starOpBase*(1-_sp);
    if(NS.nebula && NS.nebula.material){ if(NS._nebOpBase==null) NS._nebOpBase=NS.nebula.material.opacity; NS.nebula.material.opacity=NS._nebOpBase*(1-_sp); }
    if(NS._skyboxMat){ if(NS._skyOpBase==null) NS._skyOpBase=NS._skyboxMat.opacity; NS._skyboxMat.opacity=NS._skyOpBase*(1-_sp); }
  }
  // nebula slow rotation + 4D-time expansion (subtle, real-time)
  if(NS.nebula){
    NS.nebula.rotation.y += dt*0.02;
    const grow=1 + Math.min(0.25, t/600); // expands very slowly over minutes
    const s=NS.nebulaBaseSpread*grow; NS.nebula.scale.set(s,s,s);
  }
  nsStepGas(t);              // drift/curl the soft gas billboards (owner #2)
  nsStepSectors();           // infinite procedural sectors follow the camera (owner #1)
  // core pulse
  const core=NS.nodeById['core']; if(core&&core.mesh){ const b=1+0.012*Math.sin(t*1.4); core.mesh.scale.set(b,b,b); }

  nsFloatingOrigin();          // recenter the universe on the camera for precision, before any position logic
  nsPollGamepad(dt);
  nsUpdateCamera(dt);
  nsUpdateAtmoFog(dt);          // atmospheric entry haze — density ramps as you descend into a body
  nsPaintMarkers();          // every frame so labels track bodies (no lag/trailing)
  nsPaintCompass();          // Skyrim-style bearing strip (top-center) for place-nodes + GPS target
  nsQuestUpdate(dt);         // QUEST: advance the active mission (travel→repair→return), keep the beam lit
  nsUpdateBodyLOD();         // fade halos up close (glow→surface) + live panel distance
  nsUpdatePlanetDescent();   // DESCENT LOD: nearest planet only → orbital debris → cloud shell → terrain+water as you fly down
  nsUpdateWarp(dt);          // speed-illusion: streak stars + widen FOV at peak speed
  nsStreamAmbient();         // toroidal-wrap star+debris field around the camera (infinite, item 10)
  nsUpdateFieldLOD();        // LOD STREAMING: fade far asteroid/debris/blob/belt fields, gas, planets in by camera distance (no popping)
  NS._chaseDt=dt;                 // pass dt to the chase-cam lerp
  nsPlayerShipPre();               // 3rd-person: offset camera behind ship (before render)
  nsRenderBloom();
  nsPlayerShipPost();              // restore camera to ship position (after render)

  // throttled HUD/proximity refresh (position readout + nearest-body info panel)
  NS._reAcc=(NS._reAcc||0)+dt;
  NS._posAcc=(NS._posAcc||0)+dt;
  if(NS._posAcc>0.15){ NS._posAcc=0; nsUpdatePositionHud(); nsUpdateProximity(); nsUpdateThrottleHud();
    // advance smooth growth + repaint the LIVE STATE numbers if they moved (item 12)
    if(typeof nsAdvanceGrowth==='function' && typeof nsPaintHUD==='function'){ if(nsAdvanceGrowth(0.15)){ nsPaintHUD(); nsScaleNebula(); } }
  }
  if(NS._reAcc>0.5){ NS._reAcc=0; nsUpdateCounters(); }
  // AREA MAP / radar — throttled to ~6fps so it's cheap (owner #2)
  NS._radarAcc=(NS._radarAcc||0)+dt;
  if(NS._radarAcc>0.16){ NS._radarAcc=0; nsUpdateRadar(); }
  
  // Animate procedural deep-space solar systems
  if(NS._procSystems){
    for(const sys of NS._procSystems){
      if(sys) sys.rotation.y += sys._sysSpeed * dt;
    }
  }

  // Auto-save spawn every ~10s
  NS._saveAcc=(NS._saveAcc||0)+dt;
  if(NS._saveAcc>10){ NS._saveAcc=0; nsSaveSpawn(); }
  NS.raf=requestAnimationFrame(nsTick);
}

// pulse sprite pool (capped)
const nsPulsePool=[];
function nsAcquirePulse(){
  if(nsPulsePool.length) return nsPulsePool.pop();
  const spr=new THREE.Sprite(new THREE.SpriteMaterial({map:nsMakeGlowTexture(), transparent:true, depthWrite:false, blending:THREE.AdditiveBlending}));
  NS.scene.add(spr); NS.three.pulseSprites=(NS.three.pulseSprites||[]); NS.three.pulseSprites.push(spr);
  return spr;
}

/* ── /min counters + status + HUD (REAL stats) ─────────────────────────── */
function nsUpdateCounters(){
  const now=Date.now(), cut=now-60000;
  NS.signalStamps=NS.signalStamps.filter(t=>t>=cut);
  NS.errStamps=NS.errStamps.filter(t=>t>=cut);
  const spm=$('ns-spm'); if(spm) spm.textContent=NS.signalStamps.length;
  // ERRORS/MIN — only REAL errors (handled 429s are 'warn' and excluded upstream).
  const epm=$('ns-epm'); if(epm){ epm.textContent=NS.errStamps.length; epm.style.color=NS.errStamps.length?'#f87171':'var(--muted-2)'; }
  nsRenderRecentErrors();
  const st=$('ns-status');
  if(st){
    if(!NS.signalStamps.length && !NS.pulses.length) st.textContent='KAIVERSE online · awaiting signals…';
    else st.textContent=`${NS.signalStamps.length} signals/min · ${NS.errStamps.length} errors/min · ${NS.pulses.length} pulses flowing · click a body to fly to it`;
  }
}
/* ── RECENT ERRORS readout: 'who -> to : what' newest-first; click highlights edge ──
   NO-BLINK: this used to blow away box.innerHTML twice a second (called from the rAF
   loop via nsUpdateCounters @ 0.5s), which destroyed the DOM under the cursor — the
   panel flickered and the '⤢ full' button couldn't be hovered/clicked. Now we:
     1) compute a stable signature of the visible list and SKIP the DOM write when it
        hasn't changed (the common case — errors are rare),
     2) NEVER re-render while the user is hovering the panel or has a row expanded, so
        their interaction is never yanked out from under them. A pending change is
        flushed once they move off / collapse. */
let _nsErrSig = null;          // signature of the last rendered error list
let _nsErrPending = false;     // a change arrived but we deferred it (hovered/expanded)
function _nsErrSignature(list){
  return list.map(e => (e.ts||'')+'|'+(e.from||e.who||'')+'|'+(e.to||'')+'|'+((e.full||e.detail||e.type||'').length)).join('~');
}
function _nsErrBusy(box){
  // Busy = pointer is anywhere over the panel (header/padding/list), OR any
  // full-message drawer is open. We check the OUTER panel (#ns-errbox), not just
  // the list, so hovering the title/edges still defers the re-render — the owner's
  // interaction is never yanked out from under them (owner complaint #4).
  const panel=document.getElementById('ns-errbox');
  if(panel && panel.matches && panel.matches(':hover')) return true;
  if(box.matches && box.matches(':hover')) return true;
  if(box.querySelector('.ns-err-full[style*="block"]')) return true;
  return false;
}
function nsRenderRecentErrors(force){
  const box=$('ns-errlist'); if(!box) return;
  // Bind the leave-to-flush handler once (the panel lives inside a view, so we wait
  // until it actually exists rather than binding at parse time).
  if(!box._noBlinkBound){ box._noBlinkBound=true;
    box.addEventListener('mouseleave', ()=>{ if(_nsErrPending && !_nsErrBusy(box)) nsRenderRecentErrors(); });
  }
  const list=(NS.recentErrors||[]).slice(0,12);
  const sig=_nsErrSignature(list);
  if(sig===_nsErrSig && !force) return;          // nothing changed → no DOM thrash
  // Don't rip the DOM out from under an active hover / expanded row; defer instead.
  if(!force && _nsErrBusy(box)){ _nsErrPending=true; return; }
  _nsErrSig=sig; _nsErrPending=false;
  if(!list.length){ box.innerHTML='<div class="ns-err-empty">No real errors — fleet healthy.</div>'; return; }
  box.innerHTML=list.map((e,i)=>{
    const t=e.ts?new Date(e.ts*1000).toLocaleTimeString():'';
    const full=e.full||e.detail||e.type||'error';
    const short=(e.detail||e.type||'error');
    const hasMore = full.length > 90 || (e.raw && e.raw.length);
    const who=e.from||e.who||'?';
    // Row: click the body to HIGHLIGHT the 3D edge (existing behaviour). The ⤢/View
    // buttons expand the FULL untruncated message inline + jump to filtered logs.
    return '<div class="ns-err-row" title="Click path to highlight the failing connection">'
      +'<div onclick="nsFocusError('+i+')" style="cursor:pointer">'
        +'<div class="ns-err-path">'+esc(who)+' → '+esc(e.to||'engine')
          +(hasMore?' <span style="float:right;color:var(--accent);font-size:9px" onclick="event.stopPropagation();nsToggleErr('+i+')">⤢ full</span>':'')+'</div>'
        +'<div class="ns-err-what">'+esc(short.slice(0,90))+'</div>'
        +'<div class="ns-err-time">'+esc(t)+'</div>'
      +'</div>'
      +'<div class="ns-err-full" id="ns-err-full-'+i+'" style="display:none;margin-top:5px;padding:6px 8px;background:rgba(0,0,0,0.35);border:1px solid var(--border);border-radius:6px;font-family:var(--mono);font-size:10px;line-height:1.5;color:var(--txt);white-space:pre-wrap;word-break:break-word">'+esc(full)
        +(e.raw&&e.raw!==full?'<div style="margin-top:5px;color:var(--muted-2);font-size:9px">raw: '+esc(e.raw)+'</div>':'')
        +'<div style="margin-top:6px"><button class="mini-btn" style="cursor:pointer;color:var(--accent);font-size:9.5px;padding:2px 6px" onclick="jumpToLogs(\''+esc(who).replace(/'/g,"\\'")+'\',\''+esc(full.slice(0,60)).replace(/'/g,"\\'")+'\')">View logs →</button></div>'
      +'</div></div>';
  }).join('');
}
function nsToggleErr(i){
  const d=$('ns-err-full-'+i); if(!d) return;
  d.style.display = d.style.display==='none'?'block':'none';
  // Collapsing the last open drawer un-busies the panel → flush any deferred update.
  if(d.style.display==='none' && _nsErrPending && !_nsErrBusy($('ns-errlist'))) nsRenderRecentErrors();
}
/* Highlight the edge + nodes for a clicked RECENT ERROR (the 'red line from who'). */
function nsFocusError(i){
  const e=(NS.recentErrors||[])[i]; if(!e) return;
  const fromId=e.fromId||nsResolve(e.from||e.who), toId=e.toId||nsResolve(e.to);
  const edge=fromId&&toId?NS.edgeKey[fromId+'|'+toId]:null;
  if(edge){ edge.health='error'; edge.healthV=1; edge.lastTs=Date.now(); }
  // set the source node as the GPS target + open its vitals panel so the owner
  // sees WHICH bot/connection failed — NO instant teleport across space.
  const targetId=(fromId&&NS.nodeById[fromId])?fromId:((toId&&NS.nodeById[toId])?toId:null);
  if(targetId){ NS.gpsTarget=targetId; if(typeof nsOpenNodePanel==='function'){ try{ nsOpenNodePanel(targetId); }catch(_){} } }
  if(typeof nsQuestAcceptErr==='function'){ try{ nsQuestAcceptErr(e); }catch(_){} }   // clicking a RECENT ERROR starts its mission
}

/* ════════════════════════════════════════════════════════════════════════
   KAIVERSE QUEST SYSTEM (#76) — turn live lattice errors into missions.
   Y opens the MISSION BOARD (browse the real errors). Enter / Ⓐ accepts →
   voice briefing (browser TTS) + on-screen subtitles + a procedural storyline,
   the failing link lights up as a RED BEAM, the compass points you to the
   fault. Reach it, hold to STABILIZE, then fly to the AI who raised it to
   REPORT and earn credits. Self-contained: reads NS.recentErrors / nodeById /
   edgeKey / gpsTarget; reuses the existing red error-edge + compass.
   ════════════════════════════════════════════════════════════════════════ */
NS.Quest = { board:false, sel:0, active:null, list:[], credits:0, done:0, _gpPrev:{}, _ui:false };
function nsQEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c];}); }
function nsQuestNode(id){ return id?NS.nodeById[id]:null; }
function nsQuestAiFor(err){
  var id=err.fromId||nsResolve(err.from||err.who)||err.toId||nsResolve(err.to);
  var n=nsQuestNode(id);
  return { id:id, name:(n&&n.name)||err.from||err.who||'the lattice' };
}
// Procedural storyline (seeded by the error → stable wording for the same fault).
function nsQuestBrief(err, aiName){
  var what=(err.type||'fault').toString().replace(/_/g,' ');
  var detail=(err.detail||err.full||'').toString().slice(0,90);
  var h=(typeof nsHashStr==='function')?nsHashStr((err.type||'')+(err.from||'')+(err.to||'')+(err.ts||'')):(Math.random()*1e9|0);
  var openers=[
    aiName+' is bleeding signal. A '+what+' tore open on the '+(err.from||'?')+' to '+(err.to||'engine')+' link.',
    'Distress from '+aiName+'. The '+(err.from||'?')+' to '+(err.to||'engine')+' channel threw a '+what+'.',
    aiName+' cannot hold the line. A '+what+' is corrupting traffic bound for '+(err.to||'the engine')+'.'
  ];
  var orders=[
    'Follow the red beam to the fault, hold position to stabilize it, then return to '+aiName+' to report.',
    'Ride the red beam down to the break, steady the link, then carry word back to '+aiName+'.',
    'Trace the red beam to the rupture, lock it down, and report in to '+aiName+'.'
  ];
  var line=openers[(h>>>0)%openers.length]+' '+orders[(h>>>3)%orders.length];
  if(detail) line+=' Log reads: '+detail+'.';
  return line;
}
// Speak (browser TTS) + show a fading subtitle.
function nsQuestSay(text, sub){
  try{
    if(window.speechSynthesis){
      var u=new SpeechSynthesisUtterance(text); u.rate=0.97; u.pitch=1.0; u.volume=1.0;
      var vs=window.speechSynthesis.getVoices();
      if(vs&&vs.length){
        var prefer=['Google US English','Microsoft Aria','Microsoft Jenny','Microsoft Guy','Natural','Google UK English Male','Samantha','Daniel'];
        var pick=null, pi;
        for(pi=0; pi<prefer.length && !pick; pi++){ pick=vs.filter(function(v){return v.name && v.name.indexOf(prefer[pi])>=0;})[0]; }
        if(!pick) pick=vs.filter(function(v){return /en/i.test(v.lang) && /(natural|neural|google|aria|jenny|guy|samantha)/i.test(v.name||'');})[0];
        if(!pick) pick=vs.filter(function(v){return /en/i.test(v.lang);})[0];
        if(pick) u.voice=pick;
      }
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    }
  }catch(_){}
  nsQuestSub(sub!=null?sub:text);
}
function nsQuestSub(text){
  nsQuestUI(); var el=document.getElementById('kv-quest-sub'); if(!el) return;
  el.textContent=text; el.style.opacity='1';
  clearTimeout(el._t); var dur=Math.max(3200, Math.min(11000, (''+text).length*55));
  el._t=setTimeout(function(){ el.style.opacity='0'; }, dur);
}
function nsQuestUI(){
  if(NS.Quest._ui) return; var wrap=document.getElementById('ns-wrap'); if(!wrap) return;
  var css=document.createElement('style'); css.textContent=
    '#kv-quest-hud{position:absolute;top:96px;left:50%;transform:translateX(-50%);z-index:9;'
   +'min-width:260px;max-width:60vw;padding:9px 14px;border:1px solid rgba(255,90,90,0.5);'
   +'border-radius:11px;background:rgba(14,10,16,0.80);backdrop-filter:blur(9px);text-align:center;'
   +'font-family:var(--mono);box-shadow:0 6px 26px rgba(0,0,0,0.5);display:none}'
   +'#kv-quest-hud .kvq-h{font-size:11px;letter-spacing:1px;color:#ff7a7a;font-weight:700}'
   +'#kv-quest-hud .kvq-b{font-size:14px;color:#fff;margin-top:3px}'
   +'#kv-quest-hud .kvq-t{font-size:10px;color:#9aa;margin-top:2px;opacity:0.8}'
   +'#kv-quest-sub{position:absolute;bottom:96px;left:50%;transform:translateX(-50%);z-index:10;'
   +'max-width:74vw;padding:10px 18px;border-radius:12px;background:rgba(0,0,0,0.66);color:#fff;'
   +'font-family:var(--mono);font-size:15px;line-height:1.45;text-align:center;opacity:0;'
   +'transition:opacity 0.5s;text-shadow:0 1px 3px #000;pointer-events:none}'
   +'#kv-quest-board{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:30;'
   +'width:min(560px,86vw);max-height:70vh;overflow:auto;padding:16px;border:1px solid rgba(255,90,90,0.4);'
   +'border-radius:14px;background:rgba(10,8,14,0.95);backdrop-filter:blur(14px);'
   +'font-family:var(--mono);box-shadow:0 18px 60px rgba(0,0,0,0.7);display:none}'
   +'#kv-quest-board h3{margin:0 0 4px;color:#ff7a7a;font-size:15px;letter-spacing:1px}'
   +'#kv-quest-board .kvq-hint{font-size:11px;color:#8a90a0;margin-bottom:12px}'
   +'#kv-quest-board .kvq-row{padding:9px 11px;border:1px solid var(--border);border-radius:9px;'
   +'margin-bottom:7px;cursor:pointer;background:rgba(255,255,255,0.02)}'
   +'#kv-quest-board .kvq-row.sel{border-color:#ff7a7a;background:rgba(255,90,90,0.13)}'
   +'#kv-quest-board .kvq-row .r1{font-size:13px;color:#fff;font-weight:600}'
   +'#kv-quest-board .kvq-row .r2{font-size:11px;color:#9aa;margin-top:2px}'
   +'#kv-quest-board .kvq-empty{color:#8a90a0;font-size:13px;padding:14px;text-align:center}';
  document.head.appendChild(css);
  var hud=document.createElement('div'); hud.id='kv-quest-hud'; wrap.appendChild(hud);
  var sub=document.createElement('div'); sub.id='kv-quest-sub'; wrap.appendChild(sub);
  var bd=document.createElement('div'); bd.id='kv-quest-board'; wrap.appendChild(bd);
  NS.Quest._ui=true;
}
function nsQuestToggleBoard(){ if(NS.Quest.board) nsQuestCloseBoard(); else nsQuestOpenBoard(); }
function nsQuestOpenBoard(){
  nsQuestUI(); var Q=NS.Quest; Q.board=true; Q.sel=0;
  var seen={}, list=[];
  (NS.recentErrors||[]).forEach(function(e){ var key=(e.from||e.who)+'|'+(e.to)+'|'+(e.type); if(seen[key])return; seen[key]=1; list.push(e); });
  Q.list=list.slice(0,8);
  var el=document.getElementById('kv-quest-board'); if(el) el.style.display='block';
  nsQuestRenderBoard();
}
function nsQuestCloseBoard(){ NS.Quest.board=false; var el=document.getElementById('kv-quest-board'); if(el) el.style.display='none'; }
function nsQuestMove(d){ var Q=NS.Quest; if(!Q.list||!Q.list.length)return; Q.sel=(Q.sel+d+Q.list.length)%Q.list.length; nsQuestRenderBoard(); }
function nsQuestRenderBoard(){
  var Q=NS.Quest, el=document.getElementById('kv-quest-board'); if(!el) return;
  var html='<h3>&#9672; MISSION BOARD</h3><div class="kvq-hint">&#8593;&#8595; / D-pad browse &middot; Enter / &#9398; accept &middot; Esc / &#9399; close &middot; J abandons active</div>';
  if(!Q.list||!Q.list.length){ html+='<div class="kvq-empty">No active faults &mdash; the lattice is stable. &#10003;</div>'; el.innerHTML=html; return; }
  Q.list.forEach(function(e,i){
    var ai=nsQuestAiFor(e), what=(e.type||'fault').toString().replace(/_/g,' ');
    html+='<div class="kvq-row'+(i===Q.sel?' sel':'')+'" data-i="'+i+'">'
      +'<div class="r1">'+nsQEsc(ai.name)+' &middot; '+nsQEsc(what)+'</div>'
      +'<div class="r2">'+nsQEsc((e.from||e.who||'?')+' → '+(e.to||'engine'))+(e.detail?(' &mdash; '+nsQEsc(String(e.detail).slice(0,60))):'')+'</div></div>';
  });
  el.innerHTML=html;
  Array.prototype.forEach.call(el.querySelectorAll('.kvq-row'),function(row){
    row.addEventListener('click',function(){ NS.Quest.sel=parseInt(row.getAttribute('data-i'),10)||0; nsQuestRenderBoard(); nsQuestAccept(); });
  });
}
function nsQuestAcceptErr(e){
  var Q=NS.Quest; if(!Q || !e) return;
  var ai=nsQuestAiFor(e);
  var fromId=e.fromId||nsResolve(e.from||e.who), toId=e.toId||nsResolve(e.to)||'core';
  var aiId=fromId||ai.id||toId, problemId=(toId&&toId!==aiId)?toId:(fromId||'core');
  var pn=nsQuestNode(problemId), an=nsQuestNode(aiId);
  var m={ err:e, fromId:fromId, toId:toId, aiId:aiId, aiName:(an&&an.name)||ai.name,
    problemId:problemId, problemName:(pn&&pn.name)||'the fault',
    phase:'briefing', fixT:0, title:((e.type||'fault').toString().replace(/_/g,' '))+' · '+((an&&an.name)||ai.name),
    startTs:Date.now() };
  Q.active=m; nsQuestCloseBoard();
  if(fromId&&toId&&NS.edgeKey){ var ed=NS.edgeKey[fromId+'|'+toId]; if(ed){ ed.health='error'; ed.healthV=1; ed.lastTs=Date.now(); } }
  NS.gpsTarget=problemId;
  nsQuestSay('Distress signal from '+m.aiName+'. Fly to '+m.aiName+' (follow the beam) to hear what happened.', 'New mission — go to '+m.aiName);
}
function nsQuestAccept(){ var Q=NS.Quest; if(Q && Q.list && Q.list.length) nsQuestAcceptErr(Q.list[Q.sel]); }
function nsQuestAbandon(){ var Q=NS.Quest; if(Q.active){ Q.active=null; NS.gpsTarget=null; nsQuestHud(null); nsQuestSub('Mission abandoned.'); } }
function nsQuestHud(m, distStr, phase){
  nsQuestUI(); var el=document.getElementById('kv-quest-hud'); if(!el) return;
  if(!m){ el.style.display='none'; return; }
  el.style.display='block';
  var label = (phase==='briefing')?('Talk to '+m.aiName) : (phase==='return')?('Report to '+m.aiName)
           : (phase==='fix')?('Stabilizing the link — '+Math.min(100,Math.round(((m.fixT||0)/3.5)*100))+'%')
           : (phase==='done')?('Mission complete'):('Reach the fault: '+(m.problemName||'?'));
  var tag = phase==='briefing'?'BRIEFING':phase==='travel'?'TRAVEL':phase==='fix'?'REPAIR':phase==='return'?'RETURN':'DONE';
  el.innerHTML='<div class="kvq-h">&#9672; '+tag+(distStr?(' &middot; '+nsQEsc(distStr)):'')+'</div><div class="kvq-b">'+nsQEsc(label)+'</div>'
    +'<div class="kvq-t">'+nsQEsc(m.title||'')+'</div>';
}
function nsQuestUpdate(dt){
  var Q=NS.Quest; if(!Q) return; dt=dt||0.016;
  if(Q.board){
    try{
      var pads=(navigator.getGamepads&&navigator.getGamepads())||[], gp=null;
      for(var i=0;i<pads.length;i++){ if(pads[i]){ gp=pads[i]; break; } }
      if(gp){
        var up=(gp.buttons[12]&&gp.buttons[12].pressed)||(gp.axes[1]<-0.6);
        var dn=(gp.buttons[13]&&gp.buttons[13].pressed)||(gp.axes[1]>0.6);
        var a=(gp.buttons[0]&&gp.buttons[0].pressed), b=(gp.buttons[1]&&gp.buttons[1].pressed);
        var P=Q._gpPrev||{};
        if(up&&!P.up) nsQuestMove(-1);
        if(dn&&!P.dn) nsQuestMove(1);
        if(a&&!P.a) nsQuestAccept();
        if(b&&!P.b) nsQuestCloseBoard();
        Q._gpPrev={up:up,dn:dn,a:a,b:b};
      }
    }catch(_){}
  }
  var m=Q.active; if(!m){ nsQuestHud(null); if(NS._questBeam) NS._questBeam.visible=false; return; }
  var cam=NS.camera; if(!cam) return;
  if(m.fromId&&m.toId&&NS.edgeKey&&(m.phase==='travel'||m.phase==='fix')){
    var ed=NS.edgeKey[m.fromId+'|'+m.toId]||NS.edgeKey[m.toId+'|'+m.fromId];
    if(ed){ ed.health='error'; ed.healthV=1; ed.lastTs=Date.now(); }
  }
  var tgtId=(m.phase==='briefing'||m.phase==='return')?m.aiId:m.problemId; NS.gpsTarget=tgtId;
  var tn=nsQuestNode(tgtId); if(!tn||!tn.pos){ nsQuestHud(m,'—',m.phase); if(NS._questBeam) NS._questBeam.visible=false; return; }
  // QUEST BEAM: a receding TRAIL of glowing waypoint dots from YOU to the objective.
  // (Billboarded points stay visible even when you look straight down the path toward the
  //  target — unlike a 1px line, which foreshortens to a dot. red = to the fault, green = back.)
  if(!NS._questBeam && NS.scene){
    var _BN=30;
    var _bg=new THREE.BufferGeometry(); _bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(_BN*3),3));
    var _bm=new THREE.PointsMaterial({map:nsMakeGlowTexture(), color:0xff4d4d, size:NS_SCALE*5.5, sizeAttenuation:true, transparent:true, opacity:0.95, depthTest:false, depthWrite:false, blending:THREE.AdditiveBlending});
    NS._questBeam=new THREE.Points(_bg,_bm); NS._questBeam._n=_BN; NS._questBeam.frustumCulled=false; NS._questBeam.renderOrder=998; NS.scene.add(NS._questBeam);
  }
  if(NS._questBeam){
    var _dir=tn.pos.clone().sub(cam.position), _dl=_dir.length(); if(_dl>1e-3) _dir.multiplyScalar(1/_dl);
    var _len=Math.min(Math.max(NS_SCALE*80,_dl-(tn.r||1)), NS_SCALE*9000);
    var _N=NS._questBeam._n||30, _pa=NS._questBeam.geometry.attributes.position;
    NS._questBeamFlow=((NS._questBeamFlow||0)+dt*0.5)%1;     // dots flow toward the target
    var _base=NS_SCALE*70;
    for(var _i=0;_i<_N;_i++){
      var _t=((_i+NS._questBeamFlow)/_N), _off=_base+_t*_len;
      _pa.setXYZ(_i, cam.position.x+_dir.x*_off, cam.position.y+_dir.y*_off, cam.position.z+_dir.z*_off);
    }
    _pa.needsUpdate=true;
    NS._questBeam.material.color.setHex((m.phase==='return')?0x55ff88:0xff4d4d);
    NS._questBeam.visible=true;
  }
  var d=cam.position.distanceTo(tn.pos), arrive=Math.max((tn.r||1)*5,(tn.r||1)+1);
  if(m.phase==='briefing'){
    if(d<=arrive){ m.phase='travel'; nsQuestSay(nsQuestBrief(m.err, m.aiName)+' Now follow the red beam to the fault.', 'Follow the red beam to the fault.'); }
  } else if(m.phase==='travel'){
    if(d<=arrive){ m.phase='fix'; m.fixT=0; nsQuestSay('Fault reached. Hold position — stabilizing the link.','Hold position — stabilizing…'); }
  } else if(m.phase==='fix'){
    if(d<=arrive*1.8){ m.fixT=(m.fixT||0)+dt;
      if(m.fixT>=3.5){
        if(m.fromId&&m.toId&&NS.edgeKey){ var e2=NS.edgeKey[m.fromId+'|'+m.toId]||NS.edgeKey[m.toId+'|'+m.fromId]; if(e2){ e2.health='good'; e2.healthV=0.05; } }
        m.phase='return'; nsQuestSay('Link stable. Now report back to '+m.aiName+'.','Link stable — return to '+m.aiName); }
    } else { m.fixT=Math.max(0,(m.fixT||0)-dt*0.6); }
  } else if(m.phase==='return'){
    if(d<=arrive){ m.phase='done'; m.doneT=0; Q.credits+=10; Q.done++;
      nsQuestSay('Mission complete. '+m.aiName+' is back online. Plus ten lattice credits.','✓ Mission complete — +10 credits'); }
  } else if(m.phase==='done'){
    m.doneT=(m.doneT||0)+dt; if(m.doneT>5){ Q.active=null; NS.gpsTarget=null; nsQuestHud(null); return; }
  }
  nsQuestHud(m, nsFmtDist(d, tn.r), m.phase);
}


/* ════════════════════════════════════════════════════════════════════════
   KAIVERSE GLUE + MOBILE TOUCH — recovery of the thin activation/camera-input
   layer that was lost in the earlier <script> truncation (nsActivate /
   nsDeactivate / nsReturnToCore / nsFlyTo were CALLED from setView but never
   defined, so EVERY setView() threw a ReferenceError → boot + every nav broke,
   leaving the UI half-painted/untouchable — the real "grayed-out" symptom on
   phones). Every definition below is GUARDED by `typeof … !== 'function'` so it
   only fills a genuine gap and never clobbers a real implementation. Faithful to
   the visible contracts: NS.active / NS.raf / NS.built / nsBuild / nsInitThree /
   nsTick / NS.cam (orbit|fly, yaw/pitch/target) / NS.flyTo shape (see
   nsUpdateCamera) / NS.nodeById / throttleT. Desktop behaviour is unchanged:
   the 3D simply starts when you enter the Nervous System view, exactly as the
   activation block at ~6008 already assumed. ════════════════════════════════ */
(function kvGlueRecovery(){
  if(typeof NS==='undefined') return;

  /* ══ TRUNCATION-LOST KAIVERSE HUD/GROWTH/PANEL HELPERS (restored) ════════════
     These four (+closeNsEdgePanel) were called throughout the render/proximity
     code but their definitions were lost to a save-truncation. Re-implemented
     here, faithful to the real call patterns and reading REAL live state
     (memStats from /api/memory, NS.statSnap, NS.camera, the kv-* HUD ids and the
     #ns-edge-panel info panel). Each is guarded; honest fallbacks where a value
     is genuinely unknown — nothing fabricated. ──────────────────────────────── */

  // smoothed per-key store: ease the stored value toward `target`, return eased.
  if(typeof window.nsGrowVal!=='function'){
    NS._grow = NS._grow || {};
    window.nsGrowVal = function(key, target){
      const t = Number(target);
      if(!isFinite(t)) return Number(NS._grow[key])||0;
      let cur = NS._grow[key];
      if(cur==null || !isFinite(cur)){ cur = t; }     // first sample: snap, don't ease from 0
      else { cur += (t - cur) * 0.12; }               // ease toward the live target
      NS._grow[key] = cur;
      return cur;
    };
  }

  // the live engine targets the HUD tracks (REAL: memStats from /api/memory, with
  // NS.statSnap as a fallback). Returns the raw {key:target} map for nsAdvanceGrowth.
  function nsGrowthTargets(){
    const ms = (typeof memStats!=='undefined' && memStats) ? memStats : {};
    const ss = (NS && NS.statSnap) ? NS.statSnap : {};
    const num = (a,b)=>{ const x=Number(a); if(isFinite(x)) return x; const y=Number(b); return isFinite(y)?y:0; };
    const cells = num(ms.cells, ss.cells);
    const syn   = num(ms.synapses, ss.synapses);
    return {
      cells, synapses: syn,
      density:   num(ms.density,   syn&&cells?syn/cells:0),
      coherence: num(ms.coherence, 0),
      phi:       num(ms.phi,       0),
      // tripartite = astrocyte-gated subset of synapses (same honest ×0.85 the
      // dashboard uses); expansion derives from cell growth (log-scaled %).
      tripartite: num(ms.tripartite, syn*0.85),
      expansion:  num(ms.expansion, cells>0 ? Math.log10(cells+10) : 0)
    };
  }

  // step every tracked HUD value toward its latest engine target by `dt`.
  // Returns true if anything moved meaningfully (so the caller repaints).
  if(typeof window.nsAdvanceGrowth!=='function'){
    window.nsAdvanceGrowth = function(dt){
      const tg = nsGrowthTargets();
      NS._grow = NS._grow || {};
      let moved = false;
      for(const k in tg){
        const before = Number(NS._grow[k]);
        const after  = window.nsGrowVal(k, tg[k]);
        const ref    = Math.max(1, Math.abs(tg[k]));
        if(!isFinite(before) || Math.abs(after-before) > ref*1e-4) moved = true;
      }
      return moved;
    };
  }

  // write the current (grown) values into the real LIVE-STATE HUD ids, plus the
  // camera position / sector readout. Every element access is guarded.
  if(typeof window.nsPaintHUD!=='function'){
    window.nsPaintHUD = function(){
      const set=(id,txt)=>{ const el=$(id); if(el) el.textContent=txt; };
      const gv=(k,fb)=>{ const v=(NS._grow&&isFinite(NS._grow[k]))?NS._grow[k]:fb; return v; };
      const intFmt=(n)=> isFinite(n)?Math.round(n).toLocaleString():'—';
      const cells=gv('cells',NaN), syn=gv('synapses',NaN);
      const dens=gv('density',NaN), phi=gv('phi',NaN);
      const tri=gv('tripartite',NaN), exp=gv('expansion',NaN);
      if(isFinite(cells)) set('kv-cells', intFmt(cells));
      if(isFinite(syn))   set('kv-syn',   intFmt(syn));
      if(isFinite(dens))  set('kv-dens',  dens.toFixed(1)+' /cell');
      if(isFinite(phi))   set('kv-phi',   phi.toFixed(3));
      if(isFinite(tri)){ const el=$('kv-tri'); if(el){ el.textContent=intFmt(tri); el.classList.remove('na'); } }
      if(isFinite(exp))   set('kv-exp',   '×'+exp.toFixed(2));
      // camera position + sector readout (mirror nsUpdatePositionHud formatting)
      const cam=NS.camera;
      if(cam){
        const p=cam.position, U=(typeof NS_SCALE!=='undefined'?NS_SCALE:1);
        set('kv-pos', `${Math.round(p.x/U)} · ${Math.round(p.y/U)} · ${Math.round(p.z/U)}`);
        if(typeof nsUnitsToLy==='function'){
          const distU=p.length(), ly=nsUnitsToLy(distU);
          const clusterR=((NS._aiClusterR||200*U*(typeof NS_SPREAD!=='undefined'?NS_SPREAD:1))*1.3);
          let sector;
          if(distU<clusterR) sector='CLUSTER';
          else { sector=`${p.x>=0?'E':'W'}${p.y>=0?'U':'D'}${p.z>=0?'N':'S'}`; }
          set('kv-sector', `${sector} · ${Math.round(ly).toLocaleString()} ly`);
        }
      }
    };
  }

  // populate + reveal the body INFO PANEL (#ns-edge-panel). Accepts EITHER a node
  // object (proximity call ~7675) OR a node-id string (fly-to call ~8491).
  if(typeof window.nsOpenNodePanel!=='function'){
    window.nsOpenNodePanel = function(node){
      const panel=$('ns-edge-panel'); if(!panel) return;
      if(typeof node==='string'){ node = (NS.nodeById && NS.nodeById[node]) || null; }
      if(!node) return;
      const esc=(s)=> String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const title=$('ns-ep-title'); if(title) title.textContent=node.name||node.id||'Body';
      const body=$('ns-ep-body');
      if(body){
        const kindLbl={core:'Lattice core',engine:'Engine',bot:'AI agent',provider:'Provider',channels:'Channels'}[node.kind]||(node.kind||'body');
        const rows=[];
        rows.push(['Type', kindLbl]);
        if(node.sub) rows.push(['Role', node.sub]);
        if(node.status) rows.push(['Status', node.status]);
        if(node.kind==='provider' && node.active!=null) rows.push(['State', node.active?'active':'silenced']);
        if(node.pos && typeof NS_SCALE!=='undefined'){
          const U=NS_SCALE, p=node.pos;
          rows.push(['Position', `${Math.round(p.x/U)} · ${Math.round(p.y/U)} · ${Math.round(p.z/U)}`]);
        }
        if(NS.camera && node.pos && typeof nsFmtDist==='function'){
          rows.push(['Distance', nsFmtDist(NS.camera.position.distanceTo(node.pos), node.r)]);
        }
        body.innerHTML = rows.map(r=>{ const idA=(r[0]==='Distance')?' id="ns-ep-dist"':''; return `<div class="ns-ep-row"><span class="ns-ep-k">${esc(r[0])}</span><span class="ns-ep-v"${idA}>${esc(r[1])}</span></div>`; }).join('');
      }
      NS._panelNode = node;
      panel.classList.add('open');
      panel.style.opacity='1';
    };
  }

  // close the info panel (referenced by the ✕ onclick; was also lost to truncation)
  if(typeof window.closeNsEdgePanel!=='function'){
    window.closeNsEdgePanel = function(){
      const panel=$('ns-edge-panel'); if(!panel) return;
      panel.classList.remove('open'); panel.style.opacity='';
      if(typeof NS!=='undefined'){ NS.focusNid=null; NS._proxNid=null; }
    };
  }

  // ── ACTIVATE: enter the KAIVERSE view → build (once) + start the render loop ──
  if(typeof window.nsActivate!=='function'){
    window.nsActivate=function(){
      NS.active=true; NS.paused=false;
      // If already built, just unpause
      if(NS.three){
        try{ if(typeof nsResize==='function') nsResize(); }catch(_){}
        NS.lastFrame=0;
        if(!NS.raf && typeof nsTick==='function') NS.raf=requestAnimationFrame(nsTick);
        return;
      }
      // Show loading screen FIRST, yield to the browser so it paints, THEN run the heavy init
      var wrap=document.getElementById('ns-wrap');
      var _ld=document.getElementById('kv-loading');
      if(!_ld && wrap){ _ld=document.createElement('div'); _ld.id='kv-loading';
        _ld.style.cssText='position:absolute;inset:0;z-index:999;display:flex;align-items:center;justify-content:center;background:rgba(1,2,5,0.97);color:#4ae080;font:600 22px monospace;letter-spacing:2px;transition:opacity 0.6s;';
        _ld.innerHTML='<div style="text-align:center">KAIVERSE<br><span style="font-size:13px;color:#6a7a90;font-weight:400">Generating universe\u2026</span></div>';
        wrap.appendChild(_ld); }
      // setTimeout(0) yields to the browser — it paints the loading div, THEN we run init
      setTimeout(function(){
        try{
          if(!NS.built && typeof nsBuild==='function') nsBuild();
          if(!NS.three && typeof nsInitThree==='function'){
            if(!nsInitThree()) return;
            if(typeof nsRefreshHealth==='function') nsRefreshHealth();
            if(typeof nsScaleNebula==='function') nsScaleNebula();
            if(typeof allOps!=='undefined' && allOps && allOps.length && typeof nsIngestOps==='function') nsIngestOps(allOps);
          }
          if(typeof nsResize==='function') nsResize();
          NS.lastFrame=0;
          if(!NS.raf && typeof nsTick==='function') NS.raf=requestAnimationFrame(nsTick);
        }catch(e){
          console.error(e);
          if(_ld) _ld.innerHTML = '<div style="color:red;font-size:16px;">ERROR: ' + e.message + '<br>' + e.stack + '</div>';
        }
      }, 30);
    };
  }
  // ── DEACTIVATE: leave the view → stop the loop (cheap; keeps scene for re-entry) ──
  if(typeof window.nsDeactivate!=='function'){
    window.nsDeactivate=function(){
      NS.active=false;
      if(NS.raf){ try{ cancelAnimationFrame(NS.raf); }catch(_){} NS.raf=null; }
    };
  }
  // ── FLY-TO a node id: accelerated approach matching the NS.flyTo shape that
  //    nsUpdateCamera() consumes (t/dur/nid/fromPos/fromTgt/toTgt/offset). ──
  if(typeof window.nsFlyTo!=='function'){
    window.nsFlyTo=function(nid){
      try{
        const cam=NS.camera, c=NS.cam, node=NS.nodeById&&NS.nodeById[nid];
        if(!cam||!c||!node||!node.pos||typeof THREE==='undefined') return;
        const tgt=node.pos.clone();
        // Arrive in LOW ORBIT — a couple of planet-radii out so the planet LOOMS
        // huge (you are tiny relative to it), not a far speck. Floor keeps small
        // bodies clear of the near-plane. (Full continuous descent-scale = Layer 2.)
        const r=Math.max((node.r||1)*2.4, 3*(typeof NS_SCALE!=='undefined'?NS_SCALE:1));
        const dir=cam.position.clone().sub(tgt); if(dir.lengthSq()<1e-6) dir.set(0,0.3,1);
        dir.normalize();
        const offset=dir.multiplyScalar(r);
        c.mode='orbit';
        NS.flyTo={ t:0, dur:1.5, nid:nid,
          fromPos:cam.position.clone(), fromTgt:c.target.clone(),
          toTgt:tgt.clone(), offset:offset };
        if(typeof nsOpenNodePanel==='function'){ try{ nsOpenNodePanel(nid); }catch(_){} }
      }catch(e){}
    };
  }
  // ── RETURN TO CORE (compass / H key): set CORE as the GPS target so the owner
  //    flies back manually. NO instant teleport across space (owner requirement). ──
  if(typeof window.nsReturnToCore!=='function'){
    window.nsReturnToCore=function(){
      if(NS.nodeById && NS.nodeById['core']){
        NS.gpsTarget='core';
        if(typeof window.nsOpenNodePanel==='function'){ try{ window.nsOpenNodePanel('core'); }catch(_){} }
      }
    };
  }

  /* ── MOBILE / TOUCH CONTROLS (no pointer-lock, no WASD on phones) ───────────
     Gated purely by touch events firing → desktop mouse/keyboard untouched.
       • one-finger drag  = look around (drives fly-mode yaw/pitch)
       • two-finger pinch/drag = throttle (NS.throttleT 0..1) + gentle forward
       • quick tap        = fly to the nearest body under the finger
     A small on-screen ⤒ thrust pad (added once) gives a sustained "move forward"
     since there's no keyboard. All scoped to #kv-canvas so page scroll elsewhere
     is unaffected; the canvas already has touch-action:none so gestures work. */
  (function kvTouch(){
    var cvs=document.getElementById('kv-canvas');
    if(!cvs || cvs._kvTouchBound) return; cvs._kvTouchBound=true;
    var isCoarse = window.matchMedia && window.matchMedia('(pointer:coarse), (max-width:900px)').matches;
    var last=null, twoStartDist=0, twoStartThr=0, moved=0, startT=0, startX=0, startY=0, thrust=false;
    function nearestNode(cx,cy){
      try{
        if(!NS.camera || !NS.nodes || typeof THREE==='undefined') return null;
        var r=cvs.getBoundingClientRect(), best=null, bd=1e9, v=new THREE.Vector3();
        for(var i=0;i<NS.nodes.length;i++){ var n=NS.nodes[i]; if(!n.pos||!n.mesh) continue;
          v.copy(n.pos).project(NS.camera);
          if(v.z>1) continue;
          var sx=r.left+(v.x*0.5+0.5)*r.width, sy=r.top+(-v.y*0.5+0.5)*r.height;
          var d=Math.hypot(sx-cx,sy-cy); if(d<bd && d<70){ bd=d; best=n; }
        }
        return best;
      }catch(e){ return null; }
    }
    cvs.addEventListener('touchstart',function(e){
      if(!NS.active) return;
      if(e.cancelable) e.preventDefault();
      var t=e.touches;
      if(t.length===1){
        last={x:t[0].clientX,y:t[0].clientY}; moved=0; startT=Date.now();
        startX=t[0].clientX; startY=t[0].clientY;
        // first finger touch puts the camera in free-look (fly) so dragging rotates
        if(NS.cam){ if(NS.cam.mode!=='fly' && NS.cam.mode!=='walk'){ NS.cam.mode='fly'; NS.flyTo=null; NS.followNid=null; } }
      } else if(t.length===2){
        var dx=t[0].clientX-t[1].clientX, dy=t[0].clientY-t[1].clientY;
        twoStartDist=Math.hypot(dx,dy)||1;
        twoStartThr=(NS.throttleT!=null?NS.throttleT:0.3);
      }
    },{passive:false});
    cvs.addEventListener('touchmove',function(e){
      if(!NS.active) return;
      if(e.cancelable) e.preventDefault();
      var t=e.touches, c=NS.cam;
      if(t.length===1 && last && c){
        var nx=t[0].clientX, ny=t[0].clientY;
        var dx=nx-last.x, dy=ny-last.y; last={x:nx,y:ny};
        moved += Math.abs(dx)+Math.abs(dy);
        // drag → look. invert so dragging right turns the view right (natural)
        c.yaw   = (c.yaw||0)   + dx*0.005;
        c.pitch = Math.max(-1.45, Math.min(1.45,(c.pitch||0) - dy*0.005));
      } else if(t.length===2){
        var ddx=t[0].clientX-t[1].clientX, ddy=t[0].clientY-t[1].clientY;
        var dist=Math.hypot(ddx,ddy)||1;
        var ratio=dist/twoStartDist;
        NS.throttleT=Math.max(0,Math.min(1, twoStartThr*ratio));
        // two-finger gesture also nudges forward so pinch-out = accelerate ahead
        if(NS.keys) NS.keys['w']=true;
      }
    },{passive:false});
    function endTouch(e){
      if(!NS.active){ last=null; return; }
      var c=NS.cam;
      // a short, still tap = select / fly to nearest body
      if(last && moved<12 && (Date.now()-startT)<350){
        var n=nearestNode(startX,startY);
        if(n && typeof window.nsFlyTo==='function') window.nsFlyTo(n.id);
      }
      // release the two-finger forward nudge when fingers lift
      if((!e.touches || e.touches.length<2) && NS.keys && !thrust) NS.keys['w']=false;
      if(!e.touches || e.touches.length===0) last=null;
    }
    cvs.addEventListener('touchend',endTouch,{passive:false});
    cvs.addEventListener('touchcancel',endTouch,{passive:false});

    // on-screen sustained-thrust pad (touch only) — there is no WASD on a phone
    if(isCoarse){
      var wrap=document.getElementById('ns-wrap');
      if(wrap && !document.getElementById('kv-thrust')){
        var pad=document.createElement('div');
        pad.id='kv-thrust';
        pad.textContent='▲ THRUST';
        pad.style.cssText='position:absolute;left:50%;bottom:96px;transform:translateX(-50%);z-index:7;'
          +'padding:12px 22px;border-radius:30px;border:1px solid var(--border);'
          +'background:rgba(34,217,230,0.14);color:var(--accent);font-family:var(--mono);'
          +'font-size:12px;font-weight:700;letter-spacing:1px;user-select:none;touch-action:none;'
          +'box-shadow:0 8px 26px rgba(0,0,0,0.5);backdrop-filter:blur(10px)';
        var hold=function(on){ return function(ev){ if(ev&&ev.cancelable) ev.preventDefault();
          thrust=on; if(NS.cam && on && NS.cam.mode!=='fly' && NS.cam.mode!=='walk'){ NS.cam.mode='fly'; NS.flyTo=null; }
          if(NS.keys) NS.keys['w']=on;
          pad.style.background=on?'rgba(34,217,230,0.32)':'rgba(34,217,230,0.14)'; }; };
        pad.addEventListener('touchstart',hold(true),{passive:false});
        pad.addEventListener('touchend',hold(false),{passive:false});
        pad.addEventListener('touchcancel',hold(false),{passive:false});
        wrap.appendChild(pad);
      }
    }
  })();

  /* ── DESKTOP / LAPTOP INPUT (unified POINTER EVENTS + keyboard) ─────────────
     The original pointer-lock/WASD/wheel wiring was lost in an earlier <script>
     truncation, so a laptop (no touch events, poor pointer-lock support on a
     touchpad) had NO way to look or move. This restores it with POINTER EVENTS
     so mouse, touchpad AND pen all work through one path:
       • pointerdown on the canvas → begin a NON-locked drag-look (works on a
         touchpad press-drag); we also TRY pointer-lock for power mouse users,
         but the drag-look is the default/fallback so it never gets stuck.
       • pointermove → rotate camera yaw/pitch by the delta (same math as touch).
       • wheel / two-finger touchpad scroll → throttle (NS.throttleT 0..1).
       • W/A/S/D + Q/E/Space/Shift → NS.keys move flags; H=core, F=orbit/fly.
     Guarded so it binds once and only touches the gap (no clobber). */
  (function kvDesktopInput(){
    var cvs=document.getElementById('kv-canvas');
    if(!cvs || cvs._kvPtrBound) return; cvs._kvPtrBound=true;
    var dragging=false, lpx=0, lpy=0, locked=false;
    function intoFly(){ if(NS.cam && NS.cam.mode!=='fly' && NS.cam.mode!=='walk'){ var c=NS.cam; c.yaw=c.theta+Math.PI; c.pitch=(Math.PI/2 - c.phi); NS.cam.mode='fly'; NS.flyTo=null; NS.followNid=null; } }
    // POINTER-LOCK look (power mouse): relative movementX/Y while locked.
    document.addEventListener('pointerlockchange', function(){
      locked = (document.pointerLockElement===cvs);
    });
    function lockedMove(e){
      if(!locked || !NS.active) return; var c=NS.cam; if(!c) return;
      let turnScale = 1.0;
      if (NS.cam && NS.cam.vel) {
        let ratio = Math.min(1.0, NS.cam.vel.length() / (25000000 * 16 * 80));
        turnScale = 1.0 - (ratio * 0.9);
      }
      c.yaw   = (c.yaw||0)   + (e.movementX||0)*0.0028*turnScale;
      c.pitch = Math.max(-1.45, Math.min(1.45,(c.pitch||0) - (e.movementY||0)*0.0028*turnScale));
    }
    document.addEventListener('mousemove', lockedMove);
    // NON-LOCKED drag-look (touchpad / plain mouse): pointer events + capture.
    cvs.addEventListener('pointerdown', function(e){
      if(!NS.active || e.pointerType==='touch') return;   // touch handled by kvTouch
      dragging=true; lpx=e.clientX; lpy=e.clientY;   // a plain click should select, not fling into free-fly
      try{ cvs.setPointerCapture(e.pointerId); }catch(_){}
      // offer pointer-lock to mouse users (optional power path); harmless if denied
      if(e.pointerType==='mouse' && !locked && cvs.requestPointerLock){ try{ cvs.requestPointerLock(); }catch(_){} }
      if(e.cancelable) e.preventDefault();
    });
    cvs.addEventListener('pointermove', function(e){
      if(!dragging || locked || e.pointerType==='touch' || !NS.active) return;
      var c=NS.cam; if(!c) return;
      var dx=e.clientX-lpx, dy=e.clientY-lpy; lpx=e.clientX; lpy=e.clientY;
      if(Math.abs(dx)+Math.abs(dy)>2){ NS._userTook=true; intoFly(); }   // break orbit only on a real drag
      let turnScale = 1.0;
      if (NS.cam && NS.cam.vel) {
        let ratio = Math.min(1.0, NS.cam.vel.length() / (25000000 * 16 * 80));
        turnScale = 1.0 - (ratio * 0.9);
      }
      c.yaw   = (c.yaw||0)   + dx*0.005*turnScale;
      c.pitch = Math.max(-1.45, Math.min(1.45,(c.pitch||0) - dy*0.005*turnScale));
    });
    function endDrag(e){ if(!dragging) return; dragging=false; try{ cvs.releasePointerCapture(e.pointerId); }catch(_){} }
    cvs.addEventListener('pointerup', endDrag);
    cvs.addEventListener('pointercancel', endDrag);
    cvs.addEventListener('pointerleave', endDrag);
    // WHEEL / two-finger touchpad scroll = throttle (only while KAIVERSE active).
    cvs.addEventListener('wheel', function(e){
      if(!NS.active) return;          // don't hijack page scroll elsewhere
      if(e.cancelable) e.preventDefault();
      var cur=(NS.throttleT!=null?NS.throttleT:0.3);
      NS.throttleT=Math.max(0,Math.min(1, cur - Math.sign(e.deltaY)*0.06));
    },{passive:false});
    // KEYBOARD: WASD/QE + space/shift move flags; H=core; F=toggle orbit/fly.
    function keyName(e){ return (e.key||'').toLowerCase(); }
    window.addEventListener('keydown', function(e){
      if(!NS.active) return;
      var t=e.target; if(t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      var k=keyName(e);
      if(k==='y'){ if(typeof nsQuestToggleBoard==='function') nsQuestToggleBoard(); if(e.cancelable) e.preventDefault(); return; }
      if(NS.Quest && NS.Quest.board){
        if(k==='arrowup'||k==='w'){ nsQuestMove(-1); }
        else if(k==='arrowdown'||k==='s'){ nsQuestMove(1); }
        else if(k==='enter'){ nsQuestAccept(); }
        else if(k==='escape'||k==='backspace'){ nsQuestCloseBoard(); }
        if(e.cancelable) e.preventDefault(); return;
      }
      if(k==='j'){ if(typeof nsQuestAbandon==='function') nsQuestAbandon(); if(e.cancelable) e.preventDefault(); return; }
      if('wasdqe '.indexOf(k)>=0){ if(!NS.keys) NS.keys={}; if(k!=='') intoFly(); NS.keys[k===' '?' ':k]=true; if(e.cancelable) e.preventDefault(); }
      else if(k==='shift'){ if(!NS.keys) NS.keys={}; NS.keys['shift']=true; }
      else if(k==='h'){ if(typeof window.nsReturnToCore==='function') window.nsReturnToCore(); }
      else if(k==='f'){ if(NS.cam){ var _c=NS.cam; if(_c.mode==='follow'||_c.mode==='orbit'){ _c.yaw=(_c.theta||0)+Math.PI; _c.pitch=0; _c.mode='fly'; NS.flyTo=null; NS.followNid=null; } else { var _t=NS._nearPlanet||(NS.nodeById&&NS.nodeById['core']); if(_t&&_t.pos&&NS.camera){ NS.followNid=_t.id; _c.followOff=NS.camera.position.clone().sub(_t.pos); var _min=(_t.r||1)*1.5; if(_c.followOff.lengthSq() < _min*_min) _c.followOff.normalize().multiplyScalar(_min); _c.mode='follow'; NS.flyTo=null; var _dir = _t.pos.clone().sub(NS.camera.position).normalize(); _c.yaw=Math.atan2(_dir.x, _dir.z); _c.pitch=Math.asin(_dir.y); } } } }
      else if(k==='v'){ NS._thirdPerson=!NS._thirdPerson; NS._chasePos=null; var _s=document.getElementById('ns-status'); if(_s) _s.textContent=(NS._thirdPerson?'3rd person':'1st person'); }
    });
    window.addEventListener('keyup', function(e){
      if(!NS.keys) return; var k=keyName(e);
      if(k==='shift') NS.keys['shift']=false; else NS.keys[k===' '?' ':k]=false;
    });

    /* ── ON-SCREEN MOVEMENT CLUSTER (works with ANY pointer — laptop included) ──
       Press-and-hold each pad → sets the SAME NS.keys flag WASD uses, so a
       touchpad-clicked cursor can fly. Visible on desktop/laptop too (NOT gated
       behind coarse-pointer). pointerdown=start, pointerup/leave/cancel=stop. */
    (function kvMovePad(){
      var wrap=document.getElementById('ns-wrap');
      if(!wrap || document.getElementById('kv-movepad')) return;
      var pad=document.createElement('div');
      pad.id='kv-movepad';
      pad.style.cssText='position:absolute;right:16px;bottom:96px;z-index:8;display:grid;'
        +'grid-template-columns:repeat(3,38px);grid-template-rows:repeat(3,38px);gap:5px;'
        +'user-select:none;touch-action:none;font-family:var(--mono);font-size:15px;font-weight:700';
      // [dir, gridColumn, gridRow, glyph, title]
      var defs=[
        ['w',2,1,'▲','Forward (W)'], ['q',1,1,'⤒','Up (Q/Space)'], ['e',3,1,'⤓','Down (E/Shift)'],
        ['a',1,2,'◀','Strafe left (A)'], ['s',2,2,'▼','Back (S)'], ['d',3,2,'▶','Strafe right (D)']
      ];
      function mkBtn(dir,col,row,glyph,title){
        var b=document.createElement('div');
        b.textContent=glyph; b.title=title;
        b.style.cssText='grid-column:'+col+';grid-row:'+row+';display:flex;align-items:center;justify-content:center;'
          +'border:1px solid var(--border);border-radius:9px;background:rgba(34,217,230,0.10);color:var(--accent);'
          +'cursor:pointer;touch-action:none;backdrop-filter:blur(8px);box-shadow:0 4px 14px rgba(0,0,0,0.4)';
        var set=function(on){ return function(ev){ if(ev&&ev.cancelable) ev.preventDefault();
          if(!NS.keys) NS.keys={};
          if(on) intoFly();
          NS.keys[dir]=on;                         // SAME flag WASD/QE drive
          b.style.background=on?'rgba(34,217,230,0.30)':'rgba(34,217,230,0.10)';
          if(on){ try{ b.setPointerCapture(ev.pointerId); }catch(_){} }
        }; };
        b.addEventListener('pointerdown',set(true));
        b.addEventListener('pointerup',set(false));
        b.addEventListener('pointerleave',set(false));
        b.addEventListener('pointercancel',set(false));
        return b;
      }
      for(var i=0;i<defs.length;i++){ pad.appendChild(mkBtn(defs[i][0],defs[i][1],defs[i][2],defs[i][3],defs[i][4])); }
      wrap.appendChild(pad);
    })();

    // ── PAUSE MENU OVERLAY ───────────────────────────────────────────────────
    (function kvPauseMenu(){
      var menuWrap = document.createElement('div');
      menuWrap.id = 'kv-pause-menu';
      menuWrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(10,12,18,0.7);backdrop-filter:blur(12px);z-index:9999;display:none;flex-direction:column;align-items:center;justify-content:center;color:#c9d1d9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;user-select:none;';
      
      var inner = document.createElement('div');
      inner.style.cssText = 'background:rgba(22,27,34,0.85);border:1px solid #30363d;border-radius:12px;padding:2.5rem 3rem;width:400px;max-width:90%;box-shadow:0 12px 40px rgba(0,0,0,0.6);text-align:center;position:relative;';
      
      var title = document.createElement('h2');
      title.textContent = 'PAUSED';
      title.style.cssText = 'margin:0 0 1.5rem;font-size:1.8rem;letter-spacing:0.2em;color:#58a6ff;text-shadow:0 0 10px rgba(88,166,255,0.4);';
      
      var btnStyle = 'display:block;width:100%;padding:0.8rem;margin-bottom:0.75rem;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-weight:600;font-size:1rem;cursor:pointer;transition:all 0.2s ease;text-transform:uppercase;letter-spacing:0.05em;';
      
      var mainView = document.createElement('div');
      var optionsView = document.createElement('div');
      optionsView.style.display = 'none';

      // MAIN MENU BUTTONS
      var btnResume = document.createElement('button'); btnResume.textContent = 'Resume';
      var btnOptions = document.createElement('button'); btnOptions.textContent = 'Options';
      var btnSave = document.createElement('button'); btnSave.textContent = 'Save';
      var btnLoad = document.createElement('button'); btnLoad.textContent = 'Load';
      var btnReload = document.createElement('button'); btnReload.textContent = 'Reload / Exit';
      var btnSaveExit = document.createElement('button'); btnSaveExit.textContent = 'Save & Exit';
      
      var btns = [btnResume, btnOptions, btnSave, btnLoad, btnReload, btnSaveExit];
      btns.forEach(b => {
        b.style.cssText = btnStyle;
        b.onmouseover = () => { b.style.background = '#30363d'; b.style.borderColor = '#8b949e'; };
        b.onmouseout = () => { b.style.background = '#21262d'; b.style.borderColor = '#30363d'; };
        mainView.appendChild(b);
      });

      // OPTIONS MENU
      var optTitle = document.createElement('h3'); optTitle.textContent = 'OPTIONS';
      optTitle.style.cssText = 'margin:0 0 1rem;font-size:1.2rem;color:#8b949e;';
      optionsView.appendChild(optTitle);

      var buildSlider = (label) => {
        var wrap = document.createElement('div');
        wrap.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;font-size:0.9rem;';
        var lbl = document.createElement('span'); lbl.textContent = label;
        var sld = document.createElement('input'); sld.type = 'range'; sld.style.width = '150px';
        wrap.appendChild(lbl); wrap.appendChild(sld);
        return wrap;
      };
      
      optionsView.appendChild(buildSlider('Graphics Quality'));
      optionsView.appendChild(buildSlider('Mouse Sensitivity'));
      optionsView.appendChild(buildSlider('Controller Sensitivity'));
      
      var btnControls = document.createElement('button'); btnControls.textContent = 'Key/Controller Bindings';
      btnControls.style.cssText = btnStyle;
      optionsView.appendChild(btnControls);

      var btnBack = document.createElement('button'); btnBack.textContent = 'Back';
      btnBack.style.cssText = btnStyle + 'margin-top:1.5rem;background:#161b22;';
      optionsView.appendChild(btnBack);

      inner.appendChild(title);
      inner.appendChild(mainView);
      inner.appendChild(optionsView);
      menuWrap.appendChild(inner);
      
      // Delay appending so body exists
      setTimeout(() => document.body.appendChild(menuWrap), 500);

      // LOGIC
      var isPaused = false;
      function toggleMenu(){
        isPaused = !isPaused;
        menuWrap.style.display = isPaused ? 'flex' : 'none';
        if(!isPaused){ mainView.style.display='block'; optionsView.style.display='none'; }
      }
      
      window.addEventListener('keydown', function(e){
        if(e.key === 'Escape' && NS.active){
          toggleMenu();
          if(isPaused && document.pointerLockElement){ try{ document.exitPointerLock(); }catch(_){} }
        }
      });
      
      // Basic Gamepad poll for Menu button (button 9 usually)
      var padHeld = false;
      setInterval(()=>{
        if(!NS.active) return;
        var pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for(let i=0;i<pads.length;i++){
           let p=pads[i]; if(!p) continue;
           if(p.buttons && p.buttons[9] && p.buttons[9].pressed){
             if(!padHeld){ padHeld=true; toggleMenu(); }
           } else {
             padHeld=false;
           }
        }
      }, 100);

      btnResume.onclick = toggleMenu;
      btnOptions.onclick = () => { mainView.style.display='none'; optionsView.style.display='block'; };
      btnBack.onclick = () => { mainView.style.display='block'; optionsView.style.display='none'; };
      btnSave.onclick = () => { if(typeof window.nsSaveSpawn === 'function') window.nsSaveSpawn(); btnSave.textContent='Saved!'; setTimeout(()=>btnSave.textContent='Save', 1000); };
      btnLoad.onclick = () => { if(typeof window.nsRestoreSpawn === 'function') window.nsRestoreSpawn(); toggleMenu(); };
      btnReload.onclick = () => { window.location.reload(); };
      btnSaveExit.onclick = () => { if(typeof window.nsSaveSpawn === 'function') window.nsSaveSpawn(); window.location.reload(); };
    })();
  })();
})();
