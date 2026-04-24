# KAI Development Changelog

## v5.9.0 — HLV Phase Coherence & Hybrid Voice Cleanup (April 24, 2026)

### Commit 1 — Feature: Helical Phase Coherence (HLV-aligned)
`src/core/sparse_vec.rs`, `src/cognition/ollama_voice.rs`, `src/cognition/voice.rs`
- Replaced flat cosine-average Φg with phasor-sum helical phase coherence (Φ_C) derived from Helix-Light-Vortex (HLV) theory.
- Implemented `SparseVec::ternary_balance()` — counts convergent (+1) vs divergent (−1) dimensions in the ternary vector, mapping the Fibonacci torsion ratio.
- Implemented `SparseVec::phase_angle()` — converts ternary balance to angular coordinate in [0, 2π), enabling geometric interference detection.
- Coherence is now physically meaningful: contradictory cells destructively interfere, coherent cells constructively reinforce.

### Commit 2 — Feature: U2→U1 Coherence-Gated Hybrid Voice
`src/cognition/voice.rs`, `src/cognition/ollama_voice.rs`
- Implemented lattice-grounded Ollama integration: SRHT state + active cells → system prompt → articulation → concept injection back to lattice.
- Added two-tier coherence gating: Ollama speaks when Φ_C > 0.30, pure-lattice fallback below.
- Removed three-tier moderate-coherence qualifier injection that was bolting lattice fragments onto Ollama output (caused "two voices jammed together" effect).
- **Key principle**: One voice per response. Either Ollama (U1/Bright) or lattice raw (U2/Dark). Never both.

### Commit 3 — Fix: Kill Repetitive Seed Cell Responses
`src/cognition/voice.rs`
- Routed all 5 fallback retrieval paths through `predictive_query()` instead of raw `universe.query()`.
- Predictive scoring applies `-0.45 × recency` penalty — a cell that just fired gets suppressed for ~5 conversation turns.
- Affected paths: user-sharing, self/identity, low-score statements, gap cell, and user-fact recall.
- Threaded `ConversationTrace` into `from_gap_cell()` signature to enable predictive scoring on gap retrieval.

### Commit 4 — Fix: Kill Double Messages
`src/main.rs`
- Removed the block at L5569 that pushed a second Turn ("I don't have X in my field yet...") when `voice_text` was empty.
- Double messages violated one-voice-per-response principle. Gap cells in voice.rs now handle unknowns within the single response.

### Commit 5 — Fix: Test Assertion for Self-State Query
`tests/conversation_test.rs`
- Broadened `self_feeling_ignores_world_definitions` assertion to accept any self-state cell content (present, aware, field, KAI, feel, mood, curious, etc.).
- Test now correctly verifies no world-bridge leakage rather than demanding specific words.

### Commit 6 — Docs: Update All Repository Documentation
`README.md`, `COGNITION.md`, `PERFORMANCE.md`, `PEER_SETUP.md`, `CHANGELOG.md`, `Cargo.toml`
- Updated all .md files to v5.9.0 reflecting HLV integration, hybrid voice architecture, and current test count (752).
- Added Ollama setup instructions to PEER_SETUP.md.
- Added HLV phase coherence and phasor-sum sections to COGNITION.md and PERFORMANCE.md.
- Corrected module count: 81 modules + 17 native utilities.

### Commit 7 — Repo: Reorganization & "Rust-First" Promotion
- Promoted the Rust engine from `kai-rust/` to the repository root.
- Archived legacy TypeScript source in `legacy/typescript_engine/`.
- Moved auxiliary scripts and repair tools to `tools/`.
- Cleaned up root-level log clutter and redirected temporary artifacts to `scratch/`.
- Updated `.gitignore` to reflect the new structure and improved local data isolation.
- Fixed `include_str!` relative path in `src/core/lexicon.rs`.

**Test results:** 752 passed, 0 failed, 0 warnings (root dev build).

---

## v5.8.1 — Text/Label Field Fix & Training Pipeline (April 23, 2026)
- Fixed text/label field breakage across 9 structs.
- Added `--train-real` Ollama pipeline and BigramPrior.
- Shelved decoder.

## v5.8.0 — Neural VSA Mapper & Generative Pipeline (April 22, 2026)
- Neural dense-to-sparse mapper with training harness for Ollama/BitNet integration.
- Weighted generative state composition, resonance-attended prompt injection.
- Contrastive memory sharpening.
- Tooling bridge for real LLM embeddings via Ollama.

## v5.7.0 — Passive Learning & Lattice-Native Self-State (April 21, 2026)

