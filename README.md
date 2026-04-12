# RSHL — Sparse Ternary Hyperdimensional Memory Engine

A lightweight, offline memory engine based on **Hyperdimensional Computing (HDC)**.
No ML model. No GPU required. No cloud. Stores knowledge as sparse ternary vectors
and retrieves by resonance (cosine similarity) in sub-millisecond time.

Implementations in **JavaScript**, **TypeScript**, and **Python**.
Includes a native **AVX2+OpenMP** C++ addon for 50–200x faster recall,
and an optional **CUDA cuBLAS** GPU batch benchmark.

---

## How it works

Every piece of text is encoded as a **sparse ternary vector** — a list of `(dimension, ±1)` pairs in a 4096-dimensional space where ~5% of dimensions are non-zero.

```
"api connection timeout" → [(12, +1), (89, -1), (204, +1), ...]   ~205 pairs
"memory allocation error" → [(7, -1), (91, +1), (301, -1), ...]   ~205 pairs
```

- **Store**: superpose vectors into a memory cell (additive, threshold back to ternary)
- **Recall**: dot-product your query vector against all stored cells → cosine similarity
- **Reinforce**: increment strength on access (Hebbian learning)
- **Decay**: exponential strength decay over time — naturally forgets what isn't revisited
- **Bind**: XOR-style binding associates key ↔ value vectors (reversible)

Two unrelated texts produce nearly orthogonal vectors (cosine ≈ 0).
Related texts land close together. You don't train anything — the geometry is emergent.

---

## Quick start — JavaScript (zero dependencies)

```js
const { textVec, resonance } = require("./rshl-core");

const memories = [
  { key: "api-timeout",  vec: textVec("api connection timeout endpoint failed") },
  { key: "board-pass",   vec: textVec("test station board calibration passed") },
  { key: "deploy-done",  vec: textVec("deployment pipeline completed all stages") },
];

const query = textVec("api error retry");
const hits = memories
  .map(m => ({ key: m.key, score: resonance(query, m.vec) }))
  .sort((a, b) => b.score - a.score);

console.log(hits[0]);  // { key: 'api-timeout', score: 0.73 }
```

See [`examples/basic-js.js`](examples/basic-js.js) for a full store/recall/reinforce example.

---

## Quick start — Python (NumPy only)

```python
from rshl_core import RSHLCore

engine = RSHLCore(dim=10_000, sparsity=0.95)
engine.remember("api-timeout",  "api connection timeout endpoint failed")
engine.remember("board-pass",   "test station board calibration passed")
engine.reinforce("api-timeout", amount=0.5)

hits = engine.resonance("api error retry", top_k=3)
# [('api-timeout', 0.71, 1.5), ('board-pass', 0.52, 1.0), ...]
```

See [`examples/basic-py.py`](examples/basic-py.py) for bind/decay/weak-spots examples.

---

## Files

| File | Language | Description |
|---|---|---|
| `rshl-core.js` | JavaScript | Core engine — zero dependencies |
| `rshl-core.ts` | TypeScript | Same, fully typed — import into any TS project |
| `rshl_core.py` | Python | Full engine with NumPy — includes bind, decay, reinforce |
| `examples/basic-js.js` | JS | Store, recall, orthogonality check |
| `examples/basic-py.py` | Python | Store, recall, decay, bind/retrieve |
| `native/rshl_native.cpp` | C++ | AVX2+OMP addon for Node.js (50–200x faster) |
| `cuda/rshl_cuda_bench.cu` | CUDA | cuBLAS batch GEMM throughput benchmark |
| `bench.js` | JavaScript | Full hardware benchmark (runs all paths) |

---

## Benchmark

```
node bench.js           # auto-detects native addon + CUDA
node bench.js --save    # saves JSON report to reports/
```

**Sample results** (Ryzen 5 8645HS · 12 threads · RTX 4050 Laptop):

```
RSHL SCORE:    102 pts
Real-time cap: 100,000 entries < 16ms/query  (AVX2+OMP)
Peak recall:   17,681 q/s  (1K entries)

Memory recall:
    1,000 entries  Native:  0.06ms   (129x faster than JS)
   25,000 entries  Native:  1.91ms   ( 90x faster than JS)
  100,000 entries  Native:  7.44ms

GPU batch (RTX 4050 Laptop, cuBLAS):
  Bandwidth:    180.9 GB/s  (94% of spec)
  Batch-1000:   816M items/sec
```

### Build native addon (optional — needed for scoring above ~30)

```
# Windows (needs VS 2019/2022)
run-with-native.bat

# Linux / Mac (needs gcc/g++)
npm run build-native && node bench.js
```

### Build CUDA benchmark (optional — NVIDIA only)

```
cd cuda && build.bat   (needs CUDA Toolkit 12.x + VS 2022)
```

---

## Why ternary?

Balanced ternary `{-1, 0, +1}` carries more information per dimension than binary `{0, 1}` and maps naturally to **signed associations** — positive evidence, negative evidence, and absence. The Soviet Setun computer used balanced ternary arithmetic in 1958. We're just applying it to associative memory at high dimension.

At 4096 dimensions with 5% density:
- Two random vectors: cosine ≈ 0 (nearly orthogonal — easy to discriminate)
- Same text twice: cosine = 1.0 (perfectly reproducible — deterministic hash)
- Related text: cosine 0.6–0.85 (semantic neighborhood)
- Superposition of 100 vectors: still queryable — the geometry survives compression

---

## Memory footprint

| Scale | Size |
|---|---|
| 1 year (3,650 entries) | 8 MB |
| 5 years (18,250 entries) | 41 MB |
| 10 years (36,500 entries) | 82 MB |
| 100,000 entries | 225 MB |

vs GPT-4 weights: **~800 GB** — this is 9,744x smaller at 10 years of use.

---

## Requirements

- **JS/TS**: Node.js 16+
- **Python**: Python 3.9+, NumPy
- **Native addon**: Visual Studio 2019/2022 (Windows) or gcc/g++ (Linux/Mac)
- **CUDA bench**: CUDA Toolkit 12.x + VS 2022 (Windows, NVIDIA GPU only)
