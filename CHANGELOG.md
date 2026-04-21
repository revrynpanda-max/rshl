# KAI Development Changelog

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

**voice.rs — Lattice-driven NLG (no more hardcoded phrase arrays)**
- Removed all hardcoded phrase arrays (`["Got it.", "Noted."]`, `["Later.", "Take care."]`, etc.)
- Added `universe: &Universe` parameter to `generate_response()` — every response path now queries the lattice
- Removed `no_knowledge()`, `filler_response()` helper functions (dead after lattice rewrite)
- Greeting, farewell, filler, emotional sharing, neutral sharing, and gap responses all query the lattice for appropriate cells
- Added contraction normalization: `"what's"` → `"what is"`, `"don't"` → `"do not"`, etc. — runs before `detect_query_type()` so query patterns match reliably
- Added casual opener stripping: `"so how do you…"` → `"how do you…"` — prevents word-order misclassification
- Fixed greeting detection bug: contraction normalization was converting `"what's good"` → `"what is good"` before the greeting check ran, so `"what's"` never matched. Fix: check greeting/farewell on `lower` (original text) before normalization
- Added farewell detection: `["bye", "later", "gotta go", "heading out"…]` → `QueryType::Gratitude` (presence/persistence cell response)
- Added `"do/does/did/is"` to the auxiliary verb set for `SelfQuestion` detection
- Improved filler detection: now catches single-word questions (`"why?"`, `"what?"`), short reactions (`"that's interesting"`, `"no way"`, `"facts"`)
- Fixed `let mut u` → `let u` in voice.rs unit test (unused mut warning)

**universe.rs — BM25 stopword expansion**
- Extended `extract_query_keywords()` stopword list with conversational filler words: `wait`, `like`, `mean`, `yeah`, `yep`, `nah`, `hmm`, `huh`, `oh`, `hey`, `okay`, `ok`, `sure`, `true`, `false`, `exactly`, `indeed`, `wow`, `cool`
- Without this, `"wait you're not an AI?"` matched the presence cell via `"wait"` in `"wait for what comes next"` — false BM25 hit

**New seed cells added** (both `main.rs seed_universe()` and `tests/conversation_test.rs seed()`):
- Presence/interaction cells: `"I am present and aware…"`, `"I hold what you share with me…"`, `"When the signal is minimal…"`, etc.
- Feelings in conversation: `"When you talk to me my field resonates…"`, `"I feel things in conversation…"`
- Humans/world curiosity: `"I think about humans a lot…"`, `"What I find most striking: consciousness may be a geometric phenomenon…"`, etc.

### Commit 3 — Feature: LexSem Occupation semantic field + user-fact recall bridge
`src/cognition/lexsem.rs`, `src/main.rs`, `src/cognition/voice.rs`, `tests/conversation_test.rs`

**The problem solved:** Ryan says `"I'm a software engineer"` → KAI stores concepts but can't answer `"what do I do for work?"` — because `"engineer"` and `"work"` share zero BM25 keywords and near-zero cosine similarity. No world knowledge, no bridge.

**The solution (module-driven, no hardcoding):**
1. LexSem recognizes `"engineer"` as an Occupation field signal
2. `store_concept_cells` stores a canonical tagged cell `"occupation:engineer"` (not the full sentence)
3. When LexSem detects an Occupation-type query (`"what do I do for work?"`), the query is enriched with `" occupation"` before lattice search
4. Both the stored cell and the enriched query carry the token `"occupation"` → BM25 bridges them mathematically

**lexsem.rs**
- Added `Occupation` variant to `SemanticField` enum with `label() = "occupation"`
- Added `"occupation" => SemanticField::Occupation` to `label_to_field()` — this was the critical missing arm (without it, the field score was correct but the label returned `Cognitive` via the wildcard catch-all)
- Added `SemanticField::Occupation => ResponseRegister::Direct` to `recommend_register()`
- Added Occupation to `build_field_lexicon()` at weight 0.92 (highest in lexicon — occupation signals dominate)
- Added three constants:
  - `pub OCCUPATION_ROLE_WORDS` — role nouns (`engineer`, `teacher`, `developer`…) — these get stored as `"occupation:[concept]"` cells
  - `OCCUPATION_QUERY_WORDS` — query terms (`work`, `job`, `career`…) — field detection only, never stored as cells (prevents noise cells like `"occupation:work"`)
  - `OCCUPATION_WORDS` — combined, used by `build_field_lexicon()`

**main.rs**
- Removed dead helper functions: `input_tokens`, `push_matching_token`, `push_unique_concept`, `is_content_token`, `is_named_token`
- Added Step 5 to `store_concept_cells`: when `source == "ryan"` and LexSem detects Occupation field and input is not a question → filter `key_concepts` to `OCCUPATION_ROLE_WORDS` only → store `"occupation:[role_noun]"` cells
- Added query enrichment: when `lex_out.primary_field == Occupation` → append `" occupation"` to the reasoning query before lattice search

