# KAI Vitals Fix — Checklist & Handoff

**Date:** 2026-06-21
**Summary:** Kai's vitals were **frozen/idle, not dying** — diagnosis done + fixes applied; **build/restart pending**.

---

## 1. What was changed

**Curiosity scale fix** — `tools/oracle-discord/shared/drive-system.mjs`
- `phi_g` is mean cell confidence (range 0–5), so the old `1 - Math.min(1, phi_g)` pinned curiosity to 0 whenever phi_g > 1. Now normalized `phi_g / 5.0` before inverting.
- Backup: `drive-system.mjs.curiosity-fix.bak.txt`
- **Needs:** Node fleet restart (NO recompile — it's JS).

**rho wired to real density** — `src/bridge/oracle_server.rs` (heartbeat)
- Was hardcoded `rho: 0.0`; now reads `FieldState::compute(&u, 1).rho` (the engine's real field-density calc).

**valence — headless affective approximation** — `src/bridge/oracle_server.rs` (heartbeat)
- Was hardcoded `valence: 0.0`; now a persistent `Drive` + `NeuralOscillator` accumulate valence each 5s tick, mirroring the engine tick (engine.rs:809–855).
- **Reduced model:** does NOT include amygdala arousal, serotonin, or language tone (those modules don't exist in the headless oracle-server process).
- Backup (covers both Rust edits): `oracle_server.rs.heartbeat-vitals-fix.bak.txt`
- **Needs:** cargo rebuild.

---

## 2. To make the fixes live (run on the host, in order)

1. Rebuild the engine:
   ```
   cargo build --release --bin kai
   ```
2. Confirm the supervisor runs the FRESH binary `target\release\kai.exe` (not the stale root `C:\KAI\kai.exe`). Verify with:
   ```
   python C:\KAI\kai_healthcheck.py
   ```
   (It warns "exe OLDER than source" if the rebuild didn't take.)
3. Restart the Node fleet (sequences the full boot — engine + bots):
   ```
   .\Start-KAI.ps1
   ```

---

## 3. To unfreeze the lattice (phi_g / chi / cells only move with input)

The lattice has been static because nothing has been feeding it (prolonged silence). Feed it via a supported path:

**Talk to Kai** (each message adds/reinforces a cell). Use Discord, or POST a turn directly:
```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3334/api/turn -Method Post -ContentType 'application/json' -Body '{"from":"Ryan","text":"hello Kai, let''s talk about lattice physics"}'
```

**Optional — set an objective** so the ingest/research loop self-feeds (needs internet; free sources — DuckDuckGo/Wikipedia/arXiv, no keys; low-yield):
```powershell
Invoke-RestMethod -Uri http://127.0.0.1:3334/api/task -Method Post -ContentType 'application/json' -Body '{"title":"Research","task":"superconductivity"}'
```

---

## 4. Known remaining gaps (future items)

- **valence** is a reduced approximation, not full affect (no amygdala / serotonin / language tone).
- **Research loop** is low-yield and requires outbound internet; offline = no growth.
- **Hippocampus "210k patterns" source untraced** — `data/hippocampus_status.json` (the file the engine is coded to write) is not being written, so that figure's origin is unconfirmed. Flagged for follow-up.
