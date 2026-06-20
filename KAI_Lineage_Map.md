# KAI Lineage Map — three generations of the brain

*Rediscovered June 19, 2026 by reading Ryan's older project folders. This maps how KAI evolved, what each generation reached, and which ideas are worth pulling forward. Companion to The KAI Codex.*

> Timeline correction: this all happened in **months, not years.** KAI 2.0 v29.1 is dated **April 2026**; KAI-polyglot started **June 6, 2026**; current KAI is **June 2026, v9.8.x**. Fast.

---

## Generation 1 — KAI 2.0 (Python)  ·  `C:\Kai 2.0`

Three builds, chronological, each absorbing the last:

- **`KaiV2\backend\`** — the clean 5-layer LLI scaffold (reference build; had an Electron dashboard + Windows installer).
- **`KaiExperiment\...\jarvis_cognitive_kernel\`** — the richer "Jarvis" kernel: HDC ternary RSHL, `lli_router`, autonomous loop, invention engine, world control, Ray-distributed actors.
- **`KAI_v29_bundle\`** — the high-water mark: a ~52-module **non-LLM cognitive resident** that thinks in structured scalars and renders to language last.

**The LLI (Layered Living Intelligence) loop** — the spine of the whole project:
`Stem (wake) → Reflex (Bloom + Rete, <5ms) → RSHL (lattice intent + memory, <15ms) → Conscious (BitNet b1.58, <200ms) → Deep (smart tier / Ollama, <500ms)`, with resonance-based tier escalation and a reflex layer that answers greetings/time/date with zero model calls.

**Benched and real:** v29.1 scored **4.72/5 fusion** on the human integration bench, **8/8** end-to-end agent at ~27ms, full regression green, and **perfect 5.0** on identity continuity, lattice coherence, body regulation, and goal coherence. This was a measured, evaluated system — not a toy.

**RSHL lineage here:** scalar sparse field (KaiV2) → true 10,000-dim HDC **int8 ternary** vectors with bind/superpose/analogy (Jarvis) → v29 ternary field + lattice mesh. Direct ancestor of today's SRHT.

**Note:** `C:\Kai 2.0\src\` is a deliberately-forked, endpoint-stripped Claude Code CLI, customized as the ecosystem's desktop shell — part of KAI's *body*, not stray code.

---

## Generation 2 — KAI-polyglot (Rust + Go + Zig + Nim)  ·  `C:\KAI-polyglot`

The "next evolution" architecture (started June 6, 2026, while production was v7.9.7). Each language does what it's best at:

| Dir | Language | Purpose |
|---|---|---|
| `brain/` | **Rust** | RSHL lattice, 84 cognition modules, STaR reasoning, BoneHeal |
| `router/` | **Go** | Supervisory Relay, parallel task-bodies (goroutines), 4s timeout interceptor, complexity-based spawning |
| `hw-bridge/` | **Zig** | **AVX-512 ternary dot product**, GPU dispatch, memory-mapped I/O (the hot-path accelerator) |
| `tools/` | **Nim** | training pipelines, ingestion, build tooling |

Flow: `Input → Go router (spawns N goroutine task-bodies by complexity) → each calls the Rust brain over Unix socket/gRPC → hot path drops to the Zig AVX-512 ternary kernel`.

**Status:** scaffolded and building (brain compiles to `libkai_brain`; router/relay/supervisor/complexity in Go; Zig hw-bridge builds; Nim `ingest`/`train` compiled). It's a real, ambitious re-platforming — the question is whether to *continue it as the platform* or *harvest its best pieces into current KAI*.

---

## Generation 3 — Current KAI (Rust)  ·  `C:\KAI`  ·  v9.8.x

The running production: SRHT lattice with ternary `SparseVec` cells, ~78 cognition modules, the `Engine::tick` heartbeat, the native BitNet brain + the new word-calculus language module, the Discord fleet, OpenJarvis fusion, and the overnight training pipeline. This is the LLI loop and the v29 "think-in-scalars" philosophy, grown up and shipped.

---

## Concepts worth porting forward (the gold to mine)

**From KAI 2.0 (Python):**
1. **5-layer LLI routing with hard latency budgets** + a reflex layer that answers trivial inputs with zero model calls.
2. **`lli_router` resonance→tier policy** — a clean rule for when to spend an expensive/remote call.
3. **RSHL feedback binding** — `bind(wrong ⊕ why_correct)`: a user correction becomes instant associative memory, no retraining.
4. **`kai_loop_guard.py`** — detects/truncates runaway repetition loops (directly relevant to the voice-loop issues fought in current KAI). **Quickest win.**
5. **`world_control.py`** — real-world actuation (Home Assistant) with every action audited to JSON.
6. **The v29 structured-scalar core** (`phi/precision/contradiction/goal_alignment/verification` + ranked hypotheses) — the non-LLM deliberation that scored 5.0 on body/goal coherence. This is the same direction as the current native-brain + word-calculus work.

**From KAI-polyglot:**
7. **The Zig AVX-512 ternary dot-product kernel** — hardware acceleration for the lattice hot path; potentially a large speed win for the current Rust engine's cosine/dot operations.
8. **The Go supervisory-relay concurrency pattern** — goroutine task-bodies with a hard timeout interceptor; a cleaner model for parallel work than the current Node fleet's ad-hoc concurrency.
9. **STaR reasoning** (Self-Taught Reasoner) in the polyglot `brain/` — a reasoning-bootstrap method worth checking against current KAI.

---

## Folder cleanup verdict (Ryan's "what's useful vs garbage")

- **`C:\KAI-polyglot` — KEEP (valuable).** Your next-gen architecture; mine the Zig AVX-512 kernel + Go router + STaR at minimum.
- **`C:\Kai 2.0` — KEEP the source, archivable.** The cognitive code (LLI, RSHL, v29 core, loop-guard, world-control) is worth keeping as the design record + mining list above. The `dist/`, `dist-portable/`, `.build-venv/`, `node_modules/`, `win-unpacked/` build artifacts inside it are disposable.
- **`C:\KAI_Secure_Backups` — KEEP.** Your real protocol backups (~9.7 GB, 3 snapshots from `backup-kai.ps1`). Prune old snapshots with `backup-kai.ps1 -PruneOnly` if it grows.
- **`C:\KAI_GARBAGE` — the trash destination.** Safe to empty once you've confirmed nothing got dumped there by accident (worth one quick scan before deleting).
