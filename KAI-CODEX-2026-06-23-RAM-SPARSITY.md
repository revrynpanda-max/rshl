# KAI Codex Addendum — 2026-06-23 — Sparsity, RAM & "no brute-forcing"

Fold this into The KAI Codex. (Written as a separate file because the main Codex.md
contains an embedded binary byte that makes safe in-place editing risky.)

## Principle (reaffirmed)
KAI's core is a **sparse-ternary VSA**: 16,384-dim vectors over {-1,0,+1}, very few
nonzeros, ~384k cells. The whole point is that sparsity keeps it **light**. Any path that
**densifies** a sparse vector (`to_dense()` → a 16,384-wide array), or **brute-force scans
every cell densely**, or **clones the whole Universe**, throws away that premise and is a bug
to be hunted, not a feature. "Run the ternary logic better" = operate on the nonzero indices,
reuse the existing sparse ops, and never copy the whole lattice.

## Audit result (read-only sweep of src/, 2026-06-23)
**Good news — the query path already honors the Codex.** Retrieval is sparse-native:
- `SparseVec::dot()` — two-pointer merge over nonzeros, O(nnz).
- `SparseVec::cosine()` — uses cached norm.
- `DenseMask::cosine` / `PackedMask::cosine_packed` — bit-packed popcount cosine (AVX-512).
- `query_full_scan` / `query_kmeans` use these over Rayon. No densification in retrieval.
- On-disk serialization is already sparse `(u16,i8)` pairs, never the dense array.

**What was actually pinning RAM/CPU = whole-Universe `.clone()` on timers**, not the math.

## Fixed this session
1. **Autosave no longer clones the whole Universe (production `--oracle` path).**
   `src/bridge/oracle_server.rs` — the 180s autosave had two paths: streaming (serialize
   under-lock, write outside, NO clone) and the legacy whole-Universe clone (2x RAM). The
   clone was the DEFAULT. **Now streaming is the default**; the clone is opt-in only via
   `KAI_STREAMING_SAVE=0`. Kills the periodic 16→20GB spike. **Requires `cargo build --release
   --bin kai` + engine restart.**
2. **Ollama throttled** (`Start-KAI.ps1`): `OLLAMA_MAX_LOADED_MODELS=1`, `NUM_PARALLEL=1`,
   `KEEP_ALIVE=30s`, BelowNormal priority → unloads models when idle (was holding 2.6–5.3 GB),
   no parallel-inference CPU storm.
3. **`stop-inspectors.ps1`** — stops the profilers that brute-force the box: `kai_supervisor.py`
   (the RAM-recycler that force-killed kai.exe = "engine down all the time"), the RAM watcher,
   `kai_healthcheck.py`, `diagnose_bitnet*`. Boot with `Start-KAI.ps1 -NoSupervisor` to keep
   the recycler off.

## Known remaining (NOT changed yet — flagged for a careful, tested pass)
Ranked by impact; none are in the live `--oracle` query path, so they're lower urgency:
- **`main.rs:1766` `save_state`** and **`main.rs:836`** (5-cell train) — clone the entire
  384k-cell Universe on timers. These are the **TUI path only** (not `--oracle`). Fix: apply
  the same streaming-serialize pattern; for the train, clone only the 5 sampled cells (change
  `online_train_step` to take `&[Cell]`; it's the sole caller).
- **`universe.rs:884` mask_pool** — on index build, clones every sparse vec (`pool_sv`) and
  holds a 4KB `DenseMask` per cell (~1.5 GB at 384k). On-demand, not per-tick. Fix: build
  masks straight from `&c.claim.vec` (no `pool_sv` clone); use `PackedMask` (1KB) → 4x less.
- **`lattice_attention.rs` TernaryMlp** — ~167 MB resident dense weights (`weights_latent` f32
  16384×2048). Fix: keep only quantized weights resident after training, or f16.
- **DORMANT LANDMINES — rewrite sparse BEFORE re-enabling:** `ram_stream.rs:50-113` and
  `boid_engine.rs:52-213` densify EVERY cell into `Vec<f32>[16384]` (~48 GB if ever run on the
  full lattice). Currently unwired (`HomeostasisRequest` never emitted; no live caller of the
  dense homeostasis cycle). If you ever turn boids/homeostasis back on, they MUST first be
  reimplemented on sparse `nz`/`vals` via `bundle`/`dot`/`cosine` + sparse top-k.

## Stability note
The supervisor's auto RAM ceiling is ~58% of total RAM (≈22.6 GB on 39 GB). With streaming-save
default the engine should sit nearer its compact size and stop tripping that ceiling, so the
"engine keeps going down" loop should end. If kai.exe still balloons, the next real lever is
**incremental autosave** (serialize only dirty cells, not all 384k every 180s) — a deeper change.
