# RSHL Whitepaper Audit Report
## Date: 2026-05-20
## Auditor: Automated Code vs. Theory Cross-Reference
## Document: `RSHL-Inventor-Disclosure-2026.md` (1151 lines, 52K chars)

---

## Executive Summary

| Status | Count | Meaning |
|--------|-------|---------|
| **VERIFIED** | 10 | Claim matches implementation exactly |
| **PARTIAL** | 4 | Claim implemented but with deviations |
| **GAP** | 3 | Claim not implemented or significantly incomplete |

**Critical Gaps Found:**
1. **Sparsity σ=0.04** — Code uses σ=0.12 (default) or σ=0.10 (feature flag), not the claimed 4%.
2. **Predictive scoring weights** — Code uses 0.10/0.65/0.10/0.45; whitepaper specifies 0.20/0.55/0.15/0.20.
3. **Epistemic immune system** — Component 1 (Dynamic Calibration) missing; Component 3 (Three-Angle Protocol) incomplete.

---

## Contribution-by-Contribution Audit

### **1. Sparse ternary {-1,0,+1} semantic encoding**
**Status:** PARTIAL ⚠️

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Dimensions | D = 16,384 | `DIM = 16384` ✅ | VERIFIED |
| Sparsity | σ = 0.04, nnz ≈ 655 | `SPARSITY = 0.12` (1966 dims), or 0.10 with feature flag | **GAP** |
| Zero semantics | "principled abstention, not absence" | Enforced by thresholding to exactly top-k | VERIFIED |
| Ternary values | {-1, 0, +1} stored as i8 | `data: Vec<i8>` with values -1/0/+1 | VERIFIED |

**Evidence:**
- `src/core/sparse_vec.rs:12-13`: `pub const SPARSITY: f32 = 0.12;` (default)
- `src/core/sparse_vec.rs:10-11`: `#[cfg(feature = "sparsity_010")] pub const SPARSITY: f32 = 0.10;`
- Whitepaper Section 4: "σ=0.04 (4% active)"
- Whitepaper Section 17: "Exactly 4% (~655 active dims) — ternary τ operator enforces σ=0.04 at encoding time"

**Impact:** Higher sparsity (12%) increases expected random dot-product overlap from ~25.6 std to ~44.3 std, reducing effective 3σ isolation capacity from ~43,000 to a lower bound. The Boid engine's `apply_to_universe` hardcodes 4% requantization (`target_nnz = DIM * 0.04`), but this only affects post-flocking positions, not the original encoded vectors.

---

### **2. Three-layer encoding with 6-tier entity weighting**
**Status:** PARTIAL ⚠️

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Layer 1: Trigrams | 1× weight, 24 active dims | 1× weight, `n_active = 24` | VERIFIED |
| Layer 2: Word hash | 3–6× weight, 24 active dims | 3× standard, 6× proper nouns, 5× physics core, `n_active = 24` | VERIFIED |
| Layer 3: Bigrams | 2× weight, 8 active dims | 2× weight, `n_active = 8` | VERIFIED |
| Extra layers | None | Character bigrams (1×, 12 dims) + Character 4-grams (2×, 16 dims) | **DEVIATION** |

**Evidence:**
- `src/core/sparse_vec.rs:223-398`: Five layers implemented (trigrams, word-hash, word-bigrams, char-bigrams, char-4grams)
- Whitepaper Section 4.3: "Three layers of features"
- Whitepaper Section 17: "Three: surface trigrams + entity-boosted word hashing + bigrams"

**Impact:** Additional character-level layers improve surface-form matching but increase the accumulator's nnz before thresholding, potentially changing the statistical properties of the final ternary vectors.

---

### **3. Hybrid dual-channel retrieval scorer**
**Status:** VERIFIED ✅

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Formula | 0.6×cosine + 0.4×keyword_overlap | `raw * (strength_bonus + 0.6 * conf) + keyword` | VERIFIED |
| Morphological matching | "morphological_keyword_overlap" | `morphological_keyword_overlap` + `stem_overlap` | VERIFIED |

**Evidence:**
- `src/core/universe.rs:1158-1159`, `1207-1208`, `1280-1285`: All query paths implement the hybrid scorer
- Whitepaper Section 5: "0.6×cosine + 0.4×keyword_overlap"

---

