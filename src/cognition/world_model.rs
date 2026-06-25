//! World Model — a VSA-native state→action→next-state predictor.
//!
//! This is the piece that turns KAI from an *associative memory* into an
//! *internal simulator*. A classic world model answers: "given the current
//! state and an action, what state comes next?" Transformers learn this with
//! gradient descent over learned weights. KAI does it NATIVELY in its own
//! lattice paradigm — no gradients, no learned weight matrices.
//!
//! HOW IT WORKS (honest framing — this is HDC/VSA, not a trained net):
//!   * Every cell may carry an optional `continuation: Option<SparseVec>` — a
//!     predicted "what tends to follow this" vector (already in universe.rs).
//!   * `predict_next` retrieves the cells nearest the current `state`, gathers
//!     their continuation vectors, weights each by cosine(state, cell), bundles
//!     them (a VSA superposition), then BINDS the action vector so the
//!     prediction is action-conditioned, and re-sparsifies + normalizes.
//!   * `observe_transition` closes a prediction-error loop: it predicts, scores
//!     1 − cosine(predicted, actual), and nudges the relevant continuation
//!     vectors TOWARD the actual next-state — strengthening good predictors and
//!     correcting bad ones. Bounded + re-sparsified so nothing explodes.
//!
//! ALL OF THIS IS ADDITIVE + FLAG-GATED. With `KAI_WORLDMODEL` unset the engine
//! is byte-for-byte unchanged: continuation population on ingest is skipped and
//! none of these functions are wired into the default path.

use crate::core::sparse_vec::SPARSITY;
use crate::core::synapse::SynapticLayer;
use crate::core::{SparseVec, Universe};
use std::sync::Mutex;

/// Permutation seed used to project the *action* into a distinct role-space
/// before binding it onto the bundled continuations. Mirrors the `permute(1)`
/// convention already used by `Universe::bind_sequence` for the input role, so
/// action-conditioning lives in the same structural sub-space the lattice
/// already reserves for "what fired before".
const ACTION_ROLE_SEED: u32 = 1;

/// Configuration for the world model. Read from env via `from_env`.
/// Every field has a conservative default; the MASTER gate `enabled` is OFF
/// unless `KAI_WORLDMODEL=1`, so the default engine behaviour is unchanged.
#[derive(Clone, Debug)]
pub struct WorldModelConfig {
    /// Master gate. `KAI_WORLDMODEL=1` → ON. Default OFF.
    pub enabled: bool,
    /// Continuation blend retention on ingest/online update (`KAI_WM_RETAIN`,
    /// default 0.7). The OLD continuation keeps this weight, the NEW evidence
    /// gets `1 - retain`, so continuations accumulate rather than overwrite.
    pub retain: f32,
    /// Transition learning rate for `observe_transition` (`KAI_WM_LR`,
    /// default 0.1). How hard a continuation is nudged toward the actual
    /// next-state. Kept small + bounded.
    pub lr: f32,
    /// Neighbours to gather around the state (`KAI_WM_TOPK`, default 8).
    pub topk: usize,
    /// Max entries in the content-addressable transition KV memory
    /// (`KAI_WM_MEM_CAP`, default 4096). Bounded — least-hit entry is evicted
    /// when full so the store never grows without limit.
    pub mem_cap: usize,
    /// Cosine threshold for treating a query key as a hit against a stored key
    /// (`KAI_WM_KEY_MATCH`, default 0.9). Above this, `observe_transition`
    /// BLENDS into the existing value and `predict_next` RETURNS the stored
    /// full next-state; below it we insert (write) / fall back (read).
    pub key_match: f32,
}

impl Default for WorldModelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            retain: 0.7,
            lr: 0.1,
            topk: 8,
            mem_cap: 4096,
            key_match: 0.9,
        }
    }
}

