//! RSHL feedback binding: instant, retrain-free correction memory.
//!
//! Ported from Ryan's old KAI 2.0
//! (`kai-tray-starter-v6/kernel/jarvis_cognitive_kernel/kai_unified/rshl_feedback.py`
//! + `rshl_core.py`). The original idea: when KAI gives a WRONG answer and the
//! user supplies a correction ("here's why the right answer is X"), you
//! `bind(wrong_answer ⊕ why_correct)` into sparse ternary memory so the
//! correction becomes instantly recallable on a future similar probe — WITHOUT
//! any retraining or overnight pipeline pass.
//!
//! Old Python (rshl_core.RSHLCore):
//!   - `_ternary(text)`         -> a sparse ternary vector  (here: SparseVec::encode)
//!   - `bind_xor(a, b)`         -> signed-XOR proxy = element-wise product
//!                                 (here: SparseVec::bind — element-wise multiply,
//!                                  which IS the ternary bind/XOR over {-1,0,+1})
//!   - `resonance(probe)`       -> cosine over stored cells  (here: SparseVec::cosine)
//!   - `remember` / `superpose` -> Hebbian merge of probe vectors
//! Old Python (rshl_feedback.RSHLFeedbackStore):
//!   - `record_correction(wrong, why)` binds `wrong ⊕ why` into a keyed cell
//!   - `resonance_hint(query)`        cosine-ranks stored cells, returns best > threshold
//!
//! This Rust port keeps the SAME math on the CURRENT engine's `SparseVec`:
//!   bind_correction stores BOTH the bound (wrong ⊕ why) vector AND a `probe`
//!   vector (encode(wrong) — what a future wrong-ish query will look like) so a
//!   matching query can cosine-recall the stored `why_correct` text. Unbinding
//!   the bound vector with the probe (`bound.bind(probe)`, since ternary bind is
//!   self-inverse here) reconstructs the `why` support — exactly the old
//!   `bind_xor`/recall round-trip.
//!
//! Pattern mirrors `word_calculus.rs`: pure-std core (no I/O, no globals beyond
//! the flag), fully unit-tested (`cargo test rshl_feedback`), and OFF by default
//! (`RSHL_FEEDBACK`) so it cannot touch any live generation path until a caller
//! explicitly enables it AND wires it in.

use std::sync::atomic::{AtomicBool, Ordering};

use crate::core::sparse_vec::SparseVec;

/// Master switch. OFF by default — enable via `set_enabled(true)` only after
/// `cargo test rshl_feedback` passes and you deliberately want it live.
/// Nothing in the engine reads this yet; it exists so wiring stays opt-in.
pub static RSHL_FEEDBACK: AtomicBool = AtomicBool::new(false);
pub fn enabled() -> bool {
    RSHL_FEEDBACK.load(Ordering::Relaxed)
}
pub fn set_enabled(on: bool) {
    RSHL_FEEDBACK.store(on, Ordering::Relaxed);
}

/// Minimum cosine for a stored correction to be considered a match on recall.
/// Mirrors the old `resonance_hint` gate (`best[1] < 0.42 -> ""`). A query must
/// resemble the original wrong answer / topic this strongly to fire.
pub const RECALL_THRESHOLD: f32 = 0.42;

/// One bound correction. `probe` is `encode(wrong)` — the cue a future query is
/// matched against; `bound` is the ternary bind of (wrong ⊕ why_correct) — the
/// retrain-free correction trace (old `bind_xor`). `why` is the human-readable
/// correction returned on recall; `wrong` is kept for inspection/audit.
#[derive(Clone, Debug)]
pub struct Correction {
    pub wrong: String,
    pub why: String,
    pub probe: SparseVec,
    pub bound: SparseVec,
}

/// In-memory RSHL correction store. Pure data + ternary math — no persistence
/// (the old Python's JSON load/save is intentionally dropped; a caller can layer
/// it on without touching this core). Holds bound (wrong ⊕ correct) vectors keyed
/// implicitly by their topic-bearing `probe` vector.
#[derive(Default)]
pub struct FeedbackStore {
    corrections: Vec<Correction>,
}

impl FeedbackStore {
    pub fn new() -> Self {
        Self { corrections: Vec::new() }
    }

    /// Number of stored corrections.
    pub fn len(&self) -> usize {
        self.corrections.len()
    }
    pub fn is_empty(&self) -> bool {
        self.corrections.is_empty()
    }

    /// Bind a correction: `bind(wrong ⊕ why_correct)` into ternary memory so the
    /// correction is instantly recallable, no retraining. Mirrors the old
    /// `RSHLFeedbackStore.record_correction` -> `_bind_one`:
    ///   wv = encode(wrong); yv = encode(why); bound = bind_xor(wv, yv).
    /// We also retain `wv` as the recall probe so a similar future query lands on
    /// this cell. Empty inputs are ignored (matches the old `need both` guard).
    pub fn bind_correction(&mut self, wrong: &str, why_correct: &str) {
        let wrong = wrong.trim();
        let why = why_correct.trim();
        if wrong.is_empty() || why.is_empty() {
            return;
        }
        let wv = SparseVec::encode(wrong);
        let yv = SparseVec::encode(why);
        // Ternary bind == element-wise multiply == the signed-XOR proxy the old
        // `bind_xor` used. `SparseVec::bind` is the current engine's name for it.
        let bound = wv.bind(&yv);
        self.corrections.push(Correction {
            wrong: wrong.to_string(),
            why: why.to_string(),
            probe: wv,
            bound,
        });
    }

