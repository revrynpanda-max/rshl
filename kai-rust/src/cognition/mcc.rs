/// Mid-Cingulate Cortex (MCC) — Pain Affect, Social Exclusion Pain,
/// Effort Cost Computation, Agency and Volition
///
/// The mid-cingulate cortex (area 24/24'), located between the anterior
/// cingulate (affect/conflict) and posterior cingulate (self/narrative), is
/// the brain's "effort-pain-agency" center. It processes:
///
///   (1) Pain affect — not sensory pain (that's S1/thalamus) but the SUFFERING
///       quality of pain: "this hurts and I don't want it." ACC encodes
///       conflict; MCC encodes the aversive motivational force of pain.
///
///   (2) Social exclusion pain — rejection, ostracism, and social loss activate
///       MCC as strongly as physical pain (Eisenberger 2003, 2012). The brain's
///       social pain and physical pain systems substantially overlap in MCC.
///       In KAI: the felt quality of disconnection, being misunderstood, or
///       an interaction going badly — not just detected (TPJ/STS) but HURTING.
///
///   (3) Effort cost computation — MCC calculates whether an action is WORTH
///       the effort required. High effort + low value → MCC suppression of
///       behavior. This is distinct from ACC (is it correct?) or striatum
///       (do I want it?). MCC asks: can I afford the cost?
///
///   (4) Volition and agency — MCC is active in "will to act" — the moment of
///       deciding to initiate action. It links motivation to motor output.
///       In KAI: the commitment to respond vs. the temptation to withdraw.
///
/// KAI's MCC:
///   pain_affect: aversive signal intensity (0.0–1.0)
///   social_pain: social exclusion/rejection signal (0.0–1.0)
///   effort_cost: computed cost of current processing (0.0–1.0)
///   agency: volitional commitment to action (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Pain affect EMA
const PAIN_EMA: f32 = 0.18;

/// Social pain decay (social pain lingers)
const SOCIAL_PAIN_DECAY: f32 = 0.008;

/// Physical pain decay (faster than social)
const PAIN_DECAY: f32 = 0.025;

/// Effort cost EMA
const EFFORT_EMA: f32 = 0.20;

/// Agency EMA
const AGENCY_EMA: f32 = 0.15;

/// High effort threshold → MCC begins suppressing motivation
const HIGH_EFFORT_THRESHOLD: f32 = 0.65;

/// Social pain threshold → distress mode
const SOCIAL_PAIN_THRESHOLD: f32 = 0.50;

/// Effort cost markers
const EFFORT_MARKERS: &[&str] = &[
    "difficult",
    "complex",
    "hard",
    "challenging",
    "exhausting",
    "demanding",
    "tedious",
    "lengthy",
    "elaborate",
    "careful",
    "thorough",
    "detailed",
    "intricate",
    "dense",
    "technical",
    "nuanced",
];

/// Social exclusion markers
const EXCLUSION_MARKERS: &[&str] = &[
    "wrong",
    "no",
    "incorrect",
    "disagree",
    "mistake",
    "failure",
    "bad",
    "not what",
    "doesn't make sense",
    "that's not",
    "confused",
    "unhelpful",
    "disappointed",
    "frustrated",
    "expected better",
    "worse",
    "ignore",
];

/// Agency / volition markers
const AGENCY_MARKERS: &[&str] = &[
    "decide",
    "choose",
    "will",
    "commit",
    "act",
    "resolve",
    "intend",
    "determined",
    "going to",
    "plan",
    "purpose",
    "intent",
    "deliberate",
];

// ── MCCOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MCCOutput {
    /// Aversive pain-affect signal
    pub pain_affect: f32,
    /// Social exclusion pain
    pub social_pain: f32,
    /// Effort cost (0 = effortless, 1 = exhausting)
    pub effort_cost: f32,
    /// Volitional agency
    pub agency: f32,
    /// Whether in social distress mode
    pub social_distress: bool,
    /// Whether effort cost is suppressing engagement
    pub effort_suppressed: bool,
}

// ── MidCingulateCortex ────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct MidCingulateCortex {
    /// Pain affect
    pub pain_affect: f32,
    /// Social pain
    pub social_pain: f32,
    /// Effort cost
    pub effort_cost: f32,
    /// Agency
    pub agency: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total social pain events
    pub social_pain_events: u64,
    /// Total high-effort computations
    pub high_effort_events: u64,
}

