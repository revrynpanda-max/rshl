# RSHL Performance & Technical Specifications (v6.0.0)

This document tracks the precision and throughput metrics for the Recursive Sparse Hyperdimensional Lattice (RSHL) engine across various hardware targets.

## Benchmark Results (v6.0.0)
*Hardware: RTX 4050 Laptop · Ryzen 5 8645HS · 40GB RAM*

### v6.0.0 Performance Breakthrough: Hardware-Native Throughput
The v6.0.0 release introduces major optimizations to the core RSHL scan engine, shifting the performance baseline from an IPC-bottlenecked state to a high-speed, direct-to-CPU resonant model.

| Metric | v5.9.0 | v6.0.0 | Speedup |
| :--- | :--- | :--- | :--- |
| **Field State Compute** | 7.0ms | **1.57ms** | **4.5x** |
| **Store Latency** | 11,650ms | **2.02ms** | **5,750x** |
| **Consolidation (Dream)** | 2.22ms | **1.49ms** | **1.5x** |
| **Query Throughput** | 0.08 Mdots | **0.66 Mdots** | **8x** |

### Key v6.0.0 Optimizations:
1. **Cached Norm Vectors**: Every `SparseVec` now stores its L2 norm internally. This eliminates 32KB of redundant memory traffic per `cosine()` call (scanning 16,384 dims twice just to count non-zeros is now O(1)).
2. **64-Wide SIMD Dot Product**: The inner dot product loop has been widened from 16 to 64 elements, explicitly targeting AVX2 auto-vectorization for maximum CPU pipelining.
3. **Incremental Verification**: Replaced O(N²) global contradiction scans during ingestion with targeted incremental verification of the active field.

---

## Internal Engine Recall (Native Rust)
*Zero-overhead in-memory resonance scan rates at v6.0.0 scale*

| Entries | Latency | Mdots (Million Operations/sec) |
|---------|---------|----------------|
| 1,000   | 0.02ms  | 50.0           |
| 5,000   | 0.10ms  | 50.0           |
| 10,000  | 0.21ms  | 47.6           |
| 100,000 | 2.80ms  | 35.7 (Projected) |

---

## Cognitive Stability: The Triple-Gate System
To prevent "garbage geometry" from polluting the cognitive field, KAI implements a three-stage validation gate for every autonomous dream (consolidation) cycle.

### 1. Resonance Gate (Confidence)
Before any field computation, the synthetic bundle is queried against the universe. If resonance falls below the adaptive threshold (**0.15**), the dream is discarded. This stops pure noise from ever entering the field.

### 2. Contradiction Gate (χ Pressure)
KAI v6.0.0 uses the new `contradiction.rs` module to detect semantic conflicts. If a new claim shows an inherent contradiction (χ) above the threshold (**0.55**), the dream is rejected.

### 3. Coherence Gate (Φ_C / Φg Delta)
A final guard protects the global emergence score. KAI uses the **helical phase coherence** (phasor-sum model) derived from HLV theory:
```
Φ_C = |Σ R_i · e^(jθ_i)| / Σ R_i
```
If a dream would drop the total field coherence by more than **0.08**, it is discarded.

### Recall Accuracy
*Measured using native Rust integration test suite*
- **Baseline (2,159 cells)**: 100.0% Top-1
- **Mean Reciprocal Rank (MRR)**: 1.000 (Perfect rank-1 alignment)

---

## Technical Architecture: AVX2 Optimized Dot Product

The primary recall path uses **AVX2-optimized** dot products on 16,384-dimensional sparse ternary vectors.

1. **SIMD Width**: 64 elements per iteration (2x full AVX2 width).
2. **Caching**: L2 norm lookup is O(1).
3. **Execution**: The engine achieves ~0.66 Mdots on a mid-range laptop CPU while maintaining 100% recall precision.

---

## Memory Footprint (Sparse JSON Persistence)

| Scale | Duration Segment | Footprint |
|-------|------------------|-----------|
| 3,650 entries | 1 year (daily) | 12 MB |
| 100,000 entries | - | 320 MB |

*Comparison: RSHL is approximately 7,500x smaller than equivalent transformer-based memory stores at 10 years of simulated use.*