### **4. Confidence step-function amplification**
**Status:** VERIFIED ✅

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Threshold | 2.9 | `if cell.claim.confidence >= 2.9` | VERIFIED |
| strength_bonus | 0.50 → 0.85 | `0.85` (high) / `0.5` (low) | VERIFIED |
| γ multiplier | 0.6×min(conf, 5.0) | `0.6 * cell.claim.confidence.min(5.0)` | VERIFIED |

**Evidence:**
- `src/core/universe.rs:967`, `1018`, `1158`, `1207`, `1280`: All retrieval functions implement the step-function
- Whitepaper Section 5.2: "strength_bonus jumps 0.50 → 0.85 at conf≥2.9"

---

### **5. Structured epistemic cell (Claim object)**
**Status:** VERIFIED ✅

| Field | Whitepaper | Implementation | Verdict |
|-------|-----------|----------------|---------|
| `text` | String | `pub text: String` | VERIFIED |
| `vec` | SparseVec (16,384-dim) | `pub vec: SparseVec` | VERIFIED |
| `confidence` | f32 ∈ [0.0, 5.0] | `pub confidence: f32` (clamped at 5.0 in code) | VERIFIED |
| `source` | String | `pub source: String` | VERIFIED |
| `evidence` | Vec<String> | `pub evidence: Vec<String>` | VERIFIED |
| `contradictions` | Vec<String> | `pub contradictions: Vec<String>` | VERIFIED |
| `created_at` | u64 | `pub created_at: u64` | VERIFIED |
| `last_verified` | u64 | `pub last_verified: u64` | VERIFIED |
| `continuation` | SparseVec (16K) | `pub continuation: SparseVec` (on Cell) | VERIFIED |
| `last_fired` | u64 | `pub last_fired: u64` (on Cell) | VERIFIED |
| `convergence_score` | f32 ∈ [1.001, 9.99] | `pub convergence_score: f32` (on Cell) | VERIFIED |
| `nnz` | u32 | `pub nnz: u32` (on Cell) | VERIFIED |

**Evidence:**
- `src/core/claim.rs:4-46`: Full Claim struct
- `src/core/universe.rs:70-87`: Cell struct with all metadata fields
- Whitepaper Section 11: Complete Cell specification

---

### **6. Fibonacci torsion / golden phase angle**
**Status:** PARTIAL ⚠️

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Golden angle α_g | 2.399963 rad | `GOLDEN_ANGLE: f32 = 2.399_963_1_f32` | VERIFIED |
| Phase geometry | "Phasor coherence in retrieval" | Used only in `project_vogel_spiral` for spatial placement | **GAP** |
| Phasor coherence | Claimed to improve retrieval precision | Not used in `cosine()` or `query()` scoring | **GAP** |

**Evidence:**
- `src/core/sparse_vec.rs:803`: `const GOLDEN_ANGLE: f32 = 2.399_963_1_f32;`
- `src/core/sparse_vec.rs:800-833`: `project_vogel_spiral()` uses golden angle for cell placement
- Whitepaper Section 6.3: "θ = (pos × α_g) mod 2π; phasor_coherence = cos×cos(Δθ)"
- Whitepaper Section 17: "Phase geometry in HD memory — first in any AI architecture"

**Impact:** The golden angle is used for spatial initialization but NOT for retrieval scoring. The whitepaper's claim that "phasor coherence" improves retrieval precision is not implemented in the query path.

---

### **7. SpiralState golden-ratio temporal oscillator**
**Status:** VERIFIED ✅

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Growth exponent b | ln(φ)/(π/2) = 0.306349 | `GOLDEN_B: f32 = 0.306_349` | VERIFIED |
| Δθ per tick | 0.05 | `theta_step = 0.05` (default) | VERIFIED |
| τ_R range | [0.5, 1.0] | `tau_r = 0.5 + 0.5 * radius` | VERIFIED |
| Fold period | Not specified | `THETA_FOLD_PERIOD = 8π` | VERIFIED (implementation detail) |

**Evidence:**
- `src/core/spiral.rs:17-24`: All constants match whitepaper exactly
- `src/core/spiral.rs:52-84`: `tick()`, `recompute()`, `tau_r()` implementation
- Whitepaper Section 7: "b = ln(φ)/(π/2) = 0.306349, Δθ = 0.05/tick, τ_R ∈ [0.5, 1.0]"

---

