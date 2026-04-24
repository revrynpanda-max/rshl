# RSHL Performance & Technical Specifications

This document tracks the precision and throughput metrics for the Recursive Sparse Hyperdimensional Lattice (RSHL) engine across various hardware targets.

## Benchmark Results (v5.9.0)
*Hardware: RTX 4050 Laptop · Ryzen 5 8645HS · 40GB RAM*

### End-to-End Latency (IPC Server Mode)
*Measured via `kai-bench.ps1` (Process Start + Query + Shutdown)*
### End-to-End Latency (TUI Mode)
*Measured via heartbeat tick profiling in v5.9.0*
- **TUI Responsiveness**: **Instant** (0ms main-thread delay for heavy tasks)
- **Field Metric Compute (11k cells)**: 2.1ms (O(N) optimized pass)
- **SparseVec Encoding (Background)**: 30-50ms per batch (Offloaded)
- **DuckDuckGo Intake (Background)**: Asynchronous (No main-thread stall)

> [!IMPORTANT]
> **The v5.9.0 Performance Breakthrough**: Previous versions suffered from "heartbeat stutter" where heavy encoding or network calls would freeze the TUI for 500ms–5s. KAI now uses a fully decoupled asynchronous architecture. The main thread handles orchestration and UI rendering only, while all "thinking" and "learning" occurs in parallel background streams.

### Internal Engine Recall (Native Rust)
*Zero-overhead in-memory resonance scan rates*

| Entries | Latency | Speedup vs JS |
|---------|---------|----------------|
| 1,000   | 0.08ms  | 124x           |
| 5,000   | 0.41ms  | 120x           |
| 10,000  | 0.82ms  | 122x           |
| 25,000  | 2.05ms  | 120x           |
| 100,000 | 7.91ms  | -              |

## Cognitive Stability: The Triple-Gate System
To prevent "garbage geometry" from polluting the cognitive field, KAI implements a three-stage validation gate for every autonomous dream (consolidation) cycle.

### 1. Resonance Gate (Confidence)
Before any field computation, the synthetic bundle is queried against the universe. If resonance falls below the adaptive threshold (**0.10 - 0.36**), the dream is discarded. This stops pure noise from ever entering the field.

### 2. Contradiction Gate (χ Pressure)
If the resulting field state shows an inherent contradiction (χ) above the threshold (**0.42 - 0.70**), the dream is rejected. This specifically targets and kills "χ-injectors" that would otherwise cause cognitive dissonance spikes.

### 3. Coherence Gate (Φ_C / Φg Delta)
A final guard protects the global emergence score. KAI now uses **helical phase coherence** (phasor-sum model) rather than flat cosine averaging:
```
Φ_C = |Σ R_i · e^(jθ_i)| / Σ R_i
```
If a dream would drop the total field coherence by more than **0.08**, it is discarded as coherence-degrading.

### Recall Accuracy
*Measured using `eval/recall-accuracy.js` protocol*
- **Baseline (30 facts)**: 100.0% Top-1
- **+5,000 noise entries**: 100.0% Top-1
- **Mean Reciprocal Rank (MRR)**: 1.000 (Perfect rank-1 alignment)

---

## Technical Architecture: Binary Ternary POPCNT

The primary recall path uses **binary ternary packing** to maximize DRAM bandwidth and CPU instruction parallelization.

1. **Packing**: Ternary values `{-1, 0, +1}` are stored as two bitfields (`pos_mask`, `neg_mask`).
2. **Density**: 1,024 bytes per row (4096 dimensions) vs 4,096 bytes for int8, resulting in **4x less DRAM bandwidth**.
3. **Execution**: The dot product is reduced to 4 `POPCNT` instructions per 64-bit word.
   - `dot(r, q) = POPCNT(rp & qp) + POPCNT(rn & qn) - POPCNT(rp & qn) - POPCNT(rn & qp)`
4. **Efficiency**: 5–6x faster sustained throughput than sparse int8 AVX2.

---

## Memory Footprint (1024-byte rows)

| Scale | Duration Segment | Footprint |
|-------|------------------|-----------|
| 3,650 entries | 1 year (daily) | 8 MB |
| 18,250 entries | 5 years | 41 MB |
| 36,500 entries | 10 years | 82 MB |
| 100,000 entries | - | 225 MB |

*Comparison: RSHL is approximately 9,700x smaller than GPT-4 weights (~800GB) at 10 years of simulated use.*

---

## GPU Acceleration (cuBLAS SGEMM)

While CPU-based binary POPCNT is superior for low-latency single-query recall, GPU batching excels at scale:
- **Bandwidth**: 179.2 GB/s (93% of theoretical peak)
- **Batch-100**: 574M items/sec
- **Crossover Point**: GPU batching wins over multi-threaded CPU at batches of **23 or more** simultaneous queries.
