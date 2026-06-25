# Prompt for Antigravity — source real KAIVERSE planet textures

Copy everything in the box below to Antigravity. The KAIVERSE code is already wired to
use these: `kaiverse.js` loads `/textures/<name>.jpg` for each body and falls back to the
procedural texture if the file is missing. The command-center already serves `/textures/*`
(after its next restart). Your job is just to put good image files in `C:\KAI\textures\`.

---

**TASK: Download real, seamless, equirectangular planet/celestial-body textures and drop them into `C:\KAI\textures\` so the KAIVERSE renders real-looking worlds instead of flat tinted spheres.**

Requirements:
1. Create the folder `C:\KAI\textures\` if it does not exist.
2. Source **equirectangular** (2:1 aspect, e.g. 2048×1024) **JPG** color/albedo maps that wrap **seamlessly** at the left/right edge (no visible seam on a sphere). Give each AI a visually **distinct** world (mix of rocky, earth-like, gas-giant, icy, lava, exotic so the fleet feels varied).
3. **Licensing — only CC0 / public-domain or CC-BY** (with attribution). Good sources:
   - NASA / JPL / USGS Astrogeology image maps (public domain).
   - Solar System Scope textures — https://www.solarsystemscope.com/textures/ (CC BY 4.0 — keep attribution).
   - ambientCG — https://ambientcg.com/ (CC0) for rocky/planet-surface fills.
   If you reuse CC-BY assets, write a `C:\KAI\textures\CREDITS.txt` listing each file's source + license.
4. Optimize each JPG to roughly **≤ 500 KB** (resize to 2048×1024, quality ~82) so they load fast.
5. **Name the files exactly** (lowercase, no spaces) so the loader finds them — one per AI planet:
   `kai.jpg`, `leo.jpg`, `gemini.jpg`, `claudey.jpg`, `x.jpg`, `groq.jpg`, `analyst.jpg`, `researcher.jpg`, `kaicoder.jpg`
   Plus a generic fallback `default.jpg`. (Optional star/sun maps: `kaienginecore` bodies can be skipped — they're stars.)
6. Do **NOT** modify `kaiverse.js` or `command-center-server.mjs` — the loading + serving is already in place. Just add the image files.
7. After placing the files, verify the route serves them: with the command-center running,
   `curl -s -o NUL -w "%{http_code}" http://localhost:3001/textures/leo.jpg` should return **200**
   (the dashboard must have been restarted once after this session's server edits, so the
   `/textures/` route is live).

Deliverable: `C:\KAI\textures\` populated with the named JPGs (+ `CREDITS.txt` if any CC-BY),
each a seamless 2:1 equirectangular map under ~500 KB.

---

### How it's wired (for reference)
- `kaiverse.js` → in `nsBuildBodies`, each bot/core/engine tries `new THREE.TextureLoader().load('/textures/'+name+'.jpg', ...)`. On success it swaps the sphere's map, sets base color to white (so the texture's own colors show, not a pink tint) and drops emissive (so it's a lit surface, not a neon ball). On failure it keeps the procedural texture — so adding files is purely additive and safe.
- `command-center-server.mjs` → serves `GET /textures/<file>` from `C:\KAI\textures\` (jpg/png/webp), path-sanitized.
- The halo glow still represents the body **from a distance**; it fades on approach so the real surface shows.