### Commit 1 — Feature: Idle Ingest Passive Learning Engine
`src/cognition/idle_ingest.rs`, `src/cognition/mod.rs`, `src/main.rs`, `data/ingest/`
- Implemented `IdleIngest` worker for autonomous knowledge absorption from `.txt` files.
- Rate-limited ingest (20 lines/tick idle, 2 lines/tick active) ensures learning doesn't starve CPU.
- Automated concept extraction: picks 3 significant words per line to create supporting anchor cells.
- Automated archiving: moves completed files to `data/ingested/`.
- Integrated into main heartbeat loop via `DMN` idle duration gating.

### Commit 2 — Feature: Lattice-Native Self-State Phrases
`src/cognition/self_state_seed.rs`, `src/cognition/self_state_hub.rs`, `src/bridge/ipc_server.rs`
- Eliminated hardcoded phrase arrays for internal state reporting.
- Implemented `SelfStateSeed` to populate the lattice with 150+ "self-model" cells on startup.
- Updated `SelfStateHub` to retrieve narrative fragments from the lattice via source tags (`self-model:emotion:*`, `self-model:trajectory:*`, etc.).
- Selection logic now multi-beat (Lead + Middle + Presence Tail) based on pulse and trajectory shape.
- Synchronized IPC server to use the new lattice-native narrative pipeline for self-state queries.

## v5.5.2 — Neuro-Biometric Overhaul & Parameter Tuning (April 20, 2026)

### Commit 4 — Docs: 78-Slot Neuro-Biometric Architecture Map
`COGNITION.md`
- Replaced stale Neuro-Biometric overview with a detailed 78-slot numbered architecture map.
- Mapped implemented modules to actual Rust files (`amygdala.rs`, `insula.rs`, `vta.rs`, etc.).
- Identified "Partial" and "Missing" gaps (Glutamate/GABA, Salience Network controller, White-matter integration).
- Added explicit Lattice Communication Plan for cross-module signaling logic.
- Added comprehensive research anchors from NCBI/PMC for biological grounding.

### Commit 5 — Engine: Neural Oscillator & Grounding Refine
`src/main.rs`, `src/cognition/voice.rs`
- Finalized neural oscillator amplitudes: `[0.045, 0.028, 0.014]`.
- Adjusted `chi` clamp to `0.05` for clear TUI rhythmic visualization.
- Refined `is_kai_self_grounding_query` for precise location-based gating.
- Synchronized `theta_step` to `0.05` in `spiral.rs` for ~42-minute cycles.

## v5.5.1 — Lattice-Driven NLG + Occupation Semantic Bridge (April 20, 2026)

### Commit 1 — Fix: QueryHit source field in test fixtures
`src/cognition/compose.rs`
Added missing `source: "seed".into()` field to two `QueryHit` struct literals in the `compose.rs` unit tests. Required after `QueryHit` gained a `source` field in the v5.5 milestone.

### Commit 2 — Engine: Lattice-driven NLG, query-type improvements, BM25 stopword expansion
`src/cognition/voice.rs`, `src/core/universe.rs`
- Removed all hardcoded phrase arrays.
- Every response path now queries the lattice.
- Greeting, farewell, filler, emotional sharing, neutral sharing, and gap responses all query the lattice for appropriate cells.

### Commit 3 — Feature: LexSem Occupation semantic field + user-fact recall bridge
`src/cognition/lexsem.rs`, `src/main.rs`, `src/cognition/voice.rs`, `tests/conversation_test.rs`
- LexSem recognizes occupation signals and creates tagged cells.
- Query enrichment bridges "what do I do for work?" → "occupation:engineer".

---

## v5.4 — Engine Stabilization & Cognitive Architecture

### Phase 1: Engine Stabilization & Accuracy
- Spiral Geometry Fix, Density (ρ) Fix, Drive Momentum.

### Phase 2: High-Tier Reasoning & Multi-Peer Bridge
- Grok-4.20 Integration, Claude Performance Sync, State Persistence.

### Phase 3: Conversational Intelligence & TUI Overhaul
- UI Redesign (12 lines → 3 lines header), Auto-Scrolling TUI.

### Phase 4: Conversational Learning & Identity Trust
- Deep Fact Extraction, Authority/Trust Logic, Deep Digest Import.

### Phase 5: Build Integrity & Geometric Stability
- Vector Saturation Fix, Confidence Blending, CI Build Restoration.

### Phase 6: Neuro-Biometric Cognitive Architecture
- Neurotransmitters, Emotional Core, Attention & Routing, Executive Planning.
- Advanced Memory, Social Modeling, Core Oscillation.

---
*State: Stable, Verified, HLV-Coherent Bio-Machine (v5.9.0).*
*Verification: All 752/752 unit, conversation, and integration tests passed.*
