# HOTFIX NOTES — for the dispatch (Antigravity)

Ryan is away. Code edits were made to the KAI ecosystem and need to be **applied to the running server**. This note tells you exactly what changed, how to apply it, and how to handle failures. **Expect the apply to take a few minutes (engine rebuild + boot).**

---

## 1. ONE COMMAND APPLIES EVERYTHING

```powershell
powershell -ExecutionPolicy Bypass -File C:\KAI\apply-hotfix.ps1
```

`apply-hotfix.ps1` auto-detects whether the Rust engine needs a rebuild (only if `src\*.rs` / `Cargo.toml` is newer than `target\release\kai.exe`), **kills `kai.exe` first** so the binary can't be access-denied, rebuilds, then restarts the fleet via `Start-KAI.ps1`. If a build **fails**, it restarts on the **old binary** so the server stays up and logs the error to `C:\KAI\scratch\apply-hotfix.log`.

- Node/Python-only changes (faster, no compile): add `-NoRebuild`.
- Force a rebuild: add `-Force`.

After it runs: **hard-refresh the dashboard (Ctrl+Shift+R)** for `oracle.html` changes.

---

## 2. WHAT CHANGED (so you can verify)

| File | Change | Needs |
|------|--------|-------|
| `src\main.rs` | sleep→world-model learning import fix (`crate::` → `kai::`) | **cargo rebuild** + engine restart |
| `overnight_pipeline.py` | training **window gate fix** — all 5 gate sites now use bounded `overnight_window_open()` so training only runs 03:00–08:30, **never on a daytime boot** | restart (Python; the keeper relaunches it) |
| `tools\oracle-discord\command-center-server.mjs` | `/api/vitals` now also reads `/api/session` (so KAI Vitals show data instead of "engine down"); per-user passwords; dotenv path fix | restart Command Center |
| `oracle.html` | Phoenix-healed KAIVERSE functions (`nsPaintHUD`, `nsOpenNodePanel`, `nsAdvanceGrowth`, `nsGrowVal`, `closeNsEdgePanel`); map moved up; live clock; touchpad controls; dashboard metrics (10/9 count, radar, leaderboard) | **hard refresh only** (served statically) |
| `oracle.html` (v9.10.1, Jun 23) | **Mobile drawer fix** — on phones the opened nav/channels drawer was dimmed & dead to touch (every tap hit the scrim and closed it). Stacking-context trap: `.shell{position:relative;z-index:1}` confined the fixed drawers (`.col-left`/`.col-right`, `z-index:100`) BELOW the body-level `.m-backdrop` (`z-index:90`). Fix = added `.shell{z-index:auto}` inside the `@media(max-width:900px)` block (next to `.rail{display:none}`). Small targeted edit, no rewrite. | **hard refresh only** (served statically) |

---

## 3. IF SOMETHING FAILS

- **Compile error (Rust):** `apply-hotfix.ps1` keeps the server on the OLD binary. Read the error from `C:\KAI\scratch\apply-hotfix.log` (or run `cargo build --release --bin kai` to see it), report it **verbatim** (file:line) so it can be fixed. Do **not** guess-edit Rust internals.
- **Access denied during build:** the script already kills `kai.exe` and retries once. If it still fails, open Task Manager → end every `kai.exe` → re-run the script.
- **`oracle.html` looks broken / blank after refresh:** check the REAL file (Windows path) ends with `</script></body></html>` — use Read/Grep, **NOT** the Linux/bash mount (it serves a stale truncated snapshot and lies). If the real file is truncated, restore from `C:\KAI\oracle.html.GOOD.bak` (if Ryan made one) or a `.bak`. **Never** do a whole-file rewrite of `oracle.html` — only small targeted edits (that's what caused every truncation).

---

## 4. VERIFY AFTER APPLYING

1. Engine ticking: `curl http://127.0.0.1:3334/api/session` → `tick` advancing.
2. Command Center gated: `curl -s -o NUL -w "%{http_code}" http://localhost:3001/api/channels` → **401**.
3. Pipeline idle during the day (not training): check it's not pegging CPU; it should only run 03:00–08:30.
4. Dashboard (hard-refresh): KAI Vitals show real numbers (not "engine down"); agents count is X/9 not 10/9.

---

*Generated for the dispatch. The single source of truth is `apply-hotfix.ps1` — when in doubt, run it and read `scratch\apply-hotfix.log`.*

---

## DISPATCH UPDATE — 2026-06-22 (from Claude/Cowork session, for the coworker)

Summary of work done this session. Nothing here was force-pushed to the live server; most items are pending the fleet rebuild/restart.

### 1. Kai vitals (frozen/idle, not dying)
- **Curiosity scale bug** fixed in `tools/oracle-discord/shared/drive-system.mjs` — phi_g (0–5 scale) was clamped and pinning curiosity to 0; now normalized by /5.0. Backup: `drive-system.mjs.curiosity-fix.bak.txt`. Takes effect on Node fleet restart (no recompile).
- **rho** wired to real `FieldState::compute().rho` in `src/bridge/oracle_server.rs` (was hardcoded 0.0).
- **valence** given a headless affective approximation (Drive+NeuralOscillator) in `src/bridge/oracle_server.rs` (was hardcoded 0.0); reduced model — no amygdala/serotonin/tone. Backup for both Rust edits: `oracle_server.rs.heartbeat-vitals-fix.bak.txt`. Requires `cargo build --release --bin kai`.
- See `C:\KAI\VITALS-FIX-CHECKLIST.md` for full detail. NOTE: the live binary timestamps suggest these may already be compiled, but run apply-hotfix.ps1 with -Force to guarantee.
- Remaining: lattice (phi_g/chi/cells) only moves with real input (chat/task); hippocampus 210k figure source still untraced (data/hippocampus_status.json not being written).

### 2. Command Center dashboard login
- User was locked out. Token reset in `tools/oracle-discord/.env` (CC_CONTROL_TOKEN) to a value the user knows. Backup: `.env.cc-token.bak.txt`. No OS-level env override exists (confirmed). Dashboard process was restarted and respawned cleanly.

### 3. Leo voice stutter/chopping (NOT internet — confirmed)
- Root cause found via log analysis: 27.5% of Leo's turns end at "Turn complete after -1ms" (killed instantly). Primary cause = ungated `sendText()` injections (esp. the Fleet Status Update at leo.mjs:1321) sending clientContent into Leo's live Gemini session MID-TURN, which interrupts his generation. Secondary = echo leaking through a too-short 320ms half-duplex tail. Also: ~145 Gemini Live session reconnects (GoAway 10-min cap + 1008 aborts) and 760 rate-limit (429) hits.
- Fix being applied (Node .mjs, effective on fleet restart): (a) defer context-only sendText while a turn is live, queue on `_pendingContext`, flush on turnComplete (user replies with turnComplete=true still go through); (b) widen echo tail to env-tunable LEO_ECHO_TAIL_MS default ~1200ms. Files: `shared/gemini-live-bridge.mjs`, `bots/leo.mjs` (backups made). Local Discord playout was CLEARED as the cause (clean on long turns).

### 4. Hotfix script
- `apply-hotfix.ps1` reviewed and verified safe (build + restart only; no deletions/downloads/cred changes). Note it stops ALL node processes and does a full stack bring-up. Recommend running with `-Force` to guarantee the Rust engine edits compile.
