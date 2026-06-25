# GOAL (for Antigravity): KAIVERSE visual overhaul — make space look ALIVE, not 8-bit

**Status:** OPEN — large, tiered job. Do NOT mark complete until the Tier-1 acceptance criteria pass a live look-test on the owner's machine. Tiers 2–3 are follow-on passes.
**Files:** `C:\KAI\kaiverse.js` (the WebGL explorer) + `C:\KAI\oracle.html` (chrome / fullscreen / notifications). Served statically by `command-center-server.mjs` :3001 — hard-refresh to apply.
**Owner's words (intent):** planets look "plain, no filter, no aliveness… one texture stretched over the whole sphere"; nebulae are "dim 2D flat circles with lighter dim layers"; background is "2D 8-bit like a Gameboy tried to make a space game." He wants: bloom/lens/glossy-metallic camera effects, NMS-style volumetric gas you can fly *into*, blazing stars with light shimmer/aura (JWST look), procedural materials/textures driven by math, and a fullscreen mode with OS-style popup flashcard notifications.

**Aesthetic target (owner-supplied reference images):** Thor's Helmet nebula, Soul Nebula, Crab Nebula (JWST), dense star clusters with diffraction-spike stars, a strong directional light-bloom example, and the 'Oumuamua comet. The north star is **luminous, layered, volumetric, high-dynamic-range** — bright cores that bloom, gas with depth and structure, deep starfields.

---

## CURRENT STATE (audited in `kaiverse.js` — build on this, don't rewrite from scratch)

