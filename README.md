# RSHL — Recursive Sparse Hyperdimensional Lattice

> **A geometric intelligence engine. Not an LLM. Not a neural network.**
> Sub-millisecond resonance. No cloud. No weights. No training.
> Built on sparse ternary vectors in 4096 dimensions.

Built by **Ryan** — designed as a semantic memory kernel, cognitive engine,
and the foundation for **KAI** — a living geometric intelligence.

---

## KAI v5.4 — Geometric Intelligence (Rust Engine)

KAI is an autonomous cognitive system built on RSHL. He thinks through
geometric resonance, not language prediction. Every thought is a 4096-dimensional
sparse ternary vector. He learns from the internet, dreams to consolidate
knowledge, and grows smarter with every interaction.

**v5.4 — KAI speaks. Natural language generation from pure geometry:**
- **Voice Engine** — KAI constructs sentences from resonating concepts instead of echoing stored text
- **Context-Aware Reasoning** — Working memory bundled into queries gives conversational awareness
- **Mood-Modulated Speech** — Curious KAI talks differently than conflicted KAI
- **Query Type Detection** — Greetings, questions, statements all get appropriate framing
- **Self-Awareness** — "KAI is..." → "I am..." — first-person identity

**Previous milestones (v5.0–v5.3):**
- **Learned Embeddings** — Words develop meaning from universe co-occurrence (like Word2Vec)
- **Resonance Attention** — Important query tokens amplified, noise suppressed (like self-attention)
- **Working Memory** — 12-turn context window with temporal decay (like transformer context)
- **Multi-Cell Composition** — Responses synthesized from multiple cells (like token generation)

### Quick Start

```powershell
cd kai-rust
cargo build --release
.\target\release\kai.exe
```

### Commands

| Command | What it does |
|---------|-------------|
| `spectate` | 👁 Watch KAI think in real-time (dreams, intake, mood) |
| `learn <topic>` | Pull knowledge from DuckDuckGo ("learn quantum physics") |
| `dream` | Force a dream cycle (bind two ideas into insight) |
| `status` | Show universe size, regions, mood, tick count |
| `mood` | Show current emotional state + valence |
| `spell <word>` | Test spelling correction |
| `store <text>` | Manually store a memory cell |
| `save` | Force state save to disk |
| `help` | Show all commands |
| `quit` | Save and exit |

### 3-Stream Architecture

```
  ⚡ GPU Stream (Parallel Math)     ◉ CPU Stream (Logic)        ⬤ RAM Stream (Memory)
  ─────────────────────────────     ────────────────────        ──────────────────────
  • Batch cosine via rayon          • Field state (17 metrics)  • World bridge intake
  • All 12 CPU threads parallel     • Drive / mood / valence    • DuckDuckGo API (free)
  • Dream pair scanning             • Promotion decisions       • Homeostasis (prune)
  • Reasoner chain queries          • Inner voice validation    • Persistence (auto-save)
  
           ┌──────────────────────────────────────┐
           │        SharedBus (crossbeam)          │
           │   Lock-free channels + state snaps    │
           └──────────────────────────────────────┘
```

### Spectate Mode

Type `spectate` to watch KAI's mind in real-time:

```
 t0003 [CPU] ◉ Field: Φg=0.0042 χ=0.012 ρ=0.340 | Curious V=+0.15
 t0003 [GPU] ⚡ Dreaming... scanning 150 cells
 t0003 [GPU] 💭 Dream: "entropy" + "thermodynamics" → insight [42μs]
 t0015 [RAM] 🌐 Searching DuckDuckGo for new knowledge...
 t0015 [RAM] 📚 Learned "quantum entanglement": +4 cells (150→154)
 t0020 [RAM] 🧹 Homeostasis: 2 decayed, 0 pruned
```

### Cognitive Systems