impl WorldModelConfig {
    /// Build a config from environment variables. Master gate defaults OFF.
    pub fn from_env() -> Self {
        let enabled = std::env::var("KAI_WORLDMODEL")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let retain = std::env::var("KAI_WM_RETAIN")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .map(|v| v.clamp(0.0, 0.99))
            .unwrap_or(0.7);
        let lr = std::env::var("KAI_WM_LR")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .map(|v| v.clamp(0.0, 1.0))
            .unwrap_or(0.1);
        let topk = std::env::var("KAI_WM_TOPK")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .map(|v| v.clamp(1, 64))
            .unwrap_or(8);
        let mem_cap = std::env::var("KAI_WM_MEM_CAP")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .map(|v| v.clamp(16, 1 << 20))
            .unwrap_or(4096);
        let key_match = std::env::var("KAI_WM_KEY_MATCH")
            .ok()
            .and_then(|v| v.parse::<f32>().ok())
            .map(|v| v.clamp(0.0, 1.0))
            .unwrap_or(0.9);
        Self {
            enabled,
            retain,
            lr,
            topk,
            mem_cap,
            key_match,
        }
    }

    /// Whether the world model is active. Convenience for call sites.
    #[inline]
    pub fn is_active(&self) -> bool {
        self.enabled
    }
}

// ── Transition KV memory (content-addressable episodic store) ────────────────
//
// THE CEILING FIX. The continuation mechanism stores transitions via
// bind/unbind, which only recovers the index-overlap (~SPARSITY of dims) of the
// target, so prediction cosine caps low (~0.27). Here we add a parallel,
// content-addressable transition store that keeps the FULL `actual_next` vector
// as a value, keyed by a stable composite of (state, action). On predict we find
// the nearest stored key by cosine and, if it clears `key_match`, return its
// stored value WHOLE — so we recover (nearly) the entire target and the cosine
// climbs far past the bind/unbind ceiling. Disambiguation is by key: distinct
// (state, action) pairs land on distinct keys → distinct stored next-states.
//
// Bounded: capped at `cfg.mem_cap`, least-hit entry evicted on overflow. Lives
// behind the `KAI_WORLDMODEL` gate (callers only invoke when `cfg.enabled`).

/// One learned transition: composite key → full next-state value.
#[derive(Clone, Debug)]
struct TransitionEntry {
    key: SparseVec,
    value: SparseVec,
    hits: u32,
}

/// Process-global transition memory. A `Mutex<Vec<..>>` keeps the additive
/// store out of the existing `predict_next`/`observe_transition` signatures
/// (which the bench already calls) while staying bounded + thread-safe. The
/// Universe does not own world-model episodic state, so this is the least
/// invasive home for it.
static TRANSITION_MEM: Mutex<Vec<TransitionEntry>> = Mutex::new(Vec::new());

/// Composite (state, action) → key. Stable + deterministic: bind the action into
/// its role sub-space (matching `ACTION_ROLE_SEED`) and superpose it with the
/// state so both contribute to addressing. Distinct (state, action) pairs map to
/// distinct keys, which is what lets the store disambiguate rather than memorize
/// a single transition. With an empty action the key is the state itself.
fn transition_key(state: &SparseVec, action: &SparseVec) -> SparseVec {
    if action.nnz() == 0 {
        return SparseVec::superpose_sparse(&[state], SPARSITY);
    }
    let role = action.permute(ACTION_ROLE_SEED);
    let bound = state.bind(&role);
    // Superpose state + (state⊛action) so the key is sensitive to BOTH the state
    // identity and the action, re-sparsified to the lattice's native density.
    SparseVec::superpose_sparse(&[state, &bound], SPARSITY)
}

/// Find the index of the stored entry whose key is nearest `key`, with its
/// cosine. Returns `None` when the store is empty.
fn nearest_entry(mem: &[TransitionEntry], key: &SparseVec) -> Option<(usize, f32)> {
    let mut best: Option<(usize, f32)> = None;
    for (i, e) in mem.iter().enumerate() {
        let c = key.cosine(&e.key);
        match best {
            Some((_, bc)) if c <= bc => {}
            _ => best = Some((i, c)),
        }
    }
    best
}

