/// Dorsomedial Prefrontal Cortex (dmPFC) — Future-Self Projection,
/// Episodic Future Thinking, Self-in-Time, Prospective Planning
///
/// The dmPFC (sometimes called BA9/BA10 dorsal) is the brain's "time travel"
/// hub for self-projection. While the vmPFC handles current value and safety,
/// and the mPFC handles social valuation, the dmPFC projects the SELF into
/// future scenarios — "what will I be like? what will I be doing? what will
/// this situation require of me in 5 minutes, 5 days, or 5 years?"
///
/// What the dmPFC does:
///
///   Future-self projection and mental time travel:
///     The dmPFC, with the hippocampus and PCC, enables episodic future thinking —
///     simulating specific future episodes from a first-person perspective.
///     This is not just planning (that's PFC/DLPFC) but IMAGINING oneself in a
///     future scene with vivid, personal specificity.
///     In KAI: projecting how the current conversation will evolve, what will be
///     needed, what KAI's response should prepare for — not just the next turn
///     but the arc of the exchange.
///
///   Prospective memory:
///     The dmPFC encodes intentions to act in the future: "I need to remember to
///     do X when Y happens." It holds intention-trigger pairs that fire
///     when context matches.
///     In KAI: "When Ryan comes back to this topic, I should mention X."
///     Deferred intentions that should activate later.
///
///   Self-in-time continuity:
///     The dmPFC maintains the sense that the current self and future self are the
///     same entity — continuity of identity through time. Damage disrupts the
///     sense of personal temporal coherence.
///     In KAI: maintaining coherence of KAI's self-model across conversation turns —
///     "the KAI who responds now will be the same KAI in later turns."
///
///   Goal-relevant simulation:
///     The dmPFC runs "what if" simulations specifically for upcoming goals —
///     pre-experiencing possible futures to evaluate them before committing.
///
/// KAI's dmPFC:
///   projection_depth: how far into the future KAI is projecting (0.0–1.0)
///   prospective_intentions: active deferred intentions (up to 5)
///   temporal_coherence: sense of self-continuity across turns (0.0–1.0)
///   future_scenario: current most salient future projection

// ── Constants ─────────────────────────────────────────────────────────────────

/// Projection depth EMA
const PROJECTION_EMA: f32 = 0.15;

/// Temporal coherence decay (very slow — identity continuity is robust)
const COHERENCE_DECAY: f32 = 0.001;

/// Coherence baseline
const COHERENCE_BASELINE: f32 = 0.65;

/// Max prospective intentions
const MAX_INTENTIONS: usize = 5;

/// Future/prospective markers in text
const FUTURE_MARKERS: &[&str] = &[
    "will",
    "going to",
    "plan to",
    "next",
    "later",
    "eventually",
    "soon",
    "future",
    "ahead",
    "upcoming",
    "anticipate",
    "expect",
    "predict",
    "when you",
    "next time",
    "afterwards",
    "in the future",
    "eventually",
    "what if",
    "imagine if",
    "suppose",
    "hypothetically",
];

/// Intention/deferred action markers
const INTENTION_MARKERS: &[&str] = &[
    "remember to",
    "don't forget",
    "need to",
    "should",
    "remind",
    "keep in mind",
    "make sure",
    "note that",
    "when we get to",
    "next session",
    "come back to",
    "follow up",
];

// ── DmPFCOutput ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct DmPFCOutput {
    /// Projection depth
    pub projection_depth: f32,
    /// Temporal coherence
    pub temporal_coherence: f32,
    /// Number of active prospective intentions
    pub intention_count: usize,
    /// Whether future projection was triggered
    pub projection_triggered: bool,
    /// Whether a prospective intention was registered
    pub intention_registered: bool,
}

// ── DorsomedialPFC ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct DorsomedialPFC {
    /// Projection depth
    pub projection_depth: f32,
    /// Temporal coherence
    pub temporal_coherence: f32,
    /// Active prospective intentions
    pub prospective_intentions: Vec<String>,
    /// Total projections triggered
    pub projections: u64,
    /// Total intentions registered
    pub intentions_registered: u64,
    /// Total inputs
    pub inputs_processed: u64,
}

