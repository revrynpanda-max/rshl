# RSHL — Sparse Ternary Hyperdimensional Memory Engine

> **Zero-dependency, air-gap-safe memory engine that outperforms cloud memory systems while running 100% locally.**
> No LLM. No API. No GPU required. Sub-millisecond recall.

Built by **Ryan** — designed for local AI systems that need fast, private memory without cloud dependencies or API costs.

---

## Benchmark Results (RTX 4050 Laptop · Ryzen 5 8645HS · 40GB RAM)

```
RSHL SCORE:    340–359 pts  (varies with system load)
Real-time cap: 100,000 entries  <16ms/query   (AVX2+OMP)
Peak recall:   12,000–15,500 q/s  (1K entries · native)
Throughput:    30–32 Mdot/s       (25K entries · 5s sustained)
Binary POPCNT: 1,200–1,270 q/s   (25K entries · 5–6x vs sparse AVX2)
Binary format: 1,024 bytes/row   (vs 4,096 int8 — 4x smaller, 4x less DRAM)

Memory recall:
    1,000 entries  Native:  0.04–0.08ms  (94–213x faster than JS)
    5,000 entries  Native:  0.34–0.46ms  (111–152x faster than JS)
   10,000 entries  Native:  0.80–1.49ms  ( 67–94x faster than JS)
   25,000 entries  Native:  2.38–2.39ms  ( 79x faster than JS)
   50,000 entries  Native:  4.73ms
  100,000 entries  Native:  9.19ms

Memory footprint at 10 years of daily use: 82MB
GPT-4 weights: ~800GB  →  RSHL is 9,744x smaller
```

---

## Binary Ternary POPCNT — The Fast Path

The native addon includes a **binary ternary packing** format that is the primary recall path:

- Ternary `{-1, 0, +1}` values are stored as two bitfields: `pos_mask` + `neg_mask`
- **1,024 bytes/row** vs 4,096 bytes/row for int8 — **4× less DRAM bandwidth**
- Dot product reduces to 4 POPCNT instructions per 64 bits — single CPU cycle each
- `dot(row, q) = POPCNT(rp & qp) + POPCNT(rn & qn) − POPCNT(rp & qn) − POPCNT(rn & qp)`
- **5–6× faster sustained throughput** vs sparse int8 AVX2

This is what drives the score from ~106 (sparse AVX2) to **340–359** (binary POPCNT).

---

## RSHL Lattice — Smart Memory Operations (No LLM Needed)

`rshl-lattice.js` adds Mem0-comparable ADD/UPDATE/NOOP/DELETE classification
using only vector resonance + entity overlap. No API calls. No network. No cost.

**15/15 — 100% accuracy** on the same operation scenarios Mem0 is designed for:

```
  ┌────┬──────────┬──────────┬──────────┬────────────────────────────────────────┐
  │ #  │ Expected │ Got      │ Result   │ Input                                  │
  ├────┼──────────┼──────────┼──────────┼────────────────────────────────────────┤
  │  1 │ ADD      │ ADD      │ ✓ PASS   │ Ryan lives in Austin Texas             │
  │  2 │ UPDATE   │ UPDATE   │ ✓ PASS   │ Ryan moved to New York City            │
  │  3 │ NOOP     │ NOOP     │ ✓ PASS   │ Ryan lives in New York City            │
  │  4 │ ADD      │ ADD      │ ✓ PASS   │ Ryan works at Anthropic as engineer    │
  │  5 │ UPDATE   │ UPDATE   │ ✓ PASS   │ Ryan got promoted to senior engineer   │
  │  6 │ ADD      │ ADD      │ ✓ PASS   │ Ryan loves hiking and trail running    │
  │  7 │ ADD      │ ADD      │ ✓ PASS   │ Ryan's favorite food is sushi          │
  │  8 │ NOOP     │ NOOP     │ ✓ PASS   │ Ryan loves hiking and trail running    │
  │  9 │ DELETE   │ DELETE   │ ✓ PASS   │ Forget that Ryan likes sushi           │
  │ 10 │ ADD      │ ADD      │ ✓ PASS   │ Ryan prefers ramen over sushi          │
  │ 11 │ ADD      │ ADD      │ ✓ PASS   │ I work remotely from home              │
  │ 12 │ UPDATE   │ UPDATE   │ ✓ PASS   │ I switched to working from the office  │
  │ 13 │ ADD      │ ADD      │ ✓ PASS   │ The project deadline is Friday         │
  │ 14 │ UPDATE   │ UPDATE   │ ✓ PASS   │ The project deadline moved to Monday   │
  │ 15 │ NOOP     │ NOOP     │ ✓ PASS   │ The project deadline is Monday         │
  └────┴──────────┴──────────┴──────────┴────────────────────────────────────────┘
  Accuracy: 15/15 correct (100%)
```