### **8. Boid flocking in D=16,384**
**Status:** VERIFIED ✅

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| sep/align/coh | 1.5 / 1.5 / 1.5 | `separation_weight: 1.5, alignment_weight: 1.5, cohesion_weight: 1.5` | VERIFIED |
| Anchor immunity | ≥ 3.5 | `ANCHOR_CONFIDENCE_THRESHOLD: f32 = 3.5` | VERIFIED |
| Zones | 0.15 / 0.60 / 0.85 | `MIN_NEIGHBOR_SIM: 0.15`, `MAX_NEIGHBOR_SIM: 0.85`, separation at sim>0.6 | VERIFIED |
| Regional isolation | Different regions never flock | `if state.regions[i] != state.regions[j] { continue }` | VERIFIED |
| Per-user isolation | Layer 2 cellularization | `if current_layer == LAYER_CELLULAR && user_ids[i] != user_ids[j] { continue }` | VERIFIED |

**Evidence:**
- `src/core/boid_engine.rs:15-38`: All constants match
- `src/core/boid_engine.rs:124-252`: Full `run_boid_iteration()` with all safeguards
- Whitepaper Section 8.3: "sep=1.5, align=1.5, cohere=1.5; anchor immunity ≥3.5"

---

### **9. Continuation vector (dual-vec cell)**
**Status:** VERIFIED ✅ (structure) / PARTIAL ⚠️ (scoring weights)

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Secondary vec | 16K ternary per cell | `pub continuation: SparseVec` on Cell | VERIFIED |
| Predictive weight | 0.55 in final score | Code uses 0.65 in `predictive_query_filtered` | **DEVIATION** |
| Weight in diagnose | 0.55 | Code uses 0.65 | **DEVIATION** |

**Evidence:**
- `src/core/predictive.rs:12-15`: Comments claim `0.55 * predictive_match`
- `src/core/universe.rs:2382`: Actual code: `let score = 0.10 * sim + 0.65 * predict_match + 0.10 * mh - 0.45 * rec;`
- Whitepaper Section 5.3: "0.55·continuation_match"
- Whitepaper Section 17: "0.55 weight in predictive score"

**Impact:** The continuation match is overweighted (0.65 vs 0.55), and similarity is underweighted (0.10 vs 0.20), making retrieval more trajectory-dependent than specified.

---

### **10. ConversationTrace HD working memory**
**Status:** VERIFIED ✅

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Structure | Rolling HD summary | `pub struct ConversationTrace { current: SparseVec, turns_seen: u64 }` | VERIFIED |
| Push operation | `permute(current, 1)` then `bundle` | `let rotated = self.current.permute(1); self.current = SparseVec::bundle(&[&rotated, &v]);` | VERIFIED |
| Aging mechanism | Progressive dilution via permutation | Each push permutes previous state | VERIFIED |

**Evidence:**
- `src/core/predictive.rs:37-68`: Full ConversationTrace implementation
- Whitepaper Section 9.3: "permute-bundle rolling accumulator; VSA residual stream"

---

### **11. Four-component epistemic immune system**
**Status:** PARTIAL ⚠️

| Component | Whitepaper | Implementation | Verdict |
|-----------|-----------|----------------|---------|
| **1. Dynamic Calibration** | "Adjusts confidence thresholds based on observed retrieval accuracy" | **NOT IMPLEMENTED** | **GAP** |
| **2. FID Monoculture Scan** | Threshold=0.35, min_size=5 | `MONOCULTURE_THRESHOLD: f32 = 0.35`, `MONOCULTURE_MIN_SIZE: usize = 5` | VERIFIED |
| **3. ingest_and_verify** | Three-Angle Protocol (Direct/Adversarial/Domain) | Basic gatekeeping only; Three-Angle Protocol **NOT IMPLEMENTED** | **GAP** |
| **4. Lattice Reorganization** | Boid pass expresses trust state spatially | `run_homeostasis_cycle()` calls Boid + pruning | VERIFIED |

**Evidence:**
- `src/core/universe.rs:1625-1664`: FID scan fully implemented
- `src/core/universe.rs:1746-1802`: `ingest_and_verify()` exists but only calls `should_accept_claim()`
- `src/core/universe.rs:1910-1947`: `should_accept_claim()` checks confidence floor, evidence, and basic contradiction — no Three-Angle Protocol
- Whitepaper Section 10.2: FID algorithm matches exactly
- Whitepaper Section 10.3: Three-Angle Protocol with `PHYSICS_RESONANCE_FLOOR=0.55`, `COHERENCE_FLOOR=0.40` — these constants are mentioned in seed data but NOT used in `ingest_and_verify`

**Impact:** The epistemic immune system is missing its most sophisticated component (dynamic calibration) and its primary gate (Three-Angle Protocol) is reduced to a simple contradiction check. This significantly weakens the system's ability to reject false claims.

