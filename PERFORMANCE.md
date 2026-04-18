# RSHL Performance & Technical Specifications

This document tracks the precision and throughput metrics for the Recursive Sparse Hyperdimensional Lattice (RSHL) engine across various hardware targets.

## Benchmark Results (v5.4)
*Hardware: RTX 4050 Laptop · Ryzen 5 8645HS · 40GB RAM*

### End-to-End Latency (IPC Server Mode)
*Measured via `kai-bench.ps1` (Process Start + Query + Shutdown)*
- **Avg Query Latency**: 18.5ms (10-run avg)
- **Avg Store Latency**: 20.9ms
- **Ping (Round-trip)**: < 1ms

### Internal Engine Recall (Native Rust)
*Zero-overhead in-memory resonance scan rates*

| Entries | Latency | Speedup vs JS |
|---------|---------|----------------|
| 1,000   | 0.08ms  | 124x           |
| 5,000   | 0.41ms  | 120x           |
| 10,000  | 0.82ms  | 122x           |
| 25,000  | 2.05ms  | 120x           |
| 100,000 | 7.91ms  | -              |

> [!NOTE]
> Differences between IPC Latency (18ms) and Engine Recall (2ms) reflect Windows process overhead. For real-time production, KAI should be used via a persistent pipe or as a linked library.

### Recall Accuracy
*Measured using `eval/recall-accuracy.js` protocol*
- **Baseline (30 facts)**: 100.0% Top-1
- **+5,000 noise entries**: 100.0% Top-1
- **Mean Reciprocal Rank (MRR)**: 1.000 (Perfect rank-1 alignment)

---

## Technical Architecture: Binary Ternary POPCNT

The primary recall path in v5.4 uses **binary ternary packing** to maximize DRAM bandwidth and CPU instruction parallelization.

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
