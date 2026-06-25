# GOAL (for Claude Code CLI): KAIVERSE procedural planets — terrain parity, real surfaces, NMS landing & descent

**Status:** OPEN — large, phased. Browser `kaiverse.js` (Three.js **r128**, no newer APIs). Owner-reported while flying a desert planet: you clip THROUGH the surface, the planet is a stretched image, descent is low-poly, the atmosphere walls/clips, and `Y` lands from anywhere in the atmosphere. This doc is the researched plan; the CLI implements one phase at a time; the owner tests + judges the look. **Surgical, reversible, flag-gated. Don't break the working first-person fly controls** (`CLAUDE-CODE-HANDOFF.md` SCOPE box).

---

## ★ THE NORTH STAR (read first — it explains every bug)
The owner clips through hills, lands inside the planet, and flies through terrain because **the planet is displaced TWICE: a CPU vertex bake AND a GPU vertex-shader displacement — and collision only sees the CPU bake.** What you SEE (GPU) and where you STAND (CPU) are different heights. Every researched source converges on one rule:

> **ONE authoritative height function. Bake it into the real mesh vertices on the CPU. Do NOT displace again in the shader. Then the rendered surface IS the collision surface — `Raycaster` / height-sampling "just works."**
> Sources: three.js maintainers + sbcode (displacementMap doesn't move CPU geometry, so raycast misses) — https://discourse.threejs.org/t/how-to-raycast-plane-with-displacement-map/31887 , https://sbcode.net/threejs/raycast-to-displacementmap/ ; "have exactly one authoritative height source both "what you see" and "where you stand" consume" — https://www.gamedev.net/forums/topic/698814-procedural-terrain-whats-the-best-approach-to-calculate-noise-in-the-gpu/

This is **Phase 0** and it's the highest-value, most contained fix. Do it first.

---

## PHASE 0 — Terrain PARITY (fix the clipping/land-inside NOW, no rewrite)
Make the visible surface and the collision surface read the SAME heights.
1. **Find every place a planet is displaced.** In `kaiverse.js` there is (a) a CPU vertex bake using `nsTerrainHeightJS(...)` and (b) a GPU shader displacement (`nsApplyDisplacement` / the terrain `onBeforeCompile`). **Pick ONE.** Recommended: keep the **CPU bake** (it gives real heights for collision/landing) and **remove the additional GPU shader vertex displacement** so the mesh you see equals the baked mesh.
2. **Collision + walk + landing all sample the SAME source.** For "where you stand," sample `nsTerrainHeightJS` at the player's direction (cheaper than a raycast when you know the point); raycast the baked mesh only when you need the exact surface normal (orienting the ship). The fly-mode collision floor must use this same height — no separate amplitude guess.
3. **If you keep ANY shader displacement for distant LOD**, it must call the **same** function in **camera-relative single precision** — never feed huge absolute world coords to the shader (IEEE-754 reorder + float precision silently breaks parity → hover/clip). Sources: https://www.gamedev.net/forums/topic/698814... , https://godotengine.org/article/emulating-double-precision-gpu-render-large-worlds/
4. **Acceptance:** walk and fly over hills — you rest ON the surface and stop AT the visible hill, never inside it, on every planet. No "invisible surface above me."

---

## PHASE 1 — Landing & the ship (the owner's control intent)
Owner: "Y should be for when I get to the ship so I can't fly otherwise; landing shouldn't trigger from high in the atmosphere; it should find a safe flat spot like No Man's Sky; and it must put me ON the surface."
1. **`Y` = enter/exit ship (context).** On foot near the ship → enter (now you can fly). In ship → exit only when landed (you become the on-foot character). You can only fly while IN the ship.
2. **Gate landing by a SMALL height window**, not "anywhere in atmosphere." Compute `altitude − terrainHeight`; only enable "land" when that gap is below a few-hundred-meters threshold (`window.KAIVERSE_LAND_GATE`). Sources: ray-down ground detection — https://www.gdquest.com/library/raycast_introduction/
3. **Auto-find a safe flat spot (NMS-style, fully guided).** Sample a small ring/grid of candidate offsets around the ship; score each by **slope = `dot(surfaceNormal, up)`** (accept only above a cutoff) + local roughness + footprint clearance; pick the best and steer the ship there. NMS landing is automated/guided — lean into that. Sources: slope = normal vs gravity — https://arxiv.org/pdf/2409.09309 ; auto-search flattest patch — https://arxiv.org/pdf/2107.06921 ; "NMS landing is automated" — https://www.gamedev.net/forums/topic/700104-simulate-the-no-mans-sky-effect/5396086/
4. **Settle ON the surface:** snap the ship's contact point to the raycast hit point and blend the ship's up toward the surface normal (clamped so mild slopes don't over-tilt). Source: https://terrain3d.readthedocs.io/en/stable/docs/collision.html
5. **Acceptance:** can't land from high up; near the surface, pressing Y auto-picks a flat spot and seats the ship on the ground; Y on foot re-enters the ship.

---

## PHASE 2 — REAL procedural surface (kill the stretched image)
Replace the single stretched equirectangular image with a multi-scale procedural material. Inject into `MeshStandardMaterial` via **`onBeforeCompile`** so you keep Three's PBR + your bloom.
1. **Triplanar (or cheaper biplanar) projection** — sample by world axes, blend by world normal → no pole pinch, no stretch, no seam. Biplanar = 2 samples instead of 3 (~33% less bandwidth), near-identical on a sphere → use it on the laptop. Sources: https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a , https://iquilezles.org/articles/biplanar/
2. **Triplanar NORMAL maps need the Whiteout/UDN blend**, never raw mesh tangents (bumps flip). Use UDN (cheapest) on the laptop. Same source (Ben Golus).
3. **Biome blend by slope + altitude + latitude:** slope `dot(normal, up)` (rock on cliffs, grass/sand on flats), altitude `length(pos)−radius` (beach→grass→rock→snow bands), latitude `abs(normalize(pos).y)` (polar ice). `smoothstep` bands jittered by one cheap noise call. Height-aware (splat) blend, not linear `mix`, for crisp transitions. Sources: https://discourse.threejs.org/t/exoplanetary-systems-with-procedurally-generated-planet-textures/20108 , Ben Golus height-blend.
4. **Multi-scale detail (macro + micro)** of a tileable PBR set so it stays crisp on landing; **anti-tiling via IQ "Technique 3"** (2 fetches, mipmap-safe, noise-indexed) so it never looks grid-repeated. Sources: https://iquilezles.org/articles/texturerepetition/
5. **Acceptance:** no stretched-image look; surfaces read as rock/sand/grass/snow by slope & height; crisp underfoot, no obvious tiling, no seams at poles.

---

## PHASE 3 — Smooth space→surface descent (kill the low-poly pop)
The "getting closer from space" illusion is poor because the planet is a fixed low-poly sphere. The researched standard:
1. **Cube-sphere (quadsphere), 6 faces, each a quadtree of fixed-res grid patches** (≈17×17 incl. skirt). Spherify with the analytic map (not plain `normalize`) for even vertices. Sources: https://dexyfex.com/2015/11/30/planetary-terrain-rendering/ , https://catlikecoding.com/unity/tutorials/procedural-meshes/cube-sphere/
2. **Subdivide by screen-space error** (`patchAngularSize / distance` ≈ a few px); cap max depth + a per-frame split budget so the laptop doesn't spike. Source: dexyfex (above), https://discourse.threejs.org/t/another-quadtree-planet-engine/61587
3. **Crack-free LOD via skirts** (a ring of triangles pushed radially inward — no neighbor bookkeeping). Add **CDLOD per-vertex geomorphing** (morph fine verts toward the parent in the vertex shader) so detail never "pops" on descent. Sources: https://www.gamedev.net/forums/topic/485584-chunked-lod-with-procedural-planets/ , https://aggrobird.com/files/cdlod_latest.pdf
4. **Floating origin + chunk-local coords** (move the planet, not the camera) to keep 32-bit float precision usable at the surface (otherwise blocky up close). Generate chunks/noise in a **Web Worker**, transfer typed arrays; **bake displacement + normals on the CPU per chunk** (keeps Phase-0 parity — the baked chunk is the collision mesh). **Pool & dispose** chunk geometries to avoid browser GPU-memory blowups. Sources: dexyfex, https://github.com/merpnderp/webglquadtreeplanet
5. **Perf lever #1: `renderer.setPixelRatio(Math.min(devicePixelRatio,1))`** (optionally dynamic by FPS) — measured ~27→57 FPS on weak GPUs. Source: https://discourse.threejs.org/t/render-half-size-then-upscale/13228
6. **r128 caveat:** no `BatchedMesh`/TSL/WebGPU (all post-r128). Use `InstancedMesh` for scattered rocks/foliage (one draw call/type, distance-faded).
7. **Acceptance:** flying from orbit to ground, the surface gains detail continuously with no popping, no low-poly silhouette, holding ≥ ~40 fps.

---

## PHASE 4 — Atmosphere / sky (no hard wall, believable descent)
Owner: atmosphere reads as a wall, clips, and the sky/horizon looks off.
1. **From space:** an **additive `BackSide` Fresnel shell** (~1.02–1.05× radius, `transparent`, `depthWrite:false`) whose alpha is a Fresnel rim term × a **sun-direction sigmoid** (glow dies on the dark side, fades to invisible at the rim → no hard edge). Drop-in r128 GLSL exists. Sources: https://sangillee.com/2024-06-07-create-realistic-earth-with-shaders/ , https://discourse.threejs.org/t/creating-a-pseudo-realistic-planetary-atmosphere-on-the-cheap/40391
2. **On descent, cross-fade** the space shell OUT and three.js **`Sky`** (Preetham sun dome) IN over an altitude band — never both fully on → so you never "pass through" a physical atmosphere mesh. Source: https://threejs.org/examples/webgl_shaders_sky.html
3. **Reference physics** for tuning: `wwwtyro/glsl-atmosphere` (public domain) scattering constants; set Mie `g≈0` and low step count on the laptop. Source: https://github.com/wwwtyro/glsl-atmosphere
4. **Acceptance:** from space a soft sun-side limb glow, invisible rim, no ring/wall; descending, space fades to a real sky + horizon; on the surface in daytime you see sky/clouds, never black space, never a white wall following you.

---

## ⬇ DOWNLOAD LIST (CC0 / permissive — the CLI can `curl`/`git clone` these on Windows)
Grab these into a `kaiverse_assets/` folder (vendor locally so the static server serves them; keep textures **1K, max 2K** for the laptop):
1. **ashima/webgl-noise** (`noise3D.glsl`) — MIT, in-shader simplex; foundation for terrain + texture blend. https://github.com/ashima/webgl-noise
2. **FastNoiseLite** (JS + GLSL ports) — MIT, CPU heightmaps/biomes + **matching** GPU noise (FBm + domain warp built in → use the SAME config CPU & GPU for Phase-0 parity). https://github.com/Auburn/FastNoiseLite
3. **wwwtyro/glsl-atmosphere** (`index.glsl`) — Unlicense; scattering reference + Earth constants. https://github.com/wwwtyro/glsl-atmosphere
4. **Sangil Lee atmosphere + Fresnel GLSL** — copy directly (r128-ready, no lib). https://sangillee.com/2024-06-07-create-realistic-earth-with-shaders/
5. **ambientCG ground sets @1K JPG** — CC0: `Rock023`, `Ground037`, + one each grass/sand/snow (Color/Normal/Roughness). https://ambientcg.com/list?category=Ground
6. **Poly Haven `aerial_grass_rock` @1–2K** — CC0 scanned grass-over-rock. https://polyhaven.com/a/aerial_grass_rock
7. **Quaternius "150+ LowPoly Nature" (GLTF)** — CC0 rocks/trees/bushes to scatter via `InstancedMesh`. https://quaternius.itch.io/150-lowpoly-nature-models

---

## HARD CONSTRAINTS (all phases)
- **Surgical, reversible, flag-gated** (`window.KAIVERSE_*`); never wholesale-rewrite `kaiverse.js`/`oracle.html`; verify against the REAL Windows file (the mount serves stale/truncated snapshots and lies).
- **Don't break the first-person fly controls** (never alter `nsUpdateCamera` movement feel; additive only).
- **Perf is a feature** (limited laptop): quality tiers + toggles; target ≥ ~40 fps open space; 1K textures; `setPixelRatio(min(dpr,1))`.
- **One phase at a time, owner look-tests between each** — the "hard" visual items are eyeball-iterated, not blind-edited.
- Log each phase in the Codex + bump `Cargo.toml` version to match.

## Build order
**Phase 0 (parity) → Phase 1 (landing/ship) → Phase 2 (procedural surface) → Phase 3 (cube-sphere LOD descent) → Phase 4 (atmosphere).** Phase 0 alone fixes the "I went through the planet" complaint and is small — do it first, ship it, look-test, then proceed.
