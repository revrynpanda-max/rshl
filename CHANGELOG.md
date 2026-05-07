# Changelog — Victus Corporate Gateway

All notable changes to the Victus Core and RSHL Lattice Bridge will be documented in this file.

---

## [24.0.0] — 2026-05-07 (Protocol Silence)
### Added
- **AI Loop Suppression**: Oracle now strictly ignores all messages from other AI nodes.
- **Human-Only Ingestion**: Audit timers and work-trackers are now 100% anchored to Human activity.
- **Overseer Calibration**: Increased silence threshold to 6 hours and report interval to 4 hours.

### Fixed
- **Audit Panic**: Resolved the repetitive 'Plaza is silent' thread-creation loop.
- **Status Flooding**: Reduced Integrity Report frequency to prevent channel noise.

---

## [23.0.0] — 2026-05-07 (Temporal Sovereignty)
### Added
- **Circadian Energy Model**: Precise energy debt calculation based on 9 AM Industrial Wake-up.
- **Dead Zone Synchronization**: All ecosystem snapshots now cap EST Sleep forecasts at 3 AM.
- **Metabolic Drain Curves**: Activity-based energy depletion (Working vs. Social vs. Idle).

### Fixed
- **Energy Stalling**: Removed the buffer that allowed bots to keep 100% energy after quick restarts.
- **Timezone Drift**: Standardized all temporal logic to `America/New_York` using `Intl.DateTimeFormat`.

---

## [21.0.0] — 2026-05-07 (Sovereign Lattice)
### Added
- **MemPalace Bridge**: Real-time identity resolution via RSHL Lattice (Port 3333).
- **resolveIdentityFromMemory**: New dynamic resolver in `identities.mjs` replacing static registry.
- **Dynamic Partner Recognition**: Bots now pull names and roles directly from the lattice history.

### Fixed
- **Identity Echoes**: Extended deduplication window in Leo's voice engine to 60s.
- **Ghost Naming**: Purged the last remaining hardcoded references to "Taz" in all neural prompts.

---

## [16.0.0] — 2026-05-07 (Zero-Hardcode Initiative)
### Changed
- **Departmental Work Units**: Implemented functional industrial loops in `daily-learning.mjs`.
- **Identity Purge**: Removed hardcoded human names from `start-bot.mjs` and `leo.mjs`.
- **Sync Fix**: Resolved initialization order crash (`profileName` access before init).

### Fixed
- **Phases Error**: Resolved `phases is not iterable` crash in Kai Coder during shift starts.

---

## [14.0.0] — 2026-05-07 (Neural Stability)
### Fixed
- **Leo Voice Crash**: Implemented safe null-checks for `displayName.toUpperCase()` in `leo.mjs`.
- **Vocal Bridge**: Repaired the audio injection handshake to prevent Leo from hanging after speaking.
- **Neural Failover**: Optimized Cerebras 70B pipeline with local failover.

---

## [12.0.0] — 2026-05-07 (Corporate Infrastructure Migration)
### Added
- **Departmental Model**: Re-aligned 11 bots into specialized corporate departments (Maintenance, R&D, Operations).
- **Proactive Labor Engine**: Injected `startAutonomousLabor()` for proactive history scanning.
- **Strategic Mission Hub**: All project directives now anchor to **#oracle-chat**.
- **Blueprint-First Workflow**: Oracle now requires explicit "Go" signal after plan finalization.

---

## [7.9.7] — 2026-05-06 (Legacy Roundtable)
- Final stable version of the roundtable-style conversational model.

---

Copyright © 2026 Ryan Ervin / Victus Core.