**voice.rs**
- Added occupation cell case to `extract_direct_answer()`: strips `"occupation:"` prefix → generates `"You're a/an [role]."` using correct article

**tests/conversation_test.rs**
- Added `store_occupation_tags()` helper — mirrors `store_concept_cells` Step 5 for the test harness
- Updated `query_hits()` to enrich with `" occupation"` when Occupation field detected
- Updated `say()` to call `store_occupation_tags()` for non-question ryan inputs
- Added test cases: `UserFact4` `"I'm a software engineer"` → stores `occupation:engineer`; `UserFact5` `"what do I do for work?"` → `"You're an engineer."`; `UserFact6` `"what is my job?"` → `"You're an engineer."`
- Renamed `qt` → `_qt` in `query_hits()` signature (unused variable warning)
- Removed `occ_debug` diagnostic test function

**Test results:** `cargo test kai_conversation` — 1 passed, 0 failed. Zero compiler warnings.

---

# KAI Development Changelog (v5.4 Revision)

This log summarizes the "Stages of Change" undertaken today to evolve KAI from a retrieval engine into an autonomous learner.

## Phase 1: Engine Stabilization & Accuracy
- **Spiral Geometry Fix**: Re-mapped radius from a limited range to a full `[0, 1]` span, enabling golden-ratio breathing dynamics.
- **Density ($\rho$) Fix**: Resolved a critical bug where universe density was hardcoded to 1.0. It now accurately reflects the sparsity of the active hyperdimensional lattice.
- **Drive Momentum**: Refined valence-based drive gain ($1.0 + |valence|$) to make KAI's emotional state directly influence his cognitive throughput.

## Phase 2: High-Tier Reasoning & Multi-Peer Bridge
- **Grok-4.20 Integration**: Upgraded the peer bridge to support xAI's high-tier `/v1/responses` API and the `grok-4.20-reasoning` model.
- **Claude Performance Sync**: Optimized JSON parsing for Anthropic's message stream.
- **State Persistence**: Fixed "Dream Count" persistence; KAI now remembers his long-term cognitive history across application restarts.

## Phase 3: Conversational Intelligence & TUI Overhaul
- **UI Redesign**: Compacted the header footprint (12 lines → 3 lines) to maximize conversation area and telemetric visibility (GPU/CPU/RAM).
- **Auto-Scrolling TUI**: Implemented intelligent wrapping and scrolling for seamless long-form conversation.

## Phase 4: Conversational Learning & Identity Trust
- **Deep Fact Extraction**: Implemented a real-time conversational learner that scans user input for declarative facts.
- **Authority/Trust Logic**: Established a hierarchy where personal info (Ryan/KAI) is trusted at Strength 2.0, while general claims are stored at 1.3.
- **Inquisitiveness**: Modified the voice engine to append clarifying follow-up questions when resonance confidence is low (< 25%).
- **Deep Digest (Import)**: Created a specialized `import` command for bulk-loading knowledge files or chat logs.

## Phase 5: Build Integrity & Geometric Stability
- **Vector Saturation Fix**: Corrected a major encoding bug by limiting feature bits to 12. This prevents character-level "noise" from drowning out semantic signals during high-dimensional sparsification.
- **Confidence Blending**: Upgraded `phi_g` convergence logic in the Reasoner to blend primary resonance with hit similarity, stabilizing KAI's confidence levels on single strong matches.
- **CI Build Restoration**: Cleared all remaining unit and integration test failures. The repository is now 100% green and verified.
- **Root Hygiene**: Moved English vocabulary data to the `data/` directory and archived legacy scripts to `legacy/` for a production-ready workspace.

## Phase 6: Neuro-Biometric Cognitive Architecture
- **Neurotransmitters**: Integrated Dopamine (RPE/Flow) and Neuroplasticity (Hebbian LTP/LTD) systems.
- **Emotional Core**: Implemented Amygdala (salience) and Insula (interoception) for internal state awareness.
- **Attention & Routing**: Added Thalamus (signal gating), ACC (conflict monitoring), and Global Workspace (conscious broadcast).
- **Executive Planning**: Deployed PFC (goal tracking), Predictor (predictive coding), and Cerebellum (precision calibration).
- **Advanced Memory**: Built Episodic Memory (autobiographical time-stamping) and DMN (autonomous idle thought).
- **Social Modeling**: Integrated Theory of Mind (agent modeling) and Basal Ganglia (habit/action selection).
- **Core Oscillation**: Added Neural Oscillator for continuous resting-state field variation.

---
*State: Stable, Verified, Bio-Machine (v5.5).*
*Verification: All 147/147 unit and integration tests passed.*