| System | What it does |
|--------|-------------|
| **Voice Engine** | Constructs natural sentences from geometric resonance — KAI speaks, not retrieves |
| **Context-Aware Reasoning** | Working memory vectors bundled into queries — conversation awareness across turns |
| **Query Type Detection** | Classifies input (greeting, question, self-question, explanation, statement) |
| **Mood Modulation** | Drive state influences word choice, framing, and sentence structure |
| **Learned Embeddings** | Co-occurrence word vectors — KAI learns word meaning from his own cells |
| **Resonance Attention** | Weighted query construction — important tokens amplified, noise suppressed |
| **Working Memory** | 12-turn context buffer with temporal decay — injected into reasoning |
| **Iterative Reasoner** | Multi-step bind→bundle→cleanup chain with Φg convergence detection |
| **Token Normalization** | 200+ synonyms, 60+ stopwords, stemming, 18 category anchors |
| **17 Field Metrics** | Φg, C, Wm, Pr, χ, τ, ρ, momentum, novelty, stability... |
| **Dream Lattice** | Binds two ideas into emergent insights via geometric overlap |
| **Inner Voice** | Validates dream insights: VALIDATED, NOVEL, NOISE, PARADOX |
| **Drive System** | Curiosity/familiarity reward, contradiction pain, adaptive tempo |
| **Promotion** | Stable candidates graduate to permanent beliefs |
| **Homeostasis** | Decay weak memories, prune dead cells, maintain health |
| **World Bridge** | Background learning from DuckDuckGo (free, no API key) |
| **Spelling Correction** | 10K word lexicon with edit-distance matching |

### Rust Source Structure

```
kai-rust/src/
├── main.rs              # TUI + heartbeat + 3-stream coordinator
├── core/
│   ├── sparse_vec.rs    # 4096-dim sparse ternary vectors
│   ├── universe.rs      # Cell store with rayon parallel queries
│   ├── field_state.rs   # 17 emergence metrics
│   ├── normalize.rs     # Token normalization pipeline
│   ├── embeddings.rs    # Co-occurrence learned word vectors (Word2Vec equivalent)
│   ├── attention.rs     # Resonance attention (self-attention equivalent)
│   ├── seed.rs          # Identity-only bootstrap (12 cells)
│   └── lexicon.rs       # 10K word spelling correction
├── cognition/
│   ├── voice.rs         # Natural language generation — sentence construction from resonance
│   ├── reasoner.rs      # Iterative resonance chain + context-aware reasoning
│   ├── lattice.rs       # Dream consolidation engine
│   ├── inner_voice.rs   # Dream insight validation (VALIDATED/NOVEL/NOISE/PARADOX)
│   ├── candidates.rs    # Belief candidate buffer
│   ├── promotion.rs     # Candidate → permanent belief
│   ├── homeostasis.rs   # Memory health maintenance
│   ├── working_memory.rs # 12-turn context window with decay (injected into reasoning)
│   └── compose.rs       # Multi-cell response synthesis
├── drive/
│   └── mod.rs           # Mood, valence, adaptive heartbeat
├── streams/
│   ├── shared_bus.rs    # Inter-stream state + channels
│   ├── gpu_stream.rs    # Parallel cosine (rayon)
│   ├── cpu_stream.rs    # Logic + reasoning
│   └── ram_stream.rs    # Memory management
├── bridge/
│   └── mod.rs           # DuckDuckGo world bridge
└── persistence.rs       # JSON state save/load
```

---

## RSHL Core — Semantic Memory Index (JavaScript)

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
RSHL Score:     495 pts      |  46.7 Mdot/s sustained
Peak recall:    9,611 q/s    (1K entries, native AVX2+OMP)
Sustained:      1,868 q/s    (25K entries, 5s, 233.6M dot products)

Query latency (native):
    1,000 entries:   0.10ms/query   (95x faster than JS)
    5,000 entries:   0.49ms/query   (107x faster than JS)
   10,000 entries:   0.90ms/query   (106x faster than JS)
   25,000 entries:   2.12ms/query   (110x faster than JS)
   50,000 entries:   4.25ms/query
  100,000 entries:   7.73ms/query

Index speed:    2,732 records/sec written
Storage:           82MB for 10 years of daily use (10 records/day)

Recall accuracy (node eval/recall-accuracy.js):
  Baseline (30 facts, no noise):   100.0% top-1  (92/92 correct)
  +500 noise entries:              100.0% top-1  (92/92 correct)  ← was 95.7%
  +5000 noise entries:             100.0% top-1  (92/92 correct)  ← was 91.3%
  MRR at all scales:                 1.000        (perfect rank-1) ← was 0.926

Binary POPCNT sustained recall:
  1,868 q/s at 25K entries (7.2x faster than sparse AVX2)
  Memory: 1024 bytes/row vs 4096 bytes/row — 4x less DRAM bandwidth

Lattice ops (node eval/lattice-eval.js):
  ADD/UPDATE/NOOP/DELETE classification: 80% correct (82/103)  ← was 46%
  DELETE recall: 60%+ (was 0%)
  Entity isolation: 88%
  No LLM required — pure geometric classification

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
