# KAI — Systems Architecture Brief for Reinforcement-Learning Alignment

*Prepared so an external AI assistant can write RL scripts that match KAI's exact types, ports, and patterns. Repo root: `C:\KAI`. Crate version 9.8.7. Rust engine in `src/`, Node fleet in `tools/oracle-discord/`, Python at root.*

> **Read this first:** KAI has **two distinct ternary systems** — do not conflate them. (A) sparse ternary **VSA memory vectors** (the lattice), and (B) **BitNet-1.58 LLM weights** (the language decoder). They use different representations.

---

## 1. Ternary Implementation

### A. Sparse ternary VSA vectors — the memory/lattice core (`i8` primitives)
**File:** `src/core/sparse_vec.rs`
- Dimension `DIM = 16384`. Stored **sparsely** (only nonzeros), not as a dense buffer:
```rust
pub struct SparseVec {
    pub nz: Vec<u16>,    // sorted indices of active dimensions
    pub vals: Vec<i8>,   // parallel values, each -1 or +1 (0 = absent from nz)
    cached_norm: f32,    // sqrt(nnz)
}
```
- **Ternary values are `i8` primitives constrained to {-1, 0, +1}.** Not a custom enum, not quantized floats. Zero is implicit (an index simply isn't in `nz`).
- Core ternary ops (same file): `dot()` (sparse two-pointer merge), `cosine()`, `bind()` (element-wise multiply, self-inverse), `bundle()`/`bundle_weighted()`/`weighted_superpose()` (accumulate i32 votes → majority-vote threshold back to ±1/0), `permute()` (role binding), `hebbian_update()`.
- **Ternarization ("sign/quantize") step:** inside `encode()` — accumulate i32 votes, top-k by magnitude, emit `if v>0 {1} else {-1}`.
- Two bit-packed *mirrors* exist for fast cosine only (not the logical type): `PackedMask` (2-bit `[u8;4096]`, `00=0,01=+1,10=-1`) and `DenseMask` (`pos`/`neg` `[u64;256]` popcount).

### B. BitNet-1.58 LLM weights — 2-bit packed, zero-multiply matmul
**Files:** `src/cognition/ternary_math.rs`, `src/cognition/bitnet_brain.rs`
- Ternary weights packed **2 bits/weight** (I2_S). Decode map: `const MAP_2_BIT: [f32;4] = [-1.0, 0.0, 1.0, 0.0];`
- **Core op = BitLinear (no float multiply in the inner loop):** `bitlinear_matmul_buf()` is rayon-parallel per row, inner accumulate `sum += activation * MAP_2_BIT[code]` (add/subtract per 2-bit code).
- Quantize threshold ±0.5: `<= -0.5 -> -1`, `>= 0.5 -> +1`, else `0`.
- Weights live in `CompressedLayer { rows, cols, scale: f32, data: Vec<u8> }`; 30 transformer blocks mounted from `*.kai` files (magic `KAI2`). BitNet activations are plain f32.
- **No ReLU/GELU/sign-activation on the ternary vectors.** Only nonlinearity in the lattice path is f32 `softmax` (in `lattice_attention.rs`).

---

## 2. State & Action Space

**Hybrid: a continuous 16384-dim ternary vector substrate, but every action is discrete selection + graph update — not emitting a continuous action vector.**

- **State** = the "Universe": `Vec<Cell>` (`src/core/universe.rs`, `Cell` @ line 80). Each `Cell` holds a `Claim` whose `vec: SparseVec` is the 16384-dim pattern, plus `last_fired`, `convergence_score`, `activation_heat`, `resonance_signature`, fractal `children/parent`.
- **Tick loop** = autonomic heartbeat, NOT action-driven: `Engine::tick(is_responding)` (`src/core/engine.rs:759`) advances oscillators, computes `FieldState`, updates `Drive`, recomputes `phi_g/chi`, logs ~24 metrics to `data/kai_ticks.csv`. It does not consume an external action.
- **The "action" is in the query path:** `Engine::query()` / `query_multi_hop()`:
  1. **Candidate selection** (discrete) — geometric top-N cell retrieval (`NeuralBus::query_associative` → `universe.query_in_regions`).
  2. **Synaptic propagation** — boost associated cells.
  3. **Hebbian write (LTP)** — `record_co_firing` wires the fired set together.
- Soft/attention action: `lattice_attend()` does `softmax(cosine scores) -> weighted_superpose` (top-k=16, temperature=0.5), re-ternarized per hop.
- **So the action space = {which cells fire (ranking), which synapses strengthen}.** Dimensionality of the vector space: **16384**.

---

## 3. Language Boundaries (definitive)

**All cross-language communication is plain HTTP/REST over localhost TCP + `child_process` spawning. There is NO PyO3, NO napi-rs, NO WebAssembly, NO gRPC, NO active file-IPC.** (Confirmed: `Cargo.toml` has no pyo3/napi/tonic/axum/actix/hyper; `package.json` has no napi/neon/ffi.)

- **Rust HTTP server ("CNS"):** `src/bridge/oracle_server.rs`, **hand-rolled on `std::net::TcpListener`** (raw HTTP/1.1 string parsing — no web framework). Binds **`127.0.0.1:3334`**. Outbound HTTP uses `ureq`. Concurrency capped at 8 (429 + retry on overflow). Key routes: `/api/rshl/query`, `/api/rshl/query-multi-hop`, `/api/oracle-turn`, `/api/bulk-ingest`, `/api/rshl/store`, `/api/status`.
- **Node -> Rust:** `fetch('http://127.0.0.1:3334/api/...')` (e.g. `bots/kai.mjs`, `dashboard-server.mjs` proxy).
- **Python -> Rust:** also HTTP — `overnight_pipeline.py` posts to `http://127.0.0.1:3334/api/bulk-ingest` and `/api/oracle-turn`.
- **Node -> Python:** `child_process.spawn/execFile/execSync` of the `python` binary (e.g. `gemini-live-bridge.mjs` -> `calc_backend.py`).
- **Process supervision:** `kai.exe` (the Rust engine) is NOT a Node child — it's launched/auto-restarted by `kai_supervisor.py`. The RL/training driver `overnight_pipeline.py` talks to it purely over HTTP on 3334.

**Implication for RL scripts:** the cleanest integration is **HTTP to `:3334`** (any language). A Python RL loop posts goal/query vectors and reads back hits + field metrics — no FFI needed.

---

## 4. Existing Core Code (verbatim patterns to match)

**(a) Structs** — `sparse_vec.rs`:
```rust
#[derive(Clone, Debug)]
pub struct SparseVec { pub nz: Vec<u16>, pub vals: Vec<i8>, cached_norm: f32 }
```
`universe.rs` `Cell`: `{ label: String, region: Arc<str>, claim: Claim /* holds vec: SparseVec */, last_fired: u64, convergence_score: f32, activation_heat: f32, resonance_signature: u64, children: Vec<u32>, parent: Option<u32> }`.

**(b) Core loop** — `lattice_attention.rs::lattice_attend`:
```rust
let hits = universe.query_vec(query, ATTENTION_TOP_K);
let scores: Vec<f32> = hits.iter().map(|h| h.1).collect();
let weights = softmax(&scores, ATTENTION_TEMPERATURE);   // 0.5
let pairs = hits.iter().zip(&weights).map(|(h,&w)| (&h.0.claim.vec, w)).collect();
let attended_vec = SparseVec::weighted_superpose(&pairs, 0.0);
```

**(c) HTTP handler pattern** — `oracle_server.rs::handle_rshl_query`:
```rust
#[derive(Deserialize)]
struct QueryReq { query: String, n: Option<usize>,
    #[serde(default)] dense_vec: Option<Vec<f32>> }
let req: QueryReq = serde_json::from_slice(body)?;
let hits = /* lock universe+synaptic; */ NeuralBus::query_associative(&u, &sl, field.phi_g, &req.query, limit, &[], "");
write_json(stream, 200, "OK", &serde_json::to_value(hits).unwrap())
```
**Important hook:** `dense_vec: Option<Vec<f32>>` ("The Crusher") — an external policy can POST a **continuous f32 vector** which is projected into the 16384-dim ternary space via `SparseVec::from_dense_floats`. **This is the front door for an RL policy's output vector.**

---

## 5. Existing Reward / RL Hooks (what to plug into) + THE OPEN QUESTION

KAI already has the scalar signals an RL loop needs — you don't build reward from scratch:

- **Φ_g (`phi_g`) — THE designated reward.** `src/core/field_state.rs` (`FieldState`, ~17 metrics): `phi_g` is explicitly "Goal-aligned emergence — THE KEY METRIC." Companions for shaping: `r_val` (coherence), `s` (stability), `g` (goal alignment), `chi` (contradiction, use as penalty), `q` (novelty), `m_val` (momentum). All logged per tick to `data/kai_ticks.csv` (ready-made reward time-series).
- **Dopamine / RPE (literal reward-prediction-error):** `src/cognition/dopamine.rs` — `fire(topic, confidence, expected) -> rpe`, `rpe = (confidence - expected).clamp(-0.8, 0.8)`. `rpe` is a direct RL reward channel; `level`/`tonic` feed back into learning.
- **Hebbian write surface (the "apply gradient" analog):** `src/core/synapse.rs::record_co_firing(labels, dopamine, phi_g, chi, tick, lattice_size)`. LTP gain = `0.035 * (1 + dopamine*0.8) * (1 + phi_g*0.5) * chi_gate`. **An RL script sets `dopamine`/`phi_g` to control the learning rate directly.** Surprise-gated plasticity is already wired (`KAI_SURPRISE_GATED=1`): predictor error scales the imprint up to 2.5x — this is the existing test-time-RL hook.
- **Existing externally-computed reward:** `overnight_pipeline.py` — a cloud teacher (Groq/OpenRouter/Gemini/Ollama) grades KAI's `/api/oracle-turn` answers; that pass/fail grade is already a reward, currently consumed by re-ingestion rather than gradient updates.

**Recommended RL surface:** `reward = w1*phi_g + w2*rpe - w3*chi`; policy acts by either (a) POSTing a goal/query vector to `/api/rshl/query` `dense_vec` (the Crusher) or feeding `Drive::feed_goal`, or (b) setting `dopamine`/`phi_g`/`surprise` to steer `record_co_firing`.

### >> THE ONE THING ONLY RYAN CAN ANSWER (Section 5 of the request): the RL GOAL/TASK
The codebase gives the reward signals and the action surface, but **what task do you want the RL script to train KAI to solve right now?** Pick one so the external AI has a target:
- **(a) Language quality** — reward = grader score + coherence on `/api/oracle-turn`; train KAI to produce better-structured replies (pairs naturally with the new **word-calculus** module: reward correct operator/sentence structure).
- **(b) Emergence maximization** — reward = `phi_g`; train the drive/query policy to drive the lattice toward higher goal-aligned emergence without runaway `chi`.
- **(c) BitNet weight fine-tune** (open task #80) — distill/fine-tune the `.kai` ternary weights on KAI's own corpus using the teacher grades as reward.
- **(d) A concrete game/environment** — if you want a classic RL benchmark (gridworld, CartPole-style) mapped onto trinary logic, name it.

*Hand sections 1–4 + the reward hooks in 5 to the external AI as-is; tell it which of (a)–(d) is the target.*
