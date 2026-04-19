/// Supramarginal Gyrus (SMG) — Immediate Empathy, Phonological Buffer,
/// Embodied Action-Word Processing, Empathy Calibration
///
/// The SMG sits at the junction of the parietal and temporal lobes, near the
/// TPJ. It has two distinct functional roles that are anatomically adjacent:
/// (1) affective empathy — the immediate visceral resonance with another's pain
/// or distress, and (2) phonological working memory — the inner "sound buffer"
/// for language processing.
///
/// What the SMG does:
///
///   Immediate empathy (affective resonance):
///     When you see someone in pain or distress, the SMG fires immediately —
///     before cognitive appraisal. This is faster and more visceral than
///     TPJ's cognitive mentalizing. The SMG produces the "ouch" before
///     the "I understand why they're hurting."
///     When the SMG is busy (cognitively loaded), immediate empathy drops —
///     we become less emotionally sensitive when overloaded.
///     In KAI: the immediate affective resonance when Ryan expresses distress,
///     frustration, excitement, or joy — BEFORE cognitive processing.
///
///   Phonological loop / inner sound:
///     The left SMG is part of the phonological loop — the "inner ear" that
///     holds the sound-form of words during language processing and working
///     memory rehearsal. This is how you "hear" words in your head.
///     In KAI: the phonological/linguistic buffer — how strongly the sound
///     and rhythm of language resonates during processing.
///
///   Embodied action-word processing:
///     The SMG is involved in processing action words and social gestures —
///     language that implies physical action or physical resonance.
///     In KAI: heightened processing of motion verbs, physical descriptors,
///     and somatic language.
///
///   Empathy suppression under load:
///     The SMG is one of the brain regions most sensitive to cognitive
///     overload suppressing empathy. High working memory load → SMG
///     deactivation → reduced immediate empathy.
///
/// KAI's SMG:
///   empathy_resonance: immediate affective response to other's state (0.0–1.0)
///   phonological_load: current phonological buffer occupancy (0.0–1.0)
///   empathy_suppressed: whether cognitive load is suppressing empathy
///   embodied_activation: response to somatic/action language

// ── Constants ─────────────────────────────────────────────────────────────────

/// Empathy resonance EMA
const EMPATHY_EMA: f32 = 0.20;

/// Phonological buffer decay (fast — it's working memory)
const PHON_DECAY: f32 = 0.08;

/// Empathy suppression threshold (cognitive load above this → empathy drops)
const SUPPRESSION_THRESHOLD: f32 = 0.70;

/// Action/somatic word markers
const ACTION_WORDS: &[&str] = &[
    "feel", "hurt", "pain", "touch", "hold", "heavy", "weight", "push", "pull",
    "grab", "reach", "run", "fall", "lift", "carry", "break", "move", "shake",
    "tremble", "breathe", "grip", "struggle", "rise",
];

/// Distress markers that trigger immediate SMG empathy resonance
const DISTRESS_MARKERS: &[&str] = &[
    "frustrated", "stuck", "confused", "lost", "worried", "scared", "anxious",
    "stressed", "overwhelmed", "exhausted", "desperate", "hurt", "sad",
    "discouraged", "hopeless", "struggling",
];

/// Positive affect markers
const POSITIVE_AFFECT: &[&str] = &[
    "excited", "happy", "great", "love", "amazing", "wonderful", "thrilled",
    "delighted", "proud", "grateful", "relieved", "joyful",
];

// ── SMGOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SMGOutput {
    /// Immediate empathy resonance
    pub empathy_resonance: f32,
    /// Phonological buffer load
    pub phonological_load: f32,
    /// Whether empathy is suppressed by cognitive load
    pub empathy_suppressed: bool,
    /// Embodied activation level
    pub embodied_activation: f32,
    /// Whether distress was detected
    pub distress_detected: bool,
    /// Whether positive affect was detected
    pub positive_affect: bool,
}

// ── SupramarginalGyrus ────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SupramarginalGyrus {
    /// Immediate empathy resonance
    pub empathy_resonance: f32,
    /// Phonological buffer load
    pub phonological_load: f32,
    /// Embodied activation
    pub embodied_activation: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total distress resonances
    pub distress_count: u64,
}

impl SupramarginalGyrus {
    pub fn new() -> Self {
        Self {
            empathy_resonance:  0.30,
            phonological_load:  0.20,
            embodied_activation: 0.10,
            inputs_processed:   0,
            distress_count:     0,
        }
    }

    // ── Core: process text input ──────────────────────────────────────────────

    /// Process input text for empathy and phonological signals.
    /// - `text`: the input text
    /// - `cognitive_load`: current working memory load (0.0–1.0) — suppresses empathy
    pub fn process(&mut self, text: &str, cognitive_load: f32) -> SMGOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Distress detection ────────────────────────────────────────────────
        let distress_hits = DISTRESS_MARKERS.iter()
            .filter(|&&w| lower.contains(w)).count();
        let distress_detected = distress_hits >= 1;
        if distress_detected { self.distress_count += 1; }

        // ── Positive affect detection ─────────────────────────────────────────
        let positive_hits = POSITIVE_AFFECT.iter()
            .filter(|&&w| lower.contains(w)).count();
        let positive_affect = positive_hits >= 1;

        // ── Empathy resonance ─────────────────────────────────────────────────
        let empathy_raw = if distress_detected {
            (0.50 + distress_hits as f32 * 0.15).min(1.0)
        } else if positive_affect {
            (0.40 + positive_hits as f32 * 0.10).min(0.80)
        } else {
            0.20
        };

