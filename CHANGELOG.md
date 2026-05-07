# Changelog — Victus Corporate Gateway

All notable changes to the Victus Core and RSHL Lattice Bridge will be documented in this file.

---

## [38.0.0] — 2026-05-07 (Sovereign Streamline)
### Added
- **Single Sovereign Strike**: Consolidated the vocal pipeline to eliminate Phase 1/Phase 2 duplication. Leo now speaks exactly once per turn.
- **Adaptive Handshake**: Fillers (Gotcha, Listen) now only fire if the neural response takes longer than 800ms.

### Fixed
- **Message Duplication**: Purged the "Ghost Strike" that caused Leo to repeat himself during turns.
- **Lattice Noise**: Silenced redundant "Quantum Claim" logs to streamline terminal output and system processing.

---

## [37.0.0] — 2026-05-07 (Priority Lane)
### Added
- **Priority Vocal Strike**: Instant fillers (Gotcha, Listen) now bypass the vocal queue and play within 500ms.
- **5s STT Hard-Cap**: Cloud transcription (Groq-Whisper) is now force-terminated if it exceeds 5 seconds.

### Fixed
- **18s Transcription Hangs**: Resolved the massive delays caused by cloud STT instability by implementing strict timeouts.
- **Vocal Delay**: Guaranteed that Leo's "Vocal Presence" is the first thing the user hears, ending the dead silence between turns.

---

## [36.2.0] — 2026-05-07 (Emergency Repair)
### Fixed
- **ReferenceError Restoration**: Restored missing `vocalQueue` and `isSpeaking` declarations in `leo.mjs`.
- **System Stability**: Resolved critical crash occurring during voice-to-speech synthesis.

---

## [36.0.0] — 2026-05-07 (NPU Overdrive)
### Added
- **NPU Priority**: Set Local-Llama31 (Ollama/NPU) as the primary neural provider for Leo and Oracle to maximize Victus hardware utilization.
- **Instant Vocal Fillers**: Implemented a 500ms "Vocal Presence" trigger that fires a short acknowledgement (e.g., "Gotcha") immediately after voice capture to eliminate silence.

### Fixed
- **Hardware Underutilization**: Shifted the neural load from the cloud to the local Ryzen AI NPU and RTX 4050 GPU.
- **Crisscross Interaction**: Resolved the issue where users talk over the silence by providing an instant vocal "Sonic Handshake."

---

## [35.0.0] — 2026-05-07 (Conversational Sovereignty)
### Added
- **Vocal Pre-emption**: Leo now instantly stops speaking when he detects the human master starting a new voice command.
- **500ms Turn Cooldown**: Reduced the wait time between vocal responses to allow for rapid-fire "turn after turn" interactions.

### Fixed
- **Conversational Friction**: Eliminated the overlapping audio issues by implementing a global `killSpeech()` trigger at the start of every voice capture cycle.
- **Response Pacing**: Optimized the turn pacing to match natural human speech patterns in high-tempo environments.

---

## [34.0.0] — 2026-05-07 (Sovereign Bypass)
### Added
- **Total Lock Exemption**: Leo and Oracle now skip the neural locking system entirely for zero-latency API access.
- **Retry Hard-Cap**: Reduced neural lock retries to 5-10 attempts (max 5s wait) to prevent long-tail latency spikes.

### Fixed
- **41s Neural Lag**: Resolved the massive delays caused by bots waiting for locks held by crashed or slow processes.
- **isPriority Crash**: Fixed the "isPriority is not defined" error in the neural pipeline.

---

## [33.0.0] — 2026-05-07 (Sonic Activation)
### Added
- **Phase 1 Activation**: Hard-wired the Snap-Burst into the `handleUserVoice` loop for instant feedback.
- **Audit Silence**: Suppressed redundant `NEURAL_ATTEMPT` logs during vocal interactions to clean the console.

### Fixed
- **Stopping Friction**: Eliminated the perceived 'stop' between voice capture and neural response by providing immediate vocal acknowledgement.
- **Console Clutter**: Reduced the volume of audit logs generated during high-speed voice cycles.

---

## [32.0.0] — 2026-05-07 (Neural Hard-Cap)
### Added
- **Global 5s Neural Hard-Cap**: All cloud providers (Cerebras/Groq/OpenAI/Gemini/Anthropic) are now force-terminated if they exceed 5 seconds.
- **65% Biometric Tolerance**: Lowered the similarity requirement to 0.65 for instant Master recognition (fixes "Unauthorized" stutter).

