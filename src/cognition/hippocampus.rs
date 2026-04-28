use crate::core::{SparseVec, Universe};
/// Hippocampus — Pattern Completion, Pattern Separation, Consolidation Indexing
///
/// The hippocampus is the brain's rapid-binding memory system. It does not
/// store long-term memories permanently — it coordinates them. Three circuits:
///
///   CA3 (pattern completion):
///     Given a partial or degraded cue, reconstruct the full stored pattern.
///     "You remember the smell → CA3 completes the whole memory."
///     This is autoassociative: a pattern can recall itself from a fragment.
///
///   CA1 + Dentate Gyrus (pattern separation):
///     Distinguish similar inputs as distinct memories.
///     "Yesterday's conversation vs. today's — even if the topic was the same."
///     DG orthogonalizes similar inputs so CA3 doesn't confuse them.
///
///   Indexing role:
///     The hippocampus acts as a fast index to neocortical representations.
///     It doesn't hold content — it holds pointers and binding cues.
///     During sleep it replays to consolidate indexed patterns into cortex.
///
/// Without Hippocampus:
///   KAI can only recall what's literally stored in the universe.
///   No inference from partial cues. No gap-filling. No consolidation signals.
///   Two very similar concepts cause retrieval confusion.
///
/// With Hippocampus:
///   When a query partially matches a stored pattern, KAI can complete it
///   and surface concepts that weren't in the top query hits.
///   When two hits are suspiciously similar, pattern separation flags them —
///   preventing KAI from conflating distinct but related ideas.
///   Consolidation queue tells the sleep system what to replay first.
///
/// Architecture:
///   pattern_store — CA3 autoassociative bank (HippocampalPattern entries)
///   recent_patterns — CA1 short-term comparison buffer (deque, capped at 12)
///   pending_consolidations — flagged for sleep-phase replay
///   separation_threshold — cosine above which two patterns risk confusion
use std::collections::VecDeque;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum patterns stored in the CA3 autoassociative bank
const CA3_CAPACITY: usize = 256;

/// CA1 recent-pattern buffer size (for separation comparisons)
const CA1_BUFFER: usize = 12;

/// Cosine threshold above which two patterns risk being confused (separation alarm)
const SEPARATION_THRESHOLD: f32 = 0.82;

/// Minimum pattern strength for completion to fire
const COMPLETION_MIN_STRENGTH: f32 = 0.30;

/// Strength decrement per access (retrieval gradually weakens unless reinforced)
const RETRIEVAL_DECAY: f32 = 0.005;

/// Passive strength decay per tick interval
const PASSIVE_DECAY: f32 = 0.002;

// ── Data types ────────────────────────────────────────────────────────────────

/// A single stored memory pattern in the CA3 bank
#[derive(Debug, Clone)]
pub struct HippocampalPattern {
    /// The canonical text of this pattern
    pub text: String,
    /// Alias for `text`.
    pub label: String,
    /// Encoded sparse vector
    pub vec: SparseVec,
    /// Consolidation strength (0.0–1.0), decays with time, rises with replay
    pub strength: f32,
    /// Tick when this pattern was last accessed
    pub last_accessed: u64,
    /// Total access count
    pub access_count: u32,
    /// Whether this pattern is flagged for sleep consolidation
    pub flagged: bool,
    /// How many consolidation cycles this pattern has survived without promoting.
    /// Gate 3: must survive ≥ 2 cycles before promotion is allowed (unless emotional fast-track).
    pub survival_count: u32,
    /// Universe region this pattern should be stored into when promoted.
    /// Preserved from the original input so consolidation doesn't guess.
    pub region: String,
    /// Source tag for the promoted Universe cell ("conversation", "ryan", etc.)
    pub source: String,
    /// Amygdala charge at storage time — used for emotional fast-track decision.
    /// High charge (≥ 0.60) waives the survival_count gate.
    pub emotional_charge: f32,
}

/// Result of a pattern completion attempt
#[derive(Debug, Clone)]
pub struct CompletionResult {
    /// The text of the completed/matched pattern
    pub completed_text: String,
    /// How strongly it matched the query (0.0–1.0)
    pub confidence: f32,
    /// True if this filled a genuine gap vs. just confirming a top hit
    pub filled_gap: bool,
}

/// Result of pattern separation check
#[derive(Debug, Clone)]
pub struct SeparationResult {
    /// Interference risk between the two patterns (0=distinct, 1=identical)
    pub interference: f32,
    /// True if these patterns are dangerously similar (should be distinguished)
    pub needs_separation: bool,
    /// Short label for the type of confusion risk
    pub risk_type: &'static str,
}