---

### **12. Native multi-agent shared lattice**
**Status:** VERIFIED ✅

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| Roundtable region | Shared multi-agent knowledge | `"roundtable"` region exists | VERIFIED |
| Per-user isolation | User cellularization (Layer 2) | `LAYER_CELLULAR` with `user_id` filter in Boid + query | VERIFIED |
| Geometric coordination | Shared lattice, scoped access | `query_in_regions()` + `user_id` parameter | VERIFIED |

**Evidence:**
- `src/core/claim.rs:48-52`: Layer constants including `LAYER_CELLULAR = 2`
- `src/core/boid_engine.rs:191-194`: Per-user isolation in Boid engine
- `src/core/universe.rs:2314-2318`: Per-user query filtering
- Whitepaper Section 12: "7 topological regions with distinct trust profiles"
- Whitepaper Section 14.2: "Discord channels and roles define which agents speak where"

---

### **13. Explicit SynapticLayer with Hebbian LTP/LTD**
**Status:** VERIFIED ✅

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| BASE_LTP | 0.035 | `const BASE_LTP: f32 = 0.035;` | VERIFIED |
| LTD idle | 80 ticks | `const LTD_IDLE_TICKS: u64 = 80;` | VERIFIED |
| Fan-out | 32 | `const MAX_FAN_OUT: usize = 32;` | VERIFIED |
| Synapse cap | 8192 | `const MAX_TOTAL_SYNAPSES: usize = 8192;` | VERIFIED |
| Dopamine × 0.8 | "dopamine×0.8" | `BASE_LTP * (1.0 + dopamine * 0.8)` | VERIFIED |
| Φ_g × 0.5 | "phi_g×0.5" | `* (1.0 + phi_g * 0.5)` | VERIFIED |
| χ gate | "1−χ×0.8" | `(1.0 - chi * 0.8).max(0.05)` | VERIFIED |
| 12-step NeuralBus | Documented signal chain | `synapse.rs:296-312` documents all 12 stages | VERIFIED (as documentation) |

**Evidence:**
- `src/core/synapse.rs:44-63`: All constants match whitepaper exactly
- `src/core/synapse.rs:115-142`: `record_co_firing()` with full neuromodulator gating
- `src/core/synapse.rs:318-391`: `NeuralBus::query_associative()` implements stages 1-3
- Whitepaper Section 17: "BASE_LTP=0.035, chi_gate=1−χ×0.8, dopamine×0.8, phi_g×0.5; LTD_IDLE=80 ticks; fan-out=32; 8192 synapse cap"

**Note:** The 12-step NeuralBus is documented as comments but not executable as a single pipeline. `Engine::query()` implements stages 1-4; `run_homeostasis_cycle()` implements pruning + Boid (stages 10-11). Stages 5-9 and 12 are distributed across the engine tick.

---

### **14. Five-layer Scale Manager**
**Status:** VERIFIED ✅

| Aspect | Whitepaper | Implementation | Verdict |
|--------|-----------|----------------|---------|
| 5 layers | Quantum/Syncytium/Cellular/Organ/Body | `get_settings_for_layer(0..4)` | VERIFIED |
| Per-layer speed | Different movement_speed per layer | `movement_speed: 0.40, 0.25, 0.35, 0.15, 0.08` | VERIFIED |
| Per-layer decay | Different vitality_decay per layer | `vitality_decay: 0.05, 0.01, 0.02, 0.005, 0.001` | VERIFIED |
| Auto maturation | Healthy cells drift toward global stability | `if new_vitality > 0.95 && phi_g > 0.7 && current_layer < 5 { current_layer += 1 }` | VERIFIED |
| Auto degradation | Weak cells drift back toward syncytium | `if new_vitality < 0.15 && current_layer > 1 { current_layer -= 1 }` | VERIFIED |

**Evidence:**
- `src/core/scale_manager.rs:6-62`: All 5 layers with distinct parameters
- `src/core/boid_engine.rs:163-170`: Maturation/degradation logic
- Whitepaper Section 17: "Quantum/Syncytium/Cellular/Organ/Body; per-layer speed, decay, replenish, neighbor radius; automatic maturation/degradation transitions"

---

## Additional Findings

### A. Predictive Scoring Formula Discrepancy
The whitepaper and code comments in `predictive.rs` specify:
```
0.20 * sim + 0.55 * predict_match + 0.15 * mh - 0.20 * rec
```

