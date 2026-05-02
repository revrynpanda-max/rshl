# KAI Development Changelog

All notable changes are documented here. Versions follow semantic versioning.

---

## v6.1.1 — Oracle-KAI Fusion & Stability (May 1, 2026)

### Highlights
This release completes the deep integration of the **OpenJarvis agentic framework** into Oracle and resolves a series of Windows-environment stability issues. The system is now production-ready for autonomous Discord operation.

### New Features
- **Voice Council** (`tools/oracle-discord/index.mjs`): Leo can join Discord voice channels and participate in live discussions. Dual-engine pipeline: ElevenLabs Scribe (STT) → ElevenLabs Leo Voice or OpenAI `onyx` (TTS fallback).
- **KAI Blueprint Integration** (`OpenJarvis-main/`, `src/bridge/oracle_server.rs`): Oracle now uses OpenJarvis as its Task Master for multi-step coding, file operations, and system diagnostics.
- **Approval-Gated Tooling**: All agentic tool calls are surfaced and approval-gated via the Oracle Diagnostic UI at `oracle.html`.
- **Autonomous Interjections**: Agents (Leo, Analyst, Researcher, Groq, etc.) now interject unprompted when they have relevant context, creating a living roundtable.
- **Self-State Hub** (`src/cognition/self_state_hub.rs`): Integrated emotional/executive/social field with trajectory analysis (`Warming`, `Cooling`, `Sharpening`, `Fraying`, `Holding`). Narrative emerges from the lattice, not hardcoded phrases.

### Bug Fixes
- **Unicode Corruption** (`src/core/universe.rs`): Resolved critical `Â²` → `²` mojibake in the RSHL engine causing Rust build failures.
- **Windows Encoding** (`run-oracle-discord.ps1`): Enforced `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` in startup script, resolving `rich` library `ValueError` crashes on Windows.
- **OpenJarvis Syntax Errors**: Restored truncated `__all__` lists in `cloud.py`, `litellm.py`, and `serve.py` that were causing `SyntaxError` on startup.
- **RSHL UI Integration**: Fixed the React frontend so `rshl` is correctly exposed and selectable as a native memory backend in the OpenJarvis dashboard UI.
- **Discord WASM Corruption**: Fixed corrupted Node.js WASM compilation for `@discordjs/opus` and `zlib-sync` by forcing an NPM cache clean.
- **Missing `traces` Module**: Restored the `openjarvis.traces` package from backup, resolving `ModuleNotFoundError` on startup.
- **TOML Encoding Corruption** (`configs/openjarvis/config.toml`): Removed stray `Â` characters from divider lines causing `TOMLDecodeError` on load.
- **Missing Server Dependencies**: Added `uv sync --extra server` to startup to ensure `fastapi`, `uvicorn`, and `starlette` are installed.
- **Rust CI Errors** (`src/cognition/self_state_hub.rs`, `src/core/normalize.rs`, `src/core/seed.rs`): Fixed 3 compile errors in test assertion macros — truncated macro invocation, missing format argument, and unused `assert!` argument.

### Security
- **History Scrub**: Used `git-filter-repo` to rewrite 170 commits, replacing all full-length mock API key patterns (e.g. `sk-abc...`) with safe truncated examples (e.g. `sk-EXAMPLE`). Repository now passes GitHub Push Protection without disabling the feature.
- **Credential Sanitization**: All test files now use clearly fake key prefixes. The key *format* is preserved for documentation purposes; the full value is never stored.

### Infrastructure
- **All-in-one Launcher** (`run-oracle-discord.ps1`): Single command launches Rust Oracle, Python OpenJarvis, and Node.js Discord gateway in correct order.
- **Server Dependency Auto-install**: Startup script detects missing Python extras and installs them automatically.

---

## v6.1.1 — Epistemic Machine (April 28–30, 2026)

### Highlights
The transition from a text-resonance engine to a structured epistemic system. KAI's memories are now formal **Claims** with evidence, confidence, and contradiction detection.

### New Features
- **Epistemic Claim Substrate** (`src/core/claim.rs`, `claimstore.rs`, `evidence.rs`, `contradiction.rs`): Every memory is now a `Claim` carrying a semantic vector, confidence score (0.0–1.0), source attribution, and evidence links. Raw text cells are gone.
- **Contradiction Detection (χ)** (`src/core/contradiction.rs`): Real-time conflict detection. Contradictory ingests are rejected, corrected, or hedged based on confidence levels.
- **Oracle Diagnostic Server** (`src/bridge/oracle_server.rs`, `oracle.html`): WebSocket server on port `:3333` with live AI council, source file browser, and system vitals dashboard.
- **MindFrame Semantic Routing** (`src/core/mind_frame.rs`): Advanced query routing to specialized memory regions — Self-State, Personal, World, Narrative. Prevents identity leaking into world knowledge.
- **Engine Core Decoupling** (`src/core/engine.rs`): New `Engine` struct separates the cognitive brain from the Ratatui TUI for clean async architecture.
- **Kaleidoscope Memory Regions**: Partitioned lattice into `memory`, `identity`, `reasoning`, `established-physics`, `contested` regions with independent pruning policies.

### Performance
- **5,750× Faster Ingestion**: Replaced O(N²) global contradiction scan with incremental verification pipeline. Store latency: 11.65s → **2.02ms**.
- **4.5× Faster Engine**: Cached `SparseVec` norms + AVX2 64-wide SIMD dot products. FieldState: 7.0ms → **1.57ms**.
- **Anti-Bleed Floor**: Resonance floor of 0.15 prevents truth-anchor strength inflation.

### Test Results
- **634 passed, 0 failed, 0 warnings**
- **~0.66 Mdots** pure engine throughput
- **100%** Top-1 Recall Accuracy on identity + physics anchors

---

## v5.9.5 — Truth Alignment & State Recovery (April 27, 2026)
- Fixed `main.rs` truncation and source-aware FID gate.
- Recovered corrupted state file and pruned 247 duplicate identity cells.
- Applied `truth_align.py` to balance phasor noise between physics-core and discovery cells.

---

## v5.9.4 — Restoration Sync & Knowledge Recovery (April 26, 2026)
- Restored "Adult" lattice base (1,251 cells) and re-synced Phase 4 Physics Ground Truth.
- Fixed race conditions in training scripts.

---

## v5.9.3 — Repo Cleanup & Rust Promotion (April 27, 2026)
- Promoted Rust core to primary source of truth.
- Purged 15+ legacy JS/backup files from repo root.
- Resolved all compiler warnings.
- Added Phase 4 TUI monitor scripts.

---

## v5.x — Foundation Builds (April 2026)

The v5.x series established the RSHL lattice, the sparse ternary vector engine, the Ratatui TUI monitor, the initial Oracle WebSocket bridge, the world-knowledge ingestion pipeline, and the multi-model peer connection system.

Full commit history is available via `git log`.
