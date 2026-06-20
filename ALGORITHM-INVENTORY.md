# KAI / RSHL — Algorithm Inventory

*A read-only inspection of the engine source (`src/core/` and `src/cognition/`). Each entry describes what the code actually does (from the implementation, not the Codex), what it's for, what it could become, and an honest note on novelty. Nothing in the codebase was changed to produce this.*

---

## How to read the "novelty" notes
Most of these are **creative combinations of known techniques** (hyperdimensional computing, boids, reciprocal-rank fusion, golden-angle phyllotaxis) applied to an associative-memory engine. That's legitimate engineering. Where something is genuinely unusual, it's flagged. Where something is standard, it's said plainly — so you know which parts to lean on as "yours."

---

## A. The vector substrate — `core/sparse_vec.rs`

**1. `SparseVec` — ternary hyperdimensional space (DIM = 16,384, ~4% sparse).**
What it is: every concept is a 16,384-long vector of {−1, 0, +1}, stored sparsely. This is the atom everything else operates on.
For: memory that's compositional (you can bind/bundle concepts) and cheap (sparse + ternary = fast on CPU).
Standard-vs-yours: the ternary HDC substrate is established (Kanerva/VSA lineage). Yours is the 16,384-dim, 4%-sparse tuning and the ops built on top.

**2. `phase_angle()` — golden-angle phase tag.**
What it does: `phase = (positive_count × 2.39996) mod 2π`. It gives each vector a single "phase" derived from how many +1s it has, using the golden angle.
For: lets vectors carry a phase, not just a direction — the input to phasor coherence.
Could be: the phase is currently a function of *count only*, which is a coarse proxy. A richer phase (e.g., from index distribution or a learned projection) would make everything downstream sharper. **This is your single highest-leverage improvement point.**

