# CLAUDE.md — KAI project (auto-loaded every session)

**Before doing anything, read these two files** — they contain the full context and must not be skipped:
1. **`CLAUDE-CODE-HANDOFF.md`** — your onboarding: what KAI is, the repo map, the current main effort (native Rust KAIVERSE client), what's already shipped, and the critical gotchas.
2. **`The KAI Codex.md`** — the canonical living manual / source of truth. Read the masthead (Version / Last Updated) + the top CHANGELOG entries (newest = `v9.10.10`).

Owner: **Ryan (nastermodx)**. He is the tester/verifier — he runs builds and reports logs/screenshots; you do the engineering.

## Hard rules (don't violate)
- **THE BROWSER KAIVERSE (`kaiverse.js`) IS THE CURRENT FOCUS — improving it is the job; just don't BREAK it.** The owner is driving the visual overhaul (`KAIVERSE-GOAL-visual-overhaul.md`). You MAY edit `kaiverse.js` / `oracle.html` for that, BUT: (1) keep the working **FIRST-PERSON** flight controls intact — never change `nsUpdateCamera` movement/throttle in a way that alters the feel (a chase-cam rewrite broke it once, reverted v9.10.8). The player-ship **3rd-person view is fine ONLY as an additive, render-only, toggleable layer** (Tier 1.5), default first-person. (2) The "hard" visual items (day/night terminator, atmosphere shell, terrain LOD / landing, sky-sphere, volumetric clouds) are **eyeball-iterated WITH the owner via the fly→screenshot→tune loop — do NOT blind-edit them.** (3) Surgical, reversible, flag-gated edits only; confirm before changing core controls. The native `src/bin/kaiverse/` `.exe` is a **separate/parallel track, NOT the current focus** — don't spend effort there unless the owner says so. (Full detail: the SCOPE box + phase plan in `CLAUDE-CODE-HANDOFF.md`.)
- **NEVER whole-file-rewrite `oracle.html` or `kaiverse.js`** — surgical edits only (wholesale rewrites have caused truncation).
- **Secrets live in `tools/oracle-discord/.env`** — never print, commit, or echo key values.
- **Verify against the REAL Windows files.** Mounted/WSL reads of large files (`oracle.html`, `kaiverse.js`, `leo.mjs`, the Codex) can serve STALE/TRUNCATED snapshots and lie. Use content diffs as evidence of change, NOT timestamps (mtime is unreliable here).
- **Don't claim a fix you didn't make**, and don't trust your own memory of "already did X" — verify by reading the file / `git`. Show evidence.
- **Keep the Codex updated** after meaningful changes (prepend a `## CHANGELOG  -  vX.Y.Z` entry, bump `Version`, prepend the `Last Updated` line). **When you bump the Codex `Version`, also bump `Cargo.toml [package] version` to match** — they must stay in sync (the build prints the Cargo version).

## Apply/restart cheatsheet
- `oracle.html` → served statically; hard-refresh the dashboard (no restart).
- `*.mjs` (bots/fleet) → restart with `Start-KAI.ps1` (NOT the outdated `restart-ecosystem`).
- **Dashboard-server-only (`command-center-server.mjs`) changes** → `.\Start-Dashboard.ps1` — hosts ONLY the :3001 server, leaves a running engine + the training pipeline alone, spawns no bots. Ctrl+C stops just the dashboard. (Pipeline-side changes like `distill_from_bitnet.py` / `keep_pipeline_alive.ps1` still need the pipeline itself to relaunch.)
- Rust (`src/bin/kaiverse/`) → `cargo build --release --bin kaiverse`, run `.\target\release\kaiverse.exe`.

## Style
Be concise and honest. Short replies. The owner dislikes padding.