// ── Hippocampus ───────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Hippocampus {
    /// CA3: autoassociative pattern bank
    pattern_store: Vec<HippocampalPattern>,
    /// CA1: recent patterns for separation comparisons
    recent_patterns: VecDeque<(String, SparseVec)>,
    /// Pending consolidation queue (text, salience) — for sleep system
    pending_consolidations: Vec<(String, f32)>,
    /// Cosine similarity threshold for pattern separation alarm
    pub separation_threshold: f32,
    /// Total pattern completions run
    pub completions_run: u64,
    /// Total separations checked
    pub separations_run: u64,
    /// Total patterns flagged for consolidation
    pub consolidations_flagged: u64,
    /// Total patterns successfully promoted into Universe
    pub consolidations_promoted: u64,
    /// Current tick (for last_accessed tracking)
    pub tick: u64,
}

impl Hippocampus {
    pub fn new() -> Self {
        Self {
            pattern_store: Vec::with_capacity(CA3_CAPACITY),
            recent_patterns: VecDeque::with_capacity(CA1_BUFFER),
            pending_consolidations: Vec::new(),
            separation_threshold: SEPARATION_THRESHOLD,
            completions_run: 0,
            separations_run: 0,
            consolidations_flagged: 0,
            consolidations_promoted: 0,
            tick: 0,
        }
    }

    // ── Storage ───────────────────────────────────────────────────────────────

    /// Store a new pattern in the CA3 bank.
    /// If the pattern already exists (high cosine match), reinforce it instead.
    /// If the bank is full, evict the weakest pattern.
    ///
    /// `region` and `source` are preserved so consolidation can promote into
    /// the correct Universe region without guessing from content.
    /// `emotional_charge` (0.0–1.0) enables the emotional fast-track gate.
    pub fn store(
        &mut self,
        text: &str,
        initial_strength: f32,
        region: &str,
        source: &str,
        emotional_charge: f32,
    ) {
        let vec = SparseVec::encode(text);

        // Check if it already exists (high cosine = same pattern)
        let existing = self
            .pattern_store
            .iter_mut()
            .find(|p| p.vec.cosine(&vec) > 0.90);

        if let Some(pattern) = existing {
            // Reinforce existing pattern — higher charge keeps it stronger
            pattern.strength = (pattern.strength + 0.08).min(1.0);
            pattern.emotional_charge = pattern.emotional_charge.max(emotional_charge);
            pattern.access_count += 1;
            pattern.last_accessed = self.tick;
            return;
        }

        // Evict weakest if at capacity
        if self.pattern_store.len() >= CA3_CAPACITY {
            if let Some(min_idx) = self
                .pattern_store
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    a.strength
                        .partial_cmp(&b.strength)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i)
            {
                self.pattern_store.remove(min_idx);
            }
        }