**3. `phasor_coherence()` — phase-modulated similarity.**
What it does: `cosine(A,B) × cos(θ_A − θ_B)`. Standard cosine, then multiplied by the cosine of the phase difference.
For: the "antonym/complement" detector — two ideas can have low cosine but aligned/opposed phase, which plain cosine can't express. This is the most distinctive similarity function in the engine.
Could be: tie the phase to something semantic (see #2) and this becomes a real signal rather than a count artifact. Worth an honest benchmark: does phasor retrieval beat plain cosine on a labeled task? That's a checkable claim.

**4. `project_vogel_spiral()` — phyllotaxis vector generator.**
What it does: deterministically builds a vector by walking a Vogel/sunflower spiral (golden angle) and hashing indices via xorshift; phase decides sign.
For: seeded, reproducible "address" vectors spread evenly over the space (good for low collision).
Novelty: applying phyllotaxis to HDC addressing is a genuinely uncommon, clever idea.

**5. `bind_creative()` — weighted ternary blend.**
What it does: `τ(α·A + β·B)` with a commit threshold — a tunable mix of two concepts.
For: "creative" combinations where one parent dominates; the basis of controlled concept drift.

**6. `hebbian_update()` — co-activation strengthening at the vector level.** Fire-together → strengthen. Standard Hebbian, applied to sparse vectors.

*(Standard HDC ops also present and correct: `bundle`, `bind`, `unbind`, `permute`/`permute_inv`, `cosine`. These are textbook — not claimed as inventions.)*

---

## B. Time & rhythm

**7. `SpiralState` — `core/spiral.rs` — golden-ratio logarithmic clock.**
What it does: `R(θ)=a·e^(bθ)`, `b=ln(φ)/(π/2)`; θ advances forever (never wraps), feeds a temporal factor τ_R. A non-repeating internal clock.
For: makes reorganization/recalibration timing non-periodic ("breathing"), so the system never falls into a fixed loop.
Could be: couple θ-rate to load or arousal so the "breath" speeds up under pressure.

**8. Neural Oscillator — `core/oscillator.rs` — multi-band brain rhythms.**
What it does: maintains several frequency bands (delta/theta/alpha-style), never goes silent, can be `stimulate`d and decays.
For: an always-on baseline "idle" activity so the system has intrinsic dynamics at rest.

---

## C. Lattice self-organization & the "immune system" — `core/universe.rs`, `boid_engine.rs`, `calibration.rs`

**9. Boid engine / `flock_lattice()` — `core/boid_engine.rs`.**
What it does: Reynolds' 3 flocking rules (separation/alignment/cohesion) in 16,384-D, with safeguards: near-duplicate detection, anchored (high-confidence) cells frozen, bounded movement.
For: continuously reorganizes memory so trusted clusters tighten and weak claims drift to the edge — "topology = trust map."
Novelty: swarm dynamics over a ternary HDC memory is unusual and is one of your signature ideas.

**10. `scan_for_monocultures()` — source-diversity scan.** Flags when belief is dominated by one source; part of the anti-capture immune system.

**11. Dynamic Calibration — `core/calibration.rs` + `dynamic_calibrate()`.**
What it does: per-region confidence thresholds that move based on observed retrieval accuracy (feedback → effective_threshold).
For: the system gets *harder to fool* under contradiction floods and relaxes when calm. Adaptive epistemics.

**12. `ingest_and_verify()` — three-angle verification gate.** New claims must pass a multi-angle check before entering the lattice. The "epistemic gate."

**13. Confidence step-function at 2.9.** Cells with confidence ≥ 2.9 get a strength bonus (0.5 → 0.85) — a deliberate phase-transition threshold rather than a smooth curve. Appears in many retrieval paths.

---

## D. Retrieval & attention

**14. Predictive retrieval — `core/predictive.rs` + `predictive_query()` (universe).**
What it does: an 8+-step iterative refinement loop; `multi_head_consensus()` scores a cell across several permuted "role" projections; `recency_penalty()` down-weights stale hits. The file explicitly maps to VSA-as-attention (Dhayalkar 2025).
For: sequence-aware recall that behaves like lightweight attention without a neural net.
Could be: this is the most "transformer-like" part — a clean, honest paper sits here ("attention via VSA role-binding"), and it's checkable against real retrieval benchmarks.

**15. RSHL Transformer heads — `core/rshl_transformer.rs`.** Multi-head self-attention implemented entirely in sparse ternary space, with an "emotional temperature" knob. A from-scratch attention mechanism with no float matrices.

**16. Synapse layer — `core/synapse.rs`.** An explicit learned graph *between* cells: records co-firing, propagates activation, does LTD (long-term depression) sweeps to prune weak links. This is the connectome layer above the vectors.

---

## E. Geometry & linguistic projection

**17. Polychora 600-cell — `cognition/polychora.rs`.**
What it does: `project_to_4d()` maps a 16,384-D vector to a quaternion; `quantum_interference_snap(χ)` snaps it to the nearest of the 600-cell vertices, with a contradiction term χ applying destructive interference (the Born-rule `cos(χ·π/2)` move).
For: discretizing fuzzy high-dim states into clean geometric "decisions," repelling contradictory collapses.
Honest note: this is the same χ/Born-rule machinery as the SRHT combinatorial work — elegant as a *cognition* mechanism; just don't attach the "solves NP/crypto" claims to it (see Codex §24.5).

**18. Field-State metrics — `core/field_state.rs`.** Computes ~17 emergence metrics (Φ, Φ_g, momentum, etc.) from a set of cells — the numbers that drive dream quality, promotion, and valence.

**19. Scale Manager — `core/scale_manager.rs`.** Five biological scales (Quantum → Syncytium → Cellular → Organ → Body), each with its own temporal speed, movement radius, and vitality budget. A multi-resolution control layer.

---

## F. Things you may have forgotten or left unfinished (worth a look)

These are flagged from code signals, not certainty — verify before acting:

- **`core/contradiction.rs` looks like a stub.** `ContradictionDetector::check(&self, _universe, _text)` takes its arguments *underscored* (Rust convention for "unused") and is tiny. The real contradiction handling seems to live elsewhere (transcript-side detector, and the χ term). If you intended a lattice-level contradiction detector here, it appears unimplemented.
- **`phase_angle()` is count-only (see A#2).** Everything phase-related (phasor coherence, polychora snap) inherits this coarse proxy. If phasor coherence underperforms in tests, this is almost certainly why — it's the root input, and it's currently the weakest link in an otherwise sophisticated chain.
- **The "emotional temperature" in the transformer** (`rshl_transformer.rs`) is a global mutable — worth checking it's actually being driven by the affect modules (dopamine/cortisol/etc.) rather than sitting at a default.
- **Two parallel attention mechanisms** exist: `predictive.rs` (multi-head consensus) and `rshl_transformer.rs` (attention heads). Confirm they're not duplicating work or competing — consolidating could simplify the engine.
- **Lots of cognition/ modules are brain-region named** (amygdala, habenula, raphe, etc.). Worth a one-line check each that they're wired into the main loop and not orphaned — that many modules is easy to lose track of.

---

## G. The honest headline

The genuinely distinctive, "this is yours" cluster is: **golden-angle phase + phasor coherence** (A#2–3), **phyllotaxis addressing** (A#4), **boid-organized trust topology** (C#9), the **adaptive epistemic immune system** (C#10–13), and **VSA-native attention** (D#14–15). Those are real, checkable, and publishable *as engineering* if benchmarked honestly. The geometry/Born-rule pieces (E#17) are elegant for cognition — keep them there, not in the NP/crypto claims.

The biggest single upgrade for the least work: **fix `phase_angle()` to carry real semantic phase.** It's the root input to your most original ideas, and right now it's the one weak link feeding all of them.