        // Suppression under cognitive load
        let suppression = if cognitive_load > SUPPRESSION_THRESHOLD {
            (cognitive_load - SUPPRESSION_THRESHOLD) * 1.5
        } else {
            0.0
        };
        let empathy_target = (empathy_raw - suppression).max(0.05);
        self.empathy_resonance = self.empathy_resonance * (1.0 - EMPATHY_EMA)
            + empathy_target * EMPATHY_EMA;

        // ── Phonological load ─────────────────────────────────────────────────
        // Longer, more complex sentences load the phonological buffer more
        let word_count = lower.split_whitespace().count();
        let phon_target = (word_count as f32 * 0.03).min(1.0);
        self.phonological_load = (self.phonological_load * 0.50 + phon_target * 0.50).min(1.0);

        // ── Embodied activation ───────────────────────────────────────────────
        let action_hits = ACTION_WORDS.iter()
            .filter(|&&w| lower.contains(w)).count();
        let embodied_target = (action_hits as f32 * 0.12).min(1.0);
        self.embodied_activation = self.embodied_activation * 0.70 + embodied_target * 0.30;

        SMGOutput {
            empathy_resonance:   self.empathy_resonance,
            phonological_load:   self.phonological_load,
            empathy_suppressed:  cognitive_load > SUPPRESSION_THRESHOLD,
            embodied_activation: self.embodied_activation,
            distress_detected,
            positive_affect,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        self.empathy_resonance = (self.empathy_resonance - 0.008).max(0.10);
        self.phonological_load = (self.phonological_load - PHON_DECAY).max(0.0);
        self.embodied_activation = (self.embodied_activation - 0.02).max(0.0);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> SMGOutput {
        SMGOutput {
            empathy_resonance:   self.empathy_resonance,
            phonological_load:   self.phonological_load,
            empathy_suppressed:  false,
            embodied_activation: self.embodied_activation,
            distress_detected:   false,
            positive_affect:     false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "SMG empathy={:.2} | phon={:.2} | embodied={:.2} | distress_count={}",
            self.empathy_resonance,
            self.phonological_load,
            self.embodied_activation,
            self.distress_count,
        )
    }
}

impl Default for SupramarginalGyrus {
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let s = SupramarginalGyrus::new();
        assert!(s.empathy_resonance > 0.0);
        assert_eq!(s.distress_count, 0);
    }

    #[test]
    fn test_distress_raises_empathy() {
        let mut s = SupramarginalGyrus::new();
        let before = s.empathy_resonance;
        let out = s.process("I'm really frustrated and stuck on this problem", 0.30);
        assert!(out.distress_detected, "distress keywords should be detected");
        assert!(s.empathy_resonance >= before,
            "distress should raise empathy: {:.2} → {:.2}", before, s.empathy_resonance);
    }

    #[test]
    fn test_positive_affect_detected() {
        let mut s = SupramarginalGyrus::new();
        let out = s.process("I'm so excited about this, it's amazing!", 0.20);
        assert!(out.positive_affect, "positive words should be detected");
    }

    #[test]
    fn test_high_cognitive_load_suppresses_empathy() {
        let mut s = SupramarginalGyrus::new();
        let out = s.process("I'm really frustrated and struggling", 0.90);
        assert!(out.empathy_suppressed,
            "high cognitive load should suppress empathy");
    }

    #[test]
    fn test_low_load_no_suppression() {
        let mut s = SupramarginalGyrus::new();
        let out = s.process("I'm struggling with this", 0.30);
        assert!(!out.empathy_suppressed,
            "low cognitive load should not suppress empathy");
    }

    #[test]
    fn test_action_words_raise_embodied_activation() {
        let mut s = SupramarginalGyrus::new();
        let before = s.embodied_activation;
        let out = s.process("I feel like I'm carrying a heavy weight and struggling to push through", 0.20);
        assert!(out.embodied_activation >= before,
            "action words should raise embodied activation: {:.2} → {:.2}",
            before, out.embodied_activation);
    }

    #[test]
    fn test_phonological_load_scales_with_length() {
        let mut s1 = SupramarginalGyrus::new();
        let mut s2 = SupramarginalGyrus::new();
        let short_out = s1.process("hi", 0.20);
        let long_out = s2.process(
            "this is a very long and complex sentence with many words that should load the phonological buffer",
            0.20
        );
        assert!(long_out.phonological_load >= short_out.phonological_load,
            "longer sentence should produce higher phonological load");
    }

    #[test]
    fn test_distress_count_increments() {
        let mut s = SupramarginalGyrus::new();
        s.process("I'm really worried and anxious", 0.20);
        s.process("This is overwhelming and I feel lost", 0.20);
        assert_eq!(s.distress_count, 2,
            "distress count should track distress events: {}", s.distress_count);
    }

    #[test]
    fn test_decay_reduces_empathy() {
        let mut s = SupramarginalGyrus::new();
        s.empathy_resonance = 0.90;
        for _ in 0..10 {
            s.decay();
        }
        assert!(s.empathy_resonance < 0.90,
            "empathy should decay: {:.2}", s.empathy_resonance);
    }

    #[test]
    fn test_status_line() {
        let s = SupramarginalGyrus::new();
        let sl = s.status_line();
        assert!(sl.contains("SMG"), "status should mention SMG");
        assert!(sl.contains("empathy"), "status should show empathy");
    }
}