        self.pattern_store.push(HippocampalPattern {
            text: text.to_string(),
            label: text.to_string(),
            vec,
            strength: initial_strength.clamp(0.0, 1.0),
            last_accessed: self.tick,
            access_count: 1,
            flagged: false,
            survival_count: 0,
            region: region.to_string(),
            source: source.to_string(),
            emotional_charge: emotional_charge.clamp(0.0, 1.0),
        });
    }

    // ── CA3: Pattern completion ───────────────────────────────────────────────

    /// Attempt pattern completion: given a query vector, find the best matching
    /// stored pattern. Returns Some(CompletionResult) if a strong enough match
    /// exists, None if no pattern is close enough to complete from.
    ///
    /// The `top_hit_score` parameter is the best score already found in the
    /// main universe query — used to determine if this is genuinely filling
    /// a gap (low score) or just confirming what was already found.
    pub fn complete(&mut self, query: &str, top_hit_score: f32) -> Option<CompletionResult> {
        if self.pattern_store.is_empty() {
            return None;
        }

        let query_vec = SparseVec::encode(query);

        // Find best matching pattern above minimum strength
        let best = self
            .pattern_store
            .iter_mut()
            .filter(|p| p.strength >= COMPLETION_MIN_STRENGTH)
            .max_by(|a, b| {
                let sa = a.vec.cosine(&query_vec);
                let sb = b.vec.cosine(&query_vec);
                sa.partial_cmp(&sb).unwrap_or(std::cmp::Ordering::Equal)
            });

        if let Some(pattern) = best {
            let sim = pattern.vec.cosine(&query_vec);

            // Completion fires only when match is meaningful
            if sim < 0.25 {
                return None;
            }

            // Check if this is genuinely filling a gap
            let filled_gap = top_hit_score < 0.40 && sim > 0.35;

            // Access decay — retrieval without reinforcement slightly weakens
            pattern.strength = (pattern.strength - RETRIEVAL_DECAY).max(0.0);
            pattern.access_count += 1;
            pattern.last_accessed = self.tick;

            // Update CA1 buffer with this access
            let text = pattern.label.clone();
            let vec = pattern.vec.clone();
            if self.recent_patterns.len() >= CA1_BUFFER {
                self.recent_patterns.pop_front();
            }
            self.recent_patterns.push_back((text.clone(), vec));

            self.completions_run += 1;

            Some(CompletionResult {
                completed_text: text,
                confidence: sim * pattern.strength,
                filled_gap,
            })
        } else {
            None
        }
    }

    // ── DG / CA1: Pattern separation ─────────────────────────────────────────

    /// Check whether two memory patterns are dangerously similar (confusion risk).
    /// High interference → the hippocampus should orthogonalize / distinguish them.
    /// In KAI this means flagging that the voice should disambiguate.
    pub fn separate(&mut self, text_a: &str, text_b: &str) -> SeparationResult {
        self.separations_run += 1;

        let va = SparseVec::encode(text_a);
        let vb = SparseVec::encode(text_b);
        let interference = va.cosine(&vb);

        let needs_separation = interference > self.separation_threshold;

        let risk_type = match interference {
            i if i > 0.95 => "near-duplicate",
            i if i > 0.88 => "high-overlap",
            i if i > 0.82 => "semantic-blur",
            _ => "distinct",
        };

        SeparationResult {
            interference,
            needs_separation,
            risk_type,
        }
    }

    // ── Consolidation ─────────────────────────────────────────────────────────

    /// Flag a pattern for sleep-phase consolidation.
    /// High-salience or frequently-accessed patterns should be consolidated
    /// into neocortical (universe) semantic memory during sleep.
    pub fn flag_for_consolidation(&mut self, text: &str, salience: f32) {
        // Only flag if not already pending
        if !self.pending_consolidations.iter().any(|(t, _)| t == text) {
            self.pending_consolidations
                .push((text.to_string(), salience));
            self.consolidations_flagged += 1;

            // Also mark the stored pattern if it exists
            if let Some(p) = self.pattern_store.iter_mut().find(|p| p.label == text) {
                p.flagged = true;
            }
        }
    }

    /// Drain the pending consolidation queue (called by sleep system).
    /// Returns the list sorted by salience descending.
    pub fn drain_consolidations(&mut self) -> Vec<(String, f32)> {
        let mut queue = std::mem::take(&mut self.pending_consolidations);
        queue.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        // Clear flagged marks
        for p in &mut self.pattern_store {
            p.flagged = false;
        }
        queue
    }

    /// Reinforce a pattern post-consolidation (called after sleep completes it).
    pub fn reinforce(&mut self, text: &str, delta: f32) {
        if let Some(p) = self.pattern_store.iter_mut().find(|p| p.label == text) {
            p.strength = (p.strength + delta).min(1.0);
        }
    }

    // ── Consolidation into Universe ───────────────────────────────────────────

    /// Promote hippocampal traces into long-term semantic memory (Universe).
    ///
    /// Called every 50 ticks alongside hippocampus.decay().
    /// `coherence` is the spiral field's tau_r — suppresses consolidation
    /// when KAI is in a fragmented state (< 0.35), mirrors biological
    /// stress-impaired consolidation.
    ///
    /// Three gates per design:
    ///   Gate 1 — strength threshold (0.55 neutral / 0.45 emotional)
    ///   Gate 2 — novelty: boosted cosine > 0.65 in Universe = already known
    ///   Gate 3 — survival_count >= 2 (waived for emotional fast-track ≥ 0.60)
    ///
    /// Promoted traces are REMOVED from the hippocampus — they've graduated.
    /// Near-duplicate traces reinforce the existing Universe cell instead.
    ///
    /// Returns (promoted, reinforced) counts for the spectate log.
    pub fn consolidate_into_universe(
        &mut self,
        universe: &mut Universe,
        coherence: f32,
    ) -> (usize, usize) {
        // Spiral coherence gate — fragmented state impairs consolidation
        if coherence < 0.35 {
            return (0, 0);
        }

        let mut promoted = 0usize;
        let mut reinforced = 0usize;

        // Collect decisions first (immutable pass) then apply mutations.
        // This avoids holding any &Cell references while mutating universe.
        #[derive(Debug)]
        enum Decision {
            Promote,
            Reinforce,
            Wait,
        }

        let decisions: Vec<(usize, Decision)> = self
            .pattern_store
            .iter_mut()
            .enumerate()
            .map(|(idx, pattern)| {
                // Gate 1 — strength threshold
                let threshold = if pattern.emotional_charge >= 0.60 {
                    0.45
                } else {
                    0.55
                };
                if pattern.strength < threshold {
                    pattern.survival_count += 1;
                    return (idx, Decision::Wait);
                }

                // Gate 3 — survival count (waived for emotional fast-track)
                let fast_track = pattern.emotional_charge >= 0.60;
                if !fast_track && pattern.survival_count < 2 {
                    pattern.survival_count += 1;
                    return (idx, Decision::Wait);
                }

                // Gate 2 — novelty: pull boosted score from Universe query
                // Drop the Vec immediately so no &Cell borrows linger.
                let top_score: f32 = {
                    let hits = universe.query_vec(&pattern.vec, 1);
                    hits.first().map(|(_, s)| *s).unwrap_or(0.0)
                };

                if top_score > 0.65 {
                    (idx, Decision::Reinforce)
                } else {
                    (idx, Decision::Promote)
                }
            })
            .collect();

        // Apply mutations and collect indices to remove (highest-first for stable removal)
        let mut to_remove: Vec<usize> = Vec::new();
        for (idx, decision) in &decisions {
            let pattern = &self.pattern_store[*idx];
            match decision {
                Decision::Reinforce => {
                    universe.reinforce_by_text(&pattern.label, 0.10);
                    reinforced += 1;
                    to_remove.push(*idx);
                }
                Decision::Promote => {
                    let entry_strength = if pattern.emotional_charge >= 0.40 {
                        pattern.strength
                    } else {
                        pattern.strength * 0.85
                    };
                    universe.store(
                        &pattern.label,
                        &pattern.region,
                        &pattern.source,
                        entry_strength,
                    );
                    promoted += 1;
                    to_remove.push(*idx);
                }
                Decision::Wait => {}
            }
        }

        // Remove in reverse index order so earlier indices stay valid
        to_remove.sort_unstable_by(|a, b| b.cmp(a));
        for idx in to_remove {
            self.pattern_store.remove(idx);
        }

        self.consolidations_promoted += promoted as u64;
        (promoted, reinforced)
    }

    // ── Maintenance ───────────────────────────────────────────────────────────

    /// Passive decay — call periodically (every N ticks).
    /// Patterns that are never accessed gradually weaken.
    pub fn decay(&mut self) {
        self.tick += 1;
        for p in &mut self.pattern_store {
            let age = self.tick.saturating_sub(p.last_accessed);
            if age > 100 {
                p.strength = (p.strength - PASSIVE_DECAY).max(0.0);
            }
        }
        // Prune patterns that have decayed to zero
        self.pattern_store.retain(|p| p.strength > 0.01);
    }

    /// How many patterns are currently stored
    pub fn pattern_count(&self) -> usize {
        self.pattern_store.len()
    }

    /// Brief status for the brain monitor display
    pub fn status_line(&self) -> String {
        format!(
            "HIPP {} patterns | completions={} separations={} promoted={} pending={}",
            self.pattern_store.len(),
            self.completions_run,
            self.separations_run,
            self.consolidations_promoted,
            self.pending_consolidations.len(),
        )
    }
}

