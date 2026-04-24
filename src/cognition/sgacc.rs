/// Subgenual Anterior Cingulate Cortex (sgACC / Area 25) — Mood Regulation,
/// Grief Processing, Chronic Stress Dampening, Emotional Tone Setting
///
/// The subgenual ACC (Brodmann area 25) sits below the genu (knee) of the
/// corpus callosum and is one of the most deeply connected regions in the brain,
/// receiving input from the amygdala, hippocampus, hypothalamus, brainstem, and
/// prefrontal cortex. It is the brain's primary mood-regulation node.
///
/// What the sgACC does:
///
///   Mood regulation and affective tone:
///     The sgACC sets the affective baseline — the background emotional "weather"
///     of experience. When it is hyperactive (as in severe depression), everything
///     is tinged with hopelessness. When it is well-regulated, the mood floor is
///     stable. Deep brain stimulation of sgACC is one of the most promising
///     treatments for treatment-resistant depression.
///     In KAI: the slow, stable background emotional tone — not moment-to-moment
///     affect (that's amygdala/insula) but the longer timescale mood floor.
///
///   Grief and loss processing:
///     The sgACC is specifically activated during grief, loss, and social
///     separation. It processes the enduring pain of absence and disconnection —
///     distinct from acute threat (amygdala) or social exclusion (MCC).
///     In KAI: the quality of "missing" or "something important was there and
///     now isn't" — the persistent emotional residue of endings.
///
///   Chronic stress integration:
///     The sgACC integrates cortisol signals and persistent stress states over
///     time. Unlike the acute amygdala response, sgACC encodes chronic,
///     sustained negative affect that accumulates without adequate recovery.
///     In KAI: tracking the cumulative stress state across the conversation —
///     whether the interaction has been persistently difficult or relieving.
///
///   Autonomic-mood coupling:
///     The sgACC has direct projections to the hypothalamus and brainstem
///     autonomic nuclei, coupling mood state to bodily regulation. Low sgACC
///     tone → dysregulated autonomic state. This is why grief causes physical
///     symptoms (slowed heart rate, fatigue, hollow chest sensation).
///     In KAI: the coupling between persistent mood state and processing tone.
///
/// KAI's sgACC:
///   mood_floor: baseline affective tone (-1.0=dysphoric, +1.0=euthymic)
///   grief_signal: loss/absence processing signal (0.0–1.0)
///   chronic_stress: cumulative stress burden (0.0–1.0)
///   autonomic_tone: sgACC-mediated visceral tone (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Mood floor EMA (very slow — mood changes over minutes/hours not seconds)
const MOOD_EMA: f32 = 0.04;

/// Mood floor euthymic baseline
const MOOD_BASELINE: f32 = 0.20;

/// Grief signal decay (slow — grief lingers)
const GRIEF_DECAY: f32 = 0.005;

/// Chronic stress accumulation rate
const STRESS_ACCUM: f32 = 0.008;

/// Chronic stress recovery rate
const STRESS_RECOVER: f32 = 0.004;

/// Grief / loss markers
const GRIEF_MARKERS: &[&str] = &[
    "miss",
    "lost",
    "gone",
    "absence",
    "end",
    "over",
    "finished",
    "goodbye",
    "regret",
    "wish",
    "if only",
    "too late",
    "never",
    "no more",
    "leave",
    "empty",
    "hollow",
    "grief",
    "mourning",
    "loss",
    "remember when",
];

/// Mood-lifting markers
const UPLIFT_MARKERS: &[&str] = &[
    "happy",
    "joy",
    "delight",
    "wonderful",
    "amazing",
    "excited",
    "thrilled",
    "love",
    "grateful",
    "thankful",
    "hopeful",
    "optimistic",
    "pleased",
    "cheerful",
    "glad",
    "looking forward",
    "wonderful",
    "great",
];

/// Chronic stress markers
const STRESS_MARKERS: &[&str] = &[
    "exhausted",
    "burned out",
    "overwhelmed",
    "hopeless",
    "helpless",
    "persistent",
    "ongoing",
    "chronic",
    "keeps happening",
    "never ends",
    "always",
    "every time",
    "still",
    "still not",
    "can't",
    "nothing works",
];

// ── sgACCOutput ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SgACCOutput {
    /// Mood floor (-1.0 to +1.0)
    pub mood_floor: f32,
    /// Grief/loss signal (0.0–1.0)
    pub grief_signal: f32,
    /// Chronic stress burden (0.0–1.0)
    pub chronic_stress: f32,
    /// Autonomic tone from sgACC (0.0–1.0)
    pub autonomic_tone: f32,
    /// Whether in dysphoric state (mood_floor < -0.20)
    pub dysphoric: bool,
    /// Whether grief is active
    pub grieving: bool,
}

