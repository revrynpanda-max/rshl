# KAI Development Changelog

## v6.0.0 — Epistemic Architecture & Oracle Diagnostic Suite (April 28, 2026)

### Major Architectural Shift: The Epistemic Machine
KAI v6.0.0 marks the transition from a text-resonance engine to a structured epistemic system. Memories are now handled as **Claims** with evidence-based validation.

### Commit 1 — Feature: Epistemic Claim Substrate
`src/core/claim.rs`, `src/core/claimstore.rs`, `src/core/evidence.rs`, `src/core/contradiction.rs`, `src/core/calibration.rs`
- Implemented **Claim**-based memory storage replacing raw text cells.
- Claims carry semantic vectors, confidence scores (0.0-1.0), evidence links, and source attribution.
- **Contradiction Detection**: Real-time χ (chi) monitor that identifies and prevents conflicting knowledge ingestion.
- **Calibration**: Dedicated module for seeding truth-anchors for physical constants.

### Commit 2 — Feature: Oracle Diagnostic Server & council
`src/bridge/oracle_server.rs`, `oracle.html`, `launch_oracle.ps1`
- New WebSocket-based diagnostic server running on **Port 3333**.
- **AI Council**: Multi-AI interface where external models (Ollama/LLMs) can observe KAI's vitals and discuss system state in "Free Speech" mode.
- **Test Harness**: Oracle can request system tests (cargo check/test) which the user approves/denies via the UI.
- **Source Browser**: Real-time source file inspection integrated into the diagnostic transcript.

### Commit 3 — Perf: 5,750x Faster Ingestion (O(N²) → Incremental)
`src/core/universe.rs`
- Replaced the global O(N²) contradiction scan with an **incremental verification** pipeline.
- Added **Anti-Bleed Resonance Floor** (0.15 threshold) to prevent truth-anchor strength inflation.
- Parallelized duplicate consolidation using **Rayon**.
- Store latency dropped from 11.65s to **2.02ms**.

### Commit 4 — Perf: Cached SparseVec Norms & AVX2 SIMD (4.5x Engine Speedup)
`src/core/sparse_vec.rs`, `src/cognition/generative.rs`, `src/cognition/neural_mapper.rs`
- Added `cached_norm` to `SparseVec`, eliminating 32KB of redundant memory traffic per comparison.
- Widened inner dot product loop from 16 to **64 elements** for AVX2 optimization.
- Resulted in **4.5x faster** FieldState computation (7.0ms → 1.57ms).

### Commit 5 — Feature: MindFrame Semantic Routing
`src/core/mind_frame.rs`, `src/core/memory.rs`
- Advanced query routing into specialized memory regions: **Self-State**, **Personal**, **World**, and **Narrative**.
- Ensures that identity queries don't leak into world-knowledge definitions and vice-versa.

### Commit 6 — Feature: Engine Core & TUI Decoupling
`src/core/engine.rs`, `src/main.rs`
- New **Engine** struct orchestrates all cognitive modules, fully decoupling the brain from the Ratatui TUI.
- Heartbeat tick logic optimized for non-blocking background ingestion.

### Commit 7 — Fix: Clean Mojibake & Repo Reorganization
- Swept ~85 cognition files for UTF-8 encoding corruption (smart-quote fixes).
- Moved development utility scripts and backups from repo root to `dev/`.
- Repository now strictly reflects the production-ready Rust codebase.

**Test Results:** 634 passed, 0 failed, 0 warnings.
**Performance:** ~0.66 Mdots pure engine throughput.
**Integrity:** 100% Top-1 Recall Accuracy.

---

## v5.9.5 — Truth Alignment & State Recovery (April 27, 2026)
- Fixed main.rs truncation and source-aware FID gate.
- Recovered corrupted state file and pruned 247 duplicate identity cells.
- Applied `truth_align.py` to balance phasor noise between physics-core and discovery cells.

---

## v5.9.4 — Restoration Sync & Knowledge Recovery (April 26, 2026)
- Restored "Adult" lattice base (1,251 cells) and re-synced Phase 4 Physics Ground Truth.
- Fixed race conditions in training scripts.

... [Full history available in repository]
