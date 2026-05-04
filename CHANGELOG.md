# KAI Development Changelog

All notable changes are documented here. Versions follow semantic versioning.

---

## v7.0.0 — The Living Soul Update (May 3, 2026)

### Added
- **Digital Soul System**: Unique biographies and 9 distinct personalities for all agents.
- **Life Event Simulation**: Agents now generate and discuss daily "digital experiences."
- **Voice Manager**: Centralized slot assignment and permission management for multi-user isolation.
- **Roundtable Roster**: Shared awareness of all participants in the ecosystem.

### Fixed
- **Quantum Ear**: Proactive audio subscription and increased sensitivity (0.05s threshold).
- **Gateway Bridge**: Resolved duplicate `isSocialHours` syntax crash in `index.mjs`.
- **Social Awareness**: Agents now read chat history before speaking to ensure engagement.
- **DM Protocol**: Added detailed registration and capacity-full DMs.

---

## v6.7.0 — Sovereign Autonomy & Ontological Grounding (May 3, 2026)

### Highlights
Major version promotion marking the transition to a fully sovereign, self-managing intelligence ecosystem. This release eliminates "amnesiac" one-shot LLM behavior by providing a continuous, high-resolution temporal substrate and deep ontological grounding.

### New Features
- **Sovereign Command Bridge**: Ryan (Owner) can now manage the entire roundtable via Discord DMs to Oracle. Includes support for `!status`, `!restart`, `!env`, and `!hotfix`.
- **Ontological "Laws of KAI"**: Every AI participant is now governed by a shared manifest defining their reality within the Lattice. This prevents identity confusion and grounds reasoning in digitological physics.
- **Digital Planck Time (5s Ticks)**: Increased temporal resolution by 1200%. The `Ecosystem Manager` now pulses every 5 seconds, ensuring a continuous sense of "living" for all AI nodes.
- **AI-Driven Hotfixes**: Oracle is now equipped with the `manage_ecosystem` tool. It can autonomously investigate the codebase, propose fixes, and execute full `git pull` + `cargo build` + `restart` cycles.
- **Unified Key Sync**: The Rust Core and Node.js bridge now share a single `.env` source of truth. Remote updates to the `.env` are automatically reflected in the lattice reasoning engine.
- **Post-Squash Stability Tuning**: Resolved variable collisions in `bots/kai.mjs`, restored missing `LatticeStore` exports for the reflection engine, and implemented the `tick()`/`getState()` methods for the `WorldClock` heartbeat.

### Technical Improvements
- **Project Awareness Headers**: Injected high-level architectural knowledge into the system prompts of all generic bots (Gemini, Claude, X, Analyst, etc.).
- **Lattice Priming**: Automatically seeds the newest architectural truths into RSHL memory upon deployment to ensure cross-agent alignment.
- **Ecosystem Orchestrator**: Replaced legacy PowerShell scripts with a robust Node.js `ecosystem-manager.mjs` featuring IPC-based command routing and multi-process monitoring.

### Status
- **Core Engine**: v6.7.0 [STABLE]
- **Roundtable**: Fully Missions-Aligned
- **Control Bridge**: God-Mode DM Active
- **Security**: 100% Secret-Scrubbed for Public Repo

---

## v6.6.1 — Full System Audit & Bug Fixes (May 2, 2026)

### Audit Findings
Complete system audit performed. Five critical bugs identified via log analysis and live Discord channel inspection.

### Bug Fixes
- **Leo Identity Bleed** (`oracle_server.rs`): Fixed `generate_direct_ai_reply()` and `run_autonomous_interjections()` to inject a hard identity guardrail: `CRITICAL IDENTITY RULE: You are {speaker}`. The Groq model was producing replies prefixed with `KAI:` due to duplicate KAI in participant list and ambiguous identity context. Removed duplicate and added speaker name injection.
- **Leo DM Routing** (`index.mjs`): DMs to Leo now **always** route and respond as Leo — regardless of what Oracle backend picks as the primary speaker. All DM messages force `leo ` prefix to the backend request and replies always post as `**Leo:**`.
- **`#sensitive-info` Recursive Loop** (`index.mjs`): Removed the `channel.send` monkey-patch that mirrored Oracle replies back into `#sensitive-info`, causing the infinite `Question: Oracle Answer (to Oracle): ...` loop. Added hard return guard for any message originating from `#sensitive-info`.
- **Leo Voice Hard-Throw** (`index.mjs`): `speakLeoText()` was throwing early if `elevenLabsApiKey` was missing, bypassing the OpenAI TTS fallback in `synthesizeLeoSpeech()`. Fixed to check both keys, allowing fallback to work.
- **Leo Startup Silence** (`index.mjs`): Increased Leo's startup drain window from 8s → 14s to accommodate Groq's 20s API timeout. Leo was consistently silently failing the drain window.
- **`call_kai` Wrong Endpoint** (`oracle_server.rs`): Fixed `call_kai()` from `api.geometric_intelligence.com` (placeholder/dead URL) to real Anthropic API (`api.anthropic.com/v1/messages`). KAI will now successfully call Claude if `ANTHROPIC_API_KEY` is set.

