# Antigravity Plan — source & install KAIVERSE planet textures

The KAIVERSE descent code (`kaiverse.js`) is ALREADY wired to load and use these files.
Anti's job is only to **download real, CC0/public-domain texture maps and drop them into
`C:\KAI\textures\` with the exact names below.** No code changes — the loader picks them up
automatically (and falls back to procedural for anything missing, so partial delivery is fine).

Copy everything in the box to Antigravity.

---

**TASK: Populate `C:\KAI\textures\` with real, seamless, equirectangular planet maps so the KAIVERSE planets render as real-looking worlds (color + lit relief + clouds), not procedural noise.**

### 1. Files to produce (per AI planet)
For each planet name below, provide up to THREE maps (color is the minimum; normal + clouds make it great):

| File | Purpose | Format |
|------|---------|--------|
| `<name>.jpg` | COLOR / albedo (the surface look) | equirectangular 2:1 JPG |
| `<name>_normal.jpg` | NORMAL map (relief — mountains/craters catch light) | equirectangular 2:1 JPG (RGB normal, or derive from a height map) |
| `<name>_clouds.png` | CLOUD layer (transparent — only clouds opaque) | equirectangular 2:1 **PNG with alpha** |

**Planet names** (lowercase, no spaces — these are exactly what the code requests):
`kai`, `leo`, `gemini`, `claudey`, `x`, `groq`, `analyst`, `researcher`, `kaicoder`
Plus a generic fallback set: `default.jpg`, `default_normal.jpg`, `default_clouds.png`.

Give each AI a **distinct world type** so the fleet feels varied — e.g. earth-like, rocky/Mars, gas-giant bands, icy, lava, ocean, exotic. (Mix it up; no two the same.)

### 2. Specs
- **Equirectangular, 2:1 aspect**, ~2048×1024 (color/normal). Clouds can be 1024×512.
- **Seamless** at the left/right wrap (no visible seam on a sphere). Poles should look sane.
- Optimize: color/normal JPG quality ~82, each ideally **≤ 500 KB**; clouds PNG ≤ ~400 KB.
- Normal maps: if you only find a HEIGHT/bump map, convert it to a tangent-space normal map.

### 3. Sourcing (CC0 / public-domain / CC-BY only)
- **NASA / JPL / USGS Astrogeology** planetary maps — public domain (Earth, Mars, Moon, Jupiter, etc.). Many have matching elevation maps → convert to normal.
- **Solar System Scope** — https://www.solarsystemscope.com/textures/ — CC BY 4.0 (color + bump for the planets; keep attribution).
- **ambientCG** — https://ambientcg.com/ — CC0 — great for rocky/ice/lava surface fills and ready-made normal maps.
- For clouds: NASA "Blue Marble" cloud layer (public domain) or a CC0 cloud equirectangular.
If you use any CC-BY asset, write `C:\KAI\textures\CREDITS.txt` listing each file → source → license.

### 4. Install & verify
- Create `C:\KAI\textures\` if missing; place all files there.
- With the Command Center running, verify the route serves them (200):
  `curl -s -o NUL -w "%{http_code}" http://localhost:3001/textures/leo.jpg`
  `curl -s -o NUL -w "%{http_code}" http://localhost:3001/textures/leo_normal.jpg`
  `curl -s -o NUL -w "%{http_code}" http://localhost:3001/textures/leo_clouds.png`
  (The dashboard must have been restarted once after this session's `/textures/` route was added.)
- In the KAIVERSE, fly down to that planet — the descent surface should now show the real color map, relief that catches light, and the cloud shell.

**Deliverable:** `C:\KAI\textures\` populated with the named maps (+ `CREDITS.txt` for any CC-BY), each seamless 2:1 equirectangular, optimized. Do NOT edit `kaiverse.js` or the server — loading/serving is already done.

---

### Reference (already wired — for Anti's awareness, no action)
- `kaiverse.js` `nsBuildBodies` loads `/textures/<name>.jpg` (→ surface color, drops emissive so it's lit), `/textures/<name>_normal.jpg` (→ `material.normalMap`), `/textures/<name>_clouds.png` (→ used by the descent cloud shell). All optional, silent fallback to procedural.
- The descent system (`nsUpdatePlanetDescent`) uses the downloaded color for the close-up terrain, the normal map for relief on both base + terrain layers, and the cloud PNG for the rotating cloud shell.
- Server route `/textures/*` already serves from `C:\KAI\textures\` (jpg/png/webp).
