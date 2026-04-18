# RSHL Performance & Technical Specifications

This document tracks the precision and throughput metrics for the Recursive Sparse Hyperdimensional Lattice (RSHL) engine across various hardware targets.

## Benchmark Results (v5.4)
*Hardware: RTX 4050 Laptop · Ryzen 5 8645HS · 40GB RAM*

### Throughput (Dot Products)
- **Peak Recall**: 9,611 queries/sec (1K entries, native binary-packed POPCNT)
- **Sustained**: 1,868 queries/sec (25K entries, 5s duration)
- **Aggregated Score**: 657 pts

### Query Latency (Native Rust/C++)
| Entries | Latency | Speedup vs JS |
|---------|---------|----------------|
| 1,000   | 0.10ms  | 95x            |
| 5,000   | 0.49ms  | 107x           |
| 10,000  | 0.90ms  | 106x           |
| 25,000  | 2.12ms  | 110x           |
| 100,000 | 7.73ms  | -              |

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