impl Default for Hippocampus {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_store_and_count() {
        let mut h = Hippocampus::new();
        h.store(
            "consciousness arises from recursive self-reference",
            0.8,
            "memory",
            "conversation",
            0.0,
        );
        h.store(
            "RSHL geometry uses ternary hyperdimensional vectors",
            0.7,
            "memory",
            "conversation",
            0.0,
        );
        assert_eq!(h.pattern_count(), 2);
    }

    #[test]
    fn test_store_reinforces_duplicate() {
        let mut h = Hippocampus::new();
        let text = "recursive self-reference is key to consciousness";
        h.store(text, 0.5, "memory", "conversation", 0.0);
        let before = h.pattern_store[0].strength;
        h.store(text, 0.5, "memory", "conversation", 0.0); // re-store same text
        let after = h.pattern_store[0].strength;
        // Should reinforce (same count) not add duplicate
        assert_eq!(
            h.pattern_count(),
            1,
            "should not duplicate near-identical patterns"
        );
        assert!(after > before, "re-storing should reinforce strength");
    }

    #[test]
    fn test_completion_fires_on_match() {
        let mut h = Hippocampus::new();
        let stored = "consciousness is the hard problem of subjective experience";
        h.store(stored, 0.9, "memory", "conversation", 0.0);
        // Query with strong word overlap — RSHL is sparse so we need shared vocab
        let result = h.complete("consciousness hard problem subjective experience", 0.20);
        assert!(
            result.is_some(),
            "should complete from query with strong vocabulary overlap"
        );
        let r = result.unwrap();
        assert!(
            r.confidence > 0.0,
            "completion confidence should be positive"
        );
    }

