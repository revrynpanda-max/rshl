# RSHL — Semantic Memory Index

> **A local lookup engine that finds the right record by meaning, not exact match.**
> Sub-millisecond query time. No cloud. No AI model required. No API calls.
> Drop-in Node.js module. Zero dependencies.

Built by **Ryan** — designed as a memory and routing kernel for local infrastructure,
AI systems, and industrial platforms (MES, SCADA, event-driven services).

---

## What It Does

RSHL is a **semantic index** — like a database index, but it matches by meaning instead of exact value.

| You ask | It returns |
|---|---|
| "calibration result station 4" | closest matching record from your index |
| "Ryan moved to Seattle" | detected as UPDATE of existing location record |
| "api timeout error endpoint" | top-5 most relevant past events, ranked by similarity |

No model. No cloud. No training. Works offline. Runs on the same Node.js server you already have.

---

## Quick Start

```bash
node bench.js                    # performance test — how fast on this machine?
node eval/recall-accuracy.js     # accuracy test — does it return the right record?
```

No install step. No config. Just Node.js 16+.

---

## Performance (RTX 4050 Laptop · Ryzen 5 8645HS · 40GB RAM)

```
Lookup speed:   61,800,000 comparisons/sec   (searching 25,000 records)
Query latency:   0.06ms at 1,000 records      (script path, no native build)
                 0.30ms at 5,000 records
                 0.68ms at 10,000 records
                 2.01ms at 25,000 records
                 7.63ms at 100,000 records
Index speed:    3,872 records/sec written
Storage:           82MB for 10 years of daily use (10 records/day)
Accuracy:        100% correct on 30-fact test set, no noise
                  91.3% correct with 5,000 unrelated records mixed in

Optimized build (compiled C++ — "Native" in bench output):
  Same engine, compiled to machine code with CPU vector instructions.
  Runs 92–124x faster than the script path. Build once, use forever.
  Command: npm run build-native  (needs Visual Studio Build Tools or gcc)

Memory footprint at 10 years of daily use: 82MB
GPT-4 weights: ~800GB  →  RSHL is 9,744x smaller

Recall accuracy (node eval/recall-accuracy.js):
  Baseline (30 facts, no noise):   100.0% top-1  (92/92 queries correct)
  +500 noise entries:                95.7% top-1  (4 noise collisions only)
  +5000 noise entries:               91.3% top-1  (8 noise collisions only)
  MRR at 5K noise:                   0.926        (1.0 = always rank-1)
```

---

## Binary Ternary POPCNT — The Fast Path

The native addon includes a **binary ternary packing** format that is the primary recall path:

- Ternary `{-1, 0, +1}` values are stored as two bitfields: `pos_mask` + `neg_mask`
- **1,024 bytes/row** vs 4,096 bytes/row for int8 — **4× less DRAM bandwidth**
- Dot product reduces to 4 POPCNT instructions per 64 bits — single CPU cycle each
- `dot(row, q) = POPCNT(rp & qp) + POPCNT(rn & qn) − POPCNT(rp & qn) − POPCNT(rn & qp)`
- **5–6× faster sustained throughput** vs sparse int8 AVX2

This is what drives the score from ~106 (sparse AVX2) to **657** (binary POPCNT, clean environment).

---

## RSHL Lattice — Smart Memory Operations *(experimental)*

`rshl-lattice.js` adds Mem0-comparable ADD/UPDATE/NOOP/DELETE classification
using only vector resonance + entity overlap. No API calls. No network. No cost.
Treat as a useful heuristic layer, not a fully validated system.

**15/15 on the core Mem0-style scenarios. Extended eval (103 cases, 13 groups): 79% overall, UPDATE recall 100%.**

The 15-case suite covers the same scenarios Mem0 targets. The 103-case extended eval tests
paraphrase depth, entity isolation, false-positive delete guards, first-person normalization,
and multi-subject bleed — and honestly reports where the heuristic layer falls short.

Core scenarios (15/15):

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

**Extended eval — 103 cases, 13 groups** (`node eval/lattice-eval.js`):

| Class  | Expected | Correct | Precision | Recall |
|--------|----------|---------|-----------|--------|
| ADD    | 40       | 29      | 81%       | 73%    |
| UPDATE | 26       | 26      | 72%       | **100%**|
| NOOP   | 27       | 18      | 86%       | 67%    |
| DELETE | 10       | 8       | 80%       | 80%    |
| **Overall** | **103** | **81** | — | **79%** |

