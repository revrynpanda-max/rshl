# Git History (June 13-19, 2026)

## Summary
- **June 13, 2026**: No commits.
- **June 14, 2026**: No commits.
- **June 15, 2026**: 5 commits found.
- **June 16, 2026**: No commits.
- **June 17, 2026**: No commits.
- **June 18, 2026**: No commits.
- **June 19, 2026**: No commits.

**Gist of June 15**:
Pre-v9.2.0 checkpoints, connectome storage fixes, backup scan exclusions, and native generation routing with Discord fleet fixes.

## Commit Details (June 15)

`add78530 2026-06-15 Native generation routing, entropy gauge, LLM device selection, Discord fleet fixes`
- M	src/bridge/oracle_server.rs
- M	src/cognition/language_warehouse.rs
- M	src/cognition/voice.rs
- M	src/main.rs
- M	tools/oracle-discord/bots/leo.mjs
- M	tools/oracle-discord/bots/native-bot.mjs
- M	tools/oracle-discord/run-oracle-discord.ps1
- M	tools/oracle-discord/scripts/kai-scanner.mjs
- M	tools/oracle-discord/shared/biographies.mjs
- M	tools/oracle-discord/shared/codex.mjs
- M	tools/oracle-discord/shared/gemini-live-bridge.mjs
- M	tools/oracle-discord/shared/voice-gate.mjs

`ca9a1f9f 2026-06-15 pre-upgrade: commit current codex.mjs helper upgrades`
- M	tools/oracle-discord/shared/codex.mjs

`15bcbd5f 2026-06-15 fix: exclude backup directories from pre-boot scan`
- M	tools/oracle-discord/scripts/kai-scanner.mjs

`b9604f5b 2026-06-15 v9.2.0: connectome storage fix and Last Judgment snapshot scoring`
- M	The KAI Codex.md
- A	data/kai-meta.json.v3.archive
- M	src/bridge/oracle_server.rs
- M	src/core/synapse.rs
- M	src/main.rs
- M	src/persistence.rs
- M	tools/backup-kai.ps1

`47615313 2026-06-15 pre-v9.2.0 checkpoint`
- A	ALGORITHM-INVENTORY.md
- M	Cargo.lock
- M	Cargo.toml
- A	KaiCoderModelfile
- M	OpenJarvis-main/configs/openjarvis/config.toml
- M	OpenJarvis-main/src/openjarvis/engine/kai.py
- A	Restore-Codex-Baseline.ps1
- A	Restore-Working-Fleet.bat
- A	SRHT_CRITIQUE_AND_PROOF.md
- A	SRHT_UNIVERSAL_SOLVER_PAPER.md
- A	The KAI Codex.BACKUP-precleanup.md
- M	The KAI Codex.md
- A	V9.2.0-IMPLEMENTATION-PLAN.md
- (And many more _ai_damage_backup and tools additions...)
