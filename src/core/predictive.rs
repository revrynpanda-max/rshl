//! Predictive RSHL — sequence-aware retrieval built on pure sparse ternary VSA.
//!
//! Maps to the 2025 research on VSA-transformer equivalence
//! (Dhayalkar 2025, arXiv:2512.14709 — "Attention as Binding"):
//!   - queries/keys = role-space projections via `permute(seed)`
//!   - attention weights = soft unbinding via cosine
//!   - superposition = `bundle`
//!   - iterative layers = repeated refinement passes in `predictive_query`
//!   - next-state binding = `Cell.continuation` accumulation
//!
//! Final score for each cell:
//!     0.20 * similarity(refined_state, cell.vec)
//!   + 0.55 * predictive_match(trace, cell.continuation)
//!   + 0.15 * multi_head_consensus(refined_state, cell.vec)
//!   - 0.20 * recency_penalty(cell.last_fired)
//! Continuation binding dominates raw similarity so retrieval prefers
//! cells that actually fit the conversation flow, not cells that merely
//! look like the input.
use super::SparseVec;

/// Number of parallel permutation "heads" used by multi-head consensus.
pub const DEFAULT_HEADS: usize = 4;

/// Minimum iteration depth enforced by `predictive_query`.
pub const DEFAULT_ITER_STEPS: usize = 8;

/// Recency decay window (in dialogue turns). Widened from 6 to 12 so the
/// -0.45 recency penalty has time to bite before a small cell pool (e.g.
/// the 4 warmed greeting cells) rotates back into the top of the ranking.
pub const RECENCY_WINDOW: u64 = 12;

/// Rolling hyperdimensional summary of the recent conversation.
///
/// Every `push` permutes the existing trace by seed=1 (positional role)
/// and bundles the new turn on top. The resulting vector is KAI's
/// working-memory hypervector — the residual stream analog.
#[derive(Clone, Debug)]
pub struct ConversationTrace {
    pub current: SparseVec,
    pub turns_seen: u64,
}

impl ConversationTrace {
    pub fn new() -> Self {
        Self {
            current: SparseVec::zero(),
            turns_seen: 0,
        }
    }

    pub fn push(&mut self, text: &str, _role: &str) {
        let v = SparseVec::encode(text);
        let rotated = self.current.permute(1);
        self.current = SparseVec::bundle(&[&rotated, &v]);
        self.turns_seen = self.turns_seen.saturating_add(1);
    }

    pub fn reset(&mut self) {
        self.current = SparseVec::zero();
        self.turns_seen = 0;
    }
}

impl Default for ConversationTrace {
    fn default() -> Self {
        Self::new()
    }
}

/// Multi-head permutation consensus.
///
/// Each head views the query through a different seeded permutation
/// (the VSA "role projection" the 2025 paper describes). A cell that
/// aligns with the query across many heads has high consensus; one that
/// only aligns via a single quirky view does not.
pub fn multi_head_consensus(query: &SparseVec, cell: &SparseVec, heads: usize) -> f32 {
    if heads == 0 {
        return 0.0;
    }
    let mut sum = 0.0f32;
    for k in 1..=heads {
        let qh = query.permute(k as u32);
        sum += qh.cosine(cell).clamp(-1.0, 1.0).max(0.0);
    }
    sum / heads as f32
}

/// Linear time-decay recency penalty.
/// `last_fired == 0` is the "never fired" sentinel.
pub fn recency_penalty(current_tick: u64, last_fired: u64, window: u64) -> f32 {
    if last_fired == 0 || current_tick < last_fired {
        return 0.0;
    }
    let delta = current_tick - last_fired;
    if delta >= window {
        0.0
    } else {
        1.0 - (delta as f32 / window as f32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_head_consensus_nonneg_and_bounded() {
        let a = SparseVec::encode("hey");
        let b = SparseVec::encode("hello");
        let s = multi_head_consensus(&a, &b, DEFAULT_HEADS);
        assert!((0.0..=1.0).contains(&s));
    }

    #[test]
    fn permute_is_deterministic() {
        let v = SparseVec::encode("hey");
        assert_eq!(v.permute(7).data, v.permute(7).data);
    }

    #[test]
    fn permute_inv_undoes_permute() {
        let v = SparseVec::encode("hello world");
        let back = v.permute(42).permute_inv(42);
        assert_eq!(v.data, back.data);
    }

    #[test]
    fn recency_penalty_decays() {
        assert!((recency_penalty(10, 10, 6) - 1.0).abs() < 1e-4);
        assert!(recency_penalty(16, 10, 6).abs() < 1e-4);
        assert_eq!(recency_penalty(10, 0, 6), 0.0);
    }

    #[test]
    fn trace_changes_after_push() {

    }
}
