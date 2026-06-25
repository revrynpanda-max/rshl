# KAIVERSE → NMS-Quality: Research & Recommendations
*Research only. No code changed. This is the plan + what to download.*

## The one root cause of "fake depth / crappy textures"
We have been **lighting procedural noise bumps on top of photo textures that don't line up.** The crater you see in the photo is NOT where the geometry has a crater, so the shadows "tease" depth the surface doesn't have. Stacking fog/sky/atmosphere on top just muddies it.

**The fix is not more shaders — it's matched asset sets:** for each planet, use a *color map + normal map + HEIGHT map that all came from the same source*. Then displace the geometry by the height map. Now the canyon in the picture **is** a real canyon, lit correctly. This is exactly how real planet renders (and NMS's hand-authored worlds) get believable depth.

---

## 1. Download matched planet maps (biggest single win)
For each AI's planet, pick a real body and grab its **color + normal/bump + height (displacement)** maps. Drop them in `/textures` as `<name>.jpg`, `<name>_normal.jpg`, `<name>_height.jpg`.

- **Solar System Scope — Solar Textures** — NASA-based color + bump, 2k–8k, free. https://www.solarsystemscope.com/textures/
- **JHT's Planetary Pixel Emporium** — color + **bump + normal + specular** for every planet/moon, free. https://planetpixelemporium.com/planets.html
- **NASA 3D Resources** (real DEM elevation = true height maps for Moon/Mars/etc.) — public domain. https://nasa3d.arc.nasa.gov/ and https://github.com/nasa/NASA-3D-Resources
- **16K Solar System pack** (diffuse + normal + spec + roughness + **displacement** + emission) if you want one bundle. https://www.artstation.com/marketplace/p/5oNl/solar-system-in-16k-texture-pack

## 2. Download CC0 ground materials (for the close-up surface)
When you're walking, you need tiling rock/sand/grass with their own height+normal so the ground is crisp and 3D up close.
- **Poly Haven** — CC0, no signup, PBR terrain materials (color+normal+rough+**displacement**). https://polyhaven.com/textures
- **ambientCG** — CC0 surface materials, same maps. https://ambientcg.com/

## 3. Adopt proven libraries (stop hand-building)
- **`postprocessing` (pmndrs)** — production-grade bloom, SSAO, god-rays, tone-mapping. Replaces my hand-rolled bloom and looks far better. https://github.com/pmndrs/postprocessing
- **`@takram/three-clouds`** — real **volumetric ray-marched clouds + aerial-perspective atmosphere** (the actual NMS cloud/sky look). https://www.npmjs.com/package/@takram/three-clouds
- Reference planet engines to study: https://github.com/prolearner/procedural-planet · https://github.com/olivermulari/planet (Babylon)

## 4. Engine verdict (honest)
- **Stay on three.js.** It has the most planet examples + the cloud/atmosphere/postprocessing libraries above. Switching to Babylon.js = full rewrite for a marginal gain.
- **BUT:** we are on three.js **r128 (old)**. The libraries above want a newer three.js. So step 0 for libraries = **upgrade three.js** (a compatibility pass — our custom shaders use r128 syntax like `vUv`/`texture2D` that newer versions handle differently).

---

## Recommended order (for Anti / next code session)
1. **Download matched color+normal+HEIGHT maps** for each planet → `/textures`. *(No code; pure asset drop.)*
2. **Add a height-map displacement step** so geometry matches the photo (real craters/canyons). *(Small, targeted code change — works on current r128.)*
3. **Add Poly Haven CC0 ground materials** for the walked surface.
4. **Upgrade three.js**, then drop in `postprocessing` (bloom/atmosphere) and optionally `@takram/three-clouds` (volumetric). *(Bigger compatibility project.)*

**Reality check:** steps 1–2 alone (matched height maps + displacement) will do more for the "real depth" feeling than everything I stacked this week. Steps 3–4 get the cinematic atmosphere/clouds. None of it requires matching a AAA studio — it requires the *right assets* feeding *proven libraries*, instead of hand-built shaders fighting mismatched textures.

---
### Sources
- Solar System Scope textures — https://www.solarsystemscope.com/textures/
- Planetary Pixel Emporium — https://planetpixelemporium.com/planets.html
- NASA 3D Resources — https://nasa3d.arc.nasa.gov/ · https://github.com/nasa/NASA-3D-Resources
- Poly Haven — https://polyhaven.com/ · ambientCG — https://ambientcg.com/
- pmndrs/postprocessing — https://github.com/pmndrs/postprocessing
- @takram/three-clouds — https://www.npmjs.com/package/@takram/three-clouds
- procedural-planet (three.js) — https://github.com/prolearner/procedural-planet