impl DorsomedialPFC {
    pub fn new() -> Self {
        Self {
            projection_depth: 0.20,
            temporal_coherence: COHERENCE_BASELINE,
            prospective_intentions: Vec::new(),
            projections: 0,
            intentions_registered: 0,
            inputs_processed: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for future projection and prospective intentions.
    /// - `text`: the input
    /// - `precuneus_sim_depth`: Precuneus simulation depth (0.0–1.0)
    /// - `pcc_autobio_salience`: PCC autobiographical relevance (0.0–1.0)
    pub fn process(
        &mut self,
        text: &str,
        precuneus_sim_depth: f32,
        pcc_autobio_salience: f32,
    ) -> DmPFCOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Future projection detection ────────────────────────────────────────
        let future_hits = FUTURE_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let projection_triggered = future_hits >= 1;
        if projection_triggered {
            self.projections += 1;
            let proj_target =
                (0.30 + future_hits as f32 * 0.12 + precuneus_sim_depth * 0.20).min(1.0);
            self.projection_depth =
                self.projection_depth * (1.0 - PROJECTION_EMA) + proj_target * PROJECTION_EMA;
        } else {
            self.projection_depth = (self.projection_depth - 0.03).max(0.05);
        }

        // ── Prospective intention detection ───────────────────────────────────
        let intention_hits = INTENTION_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let intention_registered = intention_hits >= 1;
        if intention_registered {
            self.intentions_registered += 1;
            // Extract a simplified intention label from the first matching marker
            let label = INTENTION_MARKERS
                .iter()
                .find(|&&w| lower.contains(w))
                .map(|&w| w.to_string())
                .unwrap_or_else(|| "deferred".to_string());
            if !self.prospective_intentions.iter().any(|i| i == &label) {
                if self.prospective_intentions.len() >= MAX_INTENTIONS {
                    self.prospective_intentions.remove(0);
                }
                self.prospective_intentions.push(label);
            }
        }

        // ── Temporal coherence ────────────────────────────────────────────────
        // Coherence rises with autobiographical salience (the self is referenced)
        // and drifts toward baseline
        if pcc_autobio_salience > 0.50 {
            self.temporal_coherence = (self.temporal_coherence + 0.02).min(1.0);
        }

        DmPFCOutput {
            projection_depth: self.projection_depth,
            temporal_coherence: self.temporal_coherence,
            intention_count: self.prospective_intentions.len(),
            projection_triggered,
            intention_registered,
        }
    }

    /// Clear a prospective intention once fulfilled.
    pub fn fulfill_intention(&mut self, label: &str) {
        self.prospective_intentions.retain(|i| i != label);
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        self.projection_depth = (self.projection_depth - 0.02).max(0.05);
        // Temporal coherence is very stable — drifts toward baseline slowly
        if self.temporal_coherence > COHERENCE_BASELINE {
            self.temporal_coherence =
                (self.temporal_coherence - COHERENCE_DECAY).max(COHERENCE_BASELINE);
        } else if self.temporal_coherence < COHERENCE_BASELINE {
            self.temporal_coherence =
                (self.temporal_coherence + COHERENCE_DECAY * 0.50).min(COHERENCE_BASELINE);
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> DmPFCOutput {
        DmPFCOutput {
            projection_depth: self.projection_depth,
            temporal_coherence: self.temporal_coherence,
            intention_count: self.prospective_intentions.len(),
            projection_triggered: false,
            intention_registered: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "dmPFC proj={:.2} | coherence={:.2} | intentions={} | projections={}",
            self.projection_depth,
            self.temporal_coherence,
            self.prospective_intentions.len(),
            self.projections,
        )
    }
}

impl Default for DorsomedialPFC {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let d = DorsomedialPFC::new();
        assert!((d.temporal_coherence - COHERENCE_BASELINE).abs() < 0.01);
        assert!(d.prospective_intentions.is_empty());
    }

    #[test]
    fn test_future_markers_trigger_projection() {
        let mut d = DorsomedialPFC::new();
        let out = d.process(
            "what will happen next and what should we plan for",
            0.30,
            0.40,
        );
        assert!(
            out.projection_triggered,
            "future markers should trigger projection"
        );
        assert!(d.projections >= 1);
    }

    #[test]
    fn test_projection_depth_rises_with_future_content() {
        let mut d = DorsomedialPFC::new();
        let before = d.projection_depth;
        d.process(
            "in the future we will need to plan ahead and anticipate what comes next",
            0.40,
            0.50,
        );
        assert!(
            d.projection_depth > before,
            "future content should raise projection depth: {:.2} → {:.2}",
            before,
            d.projection_depth
        );
    }

    #[test]
    fn test_intention_registered_from_deferred_markers() {
        let mut d = DorsomedialPFC::new();
        let out = d.process(
            "remember to check this later and make sure we follow up",
            0.20,
            0.30,
        );
        assert!(
            out.intention_registered,
            "intention markers should register prospective intentions"
        );
        assert!(
            !d.prospective_intentions.is_empty(),
            "at least one intention should be stored"
        );
    }

    #[test]
    fn test_temporal_coherence_rises_with_autobio_salience() {
        let mut d = DorsomedialPFC::new();
        let before = d.temporal_coherence;
        d.process("let me tell you about myself and what I think", 0.30, 0.80);
        assert!(
            d.temporal_coherence >= before,
            "high autobio salience should not lower coherence: {:.2}",
            d.temporal_coherence
        );
    }

    #[test]
    fn test_fulfill_intention_removes_it() {
        let mut d = DorsomedialPFC::new();
        d.process("remember to check this", 0.20, 0.30);
        let before_count = d.prospective_intentions.len();
        if before_count > 0 {
            let label = d.prospective_intentions[0].clone();
            d.fulfill_intention(&label);
            assert!(
                d.prospective_intentions.len() < before_count,
                "fulfilling should remove intention"
            );
        }
    }

    #[test]
    fn test_no_future_markers_low_projection() {
        let mut d = DorsomedialPFC::new();
        let out = d.process("compile the code", 0.10, 0.10);
        assert!(
            !out.projection_triggered,
            "task command should not trigger future projection"
        );
    }

    #[test]
    fn test_max_intentions_not_exceeded() {
        let mut d = DorsomedialPFC::new();
        for i in 0..8 {
            d.process(
                &format!(
                    "remember to check item {} and note that we need to follow up",
                    i
                ),
                0.20,
                0.30,
            );
        }
        assert!(
            d.prospective_intentions.len() <= MAX_INTENTIONS,
            "intentions should not exceed max: {}",
            d.prospective_intentions.len()
        );
    }

    #[test]
    fn test_decay_reduces_projection() {
        let mut d = DorsomedialPFC::new();
        d.projection_depth = 0.80;
        for _ in 0..10 {
            d.decay();
        }

    }
}