/// Insert a fresh transition, evicting the least-hit entry when at capacity.
fn insert_transition(mem: &mut Vec<TransitionEntry>, key: SparseVec, value: SparseVec, cap: usize) {
    if mem.len() >= cap.max(1) {
        // Evict least-hit (ties → lowest index): cheap LFU bound.
        if let Some((evict_idx, _)) = mem
            .iter()
            .enumerate()
            .map(|(i, e)| (i, e.hits))
            .min_by_key(|(_, h)| *h)
        {
            mem.swap_remove(evict_idx);
        }
    }
    mem.push(TransitionEntry { key, value, hits: 1 });
}

/// Test-only: clear the global store so seeded benches/tests start cold.
#[doc(hidden)]
pub fn reset_transition_memory() {
    if let Ok(mut mem) = TRANSITION_MEM.lock() {
        mem.clear();
    }
}

/// Predict the next latent state from the current `state` + an `action`
/// embedding, NATIVE to the lattice.
///
/// Procedure:
///   (a) retrieve the cells nearest `state` via `universe.query_vec`;
///   (b) gather their `continuation` vectors (those that have one), weighting
///       each by cosine(state, cell) AND — when a `synapses` layer is supplied
///       — by any pre→post synaptic weight from the state's best-matching cell
///       to that neighbour (associative one-step prior);
///   (c) UNBIND the permuted action key from each continuation to recover the
///       action-conditioned next-state direction (the inverse of how
///       `observe_transition` stores it — ternary bind is self-inverse);
///   (d) `bundle_weighted` those recovered vectors into a single superposition;
///   (e) re-sparsify to `SPARSITY` (`superpose_sparse`) + normalize.
///
/// Fallback chain when no continuations exist near the state:
///   1. if `synapses` is supplied, follow the strongest pre→post edge from the
///      nearest cell to a neighbour and return that neighbour's vector
///      (synapse-graph one-step propagation);
///   2. otherwise return `state` itself (identity — "nothing changes").
///
/// Deterministic + cheap. `synapses` is `Option` so callers without a synaptic
/// layer (the Universe does not own one) can still use the continuation path.
pub fn predict_next(
    state: &SparseVec,
    action: &SparseVec,
    universe: &Universe,
    cfg: &WorldModelConfig,
    synapses: Option<&SynapticLayer>,
) -> SparseVec {
    if state.nnz() == 0 {
        return state.clone();
    }

    // ── PRIMARY: content-addressable transition KV lookup ───────────────────
    // Form the composite (state, action) key, find the nearest stored key by
    // cosine; if it clears `key_match`, return the stored FULL next-state. This
    // recovers (nearly) the whole target — well past the bind/unbind ceiling —
    // and disambiguates distinct (state, action) pairs by key.
    {
        let key = transition_key(state, action);
        if let Ok(mut mem) = TRANSITION_MEM.lock() {
            if let Some((idx, cos)) = nearest_entry(&mem, &key) {
                if cos >= cfg.key_match {
                    mem[idx].hits = mem[idx].hits.saturating_add(1);
                    return mem[idx].value.clone();
                }
            }
        }
    }

    let topk = cfg.topk.max(1);
    let neighbours = universe.query_vec(state, topk);
    if neighbours.is_empty() {
        return state.clone();
    }

    // The closest cell is the anchor "pre" node for synaptic weighting.
    let pre_label: &str = &neighbours[0].0.label;

    // (b) gather continuation vectors + weights.
    let mut conts: Vec<SparseVec> = Vec::with_capacity(topk);
    let mut weights: Vec<f32> = Vec::with_capacity(topk);
    for (cell, cos) in &neighbours {
        if let Some(cont) = &cell.continuation {
            if cont.nnz() == 0 {
                continue;
            }
            // Base weight: similarity of the state to this cell (clamp ≥ 0).
            let mut w = cos.max(0.0);
            // Bonus: synaptic pre→post weight (associative prior), if available.
            if let Some(syn) = synapses {
                let sw = syn.weight(pre_label, &cell.label);
                if sw > 0.0 {
                    w += sw * 0.5;
                }
            }
            if w > 0.0 {
                conts.push(cont.clone());
                weights.push(w);
            }
        }
    }

    if conts.is_empty() {
        // ── Fallback 1: synapse-graph one-step propagation ──────────────────
        if let Some(syn) = synapses {
            let strongest = syn.strongest_from(pre_label, 1);
            if let Some(edge) = strongest.first() {
                let post = edge.post_label.as_ref();
                if let Some(cell) = universe.get_cell_by_label(post) {
                    return cell.claim.vec.clone();
                }
            }
        }
        // ── Fallback 2: identity — nothing predicted, state persists ────────
        return state.clone();
    }

    // (c)+(d) UNBIND the action from each continuation, THEN bundle.
    //
    // CONVENTION (must match `observe_transition` exactly): a cell stores its
    // continuation as `next_state` BOUND with the permuted action key —
    //     continuation = next_state ⊛ permute(action, ACTION_ROLE_SEED)
    // Binding in ternary VSA is self-inverse, so to *read* the next-state back
    // we unbind with the SAME key:
    //     recovered_next = continuation ⊛ permute(action, ACTION_ROLE_SEED)
    // This is the invertible action-conditioning the old code was missing: the
    // old path SUPERPOSED action mass into the prediction on the read side but
    // never bound it on the write side, so the stored signal and the prediction
    // lived in different sub-spaces → cosine collapsed. Now read and write use
    // one consistent, exactly-invertible key.
    let action_key = if action.nnz() == 0 {
        None
    } else {
        Some(action.permute(ACTION_ROLE_SEED))
    };
    let recovered: Vec<SparseVec> = conts
        .iter()
        .map(|c| match &action_key {
            Some(k) => c.unbind(k),
            None => c.clone(),
        })
        .collect();
    let refs: Vec<&SparseVec> = recovered.iter().collect();
    let bundled = SparseVec::bundle_weighted(&refs, &weights);

    // (e) re-sparsify to the lattice's native density + normalize. The cached
    // norm is recomputed inside superpose_sparse, so the result is a valid,
    // bounded SparseVec ready to be compared/stored.
    SparseVec::superpose_sparse(&[&bundled], SPARSITY)
}