- **Renderer (line ~433):** `THREE.WebGLRenderer({antialias:true, alpha:false})`, **Three.js r128**. Tone mapping is ALREADY good: `ACESFilmicToneMapping`, exposure 0.95, `sRGBEncoding` (line ~440). Keep these.
- **NO post-processing.** There is no `EffectComposer`, no `UnrealBloomPass`, no bloom anywhere. **This is the single biggest reason nothing glows.** (THE #1 fix.)
- **Stars** (`nsBuildStarfield`, ~548): `THREE.Points` + `PointsMaterial` with a soft glow sprite (`nsMakeGlowTexture`), additive blending. No bloom → soft dots, not blazing stars.
- **Nebulae / gas** (`nsBuildNebula` ~469, `nsBuildGasClouds` ~629, `nsStepGas`): low-opacity (`0.05`) additive `SpriteMaterial` billboards + additive `PointsMaterial` puffs. → exactly the "flat dim 2D circles" the owner sees. No depth-softening, no noise structure, no parallax.
- **Planets:** `MeshStandardMaterial` (roughness ~0.85, metalness ~0.05) with triplanar terrain + a BackSide additive atmosphere shell (~1055) and a `uSun` light dir. Flat because there's no bloom, weak fresnel/limb light, and low surface-detail variation.
- Custom raw GLSL `ShaderMaterial`s already exist for stars/holes/boids → the team CAN do shaders on r128.

---

## ⚑ PREREQUISITES — ANTI FETCHES & WIRES THESE FIRST, THEN CLAUDE IMPLEMENTS

The ONLY hard external dependency for Tier 1 is the **r128 post-processing bundle** (for bloom). Everything else — planet shaders, lens grade, notification toasts, procedural noise — Claude writes inline, no procurement. So Anti's job here is narrow and verifiable; once it's done and loading, Claude starts Tier 1.

**Anti, do exactly this:**

1. **Download the r128-matching post-processing files** — the global `js/` build that attaches to `THREE.*` (NOT the `jsm/` ES-module build). Source: `https://unpkg.com/three@0.128.0/examples/js/` :
   - `shaders/CopyShader.js`
   - `shaders/LuminosityHighPassShader.js`
   - `postprocessing/EffectComposer.js`
   - `postprocessing/RenderPass.js`
   - `postprocessing/ShaderPass.js`
   - `postprocessing/MaskPass.js`
   - `postprocessing/UnrealBloomPass.js`
2. **Concatenate them IN THIS ORDER** (shaders before passes; `EffectComposer` needs `CopyShader`, `UnrealBloomPass` needs `LuminosityHighPassShader`) into ONE vendored file: `C:\KAI\three-postprocessing-r128.js` (sibling to `oracle.html` so the static server serves it).
3. **Wire it into `oracle.html`:** add ONE line immediately AFTER the three.min.js include (line **2272**) and before `kaiverse.js` (line 6120):
   ```html
   <script src="three-postprocessing-r128.js"></script>
   ```
4. **Confirm the server serves it:** GET `http://localhost:3001/three-postprocessing-r128.js` should return the JS (not 404). If the static server won't serve a sibling file, fallback to seven CDN `<script>` tags (`https://unpkg.com/three@0.128.0/examples/js/...` in the order above) — but a single vendored local file is preferred for offline/Tailscale reliability.
5. **Verify load (the done-check):** hard-refresh, open the browser console, run:
   ```js
   ['EffectComposer','RenderPass','ShaderPass','UnrealBloomPass','CopyShader','LuminosityHighPassShader'].filter(k=>!THREE[k])
   ```
   It must return `[]` (all defined). That `[]` is the signal that Claude is unblocked.

**Anti constraints:** do NOT touch `kaiverse.js` for this; the only `oracle.html` edit is the single `<script>` line; keep the bundle as a separate asset so it's reversible (delete the line + file to revert). Optional/later: vendor a GLSL simplex-noise snippet for Tier 3 — but Claude can inline that when Tier 3 starts, so skip for now.

**Handoff:** once that console check returns `[]`, ping Claude and Tier 1 implementation (composer → UnrealBloomPass → planet rim/terminator → lens grade) begins — no further fetching required.

---

## TIER 1 — the cinematic baseline (do this first; ~80% of the "wow" for ~20% of the work)

**[ADD] Bloom post-processing (the linchpin).** Add an `EffectComposer` pipeline: `RenderPass` → `UnrealBloomPass` → output. Tune strength/radius/threshold so only bright things (star cores, sun, hot gas, emissive cores) bloom, not the whole frame. This is what gives stars the JWST blaze, makes the sun a real light source, and makes gas luminous.
- **r128 RISK (must solve first):** the postprocessing classes live in three's `examples`. cdnjs's r128 entry may only host `three.min.js`. Anti must source the **r128-matching** `EffectComposer.js`, `RenderPass.js`, `ShaderPass.js`, `UnrealBloomPass.js`, `CopyShader.js`, `LuminosityHighPassShader.js` (e.g. from `unpkg.com/three@0.128.0/examples/js/...`, the global-script `js/` build, NOT `jsm/` modules — r128 era uses global `THREE.*` classes), or inline them. Verify they attach to `THREE` and run before writing the composer. If they can't be loaded, fall back to a selective-bloom shader pass hand-written in raw GLSL (the team already writes raw GLSL).
- **Perf:** bloom at half-resolution; expose `KAIVERSE_BLOOM=0/1` and a strength var. This is a **limited host** (laptop, ~39 GB RAM, integrated-class GPU per the engine's `KAI_FORCE_LIMITED`) — keep a quality tier.

**[ADD] Hero stars + sun with flare.** The brightest bodies (the sun/CORE, a handful of "hero" stars) get an emissive core that drives bloom HARD + an optional sprite **diffraction-spike** (the 4/6-point JWST cross) and a soft lens-flare sprite that faces camera. Most stars stay cheap points; only heroes get flares.

**[ADD] Planet material upgrade — kill the "flat sticker" look.**
- **Fresnel rim / limb light:** add a rim term so the planet's edge catches the star light (the bright crescent limb in every real planet shot). Cheap, huge realism gain.
- **Day/night terminator + emissive night side** (subtle city/lava glow on the dark side via emissive map) so the lit/unlit boundary reads.
- **Surface relief:** drive normal perturbation from the existing terrain noise so the one-texture flatness becomes real bumps catching light; add roughness variation (oceans glossy/specular, land matte) for the "glossy vs metallic vs rock" the owner asked for.
- **Better atmosphere:** tint the sun-facing limb (Rayleigh-style blue/orange scatter) on the BackSide shell.

**[ADD] Camera/lens grade:** subtle vignette, a faint film grain, and *very* mild chromatic aberration at the frame edge — as a final composer pass. Sells "shot through a lens" vs "raw buffer." Keep it subtle (owner noted one example was "a little too strong").

### Tier 1 acceptance criteria (live look-test)
1. Bright stars and the sun visibly **bloom/blaze** with a soft aura; the brightest read like the reference images, not flat dots.
2. Planets show a **lit limb / rim light** and a clear day-night terminator — no longer a uniform flat sticker.
3. At least the hero star/sun shows a tasteful flare/spike.
4. A subtle lens grade (vignette/grain) is present but not distracting.
5. Frame rate stays usable on the owner's laptop (target ≥ ~40 fps in open space; bloom at half-res; `KAIVERSE_BLOOM` toggle works).
6. No regression to navigation, labels, or the HUD.

---

## TIER 2 — nebulae you can fly INTO, and a deep-field background

**[ADD] Volumetric-feel nebulae (fake-volumetric, r128-safe).** Replace the flat low-opacity sprites with **layered fractal-noise billboards**:
- Each nebula = many soft camera-facing quads at varied depths, textured by **FBM/Worley noise** in a raw GLSL `ShaderMaterial` (domain-warped for the wispy, "bumpy-edge" filaments — not round circles).
- **Soft particles / depth-fade:** fade each quad where it intersects scene depth so you pass *through* without hard edges → the "I can go inside it" feel. Density/brightness ramps up as the camera enters (sample local density → boost emissive + slight fog).
- **Color by density + a "frequency" gradient** (the owner's "frequency color waveform"): map density to a palette ramp (deep red edges → blue/white hot core), per the Thor's-Helmet / Crab references.
- Parallax across 2–3 depth shells so it has real volume when you move.
- True raymarched volumetrics are too expensive here — this layered-noise approach is the achievable version of NMS-style gas.

**[ADD] Deep-field backdrop.** Replace the sparse background with: a denser multi-mag starfield, faint **galaxy/cluster sprites** scattered far out, and a very-low-frequency dust/nebula gradient on a large skybox shell — so panning the camera reveals a populated cosmos, not black with dots.

### Tier 2 acceptance
1. Flying toward a nebula, its **edges are wispy/filamentary** (not a circle) and it **brightens + thickens** as you enter, then you come out the other side — no hard pop/clip.
2. Nebula color has a core-to-edge gradient like the references.
3. The background reads as a deep, populated field at any camera angle.
4. Perf budget honored (nebula quad count scales with a quality tier).

---

## TIER 3 — procedural material/texture engine ("the math makes things")

**[ADD] A seeded procedural surface system.** This is the owner's core ask: *"the math of each thing is the algorithm… procedural generation."* Build a small GLSL noise toolkit (simplex/Worley/FBM + domain warp) and a `makeBody(seed, type)` that procedurally drives **albedo + normal + roughness + emissive** per body — rocky, gas-giant banding, icy, molten, metallic — with NO external texture files, all from the seed. Optionally bake to an offscreen render-target texture once per body for perf, then reuse. This replaces "one texture stretched over the sphere" with genuinely generated, per-planet surfaces.
- Tooling note for Anti's "create or find something" request: this can be hand-rolled GLSL (preferred, zero deps, matches the existing raw-shader approach) — a heavy npm 3D-noise dependency is NOT needed and would bloat the static file. If a helper is wanted, vendor a tiny single-file GLSL noise snippet (e.g. Ashima/Stefan Gustavson simplex) inline.

### Tier 3 acceptance
1. Two different seeds produce visibly different, believable planet surfaces (rock vs gas-giant bands vs ice), all generated, none stretched/flat.
2. Comets/asteroids (the 'Oumuamua reference) get an elongated rocky body with a sun-driven tail.
3. No external texture/model files added; all procedural; perf acceptable.

---

## SEPARATE FEATURE — Fullscreen + OS-style popup flashcard notifications

**[ADD] Fullscreen mode** is already wired (`toggleFS` in `oracle.html`); ensure the KAIVERSE view uses it and the HUD/notifications render over the canvas in fullscreen.

**[ADD] Toast notification system (DOM overlay, not WebGL).** A queued notification layer over the canvas:
- **Pop-in** (scale 0.9→1 + fade-in ~200 ms), **hold** ~4 s, **fade-out + drift** (~400 ms), auto-dismiss; stack/queue multiple; corner-anchored (top-right) with safe-area insets.
- **Content sources:** the training **flashcards** (term + meaning) and system events (level-up, pipeline stage changes, errors). Reuse the existing `#kai-training` / pipeline data the dashboard already fetches.
- Pure CSS keyframes + a small JS queue. Respect `prefers-reduced-motion`. Don't block clicks (`pointer-events:none` on the toast layer except a close affordance).

### Notification acceptance
1. A flashcard/event toast **pops in, lingers a few seconds, fades away** smoothly; multiple queue without overlapping.
2. Works in fullscreen, over the 3D canvas, without stealing camera input.

---

## TIER 1.5 — ACTIVATE what's already half-built (gas bands, atmosphere entry, player ship)

*Audit finding: these three owner-requested features already have scaffolding in `kaiverse.js` — they're wired-but-inert, not missing. Frame as activate/fix/extend, NOT new build. Most of this is inline implementation (Claude's lane). The ONE procurement is a ship model (Anti, below).*

**[FIX] Gas-giant surface = bands + storms, not one skin.** Scaffolding: the canvas-baked band generator (~line 995 / 1009–1016, `value-noise bands gas-giant/rocky look`), the `n._isGas` flag (`nsPlanetDNA(n).type==='gas'`, line 3354), and gas-wind (line 2460). Diagnose first: is KAI actually `_isGas===true`? If not, fix the DNA/type assignment so KAI reads as gas. Then make the bands READ: stronger latitudinal banding, **domain-warped turbulence** for swirls/storms (a Great-Red-Spot-style vortex), a warm/cool **per-band palette**, and **differential rotation** (bands at different latitudes rotate at different speeds) so it's alive and layered, not a static decal. Gas giants should have **no hard landable surface** — replace the rocky collision with a soft "you sink into thickening haze" descent.

**[FIX] Atmospheric entry haze (the fog that never fires).** Line 443 sets `scene.fog = FogExp2(0x0a0e16, 0.0)` with intent *"density driven by altitude (0 in space)"* — but nothing ramps the density. Implement the ramp: per frame, take the nearest body's surface distance (already computed as `NS._surfMin`/`NS._rNear` in the fly loop), and as the camera drops below the atmosphere top, **raise `scene.fog.density`** and **tint `scene.fog.color`** to that body's atmosphere color, so the horizon clouds over and visibility drops on entry; clear it back to 0 in open space. Optional: thicken the existing `nsMakeAtmosphere` shell from inside + a few descent cloud-wisps.

**[ADD] Give the PLAYER a ship + fast travel.** Today the player is a free camera ("spectating"); the AIs already render as ships (line 1294) via a *"modular ship grammar"* (line 3022) — reuse it. Attach the camera to a player ship (chase-cam, with an optional cockpit/first-person toggle), so movement reads as *piloting*. Pair with a **boost/warp** for the long interstellar legs (the slow-traversal complaint): hold-to-boost ramps speed way up in open space, auto-disengaging near a body (ties into the proximity-decel from `KAIVERSE-GOAL-proximity-movement.md`), plus a "warp to selected target" for the multi-thousand-ly hops. There's already a hidden warp-streak field (`NS.three.warp`, line 624) — switch it on during boost for the speed-line effect.

### Tier 1.5 acceptance
1. KAI (gas giant) shows **moving latitudinal bands + at least one storm vortex**, layered and differentially rotating — not one static skin; no hard surface to stand on (you sink into haze).
2. Descending toward any atmo body **clouds the view with tinted fog** that clears when you leave.
3. The player flies as a **ship** (visible craft + chase cam), with a **boost/warp** that makes crossing open space fast and disengages near bodies.

### ⚑ PREREQUISITE #2 — ANTI FETCHES A SHIP MODEL (optional but wanted)
The player ship can use the existing procedural "ship grammar" (zero download) OR a real model. Owner wants a real one, so:
1. Fetch the r128 **GLTFLoader**: `https://unpkg.com/three@0.128.0/examples/js/loaders/GLTFLoader.js` (global `js/` build) → vendor as `C:\KAI\three-gltfloader-r128.js`, wire into `oracle.html` right after `three-postprocessing-r128.js` (line 2273) with one `<script>` line.
2. Download **one CC0 / public-domain low-poly spaceship** in **.glb** (sources: Kenney.nl "Space Kit", Poly Pizza CC0, Quaternius — all CC0). Keep it small (< ~1–2 MB, low-poly). Save as `C:\KAI\models\ship\player-ship.glb`. Confirm the static server serves it (GET returns the binary, not 404).
3. Verify load: console check `typeof THREE.GLTFLoader` returns `"function"`, and the `.glb` GETs 200. That `"function"` + 200 is the signal Claude can wire the player ship to a real model.
**Anti constraints:** don't touch `kaiverse.js`; only the two `<script>` lines + the vendored files; reversible. If no good CC0 .glb is found, skip it — Claude will use the procedural ship grammar instead.

### TIER 2.5 — Ship piloting + NMS-style land/exit/walk + orbital rocks (owner beta-evidence: "invisible spectator mode")

*Owner wants to STOP being an invisible spectator camera: fly a visible ship, land it with animation + FX, press a button to step out and walk on foot (like No Man's Sky), and see asteroids/comets when in orbit. Some of this exists — there's already a `walk` camera mode (`NS.cam.mode==='walk'`, glued to the surface) and an asteroid/debris system — so it's extend, not all-new.*

**[ADD] Player ship (visible) + chase cam.** Use the fetched `.glb` (Prereq #2) or the procedural ship grammar (line ~3022). Camera rides behind/above the ship; ship banks with turns; thruster glow + trail.

**[ADD] Landing sequence (NMS-style).** When near a surface and the owner triggers land (key, e.g. `L`, or auto on slow descent): ship eases down to the ground, orients to the surface normal, plays a short descent animation with **thruster wash + dust kick-up particles**, then parks. Disable free-fly during the land anim.

**[ADD] Exit ship → on-foot, and re-board.** Parked → press a key (e.g. `F`/`E`) to **disembark**: camera transitions from ship-chase to the existing `walk` mode (first or third person), ship stays parked as a landmark. Walk around (the `walk` mode + terrain-follow already exist). Walk back to the ship + press the key to **board** and fly off. Mirror NMS's get-in/get-out loop.

**[ADD] Orbital bodies — rocks, asteroids, comets.** When orbiting a planet, populate a thin **asteroid belt / debris field** around it (reuse/extend the existing asteroid system) so orbit isn't empty; scatter a few **comets** (elongated rocky body + sun-facing tail — the 'Oumuamua reference) drifting through. Keep counts perf-budgeted + LOD'd.

#### ⚑ PREREQUISITE #3 — ANTI FETCHES MODELS (so Claude can wire them)
What to find/download (all **CC0 / public-domain**, low-poly, `.glb`, vendored under `C:\KAI\models\...`, confirm the server serves each with a 200):
- **Asteroid / space-rock set** (3–6 low-poly rock `.glb`s) → `C:\KAI\models\rocks\` (sources: Kenney "Space Kit", Quaternius, Poly Pizza). *Or* tell Claude to generate procedural rocks (no download) — owner's choice.
- *(Optional)* **A low-poly astronaut / character `.glb`** for third-person on-foot → `C:\KAI\models\character\`. If skipped, on-foot stays first-person (no model needed).
- Landing FX (dust, thruster wash) are **procedural particles** — NO download; Claude builds them.
**Done-check:** each `.glb` GETs 200 from `localhost:3001`, and `typeof THREE.GLTFLoader === "function"` (from Prereq #2). Report the list of model paths back — that's the signal Claude wires them in.
**Anti constraints:** models + wiring only; don't edit `kaiverse.js`; keep everything reversible; prefer small low-poly assets (perf — limited host).

---

## TIER 3b — TERRAIN: close-up surface detail + fix the LOD seam (the hard one — needs visual iteration)

*Owner beta-test evidence (screenshots, 364 km altitude over KAI): a hard diagonal "cut" across the terrain; up close the surface is magnified low-res "paint" with no real detail; the hills don't match the texture. This is the single hardest piece — real planetary surface LOD. The bones EXIST but underperform. This work REQUIRES on-screen iteration (fly down → screenshot → adjust → repeat); the owner is the beta tester, Anti drives the edits. Tags: **[FIX]**/**[ADD]**.*

**Audited reality (cite these):**
- `nsApplyDisplacement` (line ~3157): terrain is displaced **per-vertex** (`transformed += normalize(position)*nsTerrainH(...)`), so geometric detail is capped by **mesh resolution** → blocky/coarse up close, no fine relief.
- `nsMakeDetailTexture` (line ~3193): an "NMS-style high-frequency detail texture" EXISTS (512², per-type grain) but isn't delivering close-up detail — under-tiled / under-blended.
- The high-detail terrain **PATCH** (`_pat`, line ~2499) is the likely source of the "large cut" — its boundary doesn't stitch to the base sphere (heights/normals mismatch = seam/crack).
- `uApproach` (updated line ~2988, in the relief shader): a camera-proximity uniform already exists to blend detail in as you descend — it's the hook to drive crisp close-up detail.
- `nsTerrainHeightJS` (line ~3152): the shared CPU height function (continents + hills + ridged).

**[FIX] Kill the "large cut" seam.** Diagnose the `_pat` patch boundary. Stitch it to the base mesh (match edge heights/normals to the base sphere's `nsTerrainH`), or add a vertical **skirt** at the patch edge, or crossfade patch↔base over a band so there's no hard discontinuity. Acceptance: no visible seam/crack at any descent angle.

**[ADD] Real geometric detail near camera.** Raise the patch's subdivision (or add a second finer patch tier) so hills aren't blocky up close; keep it camera-distance-gated via `uApproach` so far-LOD stays cheap. Acceptance: descending, the silhouette/relief gains finer geometry, not bigger facets.

**[ADD] Resolution-independent surface detail (kills "magnified paint").** Drive a strong **procedural** albedo + normal detail in the fragment shader off `uApproach` — high-frequency FBM (the shader already has `nsVN`/`nsFbm`/`nsRidged`) blended in as you approach, plus stronger tiling/▲ of `nsMakeDetailTexture`. Because it's procedural, it stays crisp at ANY zoom (no texture-magnification blur). Acceptance: at walking distance the ground shows fine grain + micro-normal relief, not flat color.

**[FIX] Align albedo to the actual terrain.** Color the surface from the SAME height/slope as the geometry (altitude bands + slope→rock from `nsTerrainH`), so the "hills match the image." Acceptance: peaks/valleys/slopes are colored consistently with their shape.

**Iteration loop (mandatory):** fly to KAI → screenshot → adjust one knob → repeat. Do NOT batch all four blind. Each is reversible / flag-gated.

---

## TIER 3c — the owner's LOD + atmosphere/skybox + core vision (detailed, June 25)

*Owner's described model of how the universe should render. Applies to BOTH the browser version and the native client. This is the "looks 3D at distance without paying for it, gets truly 3D up close" approach — same idea NMS uses.*

**Core (central star) — blinding + lens flare.** The Core should read as a **bright, near-white blinding light with a camera/lens flare**, and it should get BRIGHTER as you approach — not dimmer. NOTE: the current browser proximity-tamed bloom likely DIMS the core on approach (it reduces bloom near any body). Fix: **exempt the Core/stars from the proximity-bloom-taming** (taming is only for planet atmospheres), give the Core a high emissive that blooms hard, and add a sun/lens-flare sprite that faces the camera. Also revisit overall **light direction**.

**Planet LOD — distance image → close procedural, pixel-matched.** At a distance, a planet can be a cheap, image-like surface (looks fine, low cost). As you approach, **swap the stretched image for PROCEDURALLY GENERATED color/detail that matches the distant view pixel-for-pixel** — so it reads as "the same surface," just getting **richer, crisper, more 3D** the closer you get. The illusion: the distant 2D *becomes* 3D as depth/detail are added on approach, driven by camera proximity + POV. Don't render full 3D complexity when far (not needed); add geometric depth + procedural texture progressively as the camera closes in. (This is the resolution-independent procedural-detail idea from Tier 3 + the patch LOD from Tier 3b — the owner's framing makes the *intent* explicit: never a giant stretched image you fly into.)

**Atmosphere as a sphere "sky-block," not a cube.** Entering a planet's orbit / gravitational field triggers loading that planet's **sky-sphere** (a SPHERE, not a square skybox). From inside it: high up it still looks like the space you just left (a soft 2D/3D shell), and as you **descend toward the surface it transitions to the planet's atmosphere — sky color, climate, clouds**. A few thousand feet up it's still flat-ish but reads 3D because of the cloud layer above the surface. **On landing in daytime: no space visible — just the sky, clouds, and ground** (the sky-sphere fully takes over). The transition (space-shell → atmosphere → ground) is altitude-driven and continuous.

### Tier 3c acceptance
1. Approaching the Core, it goes **blinding white with a lens flare** and brightens (not dims).
2. Flying to a planet, the surface **swaps from the distant image to crisp procedural detail that matches** — feels like the same place getting sharper, not a stretched photo you crash into.
3. Entering orbit loads a **sky-sphere**; descending shows space → atmosphere → clouds → ground continuously; **on the surface in daytime you see sky/clouds, no black space.**

### Refined from live test (June 25 — owner flew it)
- ✅ Core blaze fix WORKED (it now blazes white on approach).
- ❌ **Planets are now over-bright / blown out** (bloom + sun light too strong on the lit side). Lowered the global bloom threshold 0.5→0.72 as a first cut; the deeper fix is per-planet: **reduce the directional/sun intensity + lower ambient so a real DAY/NIGHT terminator returns — a lit side, a dark side, and a soft shadow fade across the terminator like a real planet.** Right now planets read as uniformly bright with no dark side.
- ❌ **Atmosphere shell is a hard "barrier", not air.** It shows a visible ring/halo/"wall", has layer/seam lines, and gets BRIGHTER as you approach (should get *subtler*). Required behavior: the atmosphere must **fade to fully invisible at the rim** (no hard edge), show only a **soft limb glow on the SUN-facing side**, fall away on the dark side, and NOT brighten on approach. From inside, no giant bright white wall/halo that follows you around the planet.
- ❌ **Landing clips you INSIDE the ground** — collision/landing puts the camera below the surface. Fix the collision floor / landing stop so you rest ON the surface.
- ❌ The **LOD patch seam** is still visible (Tier 3b).

### What's quick vs hard
- **Quick (browser, done):** Core exempt from bloom-taming (blazes) + bloom threshold up (less planet blow-out).
- **Hard (the real build — needs the fly→screenshot→tune loop, browser or native):** day/night terminator + sun-intensity rebalance; the atmosphere shell rework (fade-to-invisible rim, sun-side limb glow only, no brighten-on-approach, no inside-wall); the pixel-matched procedural LOD swap; the sky-sphere; the landing/collision fix; the seam stitch. Do NOT blind-edit these — they must be eyeballed each iteration.

---

## HARD CONSTRAINTS (all tiers)

- **Surgical, incremental edits** — do NOT wholesale-rewrite `kaiverse.js` or `oracle.html` (both have a truncation/whole-rewrite history; keep diffs reviewable).
- **`node --check kaiverse.js` must pass** and the file must stay complete; verify against the REAL file, not the Linux mount (it serves a stale/truncated snapshot of large files — confirm on the Windows host / in-browser).
- **r128 only** — no APIs newer than r128 (e.g. no `CapsuleGeometry`); load any postprocessing as r128-matching global `js/` scripts, verified before use.
- **Performance is a feature** — this runs on a limited laptop. Every heavy effect (bloom, nebula quads, procedural bakes) gets a quality tier + an env/`window` toggle, and a target of staying interactive (≥ ~40 fps open-space).
- **Reversible** — gate big changes behind flags so the owner can A/B and revert fast.
- Log the work in **The KAI Codex** changelog when each tier lands.

## Build order (recommended)
1. Tier 1 bloom + planet rim/terminator + lens grade  →  ship, look-test.
2. Notification toasts (small, independent, high daily value).
3. Tier 2 nebulae + deep field.
4. Tier 3 procedural surfaces.

Each tier is its own PR-sized chunk with its own look-test. Tier 1 is where the "completely overhauled" feeling comes from.