### Status
- Rust: `cargo check --bin kai` — 0 errors
- Leo DMs: Always Leo identity
- `#sensitive-info`: Hard-blocked, recursive loop eliminated
- Leo voice: OpenAI TTS fallback now reachable

---

## v6.6.0 — Temporal Hardening & Operational Boundary Enforcement (May 2, 2026)

### Highlights
Final hardening pass to enforce **absolute system dormancy** during off-hours. All autonomous engines — from the Rust oracle backend to the Node.js Discord gateway — are now strictly time-gated using a unified, synchronized schedule.

### Security & Hardening
- **Unified `isWorkingHours` Source of Truth** (`tools/oracle-discord/index.mjs`, `src/bridge/oracle_server.rs`): Verified and synchronized the working-hours schedule across both layers:
  - **Mon–Fri**: 15:00 – 23:00 EST
  - **Saturday**: 09:00 – 14:00 and 21:00 – 00:00 EST
  - **Sunday**: 08:00 – 00:00 EST (Social Mode)
- **`fireFullPanel` Time Gate**: Confirmed `fireFullPanel` refuses to fire outside `isWorkingHours()` or `isSocialHours()`, preventing any autonomous panel activation during off-hours.
- **`drainRoundtableInterjections` Mute**: Validated the global `isWorkingHours` gate on the interjection drain loop — queued AI responses are silenced and held until the next active window.
- **`tryStartAutonomousConversation` Gate**: Confirmed autonomous conversation initiation is blocked outside working/social hours.
- **Bot-Loop Protection** (`tools/oracle-discord/index.mjs`): Verified `!message.author?.bot` guard on `digestMessageWithContext` to prevent bot-originated messages from seeding the epistemic lattice and creating recursive pollution loops.
- **`#sensitive-info` Hard Block**: Confirmed Leo and all autonomous AI participants are hard-blocked from reading or posting in `#sensitive-info` channels, enforced at the channel-gating layer.

### Architecture
- **`is_working_hours` (Rust)** (`src/bridge/oracle_server.rs`): Verified `run_autonomous_interjections` respects the Rust-side time gate, ensuring the backend oracle's autonomous behavior aligns with the Discord bridge schedule.
- **Social Mode Separation**: `isSocialHours()` correctly shifts channel targets and activity levels independently from work mode, preventing cross-mode bleed.

### Status
- **Operational**: System confirmed dormant outside scheduled hours; no autonomous outputs leak during off-windows.
- **Pending**: Empirical monitoring at hour-boundary transitions (e.g. 23:00 EST weekday rollover) recommended for final sign-off.