/// Online continuation update for a single cell vector (VSA blend).
///
/// `old` keeps weight `retain`, `new_evidence` gets `1 - retain`, then the
/// result is re-sparsified to `SPARSITY`. This is the accumulation rule used
/// both by ingest population and by the Hebbian transition update — so a
/// continuation *averages* over everything that has followed a state rather
/// than being overwritten by the most recent observation.
pub fn blend_continuation(old: &SparseVec, new_evidence: &SparseVec, retain: f32) -> SparseVec {
    if old.nnz() == 0 {
        return new_evidence.clone();
    }
    if new_evidence.nnz() == 0 {
        return old.clone();
    }
    let r = retain.clamp(0.0, 0.99);
    let blended = SparseVec::weighted_superpose(&[(old, r), (new_evidence, 1.0 - r)], 0.0);
    SparseVec::superpose_sparse(&[&blended], SPARSITY)
}

/// Observe a real transition and close the prediction-error loop with a
/// bounded, VSA-native Hebbian update on continuation vectors.
///
/// Steps:
///   1. predict the next state from `prev_state` + `action`;
///   2. measure `error = 1 − cosine(predicted, actual_next)` (the SAME metric
///      the PredictiveEngine uses — surface it so it can feed curiosity/amygdala);
///   3. for the cells nearest `prev_state`, nudge each `continuation` TOWARD
///      `actual_next` with strength `lr * error * cosine(prev_state, cell)` —
///      strengthen predictors that were close, correct the ones that were off,
///      and barely touch cells that weren't really involved.
///
/// Returns the prediction error in [0, 1]. NO-OP (returns 0.0) when the world
/// model is gated OFF, so this is safe to call unconditionally.
pub fn observe_transition(
    prev_state: &SparseVec,
    action: &SparseVec,
    actual_next: &SparseVec,
    universe: &mut Universe,
    cfg: &WorldModelConfig,
) -> f32 {
    if !cfg.enabled || prev_state.nnz() == 0 || actual_next.nnz() == 0 {
        return 0.0;
    }

    // 1 + 2: predict, then measure error (the SAME metric the bench reads).
    let predicted = predict_next(prev_state, action, universe, cfg, None);
    let sim = predicted.cosine(actual_next);
    let error = (1.0 - sim).clamp(0.0, 1.0);

    // ── PRIMARY WRITE: store the FULL next-state in the transition KV memory ──
    // key = composite(prev_state, action); value = actual_next stored WHOLE (not
    // bound/unbound). If a near-duplicate key already exists (cosine > key_match)
    // BLEND its value toward actual_next (bounded, retain-weighted) and bump
    // hits; else INSERT a new entry (evicting least-hit when at cap). This is the
    // path that lifts the prediction ceiling — predict_next reads these values
    // back whole.
    {
        let key = transition_key(prev_state, action);
        if let Ok(mut mem) = TRANSITION_MEM.lock() {
            let matched = nearest_entry(&mem, &key).filter(|(_, c)| *c >= cfg.key_match);
            match matched {
                Some((idx, _)) => {
                    let blended = blend_continuation(&mem[idx].value, actual_next, cfg.retain);
                    mem[idx].value = blended;
                    mem[idx].hits = mem[idx].hits.saturating_add(1);
                }
                None => insert_transition(&mut mem, key, actual_next.clone(), cfg.mem_cap),
            }
        }
    }

    // BIND the learning target into the SAME action sub-space `predict_next`
    // reads from. We store `actual_next ⊛ permute(action)` so that, on the next
    // prediction, `continuation ⊛ permute(action)` recovers `actual_next`
    // exactly (ternary bind is self-inverse). This is the consistent,
    // invertible action convention that makes learning actually help: what we
    // write is precisely what predict_next reads back. With an empty action the
    // target is `actual_next` itself (cold path, still consistent).
    let bound_target = if action.nnz() == 0 {
        actual_next.clone()
    } else {
        let action_key = action.permute(ACTION_ROLE_SEED);
        actual_next.bind(&action_key)
    };

    // 3: bounded delta-rule nudge of the nearest cells' continuations.
    // Gather targets first (immutable borrow), then apply (mutable borrow).
    let topk = cfg.topk.max(1);
    let neighbours = universe.query_vec(prev_state, topk);
    let mut updates: Vec<(String, f32)> = Vec::with_capacity(topk);
    for (cell, cos) in &neighbours {
        let c = cos.max(0.0);
        if c <= 0.0 {
            continue;
        }
        // Delta-rule step size: pull harder toward the (bound) target for cells
        // that match the state well. NOTE the step is gated by `c` only, NOT by
        // `error` — gating by error would shrink the step as we converge and
        // stall short of the target. A constant per-pass fraction `lr*c` makes
        // the continuation geometrically approach `bound_target` over repeated
        // calls (retain^k → 0), i.e. monotone convergence toward actual_next.
        let strength = (cfg.lr * c).clamp(0.0, 0.5);
        if strength > 0.0 {
            updates.push((cell.label.clone(), strength));
        }
    }

    if updates.is_empty() {
        return error;
    }

    for cell in universe.cells_mut().iter_mut() {
        if let Some((_, strength)) = updates.iter().find(|(lbl, _)| lbl == &cell.label) {
            // retain = 1 - strength: small strength → mostly keep the old
            // continuation, large strength (close match) → pull harder toward
            // the bound target. Bounded so a single step can never wipe state
            // and repeated steps converge rather than oscillate (strength ≤ 0.5).
            let retain = (1.0 - *strength).clamp(0.5, 0.99);
            let old = cell
                .continuation
                .take()
                .unwrap_or_else(SparseVec::zero);
            cell.continuation = Some(blend_continuation(&old, &bound_target, retain));
        }
    }

    error
}