    /// Recall the best-matching correction for a query. Cosine-ranks the query
    /// against every stored `probe` (the original wrong answer / topic) and
    /// returns the corresponding `why_correct` text if the best match clears
    /// `RECALL_THRESHOLD`. Returns `None` when nothing matches — mirrors the old
    /// `resonance_hint` (`best[1] < 0.42 -> ""`).
    pub fn recall_correction(&self, query: &str) -> Option<String> {
        let q = query.trim();
        if q.is_empty() || self.corrections.is_empty() {
            return None;
        }
        let qv = SparseVec::encode(q);
        let mut best: Option<(f32, &Correction)> = None;
        for c in &self.corrections {
            let sim = qv.cosine(&c.probe);
            match best {
                Some((bs, _)) if sim <= bs => {}
                _ => best = Some((sim, c)),
            }
        }
        match best {
            Some((sim, c)) if sim >= RECALL_THRESHOLD => Some(c.why.clone()),
            _ => None,
        }
    }

    /// Reconstruct the `why` support vector by unbinding the stored bound trace
    /// with the probe: `bound.bind(probe)`. Ternary element-wise bind is
    /// self-inverse over {-1, 0, +1} on the shared support, so this recovers the
    /// `encode(why)` pattern (within the bound trace's surviving support). This is
    /// the old `bind_xor` round-trip, kept so callers can verify the binding math
    /// rather than only trusting the probe-cosine path.
    pub fn unbind_why(&self, idx: usize) -> Option<SparseVec> {
        let c = self.corrections.get(idx)?;
        Some(c.bound.bind(&c.probe))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_off_by_default() {
        // Mirrors word_calculus: the feature must ship OFF.
        assert!(!enabled(), "RSHL_FEEDBACK must default to OFF");
    }

    #[test]
    fn bound_correction_is_recalled_for_matching_query() {
        let mut store = FeedbackStore::new();
        // KAI answered the capital of Australia wrong; user corrects.
        store.bind_correction(
            "the capital of Australia is Sydney",
            "the capital of Australia is Canberra not Sydney",
        );
        assert_eq!(store.len(), 1);

        // A future query on the same topic should recall the correction.
        let got = store.recall_correction("what is the capital of Australia");
        assert!(
            got.is_some(),
            "a matching topic query must recall the bound correction"
        );
        assert!(
            got.unwrap().contains("Canberra"),
            "recalled correction should carry the corrected fact"
        );
    }

    #[test]
    fn non_matching_query_returns_none() {
        let mut store = FeedbackStore::new();
        store.bind_correction(
            "the capital of Australia is Sydney",
            "the capital of Australia is Canberra not Sydney",
        );

        // An unrelated query must NOT trigger the stored correction.
        let got = store.recall_correction("chocolate cake baking recipe");
        assert!(
            got.is_none(),
            "an unrelated query must not recall any correction, got {:?}",
            got
        );
    }

    #[test]
    fn empty_inputs_are_ignored() {
        let mut store = FeedbackStore::new();
        store.bind_correction("", "something");
        store.bind_correction("something", "   ");
        assert!(store.is_empty(), "empty wrong/why pairs must be skipped");
        assert!(store.recall_correction("anything at all").is_none());
        assert!(store.recall_correction("").is_none());
    }

    #[test]
    fn best_of_several_corrections_wins() {
        let mut store = FeedbackStore::new();
        store.bind_correction(
            "Ryan lives in Dallas",
            "Ryan actually lives in Austin Texas",
        );
        store.bind_correction(
            "water boils at 50 degrees celsius",
            "water boils at 100 degrees celsius at sea level",
        );
        assert_eq!(store.len(), 2);

        // Query about the boiling point should retrieve the temperature fact,
        // not the location fact.
        let got = store
            .recall_correction("at what temperature does water boil")
            .expect("boiling-point query should recall a correction");
        assert!(
            got.contains("100"),
            "should recall the boiling-point correction, got: {got}"
        );
    }

    #[test]
    fn unbind_recovers_why_support() {
        // The bind/unbind round-trip: bound = wrong ⊕ why; bound ⊕ wrong ≈ why
        // on the shared ternary support. Recovered support must resemble
        // encode(why) far more than an unrelated vector.
        let mut store = FeedbackStore::new();
        let why = "the capital of Australia is Canberra not Sydney";
        store.bind_correction("the capital of Australia is Sydney", why);

        let recovered = store.unbind_why(0).expect("correction 0 exists");
        let why_vec = SparseVec::encode(why);
        let unrelated = SparseVec::encode("quantum chromodynamics field theory");

        let sim_why = recovered.cosine(&why_vec);
        let sim_unrelated = recovered.cosine(&unrelated);
        assert!(
            sim_why > sim_unrelated,
            "unbound support should resemble why ({sim_why:.4}) more than unrelated ({sim_unrelated:.4})"
        );
    }

    #[test]
    fn enable_disable_toggles_flag() {
        // Don't leave the global flipped for other tests in the suite.
        let prev = enabled();
        set_enabled(true);
        assert!(enabled());
        set_enabled(false);
        assert!(!enabled());
        set_enabled(prev);
    }
}
