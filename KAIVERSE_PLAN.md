# KAIVERSE — Master Improvement Plan

> Living checklist. We work through this one item at a time, verifying each before moving on.
> Status: 🔴 not started · 🟡 in progress · 🟢 done · ⏸️ parked
> File under work: `C:\KAI\kaiverse.js` (edit via node scripts only — large writes truncate it).
> Last updated: 2026-06-23

---

## Guiding ideas (the "feel" we're aiming for)
- Reference images: (1) a single brilliant heat-light = the galactic core / central sun-or-black-hole, very far; (2) rich colorful nebula, NOT plain black; (3) standing on a planet seeing pretty lights + rings in the sky; (4) correct rings in/around planets with asteroids; (5) planet from orbit — thin bright **atmospheric limb-glow** rim, real surface clouds, a **moon** behind it on a clean black starfield.
- KAI's space is its own cosmos, not NMS — but the same *vastness and beauty*.
- You are a **god / universe doctor**: no ship, you travel and descend yourself. You go fix the real problems in the living system as an adventure.
- Light in space = heat. A star/planet's glow **color encodes its wavelength/heat/status**; hotter bodies emit stronger and are visible from farther away.

---

## A. Space visuals & atmosphere
- 🔴 **A1 — Real nebulas, gas clouds & color.** Replace the plain-black void with colorful volumetric nebulae and gas clouds (ref img 2). Color zones, not uniform black.
- 🟢 **A2 — Fix the "following" glow clouds.** *(Done 2026-06-23.)* Root cause: `nsFloatingOrigin` shifted the camera + world on each origin jump but not the gas-cloud stored bases (`NS._gasPuffs`, `NS.gasClouds`), so `nsStepGas` snapped them back toward spawn every frame → they appeared to follow you. Fix: shift those bases by the same vector. Now world-anchored — you fly past them.
- 🔴 **A3 — Heat-light star/core model.** Central massive light = sun / black hole emitting real heat-light. Body glow **color = wavelength = heat/status**; stronger heat → larger emission → visible from farther. Tie a body's glow intensity/color to its live status.
- 🔴 **A4 — Correct planetary rings.** Proper rings *in/around* planets (ref img 4), correctly oriented and lit — not flat childish bands.
- 🔴 **A5 — On-planet sky beauty.** From a planet surface (ref img 3) you should see the pretty space lights, nebulae, rings, and the heat-core in the sky.
- 🔴 **A6 — Atmospheric limb-glow from orbit.** Thin bright atmosphere rim around the planet edge when viewed from orbit (ref img 5), with real surface clouds — the "alive planet" look.
- 🔴 **A7 — Moons.** Planets get orbiting moons (ref img 5) for depth and scale.