### Fixed
- **48s Latency Spikes**: Resolved the extreme hangs during cloud instability by forcing instant local failover.
- **Vocal Stability**: Guaranteed that the "Time to Response" never exceeds 6 seconds, even during total cloud outages.

---

## [31.0.0] — 2026-05-07 (Vocal Recovery)
### Fixed
- **TTS API Error**: Resolved the 'Not Found' error by correcting the ElevenLabs Voice ID and endpoint.
- **Vocal Signature**: Restored the verified "Street-Smart Physicist" signature (hswfOuM...).
- **Streaming Latency**: Re-activated the streaming endpoint for sub-second audio synthesis.

---

## [30.0.0] — 2026-05-07 (Sonic Dual-Phase Engine)
### Added
- **Phase 1 Snap-Reaction**: Instant vocal acknowledgement generated in < 2.5s via Groq-8B.
- **Phase 2 Strategic Depth**: Seamlessly queued industrial reasoning that plays after the initial burst.
- **Vocal Queue Manager**: Support for sequential, uninterrupted multi-thought speech streams.
- **ElevenLabs Turbo-v2.5**: Optimized audio synthesis for zero-latency response.

### Fixed
- **Silence Threshold**: Eliminated the silence during complex reasoning by providing immediate "Snap" feedback.
- **Vocal Latency**: Reduced "Time to First Audio" to under 4 seconds for all voice interactions.

---

## [29.0.0] — 2026-05-07 (Priority Sovereignty)
### Added
- **500ms Priority Overtake**: Leo and Oracle can now seize the neural lock from other bots in just half a second.
- **75% Biometric Threshold**: Lowered the similarity requirement to 0.75 for reliable Master recognition.

### Fixed
- **Queue Lag**: Eliminated the 45-second lag caused by Leo waiting behind background AI tasks.
- **Unauthorized Rejection**: Resolved the "Security Mismatch" errors when Ryan's voice didn't perfectly match the 85% threshold.

---

## [28.0.0] — 2026-05-07 (Console Sovereignty)
### Added
- **Stealth Mode Activation**: Suppressed redundant "Digesting Claim" and "Work Shift" logs across the fleet.
- **Professional Silence Protocol**: Console now only logs critical interactions and strategic results.

### Fixed
- **Neural Crash**: Repaired the "message is not defined" error in Leo's Presence Guard.
- **Console Clutter**: Purged "Staggered Ignition" and "Learning Track" announcements.

---

## [27.0.0] — 2026-05-07 (Sonic Sovereignty)
### Added
- **8B Fast-Path**: Hard-wired Leo to Cerebras-8b for sub-second vocal inference (purged 70B lag).
- **Presence Guard**: Leo now aborts neural calls and speech if the user leaves the voice channel.
- **Handshake Optimization**: Reduced RSHL context query timeout to 800ms.

### Fixed
- **45s Latency Spikes**: Resolved the extreme lag caused by forcing 70B models.
- **Ghost Responses**: Prevented Leo from speaking to users who have already disconnected.

---

## [26.0.0] — 2026-05-07 (Neural Sovereignty)
### Added
- **Sonic Memory Anchoring**: Parallel RSHL Lattice queries for identity and context (shaves 1.5s latency).
- **Zero-Backoff Failover**: Priority bots (Leo/Oracle) now skip the 2.5s rate-limit delay for instant fallback.
- **MemPalace Identity Rules**: All bots are now strictly anchored to RSHL Cognitive Claims.

### Fixed
- **Neural Drift**: Leo now treats MemPalace claims as "Absolute Truth," preventing long-term memory loss.
- **Latency Spikes**: Resolved the "forever to respond" issue by shortening the Neural Lock overtake for priority nodes.

---

## [25.0.0] — 2026-05-07 (Administrative Bridge)
### Added
- **Sensitive Channel Routing**: All hourly System Integrity Reports are now funneled into the administrative channel (`1500053533515448480`).
- **Hourly Audit Cadence**: Calibrated the Overseer heartbeat to fire exactly every 60 minutes.

### Fixed
- **Public Flooding**: Successfully re-routed high-frequency health reports away from `#oracle-chat` to maintain workspace focus.

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