/// Populate the PRIOR cell's `continuation` toward the NEXT cell's vector.
///
/// Called from the ingest path (universe.rs) ONLY when `cfg.enabled`. The
/// caller is responsible for the sequential-linking rule (same source/
/// conversation, adjacent in time) — this fn just performs the bounded online
/// blend on whichever cell index it is handed, so the policy stays in the
/// ingest site and this stays a pure mechanism.
///
/// `prior_idx` is the index of the cell that should learn "what follows me";
/// `next_vec` is the vector of the cell that came immediately after it.
pub fn link_continuation(
    universe: &mut Universe,
    prior_idx: usize,
    next_vec: &SparseVec,
    cfg: &WorldModelConfig,
) -> bool {
    if !cfg.enabled || next_vec.nnz() == 0 {
        return false;
    }
    let cells = universe.cells_mut();
    if prior_idx >= cells.len() {
        return false;
    }
    let cell = &mut cells[prior_idx];
    let old = cell.continuation.take().unwrap_or_else(SparseVec::zero);
    cell.continuation = Some(blend_continuation(&old, next_vec, cfg.retain));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_off() {
        let cfg = WorldModelConfig::default();
        assert!(!cfg.enabled, "world model must default OFF");
        assert!(!cfg.is_active());
        assert!((cfg.retain - 0.7).abs() < 1e-6);
        assert!((cfg.lr - 0.1).abs() < 1e-6);
        assert_eq!(cfg.topk, 8);
    }

    #[test]
    fn blend_into_empty_takes_new() {
        let new = SparseVec::encode("the sun rises in the east each morning");
        let out = blend_continuation(&SparseVec::zero(), &new, 0.7);
        assert!(out.cosine(&new) > 0.5, "blend into empty should adopt the new vector");
    }

    #[test]
    fn blend_accumulates_toward_both() {
        let a = SparseVec::encode("apples grow on trees in the orchard");
        let b = SparseVec::encode("apples are a sweet and crunchy fruit");
        let blended = blend_continuation(&a, &b, 0.7);
        // The blend should retain meaningful similarity to the dominant (old) vector.
        assert!(blended.cosine(&a) > blended.cosine(&b) * 0.5,
            "retain=0.7 should keep the blend closer to the old vector");
        assert!(blended.nnz() > 0);
    }

    #[test]
    fn predict_identity_when_no_continuations() {
        // Empty universe → no neighbours → identity fallback returns state.
        let uni = Universe::new();
        let cfg = WorldModelConfig { enabled: true, ..Default::default() };
        let state = SparseVec::encode("a state with no neighbours in an empty lattice");
        let action = SparseVec::zero();
        let pred = predict_next(&state, &action, &uni, &cfg, None);
        assert!(pred.cosine(&state) > 0.99, "no-neighbour fallback should be identity");
    }

    #[test]
    fn kv_memory_recovers_full_target_and_disambiguates() {
        reset_transition_memory();
        let mut uni = Universe::new();
        let cfg = WorldModelConfig { enabled: true, ..Default::default() };
        // Two distinct states, two distinct independent targets, shared action.
        let s1 = SparseVec::encode("a first distinct origin state vector here");
        let s2 = SparseVec::encode("an entirely different second origin state");
        let n1 = SparseVec::encode("target one totally unrelated to its origin");
        let n2 = SparseVec::encode("target two also unrelated to its own origin");
        let action = SparseVec::encode("advance one step");
        uni.store_with_vec("s1", "memory", "bench", 3.0, s1.clone());
        uni.store_with_vec("s2", "memory", "bench", 3.0, s2.clone());
        for _ in 0..3 {
            observe_transition(&s1, &action, &n1, &mut uni, &cfg);
            observe_transition(&s2, &action, &n2, &mut uni, &cfg);
        }
        let p1 = predict_next(&s1, &action, &uni, &cfg, None);
        let p2 = predict_next(&s2, &action, &uni, &cfg, None);
        // Full target recovered (≫ 0.27 bind/unbind ceiling) and disambiguated.
        assert!(p1.cosine(&n1) > 0.8, "KV should return ~the full target n1");
        assert!(p2.cosine(&n2) > 0.8, "KV should return ~the full target n2");
        assert!(p1.cosine(&n1) > p1.cosine(&n2), "key must disambiguate s1→n1");
        reset_transition_memory();
    }

    #[test]
    fn observe_transition_noop_when_gated_off() {
        let mut uni = Universe::new();
        let cfg = WorldModelConfig::default(); // OFF
        let s = SparseVec::encode("previous state vector");
        let a = SparseVec::zero();
        let n = SparseVec::encode("actual next state vector");
        let err = observe_transition(&s, &a, &n, &mut uni, &cfg);
        assert_eq!(err, 0.0, "gated-off observe_transition must be a no-op");
    }
}
