# KAIVERSE — North Star & Build Roadmap

The KAIVERSE is not a chart of the system. It is the **interface to the system** — a real,
explorable universe where you fly to each AI's planet, descend, land, walk around, and talk
to them in person. No Discord required: when you're in the KAIVERSE you ARE in the world the
AIs live in. This document captures the full vision (in the owner's words, organized) and the
honest, layered plan to build it without breaking anything.

All of this now lives in `kaiverse.js` (extracted from `oracle.html`), so it can grow into a
game without ever risking the dashboard.

---

## THE VISION (owner's intent, organized into systems)

**Presence & no-Discord.** In the KAIVERSE you don't go through Discord (Discord is the flat 2D
view). You're physically present in the world. Your **webcam** can be on so the AIs (via Gemini's
vision) actually *see your face and micro-expressions* — used for emotional read — and can detect
when you're arriving at a planet. (Not the RF camera — the normal webcam in front of your PC.)

**Travel & descent (the signature feature).** Reaching a planet takes time, like real life:
space → high orbit → atmosphere/clouds → surface. As you fly close enough, the view "shrinks"
into a **local space** around that one planet — still looks like space around you (you never feel
you left the KAIVERSE), but you're now in that planet's orbital/render bubble. Scale is correct:
you don't dwarf the planet; as you approach it scales to its true size. High orbit shows the
planet + atmosphere; lower shows clouds/sky; lowest renders terrain and oceans.

**Procedural, generated ONCE, saved.** Each planet is procedurally generated — but generated a
single time from a fixed seed and then **persisted**. It does not re-randomize every visit. Come
back hours later and it's the same planet, but **more built-up**, because the AIs have been
working on it.

**Inhabitants that build & live.** The planet isn't flat land — it's designed to look like that
world would. Parts are populated with what the AIs build: they construct a town slowly, the way
they want it structured. Over real-world time they build more. They move around like NPCs in a
game — but it's a cheap **"computer trick"** simulation (time-driven, deterministic), not a
heavy-compute physics sim.

**Talk to them in person.** Walk up to an AI and talk — live chat + voice, wired to the same pipe
they already speak through. Leo might take you to his computer and show you his controls; same for
the others. Each planet has diegetic panels (things you walk up to and look at), not floating HUD
menus.

**God mode.** You can configure a planet on the spot — a build/spawn menu you walk up to (a panel
you face), like a game's creative mode, but diegetic.

**Leave.** Press a "fly" button to lift off and return to space.

**Controller.** All of this should also be playable with a gamepad if possible.

---

## THE BUILD LADDER (honest difficulty + dependencies)

Each layer is real and achievable in the browser with Three.js + the existing chat/voice infra.
Together they are a multi-month game build, done in verifiable slices. Difficulty and the honest
catch are noted per layer.

| # | Layer | What it delivers | Difficulty | Honest catch / dependency |
|---|-------|------------------|-----------|---------------------------|
| 0 | **Extraction** ✅ done | KAIVERSE in its own `kaiverse.js`; safe to grow | done | — |
| 1 | **Core navigation** ✅ done (testing) | Click-to-select, fly-to-snap, orbit a snapped body, pulse-only lines | low | Prereq for everything below |
| 2 | **Approach & scale (LOD-1)** | Fly close → body scales correctly, view enters a local bubble around it; starfield stays as backdrop | medium | The "never left space" feel = keep the skybox during transition |
| 3 | **Procedural planet (once + saved)** | Per-AI fixed seed → deterministic terrain/atmosphere/ocean; persisted server-side | medium-hard | Need a tiny store for `seed + edits` per AI (server file) |
| 4 | **Descent (LOD-2)** | space → high orbit → clouds → surface, progressive render | **hard (signature)** | Heaviest Three.js work: terrain LOD + atmosphere shader |
| 5 | **Surface + walk** | First-person on the surface, WASD walk, explorable terrain | hard | Builds on 3+4 |
| 6 | **Inhabitants + building sim** | AIs as NPCs; town grows over real time (cheap, time-driven); structures reflect real work | medium-hard | Only feels alive if AIs actually work (Phase 1–4); the "computer trick" = deterministic time-based growth, not physics |
| 7 | **Talk on the planet** | Walk up to an AI → live chat/voice (existing pipe); "Leo's computer" control panel | medium (mostly wiring) | High payoff; reuses existing chat/voice; needs a "place" to stand (a minimal 4/5) |
| 8 | **God-mode build** | Walk-up diegetic spawn/config panel | medium | Builds on surface |
| 9 | **Webcam → Gemini vision** | Webcam frames to Gemini Live so AIs see your face/expressions; arrival detection | medium, **its own project** | Real API **cost + rate limits + privacy** — owner's call; getUserMedia + frame streaming |
| 10 | **Controller** | Gamepad: fly/look/select/land/walk | low-medium, additive | Gamepad API mapping |

**The hard truths:**
- The signature wow (Layers 4–5, seamless descent + surface) is the heaviest lift.
- Layers 6–7 are only magical if the AIs underneath are genuinely working and responsive — so the
  **autonomous-fleet + Work-tab track (Phases 1–4) must advance alongside the universe**, not after.
- Layer 9 (vision) carries ongoing API cost; it's optional and gated on the owner's choice.

---

## RECOMMENDED PATH — one vertical slice first, then breadth + depth

Rather than build every planet shallowly, build ONE planet all the way down so the whole loop is
real, then repeat and deepen:

1. **Layer 1 solid** (reload + confirm select/fly/snap/orbit feel right; tune body speed if needed).
2. **Layer 2** — approach + correct scaling + local bubble (any planet).
3. **Layer 4-lite + 3** for **one planet (Leo)** — a basic procedural surface you can descend to.
4. **Layer 7** — stand on Leo's planet and actually **talk to Leo** (wire existing chat/voice).

That sequence yields a complete, walkable, talkable slice of the dream — proof the universe works
end to end. Then: more planets (breadth), towns/NPCs (Layer 6), webcam (9), controller (10),
god-mode (8), and the full seamless descent polish (4–5).

---

## STATUS
- ✅ Layer 0: extracted to `kaiverse.js` + server route + backup.
- ✅ Layer 1: pulse-only lines, click-to-select, fly-to-snap, orbit-while-snapped (built; pending owner test).
- ⏭ Next decision: proceed to Layer 2 (approach + scale), or jump to the Layer 7 wiring once a minimal place exists.