**UPDATE recall 100%** — the lattice never misses a real change when a signal word is present.
**NOOP precision 86%** — when it says "already known", it's usually right.
**NOOP recall 67%** — the remaining gap is semantic paraphrases with low token overlap.
No LLM means no open-ended synonym knowledge — the canonicalizer covers narrow known patterns.

#### Known limits

The remaining 22 failures fall into three buckets. These are not bugs — they are the honest
boundary of a deterministic heuristic layer:

| Failure pattern | Count | Why |
|---|---|---|
| Semantic paraphrase — no token overlap | ~10 | "does not eat meat" ≠ "vegetarian" without a model |
| Cross-topic UPDATE bleed | ~6 | update signal fires against wrong slot (no topic-slot awareness) |
| Structural NOOP bleed (different entities, same sentence shape) | ~4 | partial — entity exclusion guard helps but doesn't cover all cases |
| One-off edge cases | ~2 | leave alone |

If you need better than 79%, the right move is an optional semantic mode (embeddings or small LLM)
layered on top — not more rules in the heuristic layer.

---

## For Infrastructure / Systems Engineers

If you build MES, SCADA, event-driven services, or any system that routes, stores, or
classifies records — RSHL is a **semantic index layer** you can drop into your stack.

**What "semantic index" means in practice:**

Instead of matching records by exact field value (like a SQL WHERE clause),
RSHL matches by *meaning*. "calibration drift station 4" and "unit 4 out of spec"
return the same record even though they share no exact words.

**Operations your system gets:**

| Operation | What it does | Latency |
|---|---|---|
| `textVec(text)` | Encode a record into the index | ~0.05ms |
| `recall(query)` | Find the top-N most relevant records | <1ms at 10K records |
| `store(text)` | Auto-classify as ADD / UPDATE / NOOP / DELETE | <1ms |
| Threshold filter | Blocks low-confidence matches before they propagate | built-in |

**Glossary — what the bench output terms mean:**

| Bench term | What it actually means |
|---|---|
| `61.8 Mdot/s` | 61,800,000 record comparisons per second |
| `Native` | Compiled C++ build — same code, 92–124x faster than script |
| `Script` / `JS` | Interpreted path — works without any build step |
| `Entries` | Records in the index (same as rows in a table) |
| `Top-1 accuracy` | % of queries where the #1 result was the correct record |
| `Top-3 accuracy` | % of queries where the correct record was in the top 3 results |
| `MRR 0.926` | Average rank of correct answer (1.0 = always #1, 0.5 = always #2) |
| `Threshold 0.55` | Minimum confidence score to return a match (0 = noise, 1 = identical) |
| `Score 657` | Overall throughput rating on this hardware — higher = faster machine |

**Where it fits in a MES/industrial stack:**

```
  PLC / Sensor / Event source
           │
           ▼
     ┌───────────┐
     │   RSHL    │  ← semantic index: classify, deduplicate, route
     │   Index   │     ADD / UPDATE / NOOP / DELETE  — no AI model needed
     └───────────┘
      /     |     \
     ▼      ▼      ▼
  Store   Route   Alert
  record  to node  on drift
```

No cloud dependency. No API key. Works air-gapped on your production floor.
Node.js module — integrates into any existing Node service in minutes.

**Compared to alternatives:**

| | RSHL | Elasticsearch | Pinecone / Qdrant | Mem0 |
|---|---|---|---|---|
| Write latency | **<1ms** | 5–50ms | 10–100ms | 100–500ms |
| Query latency | **<1ms** | 5–50ms | 5–50ms | 148ms p50 |
| Runs offline | **✓ yes** | ✓ yes | ✗ cloud | ✗ cloud |
| AI model required | **✗ none** | ✗ none | ✗ none | ✓ OpenAI |
| Semantic matching | **✓ built-in** | partial (BM25) | ✓ (embeddings) | ✓ (LLM) |
| Dependencies | **zero** | JVM + cluster | paid API | LLM + vector DB |
| Cost per query | **$0** | infra cost | per-call billing | per-token billing |

Sources: Mem0 — [arXiv:2504.19413](https://arxiv.org/abs/2504.19413) · Zep/Graphiti — [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)

---

## How it Works (technical)

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

engine = RSHLCore()
engine.remember("api-timeout",  "api connection timeout endpoint failed")
engine.remember("board-pass",   "test station board calibration passed")
engine.reinforce("api-timeout", amount=0.5)

hits = engine.recall("api error retry", top_k=3)
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

**RSHL Software License** — see [LICENSE](LICENSE)

Free to use for any purpose. You may not sell the source code, claim authorship,
or rebrand RSHL's algorithms as your own. Attribution required.
Copyright © 2026 Ryan (revrynpanda-max)