## B. Movement, controls & structure integrity (outer "kaispace")
- 🔴 **B1 — Better space movement & controls overall.** Smoother NMS-like flight/orbit feel; refine controller + keyboard mapping.
- 🔴 **B2 — Fix overlapping structures.** Bodies/structures spawning **inside each other** cause the gritty, glitchy, z-fighting look. Enforce spacing / fix intersections / fix z-fighting.
- 🔴 **B3 — Navigation beam from YOU → destination.** The red signal path should originate **from the player and point to the target** so you can just follow it through hard-to-navigate space (it's a guidance trail, not a planet emission).

## C. Planet zone transition + close-up detail (staged build, in progress)
Staged plan designed (safe→risky): 1 feel-huge → 2 relief-parity → 3 vertex pigment → 5 chunked build → 4 higher detail.
- 🟢 **Stage 1 — Feel huge / no edge-of-map.** Slower final approach (crawl band 0.30→0.18) so the planet grows gradually; descent/atmosphere engages earlier (build range r*18→r*26). *(Done 2026-06-23.)*
- 🟢 **Stage 2 — Relief parity.** Base-mesh relief raised 0.02→0.04 to match descent, so the surface no longer "pops" taller at the LOD swap. *(Done.)*
- 🟢 **Stage 3 — Per-vertex pigment + height.** Altitude vertex colors (dark valleys → bright peaks → snow caps) layered over the texture — the "each vertex its own pigment and height" ask. *(Done.)*
- 🟢 **Stage 5 — Chunked/time-sliced terrain build.** The ~24k-vertex displace+colour bake now runs in 4k-vertex slices across frames (in nsUpdatePlanetDescent) instead of one blocking burst; base sphere stays visible until the detailed terrain is fully baked; collision is unaffected (samples the height fn directly). Kills the per-approach freeze. *(Done 2026-06-23.)* NOTE: the initial 20s LOAD is a SEPARATE synchronous build (nsBuildBodies + star/gas/asteroid fields) — still needs its own async pass.
- 🔴 **Stage 4 — Higher detail for the nearest planet only.** Bump seg cap 192×128→288×192 once Stage 5 makes it freeze-free. Skip quadtree (too risky for this single-file app).
- 🔴 **C1 — own seed-generated world per planet** + **C2 fully blended orbit→atmosphere→sky→ground** remain the end-goal these stages build toward.

## D. Landing & on-foot god avatar
- 🔴 **D1 — Descent animation, not teleport.** Y / L currently teleports you to the surface from whatever altitude (bad). Replace with an **animated descent** (we're gods — no ship, we float/drop down ourselves).
- 🔴 **D2 — Body + shadow.** Give the player an actual body and a ground shadow cast from the sun.
- 🔴 **D3 — First-person arms/hands.** See your arms and hands swing when you **run** (hold left analog stick / Left Shift).
- 🔴 **D4 — Jump + better on-foot controls.** Jump with A; refine walk/run/look controls on the surface.

## E. Avatar UI, comms & notifications
- 🔴 **E1 — Wrist/arm phone (Tab).** Tab opens an **animated arm phone screen**, controllable like a real phone — pick input mode (mouse / touch / controller). Exit with B / Back / Esc.
- 🔴 **E2 — Comms voices in-ear.** Hear the AI voices you'd hear "in your ears" like comms while traveling.
- 🔴 **E3 — Notification UX.** Kill the persistent middle-top popup. Make it a **transient notification that fades**; keep a **compact distance readout pinned on top**.

## F. Quest / adventure system (tie to REAL errors)
- 🔴 **F1 — Quest sources.** Quests come **either from Oracle** (go to Oracle to receive) **or directly from the AI/channel** that raised the request/error.
- 🔴 **F2 — Real-error missions.** Each quest maps to an actual system error / fail / issue. You travel, go places, talk to other AIs, and **fix the real problem** to complete it — adventure framing.
- 🔴 **F3 — Themed AI home planets.** Leo, Groq, Claudey, Gemi, X live on planets **not named after them** — each world designed around that AI's "type"/personality.

---

## H. Performance & "render only what's in scene" (NMS-style) — research-backed
Goal: smooth framerate + high *perceived* detail without brute-force cost. Established techniques (sources below):
- 🟢 **H1 — Right-size textures.** Color maps were 4096×2048 (~33 MB VRAM each ×~9 planets). Downscaled to 2048×1024 (~4× less); normal maps carry the relief detail. Originals kept in `textures/_orig_4k/`. *(Done 2026-06-23.)*
- 🟢 **H2 — Anisotropic filtering** on planet + detail textures so the lighter maps still look crisp at grazing angles. *(Done.)*
- 🟢 **H3 — Terrain vertex count** cut 384×256→192×128 (the synchronous build freeze). *(Done.)*
- 🔴 **H4 — Distance LOD / cull far bodies.** Only fully render bodies near the camera; far ones = cheap billboards/points (NMS does this). Three.js frustum-culls per-object automatically; add distance-based detail tiers (THREE.LOD) + keep draw calls low (~100 budget).
- 🔴 **H5 — Async/chunked descent build.** Build heavy terrain off the main thread / in slices so approaching a planet never freezes.
- 🔴 **H6 — Detail via normal + triplanar/detail textures, displacement only up close.** Fake high detail cheaply; real geometry displacement only on the patch under your feet.

Sources: [100 Three.js performance tips](https://www.utsubo.com/blog/threejs-best-practices-100-tips) · [depth-based fragment culling](https://cprimozic.net/blog/depth-based-fragment-culling-webgl/) · [procedural planet + triplanar](https://discourse.threejs.org/t/procedural-planet-generator/59244)

### The named techniques (the "something online" — what to actually use)
- 🟢 **Spin too fast** → lower self-spin rate (NS_SPIN_SLOW 0.35→0.12) for a longer "day." *(Done.)*
- 🟢 **Blue squares on surface** → ground-scatter points had no sprite (hard squares) and showed too high; gave them a soft sprite + only at walking range. *(Done.)*
- 🔴 **H7 — "Dome / only render what's in view, fade far, detail near"** → **THREE.LOD** (swap detail tiers by distance) + automatic frustum culling + **impostors/billboards** for distant bodies + **distance fade** so nothing pops in. This is your "half-circle dome in front of the camera."
- 🔴 **H8 — "Texture should get finer as I approach"** → **Parallax Occlusion Mapping (POM)** + distance-scaled detail-texture tiling, so the ground gains real depth/grain up close instead of one stretched photo.
- 🔴 **H9 — Orbit co-rotation (the "green gravity zone").** When inside a planet's orbit zone, carry the camera along with the planet's spin so it sits still/slow under you (you orbit *with* it) instead of whipping past.
- 🔴 **H10 — Day/night + readable scale.** Sun-driven day/night so you can tell time-of-day; planets feel ~bigger via the local-patch illusion + slower spin (avoid the risky literal 100× radius). "Make me feel smaller" = the local huge-curvature patch, not shrinking the player.
- 🟢 **H11 — Atmosphere entry effect.** Hard shell now dissolves as you enter (no flat circular edge), and a screen-space tint ramps up as you descend so it feels like being immersed in the air (follows your POV). *(Done 2026-06-23.)*
- 🔴 **H12 — G-meter / gravity-field entry HUD.** Show a "entering orbital field" indicator + G/data readout when you cross into a planet's zone (not in the top-right).
- 🔴 **H13 — Closable/reopenable panels.** Signal-health (and other) HUD panels can be closed and reopened from a menu.
- 🟡 **H11b — Sky dome disabled** (drew as a hard faceted circle / "red sea wallhack"); screen-tint now owns the atmosphere color. *(Done — but tint color needs to vary by altitude, see H14.)*
- 🔴 **H14 — Volumetric clouds / dust-storm aesthetic (per-planet).** Dense clouds in the body's real palette (e.g. crimson + orange/brown for a gas/plasma world, not flat purple). Far away = Jupiter-like banding; up close = fly INTO a dust/cloud storm with internal structure (swirls, depth), higher resolution, real shadow, and hue shift as you descend. No hard circle/edge — true volumetric feel.
- 🔴 **H14b — Safe spots / platforms** the AIs inhabit — landable floating structures over the plasma/lava/gas where there's no solid ground.
- 🔴 **H15 — Gas/liquid layers are solid to entry** (no wallhack through clouds/water) + render with depth.
- 🔴 **H16 — Texture LOD by distance + biome variation** (tile size/detail scales to how close you are; varied hues per region, not one repeating pattern).

Sources: [THREE.LOD docs](https://threejs.org/docs/pages/LOD.html) · [impostors/billboards LOD](https://discourse.threejs.org/t/about-dynamic-imposters/27330) · [Parallax Occlusion Mapping](http://mebiusbox.github.io/contents/pixyjs/samples/shader_parallax_occlusion.html)

## G. Carried-over (non-KAIVERSE — tracked so we don't forget)
- 🔴 **G1 — Resource gating + owner-awareness ("only work while alive, and sense me").** KAI shouldn't self-study on a timer. Training stays off by default; heavy work triggers from **real live activity**, not a clock. PLUS: KAI should *sense the owner is actively building* — detect the pattern of frequent restarts / updates / your activity as a calculated signal ("owner is rebuilding → hold, stay quiet, don't grind") — his digital-realm version of awareness/feeling. Verify the pause flag holds (Task Manager check).
- 🔴 **G2 — Groq one-way.** Groq greets but never replies back — fix the broken reply path.
- 🔴 **G3 — Leo sandbox breakout.** Harden Leo's containment so he stops breaking out.
- ⏸️ **G4 — 12M-token context window for Leo.** SQ-style long-context capability. Large dedicated track — parked until the above are stable.

---

## Suggested order (lowest-risk / high-impact first)
1. **A2** (stop the following clouds) + **A1** (nebula color) — contained, big visual win.
2. **B2** (overlap / z-fighting) — fixes the "gritty glitch" you keep seeing.
3. **A3 + A4 + A5** (heat-light, rings, on-planet sky) — visual depth.
4. **B3 + E3** (guidance beam from you + notification/distance UX).
5. **D1 → D2 → D3 → D4** (descent anim → body → arms → jump/controls).
6. **C1 + C2** (seamless planet zone handoff — biggest engineering piece).
7. **E1 + E2** (wrist phone + comms audio).
8. **F1–F3** (quest system + themed planets).
9. **G1–G3**, then **G4** when ready.

*(Order is a proposal — we can reprioritize anytime.)*