    #[test]
    fn test_completion_returns_none_for_empty_store() {
        let mut h = Hippocampus::new();
        let result = h.complete("something random", 0.10);
        assert!(result.is_none(), "empty store should return None");
    }

    #[test]
    fn test_filled_gap_flag() {
        let mut h = Hippocampus::new();
        h.store(
            "RSHL sparse ternary vectors enable geometric reasoning",
            0.8,
            "memory",
            "conversation",
            0.0,
        );
        // Low top_hit_score simulates a knowledge gap
        let result = h.complete("RSHL geometry vectors", 0.15);
        if let Some(r) = result {
            if r.confidence > 0.3 {
                assert!(r.filled_gap, "low top_hit_score should set filled_gap=true");
            }
        }
    }

    #[test]
    fn test_pattern_separation_distinct() {
        let mut h = Hippocampus::new();
        let result = h.separate(
            "consciousness arises from integration of information",
            "RSHL uses sparse ternary hyperdimensional vectors for geometric reasoning",
        );
        assert!(
            !result.needs_separation,
            "very different texts should not need separation"
        );
        assert!(
            result.interference < 0.82,
            "interference should be low for distinct concepts"
        );
    }

    #[test]
    fn test_pattern_separation_similar() {
        let mut h = Hippocampus::new();
        // Two very similar phrases
        let result = h.separate(
            "consciousness is the hard problem of subjective experience",
            "consciousness is the hard problem of subjective experience and qualia",
        );
        // High overlap — should flag separation need
        assert!(
            result.interference > 0.70,
            "very similar texts should have high interference"
        );
    }

    #[test]
    fn test_consolidation_queue() {
        let mut h = Hippocampus::new();
        h.flag_for_consolidation("consciousness and self-reference", 0.8);
        h.flag_for_consolidation("RSHL geometry core concepts", 0.6);
        assert_eq!(h.consolidations_flagged, 2);
        let queue = h.drain_consolidations();
        assert_eq!(queue.len(), 2);
        // Should be sorted by salience descending
        assert!(
            queue[0].1 >= queue[1].1,
            "consolidation queue should be sorted by salience"
        );
        // Queue should be empty after drain
        assert!(h.drain_consolidations().is_empty());
    }

    #[test]
    fn test_no_duplicate_consolidation() {
        let mut h = Hippocampus::new();
        h.flag_for_consolidation("memory consolidation test", 0.7);
        h.flag_for_consolidation("memory consolidation test", 0.9); // duplicate
                                                                    // Should only have 1 pending
        let queue = h.drain_consolidations();
        assert_eq!(
            queue.len(),
            1,
            "should not add duplicate consolidation entries"
        );
    }

    #[test]
    fn test_decay_prunes_weak_patterns() {
        let mut h = Hippocampus::new();
        h.store(
            "this will decay away soon",
            0.015,
            "memory",
            "conversation",
            0.0,
        ); // very weak
           // Advance tick well past age threshold
        h.tick = 200;
        for _ in 0..10 {
            h.decay();
        }
        // Pattern should have been pruned
        assert_eq!(
            h.pattern_count(),
            0,
            "very weak old pattern should be pruned by decay"
        );
    }

    #[test]
    fn test_reinforce_after_consolidation() {
        let mut h = Hippocampus::new();
        let text = "reinforcement testing pattern";
        h.store(text, 0.5, "memory", "conversation", 0.0);
        let before = h.pattern_store[0].strength;
        h.reinforce(text, 0.2);
        let after = h.pattern_store[0].strength;
        assert!(after > before, "reinforce should increase pattern strength");
    }

    #[test]
    fn test_status_line() {
        let h = Hippocampus::new();
        let s = h.status_line();
        assert!(s.contains("HIPP"), "status line should mention HIPP");
    }
}