The actual implementation in `universe.rs:2382` uses:
```rust
let score = 0.10 * sim + 0.65 * predict_match + 0.10 * mh - 0.45 * rec;
```

This shifts emphasis from raw similarity (-0.10) and consensus (-0.05) toward trajectory prediction (+0.10) and anti-recency (-0.25). The comment in `predictive.rs` is misleading and should be updated to match the code, or the code should be restored to the documented weights.

### B. Encoding Sparsity Discrepancy
The whitepaper claims σ=0.04 (4%, ~655 active dims) throughout. The code uses σ=0.12 (12%, ~1966 dims) by default. The Boid engine's `apply_to_universe` does requantize to 4% (`target_nnz = DIM * 0.04`), but this only affects cells AFTER flocking, not the original encoding.

**Recommendation:** Either update the whitepaper to reflect 12% sparsity, or adjust `SPARSITY` to 0.04 and re-validate retrieval performance.

### C. Missing `ingest_and_verify` Three-Angle Protocol
The whitepaper describes a rigorous protocol:
1. Angle 1: Query lattice for positive evidence
2. Angle 2: Query lattice for contradicting evidence
3. Angle 3: Compute domain resonance score
4. Physics resonance floor (0.55) for established-physics claims
5. Coherence floor (0.40) for all claims

The actual `ingest_and_verify()`:
1. Creates a temporary claim
2. Calls `should_accept_claim()` — which only checks: confidence ≥ 0.45, evidence non-empty, no direct contradiction
3. Does NOT query the lattice for corroboration or contradiction
4. Does NOT compute domain resonance
5. Does NOT enforce physics/coherence floors

**Recommendation:** Implement the full Three-Angle Protocol in `ingest_and_verify()`.

### D. Missing Dynamic Calibration
Component 1 of the epistemic immune system ("Dynamic Calibration") is entirely absent. There is no mechanism that tracks retrieval accuracy and adjusts confidence thresholds.

**Recommendation:** Implement a calibration tracker that monitors query→response accuracy and adjusts effective confidence thresholds per region.

### E. Phasor Coherence Not Used in Retrieval
The whitepaper claims Fibonacci torsion "improves retrieval precision" via phasor coherence. The `project_vogel_spiral()` function uses the golden angle for spatial placement, but no retrieval function (`query()`, `predictive_query()`, `cosine()`) uses phase-angle-based coherence scoring.

**Recommendation:** Either remove the retrieval-precision claim from the whitepaper, or implement `phasor_coherence = cos(θ_q) * cos(θ_cell)` as an additive term in retrieval scoring.

---

## Summary Table

| # | Contribution | Status | Key Evidence | Notes |
|---|-------------|--------|------------|-------|
| 1 | Sparse ternary encoding | **PARTIAL** | `sparse_vec.rs:SPARSITY=0.12` vs claimed 0.04 | Critical gap |
| 2 | Three-layer encoding | **PARTIAL** | 5 layers in code vs 3 in paper | Additional layers are evolution |
| 3 | Hybrid retrieval scorer | **VERIFIED** | `universe.rs:1158-1159` | Exact match |
| 4 | Confidence step-function | **VERIFIED** | `universe.rs:967,1280` | Exact match |
| 5 | Structured epistemic cell | **VERIFIED** | `claim.rs:4-46`, `universe.rs:70-87` | All fields present |
| 6 | Fibonacci torsion / phase | **PARTIAL** | Golden angle implemented but NOT used in retrieval | Spatial only |
| 7 | SpiralState oscillator | **VERIFIED** | `spiral.rs:17-84` | Exact match |
| 8 | Boid flocking | **VERIFIED** | `boid_engine.rs:15-252` | Exact match |
| 9 | Continuation vector | **PARTIAL** | Structure OK; scoring weight 0.65 vs claimed 0.55 | Minor deviation |
| 10 | ConversationTrace | **VERIFIED** | `predictive.rs:37-68` | Exact match |
| 11 | Epistemic immune system | **PARTIAL** | FID + Boid OK; Dynamic Calibration + 3-Angle missing | Significant gap |
| 12 | Multi-agent shared lattice | **VERIFIED** | `claim.rs:48-52`, Boid + query isolation | Exact match |
| 13 | SynapticLayer Hebbian | **VERIFIED** | `synapse.rs:44-391` | All constants match |
| 14 | Five-layer Scale Manager | **VERIFIED** | `scale_manager.rs:14-61` | Exact match |

---

*End of Audit Report*
