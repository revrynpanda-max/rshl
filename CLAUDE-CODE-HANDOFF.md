# CLAUDE CODE — START HERE (KAI project handoff)

You are taking over hands-on work on the KAI ecosystem, in `C:\KAI`, from a previous agent (Antigravity / GPT-OSS, now retired — its credit ran out). This file onboards you in one read. **The owner is Ryan (nastermodx).**

---

## ⛔ SCOPE — what we're actually doing (read this twice)

**THE CURRENT FOCUS IS THE BROWSER KAIVERSE (`kaiverse.js`) — the VISUAL OVERHAUL.** The plan lives in **`KAIVERSE-GOAL-visual-overhaul.md`** (tiers) — that is the job right now. Improving the browser sim *is* your work. (The native `src/bin/kaiverse/` `.exe` is a **separate / parallel / longer-term track** — Phase 1 runs, but it is NOT the current focus. Don't spend effort there unless the owner explicitly says so.)

**The one hard rule: IMPROVE the browser, but do NOT BREAK the working first-person controls.** The owner's flight feel is dialed in (first-person fly: WASD + mouse-look, wheel = throttle, click = fly-to a body, H = core, F = orbit/fly, on-foot walk near a surface) — that baseline is sacred.
- **Never alter `nsUpdateCamera` movement/throttle in a way that changes the feel.** On 2026-06-25 a chase-cam rewrite swapped first-person for a 3rd-person cam that "flew away really fast" + rewrote the slow-into-body logic; it had to be fully reverted (Codex **v9.10.8**).
- **A 3rd-person player-ship view IS on-plan (Tier 1.5)** — but ONLY as an **additive, render-only, toggleable** layer that leaves movement untouched and defaults to first-person. (The render-only pre/post-render offset pattern is the right way.)
- **The "hard" visual items — day/night terminator, atmosphere shell, terrain LOD / landing-inside-ground, sky-sphere, volumetric clouds — are EYEBALL-ITERATED WITH THE OWNER** via the fly→screenshot→tune loop. **Do NOT blind-edit them**; ship one small change, let the owner fly + screenshot, tune, repeat.

**Edit discipline:** surgical, reversible, flag-gated (`window.KAIVERSE_*` / env toggles) so the owner can A/B and revert fast; **never wholesale-rewrite** `kaiverse.js` or `oracle.html`; verify against the REAL Windows file (the mount serves stale/truncated snapshots and lies). Don't add features nobody asked for. Before touching the bots (`tools/oracle-discord/`) or `overnight_pipeline.py`, confirm with the owner — those aren't the KAIVERSE plan.

---

## 0. READ THESE FIRST (in order)
1. **`The KAI Codex.md`** — the single source of truth / living manual for the whole system. Huge. At minimum read the masthead table (Version, Version history, **Last Updated**) and the top CHANGELOG entries (newest = `v9.10.10`). The "Plain-Language Index" at the very end maps everyday questions to sections.
2. **`HOTFIX-NOTES.md`** — operational notes + critical warnings.
3. The KAIVERSE design/goal docs: **`KAIVERSE-GOAL-procedural-planets.md`** (the BIG researched plan — terrain parity/clipping fix, real procedural surfaces, NMS landing, cube-sphere LOD descent, atmosphere, + a CC0 download list; **start with its Phase 0**), **`KAIVERSE-GOAL-visual-overhaul.md`** (the visual plan), **`KAIVERSE-GOAL-3rdperson-controls.md`** (B=back, analog throttle, 3rd-person camera flip fix), **`KAIVERSE-GOAL-proximity-movement.md`**, **`KAIVERSE-QUEST-SYSTEM-DESIGN.md`**.

The Codex is canonical. When in doubt, it wins. **Keep it updated as you work** (see §5).

---

## 1. What KAI is (one paragraph)
KAI is a non-transformer "RSHL" lattice intelligence (Rust engine, zero neural weights) plus a Discord bot fleet (Leo = voice, Groq/Gemini/Claudey/X = social, Analyst/Researcher/Kai-Coder = work, Oracle = control). It self-trains nightly (graduate-school tutoring + BitNet distillation). A web dashboard ("Oracle Lattice OS", `oracle.html` on `command-center-server.mjs` port **3001**) shows live telemetry and a 3D "KAIVERSE" view. Full detail: the Codex.

## 2. Repo map (the parts in active play)
- `oracle.html` — the dashboard UI (served statically from repo root by the server). **HUGE single file. NEVER whole-file-rewrite it — only small targeted edits** (whole rewrites have caused truncation before).
- `kaiverse.js` — the browser 3D explorer (Three.js r128) embedded in the dashboard. Same "no wholesale rewrite" rule.
- `tools/oracle-discord/` — the fleet. `command-center-server.mjs` (:3001), `bots/leo.mjs` (voice), `bots/native-bot.mjs` (Groq/Gemini/Claudey/X), `shared/*.mjs` (tts-engine, gemini-live-bridge, presence-gate, etc.), `.env` (keys — **secrets, never commit/echo**).
- `overnight_pipeline.py`, `extract_bitnet_to_lattice.py`, `distill_from_bitnet.py` — nightly training.
- `src/bin/kaiverse/` — **the NEW native Rust/wgpu KAIVERSE client** (see §3). `Cargo.toml` has the `kaiverse` binary target.
- `kaiverse_app/` — an earlier Tauri-wrapper attempt (superseded by the native client; `index.html` is a copy of `oracle.html` pointed at LOCAL `three.min.js` + `three-postprocessing-r128.js` which still need vendoring there).

## 3. The current MAIN effort: BROWSER KAIVERSE visual overhaul (`kaiverse.js`)
**This is what we're doing now.** Make the in-dashboard WebGL KAIVERSE look *alive / cinematic* instead of "8-bit Gameboy space." Full plan + acceptance criteria: **`KAIVERSE-GOAL-visual-overhaul.md`** (read it). Served statically by `command-center-server.mjs` :3001 — **hard-refresh to apply** (no restart).

**What the owner wants (intent):** bloom/lens/glossy-metallic look, NMS-style **volumetric gas you can fly INTO**, blazing JWST-style stars with aura/diffraction spikes, **real planets** (day/night terminator, fresnel limb, surface relief, glossy-vs-rock materials), atmosphere that reads as *air* not a wall, deep layered starfields — all driven procedurally by math. Controls stay **first-person** and working; a **3rd-person player-ship view** is a wanted *additive* option (Tier 1.5).

**The tiers (the phases):**
- **Tier 1 — cinematic baseline:** bloom post-processing (the linchpin — **DONE**, proximity-tamed), hero stars + sun flare, planet material upgrade (fresnel/terminator/relief/atmosphere), lens grade. *Mostly the remaining planet-material work is what's live-tuning now.*
- **Tier 1.5 — activate what's half-built:** gas bands, atmosphere-entry, **player ship (3rd-person, additive/toggle)**.
- **Tier 2 — nebulae you can fly INTO** + a deep-field background (volumetric gas with depth/structure, not flat 2D circles).
- **Tier 3 — procedural material/texture engine** (math-driven surfaces).
- **Tier 3b — close-up terrain detail + fix the LOD seam** (hard, needs visual iteration).
- **Tier 3c — owner's LOD + atmosphere/skybox + core vision** (procedural detail swap on approach, sky-sphere on descent, surface daytime sky).

**⭐ THE NEXT PHASE = the open items from the June 25 live test** (in `KAIVERSE-GOAL-visual-overhaul.md` → "Refined from live test"):
1. **Planets over-bright / blown out** → real **day/night terminator + sun-intensity rebalance** (lit side, dark side, soft terminator fade). ← best one to take first.
2. **Atmosphere shell is a hard "wall"** → fade-to-invisible at the rim, **sun-side limb glow only**, no brighten-on-approach, no inside white wall.
3. **Landing clips you INSIDE the ground** → fix collision/landing floor (GPU-shader terrain vs JS-collision terrain mismatch).
4. **LOD patch seam** still visible (Tier 3b).
5. **Volumetric clouds** — close up they read as flat 2D; make them gas-with-depth.
6. Finish the **player ship** (Tier 1.5).

**HOW (non-negotiable):** these "hard" items are **eyeball-iterated with the owner** — ship ONE small, flag-gated change, the owner flies + screenshots, you tune, repeat. **Do NOT blind-edit them.** Performance is a feature (limited laptop) — every heavy effect gets a quality tier + a `window.KAIVERSE_*`/env toggle. Keep it reversible.

## 3b. Separate / parallel track (NOT the current focus): native `.exe` (`src/bin/kaiverse/`)
A from-scratch native `kaiverse.exe` (Rust + **wgpu**) exists; **Phase 1 compiles + runs** on the owner's RTX 4050 (window, 50k starfield, 9 agent planets, FPS camera, polls :3001, `planet.wgsl` rim glow). Build: `cargo build --release --bin kaiverse`. Its eventual design = procedural galaxy + warp/star-chart + infinite sectors + agents that DRIFT (not teleport) to reflect real Discord activity. **Do not work on this unless the owner says so** — the browser overhaul is the priority right now. (If you do: keep `Cargo.toml [package] version` synced to the Codex version.)

## 4. Recently shipped (v9.10.5 → v9.10.10) — so you don't redo OR undo it
- **v9.10.10** — synced `Cargo.toml` version (9.9.0 → 9.10.10, now tracks the Codex) + cleared all native-client build warnings (trimmed unused `main.rs`/`star_chart.rs` imports, egui pass `mut`, `kai_bench` var; `#![allow(dead_code)]` on `scene.rs`/`server.rs`/`camera.rs` for Phase-2 scaffolding fields — owner to confirm a clean `cargo build`).
- **v9.10.9** — Learning & Dreams vitals: mapping was already correct; the `n/a`s were the engine going quiet during ingest/weave. Added a **last-good cache** in `buildVitals()` (`command-center-server.mjs`) + un-crunched the vitals panels (`oracle.html` CSS). **Needs a server restart** (`Start-KAI.ps1`). ALSO fixed pipeline "recent stage events" reading stale: `keep_pipeline_alive.ps1` now redirects the pipeline's stdout → `overnight_pipeline.log` (was nowhere). *(Dashboard/server work — legitimate, just not the KAIVERSE visual track.)*
- **v9.10.8** — **reverted** a browser `kaiverse.js` 3rd-person chase-camera regression (the bad kind: it edited movement and "flew away fast"). First-person is the restored baseline. **A 3rd-person player-ship view is fine as an ADDITIVE, render-only, toggle (Tier 1.5) — just never edit `nsUpdateCamera` movement to do it.**
- **v9.10.7** — overnight pipeline ingest hygiene: KAI was regurgitating raw `oracle_*.log` command output as answers; `fetch_internal_logs()` + a global filter in `bulk_ingest()` now drop command/log noise (`overnight_pipeline.py`).
- **v9.10.6** — animated 8-bit training classroom (`classroom-preview.html`) embedded in `oracle.html`'s Training panel via iframe; a `/classroom-preview.html` route was added to `command-center-server.mjs`.
- **Older (v9.10.5):**
- **Browser KAIVERSE** (`kaiverse.js`): bloom (UnrealBloomPass via EffectComposer, proximity-tamed), atmosphere-entry fog (`nsUpdateAtmoFog`), audio-player `setMaxListeners(40)`.
- **Dashboard** (`oracle.html`): radar Synapse-Dens now derived (`synapses÷cells`); "Mem Free"/"CPU Free" relabels; (v9.10.3) learn-card sizing, vitals overlap, N/A-flicker cache.
- **Leo voice**: `en-GB-RyanNeural` British edge voice; mic gate ATTACK `5→3`; an English-only `[LANGUAGE]` rule in his Gemini-Live prompt; audio-player listener cap. Per-bot Gemini keys separated in `.env` (no shared-quota fighting).
- **Key reality**: the one prepay-billing key (on Leo) is depleted on the **text** endpoint only; **Gemini Live native-audio (Charon) is a separate service and works** — Leo's *voice* is fine, his *text* falls to local Ollama. KAI can get a voice the same way (lattice text → edge-tts; he already has `en-US-ChristopherNeural`), no LLM needed — an open task.

## 5. CRITICAL GOTCHAS (read before editing anything)
- **The Linux/WSL view of large files LIES.** Tools that read through a mount may serve a STALE/TRUNCATED snapshot of `oracle.html`, `kaiverse.js`, `leo.mjs`, and the Codex. Always trust the REAL Windows file. Do not conclude a file is truncated from a mounted read; verify on the real path. `node --check` over the mount has falsely reported truncation mid-file.
- **Timestamps (mtime) on these files have been unreliable.** Use CONTENT diffs as evidence of change, never the date stamp.
- **No wholesale rewrites of `oracle.html` or `kaiverse.js`** — surgical edits only.
- **Secrets live in `tools/oracle-discord/.env`** — never print, commit, or paste key values.
- **`oracle.html` is served statically** — its changes apply on a browser hard-refresh, no server restart. **`.mjs` changes need the bot/fleet restarted** (`Start-KAI.ps1`). Rust changes need `cargo build`.
- **Don't trust an agent's self-report of its own actions** (including your own memory of "I already did X"). Verify by reading the real file / `git`. A previous agent hallucinated completing a fix; the owner values hard evidence over reassurance.
- **`Start-KAI.ps1`** is the correct full-fleet launcher. (An old `restart-ecosystem` script is outdated and gave a false "dead bots" scan.)

## 6. Working style the owner wants
- **Be concise.** Short replies. Don't pad.
- **Be honest, show evidence.** If you're unsure, say so; verify against files; don't claim a fix you didn't make.
- **Keep the Codex updated.** After meaningful changes, append a CHANGELOG entry at the TOP (prepend above the newest), bump the masthead `Version`, and prepend a one-line summary to the `Last Updated` cell — matching the existing format (`## CHANGELOG  -  vX.Y.Z  (date  -  recorded … UTC)`).
- **The owner is the tester/verifier.** He runs builds and reports evidence (logs/screenshots); you do the engineering. "Feels right" is his call, not something you can self-certify.

## 7. Good first moves
1. Read the Codex masthead + top CHANGELOG (`v9.10.10` down), the **SCOPE box** above, and **`KAIVERSE-GOAL-visual-overhaul.md`** (the active plan).
2. Open the dashboard at `http://localhost:3001/`, enter the KAIVERSE, and fly it so you've SEEN the current look before changing anything.
3. **Default task = the browser visual overhaul, next item:** the over-bright planets → **day/night terminator + sun-intensity rebalance** (§3 / the goal doc's "Refined from live test"). Ship ONE small, flag-gated change; let the owner fly + screenshot; tune; repeat. Do not blind-edit.
4. If the owner instead wants: the **atmosphere shell rework**, the **landing-inside-ground** fix, **volumetric clouds**, or finishing the **player-ship 3rd-person toggle** (Tier 1.5) — all are queued in §3. (Other parked threads, only if he asks: KAI's edge-tts voice, the quest system, or the native `.exe`.)

Welcome aboard. The Codex is your memory; this file is your map.