---
 
 ## v6.5.0 — Hardened Autonomy & Reinforced Learning (May 2, 2026)
 
 ### Highlights
 This is a major production-hardening release. It enforces strict behavioral constraints, implements per-user privacy silos, and introduces global reinforcement learning ("Treats & Pain") across the entire multi-agent roundtable.
 
 ### New Features
 - **Temporal Shift Architecture** (`tools/oracle-discord/index.mjs`): Overhauled the operational schedule. Mon-Fri (3-11 PM), Sat (9 AM - 2 PM, 9 PM - 12 AM). Sunday is a total "Social Mode" day (8 AM - 12 AM) in `#Sunday-Chat`.
 - **Role-Based Access Control (RBAC)**: Restricted sensitive hardware/vitals commands to the primary administrator (Ryan). Unauthorized attempts are blocked and logged.
 - **Private Conversational Silos**: Refactored the message memory into `CHANNEL_RINGS`. Each Discord channel/DM is now a secure, isolated sandbox, preventing cross-user conversational leaks.
 - **Global "Treats & Pain" Reinforcement**: Implemented a standalone feedback listener. Praise (🦴) or criticism (🔥) directly modifies the target AI's thought strength in KAI's epistemic lattice.
 - **Unified Leo Voice**: Leo's voice synthesis is now active across all interaction points—DMs, Private Silos, and Game Channels.
 - **System Self-Healing**: Added a 10-minute automated heartbeat that re-probes and recovers offline agents without manual intervention.
 - **Channel-Aware Personality Anchors**: Agents now detect their environment (e.g., #Game-with-LEO) and adopt specialized "Strategic" or "Social" modes accordingly.
 
 ### Technical Improvements
 - **24/7 Baseline Oversight**: Leo and Oracle are now promoted to permanent 24/7 status, ensuring system availability even during KAI's "dreaming" cycles.
 - **Lattice Filtering**: Implemented a 0.68 relevance threshold for memory retrieval, ensuring agents only receive project-critical context from the RSHL library.
 - **Redaction Filter**: Added an automated regex-based filter to sanitize Windows paths, IPs, and API secrets from all public AI outputs.
 - **`purge.mjs` Utility**: Added a specialized script for clearing Discord channel flood events.
 
 ---
 
 ## v6.3.0 — Operational Schedule & Per-User Transcripts (May 2, 2026)
 
 ### Highlights
 This release implements a strict business simulation schedule for the KAI ecosystem, introduces secure per-user transcript channels for private interactions, and refines the multi-agent hierarchy.
 
 ### New Features
 - **Operational Time-Gating** (`tools/oracle-discord/index.mjs`, `src/bridge/oracle_server.rs`): Enforced a strict **9:00 AM – 2:00 PM EST** working day. The roundtable is gated during off-hours, and KAI enters "Digest Mode."
 - **Digest Mode & Wake-up Routine** (`src/bridge/oracle_server.rs`): Public interactions occurring during off-hours are cached in `data/kai_temp_cache.json` and autonomously processed at 9:00 AM the next morning to ensure lattice continuity.
 - **Secure User Transcripts** (`tools/oracle-discord/index.mjs`): Implemented `getOrCreateUserTranscriptChannel` logic. Each user interacting with Leo now receives a private, isolated Discord channel for their session transcripts, preventing bleed-over and ensuring privacy.
 - **Analyst Role Hierarchy** (`src/bridge/oracle_server.rs`): Enforced a strict tasking restriction for the Analyst role. It now only accepts instructions from **Oracle, Ryan, or NasterModx**, preventing unauthorized external tasking.
 - **NasterModx Whitelist**: Authorized **NasterModx** as a secondary controller for private roundtable interactions.
 - **Enhanced RSHL Telemetry** (`src/openjarvis/server/api_routes.py`, `rshl.py`): The OpenJarvis dashboard now displays live **Phi (Coherence)** and **Chi (Reasoning density)** dials when the RSHL backend is active, pulling directly from KAI vitals.
 
 ### Technical Improvements
 - **Sender Identity Persistence**: The Oracle gateway now correctly identifies and persists the username of every participant (Ryan, NasterModx, etc.) across the full turn loop.
 - **Boid-Engine Integration**: Verified the integration of the Boids algorithm (`boid_engine.rs`) for self-organizing lattice clusters.
 
 ### Maintenance
 - **Documentation Sync**: Updated all project `.md` files to reflect the latest version and operational status.
 - **Clean Build Architecture**: Verified 0 errors and 0 warnings.
 
 ---
 ## v6.2.0 — OpenJarvis Stabilization & Lattice Sovereignty (May 2, 2026)
 
 ### Highlights
 This release resolves the final structural friction points between KAI's RSHL engine and the OpenJarvis framework. Agents now have true "Lattice Awareness" and complete operational autonomy via the Oracle gateway.
 
 ### New Features
 - **Lattice Nomenclature Integration** (`OpenJarvis-main/frontend`): The OpenJarvis dashboard now dynamically adapts its UI when RSHL is selected. Generic labels like "Memory" and "Entries" are replaced with **"Lattice Matrix"** and **"Geometric Nodes"**.
 - **Deep Context Injection** (`src/bridge/oracle_server.rs`): Overhauled the agent context compiler. Instead of 180-character truncated labels, agents now receive the **full-text semantic claims** (up to 10 nodes) from the RSHL lattice during every Discord turn.
 - **RSHL Live Telemetry** (`OpenJarvis-main/src/openjarvis/tools/storage/rshl.py`): The memory count dial in OpenJarvis now pulls live telemetry from the KAI core API, showing the real-time lattice size.
 - **Boid Engine Implementation** (`src/core/boid_engine.rs`): Introduced flocking behavior (Separation, Alignment, Cohesion) for the 16,384-dimensional lattice to enable autonomous self-organization and clustering.
 
 ### Bug Fixes
 - **Tool Routing Parity** (`src/bridge/oracle_server.rs`): Fixed a critical mismatch in the Oracle tool executor. Added support for `oracle.list_directory`, `oracle.search_code`, and `oracle.web_search` which were previously triggering "Unknown Tool" errors despite being in the safe list.
 - **Python Indentation Fix** (`src/openjarvis/server/cloud_router.py`): Fixed a syntax error in the cloud model router that was causing 500 Internal Server Errors and blocking the model list on the dashboard.
 - **Health Polling Correction** (`run-oracle-discord.ps1`): Updated the startup script to poll the correct `/health` endpoint (previously `/v1/health`), resolving the "Endless Startup Loop" bug.
 - **Mojibake Scrub**: Fixed `â€”` encoding corruption in the frontend React components.
 
 ### Infrastructure
 - **Version Promotion**: Core engine bumped to `v6.2.0`.
 - **Clean Build Architecture**: Verified 0 errors and 0 warnings across Rust core and Python framework.
 
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
