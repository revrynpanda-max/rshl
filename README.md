# RSHL Personal Memory Engine — Benchmark

**What this is:** A benchmark for a sparse ternary HDC (Hyperdimensional Computing) memory engine.
No ML model. No GPU required. No cloud. Runs on any machine with Node.js.

**What it tests:**
- How fast can this machine index knowledge (entries/sec)
- How fast can it recall from 1K → 100K stored entries
- Memory footprint at 1/5/10 years of use
- A single comparable score so you can line up machines
- *(Optional)* GPU batch throughput via CUDA cuBLAS — if you have an NVIDIA GPU and build it

**Results will differ on every machine.** A server with 32 cores will score differently than a laptop.
A machine with AVX2 support will score differently than one without. That's the point.

---

## Quick Start (any machine with Node.js)

```
Double-click run.bat          (Windows)
bash run.sh                   (Linux / Mac)
```

No build step. Just needs Node.js 16+. The benchmark **auto-detects your hardware**:
- If the native addon is built, it loads it and uses it for scoring
- If not, it runs pure JS — still gives accurate numbers for your machine

---

## With Native Acceleration (faster, needs Visual Studio or gcc)

```
Double-click run-with-native.bat    (Windows — needs VS 2019/2022)
npm run build-native && node bench.js --save   (Linux/Mac — needs gcc/g++)
```

The native addon uses **AVX2 SIMD + OpenMP** (all CPU cores). Typically 50–200x faster
for large memory recall. Once built, `run.bat` auto-detects it — no flags needed.
If the build fails, the benchmark falls back to pure JS automatically.

---

## With GPU Benchmark (NVIDIA only, optional)

Adds Section 3D: cuBLAS SGEMM batch throughput on the installed GPU.
Shows single-query vs batch scaling and measures actual memory bandwidth.

```
cd cuda
build.bat          (Windows — needs VS 2022 + CUDA Toolkit 12.x)
```

Then run normally — the bench auto-detects `cuda/rshl_cuda_bench.exe` and runs it.

> **Note:** For single-query use cases (one lookup at a time), CPU AVX2+OMP is faster.
> GPU batch mode only wins when you batch 18+ queries simultaneously.

---

## Command Line Options

```
node bench.js            # auto-detect native + CUDA, no report file
node bench.js --save     # saves JSON report to reports/
```

---

## Sample Results  (Ryzen 5 8645HS · RTX 4050 Laptop · 40GB RAM)

```
RSHL SCORE:    102 pts
Throughput:    6.6 Mdot/s   (25K entries · 5s sustained)
Peak recall:   17,681 q/s   (1K entries · AVX2+OMP)
Real-time cap: 100,000 entries (<16ms/query)

Memory recall:
    1,000 entries  Native:  0.06ms/query   (129x faster than JS)
   25,000 entries  Native:  1.91ms/query   ( 90x faster than JS)
  100,000 entries  Native:  7.44ms/query

GPU batch throughput (RTX 4050 Laptop, CUDA):
  Bandwidth:     180.9 GB/s  (94% of 192 GB/s spec)
  Batch-1:        11M items/sec  (memory-bandwidth bound)
  Batch-1000:    816M items/sec  (4.1x faster than CPU)
```

---

## Sharing Results

Each `--save` run writes:
```
reports/rshl-bench-HOSTNAME-YYYY-MM-DD.json
```

Share that file. The JSON contains full machine info + all benchmark numbers.
To compare machines, look at the `score` field and `memory_growth.growth_curve`.

---

## What the Score Means

```
Score = sustained_Mdot_per_sec × 10 + index_entries_per_sec / 100
```

`sustained_Mdot_per_sec` = million dot-products per second over a 5-second recall stream
against a 25,000-entry memory. This is the most stable number in the benchmark.

Higher = faster hardware. Not normalized — a 32-core server scores proportionally higher.

| Mode | Typical score range |
|---|---|
| Pure JS (no native build) | 5–30 |
| Native AVX2+OMP (laptop) | 80–150 |
| Native AVX2+OMP (desktop / server) | 200–2000+ |

---

## Why This Matters

Most AI memory systems are either:
- Cloud-based (your data leaves your machine)
- Model-dependent (requires a GPU, gigabytes of weights)
- Slow at scale (database-backed, gets slower as it grows)

This engine:
- Stays under 82MB for 10 years of heavy use
- Stays under 16ms/query up to 100,000 entries with the native addon
- Runs entirely offline, on-device
- No external dependencies — zero npm packages required to run the benchmark

The benchmark answers: **can this specific machine run a personal memory engine in real time?**

---

## Requirements

- Node.js 16 or higher (https://nodejs.org)
- For native addon: Visual Studio 2019/2022 (Windows) or gcc/g++ (Linux/Mac)
- For CUDA section: CUDA Toolkit 12.x + Visual Studio 2022 (Windows, NVIDIA GPU only)
- No special drivers, no cloud accounts, no ML models