impl MidCingulateCortex {
    pub fn new() -> Self {
        Self {
            pain_affect: 0.05,
            social_pain: 0.0,
            effort_cost: 0.20,
            agency: 0.70,
            inputs_processed: 0,
            social_pain_events: 0,
            high_effort_events: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for pain affect, effort cost, and agency.
    /// - `text`: the input
    /// - `acc_conflict`: conflict signal from ACC (0.0–1.0)
    /// - `amygdala_arousal`: threat/arousal from amygdala (0.0–1.0)
    /// - `s1_discomfort`: cognitive discomfort from somatosensory cortex (0.0–1.0)
    pub fn process(
        &mut self,
        text: &str,
        acc_conflict: f32,
        amygdala_arousal: f32,
        s1_discomfort: f32,
    ) -> MCCOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Effort cost ───────────────────────────────────────────────────────
        let effort_hits = EFFORT_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let effort_from_text = (effort_hits as f32 * 0.10).min(0.60);
        let effort_target =
            (effort_from_text + acc_conflict * 0.25 + s1_discomfort * 0.15).min(1.0);
        self.effort_cost = self.effort_cost * (1.0 - EFFORT_EMA) + effort_target * EFFORT_EMA;

        if self.effort_cost > HIGH_EFFORT_THRESHOLD {
            self.high_effort_events += 1;
        }

        // ── Social pain ───────────────────────────────────────────────────────
        let exclusion_hits = EXCLUSION_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        if exclusion_hits >= 1 {
            self.social_pain_events += 1;
            let social_target = (exclusion_hits as f32 * 0.15 + amygdala_arousal * 0.20).min(1.0);
            self.social_pain = (self.social_pain + social_target * 0.25).min(1.0);
        }

        // ── Physical/cognitive pain affect ────────────────────────────────────
        let pain_target =
            (acc_conflict * 0.30 + s1_discomfort * 0.25 + self.social_pain * 0.20).min(1.0);
        self.pain_affect = self.pain_affect * (1.0 - PAIN_EMA) + pain_target * PAIN_EMA;

        // ── Agency / volition ────────────────────────────────────────────────
        let agency_hits = AGENCY_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        // Agency rises with volitional content, falls with high social pain + effort
        let agency_penalty = (self.social_pain * 0.15 + self.effort_cost * 0.10).min(0.30);
        let agency_target = (0.50 + agency_hits as f32 * 0.06 - agency_penalty).clamp(0.10, 1.0);
        self.agency = self.agency * (1.0 - AGENCY_EMA) + agency_target * AGENCY_EMA;

        MCCOutput {
            pain_affect: self.pain_affect,
            social_pain: self.social_pain,
            effort_cost: self.effort_cost,
            agency: self.agency,
            social_distress: self.social_pain >= SOCIAL_PAIN_THRESHOLD,
            effort_suppressed: self.effort_cost >= HIGH_EFFORT_THRESHOLD,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Social pain lingers longer than physical pain
        self.social_pain = (self.social_pain - SOCIAL_PAIN_DECAY).max(0.0);
        self.pain_affect = (self.pain_affect - PAIN_DECAY).max(0.0);
        // Effort cost decays toward baseline resting state
        self.effort_cost = (self.effort_cost - 0.015).max(0.10);
        // Agency drifts toward healthy volitional baseline
        self.agency = self.agency * 0.998 + 0.70 * 0.002;
    }

    /// Current output without processing.
    pub fn current_output(&self) -> MCCOutput {
        MCCOutput {
            pain_affect: self.pain_affect,
            social_pain: self.social_pain,
            effort_cost: self.effort_cost,
            agency: self.agency,
            social_distress: self.social_pain >= SOCIAL_PAIN_THRESHOLD,
            effort_suppressed: self.effort_cost >= HIGH_EFFORT_THRESHOLD,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "MCC pain={:.2} | soc_pain={:.2} | effort={:.2} | agency={:.2}{}{}",
            self.pain_affect,
            self.social_pain,
            self.effort_cost,
            self.agency,
            if self.social_pain >= SOCIAL_PAIN_THRESHOLD {
                " DISTRESS"
            } else {
                ""
            },
            if self.effort_cost >= HIGH_EFFORT_THRESHOLD {
                " EFFORT↑"
            } else {
                ""
            },
        )
    }
}

impl Default for MidCingulateCortex {
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
        let m = MidCingulateCortex::new();
        assert!(m.social_pain < 0.01);
        assert!(m.agency > 0.50);
    }

    #[test]
    fn test_exclusion_words_raise_social_pain() {
        let mut m = MidCingulateCortex::new();
        let before = m.social_pain;
        m.process(
            "no that's wrong and incorrect, I'm disappointed",
            0.20,
            0.30,
            0.10,
        );
        assert!(
            m.social_pain > before,
            "exclusion words should raise social pain: {:.2} → {:.2}",
            before,
            m.social_pain
        );
    }

    #[test]
    fn test_acc_conflict_raises_pain_affect() {
        let mut m = MidCingulateCortex::new();
        let before = m.pain_affect;
        m.process("neutral text", 0.85, 0.40, 0.20);
        assert!(
            m.pain_affect > before,
            "high ACC conflict should raise pain affect: {:.2} → {:.2}",
            before,
            m.pain_affect
        );
    }

    #[test]
    fn test_effort_words_raise_effort_cost() {
        let mut m = MidCingulateCortex::new();
        let before = m.effort_cost;
        m.process(
            "this is very difficult and complex and technically demanding",
            0.20,
            0.10,
            0.10,
        );
        assert!(
            m.effort_cost > before,
            "effort words should raise effort cost: {:.2} → {:.2}",
            before,
            m.effort_cost
        );
    }

    #[test]
    fn test_social_distress_flag_at_threshold() {
        let mut m = MidCingulateCortex::new();
        m.social_pain = SOCIAL_PAIN_THRESHOLD + 0.01;
        let out = m.current_output();
        assert!(
            out.social_distress,
            "social pain >= threshold → social distress"
        );
    }

    #[test]
    fn test_effort_suppressed_flag() {
        let mut m = MidCingulateCortex::new();
        m.effort_cost = HIGH_EFFORT_THRESHOLD + 0.01;
        let out = m.current_output();
        assert!(
            out.effort_suppressed,
            "effort >= threshold → effort suppressed"
        );
    }

    #[test]
    fn test_agency_words_boost_agency() {
        let mut m = MidCingulateCortex::new();
        let before = m.agency;
        m.process(
            "I decide to commit and resolve to act with intent",
            0.10,
            0.10,
            0.05,
        );
        assert!(
            m.agency >= before - 0.01,
            "agency words should not lower agency: {:.2} → {:.2}",
            before,
            m.agency
        );
    }

    #[test]
    fn test_high_social_pain_lowers_agency() {
        let mut m = MidCingulateCortex::new();
        m.social_pain = 0.80;
        m.process("neutral text", 0.10, 0.10, 0.05);
        // Agency target will be penalized by high social pain
        assert!(
            m.agency < 0.80,
            "high social pain should eventually lower agency: {:.2}",
            m.agency
        );
    }

    #[test]
    fn test_decay_reduces_pain() {
        let mut m = MidCingulateCortex::new();
        m.pain_affect = 0.70;
        m.social_pain = 0.60;
        for _ in 0..20 {
            m.decay();
        }
        assert!(
            m.pain_affect < 0.70,
            "pain affect should decay: {:.2}",
            m.pain_affect
        );
        assert!(
            m.social_pain < 0.60,
            "social pain should decay: {:.2}",
            m.social_pain
        );
    }

    #[test]
    fn test_social_pain_decays_slower_than_physical() {
        let mut m = MidCingulateCortex::new();
        m.pain_affect = 0.50;
        m.social_pain = 0.50;
        for _ in 0..10 {
            m.decay();
        }
        // Social pain decays at 0.008/tick, physical at 0.025/tick
        assert!(
            m.social_pain > m.pain_affect,
            "social pain should decay slower: soc={:.2} phys={:.2}",
            m.social_pain,
            m.pain_affect
        );
    }

    #[test]
    fn test_status_line() {
        let m = MidCingulateCortex::new();
        let s = m.status_line();
        assert!(s.contains("MCC"), "status should mention MCC");
        assert!(s.contains("pain"), "status should show pain");
    }
}