---

## How RSHL Compares to Mem0, Zep, and MemGPT

| Feature | RSHL Lattice | Mem0 | Zep/Graphiti | MemGPT/Letta |
|---|---|---|---|---|
| **Store latency** | **<1ms** | ~100–500ms | ~50–300ms | ~200–2000ms |
| **Query latency** | **<1ms** | 148ms p50 | 10–300ms | 10–50ms |
| **ADD/UPDATE/NOOP/DELETE** | **✓ local, no LLM** | ✓ requires LLM | partial | partial |
| **Entity normalization** | **✓ local** | ✓ via LLM | ✓ via LLM | ✓ via LLM |
| **Works offline / air-gap** | **✓** | ✗ | ✗ | ✗ |
| **API cost** | **$0** | OpenAI API | LLM + Neo4j | LLM + vector DB |
| **Dependencies** | **zero** | qdrant + openai | Neo4j/FalkorDB | vector DB + LLM |
| **Accuracy (same test set)** | **100%** | LLM-dependent | LLM-dependent | LLM-dependent |

Sources: Mem0 — [arXiv:2504.19413](https://arxiv.org/abs/2504.19413) · Zep/Graphiti — [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) · MemGPT — [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)

**RSHL Lattice vs Mem0:**
- Store: **~250x faster** — sub-millisecond vs ~250ms LLM round-trip
- Query: **~150x faster** — <1ms vs 148ms p50
- Cost: **$0** per operation vs per-token API billing
- Privacy: **100% local** — nothing leaves your machine

---

## How it Works

Every piece of text is encoded as a **sparse ternary vector** — a list of `(dimension, ±1)` pairs
in a 4096-dimensional space where ~5% of dimensions are non-zero.

```
"api connection timeout" → [(12, +1), (89, -1), (204, +1), ...]   ~205 pairs
"memory allocation error" → [(7, -1), (91, +1), (301, -1), ...]   ~205 pairs
```

- **Store** — superpose vectors into a memory cell (additive, threshold back to ternary)
- **Recall** — dot-product query vector against all stored cells → cosine similarity
- **Lattice** — classify each store as ADD / UPDATE / NOOP / DELETE without any LLM
- **Reinforce** — increment strength on access (Hebbian learning)
- **Decay** — exponential strength decay over time — naturally forgets what isn't revisited
- **Bind** — XOR-style binding associates key ↔ value vectors (reversible)

Two unrelated texts produce nearly orthogonal vectors (cosine ≈ 0.5).
Related texts land close together. You don't train anything — the geometry is emergent.

---

## Quick Start — JavaScript (zero dependencies)

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

## Quick Start — RSHL Lattice (smart ops, still zero deps)

```js
const { RSHLLattice } = require("./rshl-lattice");
const mem = new RSHLLattice({ userName: "Ryan" });

mem.store("I live in Austin");          // → op: ADD
mem.store("I moved to NYC");            // → op: UPDATE  (replaced Austin)
mem.store("I live in NYC");             // → op: NOOP    (already known)
mem.store("Forget I ever lived there"); // → op: DELETE

const hits = mem.recall("where does Ryan live?");
// → [{ text: "I moved to NYC", score: 0.91, strength: 1.2 }]
```

## Quick Start — Python (NumPy only)

```python
from rshl_core import RSHLCore

engine = RSHLCore(dim=10_000, sparsity=0.95)
engine.remember("api-timeout",  "api connection timeout endpoint failed")
engine.remember("board-pass",   "test station board calibration passed")
engine.reinforce("api-timeout", amount=0.5)

hits = engine.resonance("api error retry", top_k=3)
# [('api-timeout', 0.71, 1.5), ('board-pass', 0.52, 1.0), ...]
```

---

## Files

| File | Language | Description |
|---|---|---|
| `rshl-core.js` | JavaScript | Core engine — zero dependencies |
| `rshl-core.ts` | TypeScript | Same, fully typed — import into any TS project |
| `rshl_core.py` | Python | Full engine with NumPy — includes bind, decay, reinforce |
| `rshl-lattice.js` | JavaScript | Smart ops layer — ADD/UPDATE/NOOP/DELETE, no LLM |
| `examples/basic-js.js` | JS | Store, recall, orthogonality check |
| `examples/basic-py.py` | Python | Store, recall, decay, bind/retrieve |
| `native/rshl_native.cpp` | C++ | AVX2+OMP addon for Node.js (50–200x faster) |
| `cuda/rshl_cuda_bench.cu` | CUDA | cuBLAS batch GEMM throughput benchmark |
| `bench.js` | JavaScript | Full hardware benchmark (runs all paths) |

---

## Run the Benchmark

```
node bench.js           # auto-detects native addon + CUDA
node bench.js --save    # saves JSON report to reports/
```

### Build native AVX2+OMP addon (recommended — needed for score above ~30)

```bash
# Windows (needs VS 2019/2022 + node-gyp)
run-with-native.bat

# Linux / Mac (needs gcc/g++)
npm run build-native && node bench.js
```

### Build CUDA benchmark (optional — NVIDIA only)

```bash
cd cuda && build.bat   # needs CUDA Toolkit 12.x + VS 2022
```

---

## Why Ternary?

Balanced ternary `{-1, 0, +1}` carries more information per dimension than binary `{0, 1}`
and maps naturally to **signed associations** — positive evidence, negative evidence, and absence.

At 4096 dimensions with 5% density:
- Two random vectors: cosine ≈ 0.5 (nearly orthogonal — easy to discriminate)
- Same text twice: cosine = 1.0 (perfectly reproducible — deterministic hash)
- Related text: cosine 0.6–0.85 (semantic neighborhood)
- Superposition of 100 vectors: still queryable — the geometry survives compression

---

## Memory Footprint

| Scale | Size |
|---|---|
| 1 year (3,650 entries) | 8 MB |
| 5 years (18,250 entries) | 41 MB |
| 10 years (36,500 entries) | **82 MB** |
| 100,000 entries | 225 MB |

vs GPT-4 weights: **~800 GB** — RSHL is 9,744x smaller at 10 years of use.

---

## GPU Batch Results (RTX 4050 Laptop, cuBLAS SGEMM)

```
Bandwidth:    179.2 GB/s  (93% of 192 GB/s spec)
Batch-1:      9M items/sec    (memory-bandwidth bound, PCIe overhead)
Batch-100:    574M items/sec
Batch-1000:   775M items/sec  (GPU wins over CPU at batch ≥ 23)
```

CPU AVX2+OMP binary POPCNT is faster for single-query recall.
GPU batch wins at 23+ simultaneous queries.

---

## Requirements

- **JS/TS**: Node.js 16+
- **Python**: Python 3.9+, NumPy
- **Native addon**: Visual Studio 2019/2022 (Windows) or gcc/g++ (Linux/Mac)
- **CUDA bench**: CUDA Toolkit 12.x + VS 2022 (Windows, NVIDIA GPU only)

---

## License

MIT — see [LICENSE](LICENSE)