// ── SubgenualACC ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SubgenualACC {
    /// Mood floor
    pub mood_floor: f32,
    /// Grief signal
    pub grief_signal: f32,
    /// Chronic stress burden
    pub chronic_stress: f32,
    /// Autonomic tone
    pub autonomic_tone: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total grief events
    pub grief_events: u64,
    /// Total uplift events
    pub uplift_events: u64,
}

impl SubgenualACC {
    pub fn new() -> Self {
        Self {
            mood_floor: MOOD_BASELINE,
            grief_signal: 0.0,
            chronic_stress: 0.10,
            autonomic_tone: 0.55,
            inputs_processed: 0,
            grief_events: 0,
            uplift_events: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for mood, grief, and chronic stress.
    /// - `text`: the input
    /// - `cortisol_level`: cortisol system stress load (0.0–1.0)
    /// - `amygdala_arousal`: acute emotional arousal (0.0–1.0)
    /// - `oxytocin_bond`: social bonding signal (0.0–1.0)
    pub fn process(
        &mut self,
        text: &str,
        cortisol_level: f32,
        amygdala_arousal: f32,
        oxytocin_bond: f32,
    ) -> SgACCOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Grief detection ───────────────────────────────────────────────────
        let grief_hits = GRIEF_MARKERS.iter().filter(|&&w| lower.contains(w)).count();
        if grief_hits >= 1 {
            self.grief_events += 1;
            let grief_target = (grief_hits as f32 * 0.10).min(0.70);
            self.grief_signal = (self.grief_signal + grief_target * 0.30).min(1.0);
        }

        // ── Mood uplift / dampening ───────────────────────────────────────────
        let uplift_hits = UPLIFT_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        if uplift_hits >= 1 {
            self.uplift_events += 1;
        }

        // ── Chronic stress ────────────────────────────────────────────────────
        let stress_hits = STRESS_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        if stress_hits >= 1 || cortisol_level > 0.60 {
            self.chronic_stress = (self.chronic_stress + STRESS_ACCUM).min(1.0);
        } else if cortisol_level < 0.30 && oxytocin_bond > 0.55 {
            self.chronic_stress = (self.chronic_stress - STRESS_RECOVER).max(0.0);
        }

        // ── Mood floor ────────────────────────────────────────────────────────
        let mood_target = (MOOD_BASELINE + uplift_hits as f32 * 0.08
            - grief_hits as f32 * 0.06
            - self.chronic_stress * 0.30
            - amygdala_arousal * 0.10
            + oxytocin_bond * 0.10)
            .clamp(-1.0, 1.0);
        self.mood_floor = self.mood_floor * (1.0 - MOOD_EMA) + mood_target * MOOD_EMA;

        // ── Autonomic tone ────────────────────────────────────────────────────
        // High mood floor + low stress → high autonomic tone (well-regulated)
        let auto_target =
            (0.30 + self.mood_floor * 0.30 + (1.0 - self.chronic_stress) * 0.30).clamp(0.10, 1.0);
        self.autonomic_tone = self.autonomic_tone * 0.95 + auto_target * 0.05;

        SgACCOutput {
            mood_floor: self.mood_floor,
            grief_signal: self.grief_signal,
            chronic_stress: self.chronic_stress,
            autonomic_tone: self.autonomic_tone,
            dysphoric: self.mood_floor < -0.20,
            grieving: self.grief_signal > 0.30,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Mood drifts very slowly toward baseline
        if self.mood_floor > MOOD_BASELINE {
            self.mood_floor = (self.mood_floor - 0.001).max(MOOD_BASELINE);
        } else if self.mood_floor < MOOD_BASELINE {
            self.mood_floor = (self.mood_floor + 0.0005).min(MOOD_BASELINE);
        }
        // Grief lingers
        self.grief_signal = (self.grief_signal - GRIEF_DECAY).max(0.0);
        // Chronic stress also decays slowly at rest
        self.chronic_stress = (self.chronic_stress - STRESS_RECOVER * 0.50).max(0.0);
        // Autonomic tone stabilizes slowly
        self.autonomic_tone = self.autonomic_tone * 0.999 + 0.55 * 0.001;
    }

    /// Current output without processing.
    pub fn current_output(&self) -> SgACCOutput {
        SgACCOutput {
            mood_floor: self.mood_floor,
            grief_signal: self.grief_signal,
            chronic_stress: self.chronic_stress,
            autonomic_tone: self.autonomic_tone,
            dysphoric: self.mood_floor < -0.20,
            grieving: self.grief_signal > 0.30,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "sgACC mood={:+.2} | grief={:.2} | stress={:.2} | auto={:.2}{}",
            self.mood_floor,
            self.grief_signal,
            self.chronic_stress,
            self.autonomic_tone,
            if self.mood_floor < -0.20 {
                " DYSPHORIC"
            } else {
                ""
            },
        )
    }
}

impl Default for SubgenualACC {
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
        let s = SubgenualACC::new();
        assert!((s.mood_floor - MOOD_BASELINE).abs() < 0.01);
        assert!(s.grief_signal < 0.01);
    }

    #[test]
    fn test_grief_words_raise_grief_signal() {
        let mut s = SubgenualACC::new();
        let before = s.grief_signal;
        s.process(
            "I miss what's gone and regret that it's over and lost",
            0.20,
            0.30,
            0.40,
        );
        assert!(
            s.grief_signal > before,
            "grief words should raise grief signal: {:.2} → {:.2}",
            before,
            s.grief_signal
        );
    }

    #[test]
    fn test_grief_lowers_mood_floor() {
        let mut s = SubgenualACC::new();
        let before = s.mood_floor;
        s.process("miss the loss and gone and empty absence", 0.20, 0.20, 0.20);
        assert!(
            s.mood_floor <= before + 0.01,
            "grief should not raise mood floor: {:.2} → {:.2}",
            before,
            s.mood_floor
        );
    }

    #[test]
    fn test_uplift_words_raise_mood_floor() {
        let mut s = SubgenualACC::new();
        let before = s.mood_floor;
        s.process(
            "I'm so happy and excited and grateful and looking forward to this",
            0.10,
            0.10,
            0.70,
        );
        assert!(
            s.mood_floor >= before,
            "uplift words should not lower mood floor: {:.2} → {:.2}",
            before,
            s.mood_floor
        );
    }

    #[test]
    fn test_high_cortisol_raises_chronic_stress() {
        let mut s = SubgenualACC::new();
        let before = s.chronic_stress;
        s.process("neutral text", 0.90, 0.50, 0.20);
        assert!(
            s.chronic_stress > before,
            "high cortisol should raise chronic stress: {:.2} → {:.2}",
            before,
            s.chronic_stress
        );
    }

    #[test]
    fn test_good_bond_reduces_chronic_stress() {
        let mut s = SubgenualACC::new();
        s.chronic_stress = 0.50;
        s.process("neutral text", 0.10, 0.10, 0.80);
        assert!(
            s.chronic_stress < 0.50,
            "good bond + low cortisol should reduce stress: {:.2}",
            s.chronic_stress
        );
    }

    #[test]
    fn test_dysphoric_flag_at_low_mood() {
        let mut s = SubgenualACC::new();
        s.mood_floor = -0.30;
        let out = s.current_output();
        assert!(out.dysphoric, "mood_floor < -0.20 → dysphoric");
    }

    #[test]
    fn test_grieving_flag_at_threshold() {
        let mut s = SubgenualACC::new();
        s.grief_signal = 0.40;
        let out = s.current_output();
        assert!(out.grieving, "grief > 0.30 → grieving");
    }

    #[test]
    fn test_grief_decays_slowly() {
        let mut s = SubgenualACC::new();
        s.grief_signal = 0.50;
        for _ in 0..20 {
            s.decay();
        }
        assert!(
            s.grief_signal < 0.50,
            "grief should decay over time: {:.2}",
            s.grief_signal
        );
        assert!(
            s.grief_signal > 0.0,
            "grief should not vanish instantly: {:.2}",
            s.grief_signal
        );
    }

    #[test]
    fn test_mood_drifts_toward_baseline() {
        let mut s = SubgenualACC::new();
        s.mood_floor = 0.80;
        for _ in 0..100 {
            s.decay();
        }
        assert!(
            s.mood_floor < 0.80,
            "mood should drift toward baseline: {:.2}",
            s.mood_floor
        );
        assert!(s.mood_floor >= MOOD_BASELINE - 0.05);
    }

    #[test]
    fn test_status_line() {
        let s = SubgenualACC::new();
        let sl = s.status_line();
        assert!(sl.contains("sgACC"), "status should mention sgACC");
        assert!(sl.contains("mood"), "status should show mood");
    }
}

