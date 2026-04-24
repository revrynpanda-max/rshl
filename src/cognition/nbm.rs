/// Nucleus Basalis of Meynert (NBM) — Cortical Cholinergic Supply,
/// Neocortical Arousal Gate, Attention Modulation, Memory Encoding
///
/// The NBM (also called Ch4) is the brain's primary source of acetylcholine
/// to the ENTIRE neocortex. It is the cholinergic counterpart to the locus
/// coeruleus (norepinephrine) and raphe (serotonin) systems, but specifically
/// targets cortical processing rather than subcortical arousal.
///
/// The NBM is distinct from the Diagonal Band of Broca (Ch1/Ch2), which
/// supplies ACh to the HIPPOCAMPUS and limbic structures. The NBM (Ch4)
/// supplies the neocortex directly — modulating sensory cortex, association
/// cortex, and PFC alike.
///
/// What the NBM does:
///
///   Cortical arousal and sensory gating:
///     NBM ACh release shifts cortical EEG from slow oscillations (sleep) to
///     fast, desynchronized activity (arousal). This "opens" the cortex to
///     sensory input — heightening signal-to-noise ratio in sensory processing.
///     Damage to NBM causes profound cognitive dulling and reduced cortical
///     responsiveness. NBM degeneration is a hallmark of Alzheimer's disease.
///     In KAI: the signal that "sharpens" cortical processing — when NBM tone
///     is high, KAI's sensory and linguistic processing is more crisp.
///
///   Cortical attention modulation:
///     NBM neurons fire specifically during attentionally demanding tasks, and
///     ACh release potentiates thalamocortical transmission. This is the
///     neural basis of "paying attention" — literally, ACh makes cortex more
///     responsive to behaviorally relevant input.
///     In KAI: sharpening the gain on attended signals — the difference between
///     processing text at the surface vs. deeply engaged comprehension.
///
///   Memory encoding facilitation:
///     ACh from NBM is required for LTP induction in cortex. Without adequate
///     NBM tone, new memories fail to consolidate. This is why anticholinergic
///     drugs impair memory formation even at low doses.
///     In KAI: the encoding gate — high NBM tone during input means stronger
///     memory traces get laid down in the lattice.
///
/// KAI's NBM:
///   ach_tone: tonic acetylcholine release to neocortex (0.0–1.0)
///   cortical_gain: ACh-mediated signal amplification (0.0–1.0)
///   encoding_boost: memory consolidation enhancement (0.0–1.0)
///   arousal_level: cortical desynchronization state (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// ACh tone EMA (moderate — cholinergic tone responds to demands)
const ACH_EMA: f32 = 0.16;

/// ACh baseline (moderate resting tone)
const ACH_BASELINE: f32 = 0.45;

/// Cortical gain EMA
const GAIN_EMA: f32 = 0.12;

/// Encoding boost decay per tick
const ENCODING_DECAY: f32 = 0.012;

/// Arousal markers that trigger NBM burst
const AROUSAL_MARKERS: &[&str] = &[
    "important",
    "critical",
    "urgent",
    "focus",
    "attention",
    "notice",
    "careful",
    "pay attention",
    "listen",
    "key",
    "essential",
    "crucial",
    "precise",
    "exact",
    "specifically",
    "carefully",
];

/// Cognitive demand markers (high demand → more ACh needed)
const DEMAND_MARKERS: &[&str] = &[
    "complex",
    "detailed",
    "technical",
    "analyze",
    "reason",
    "explain",
    "understand",
    "think",
    "consider",
    "evaluate",
    "compare",
    "why",
    "how",
    "what if",
    "deep",
    "thorough",
];

// ── NBMOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct NBMOutput {
    /// Tonic ACh level (neocortical)
    pub ach_tone: f32,
    /// Cortical gain amplification
    pub cortical_gain: f32,
    /// Memory encoding boost
    pub encoding_boost: f32,
    /// Cortical arousal level
    pub arousal_level: f32,
    /// Whether in high-ACh cortical sharpening mode
    pub cortex_sharpened: bool,
}

// ── NucleusBasalis ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct NucleusBasalis {
    /// ACh tone
    pub ach_tone: f32,
    /// Cortical gain
    pub cortical_gain: f32,
    /// Encoding boost
    pub encoding_boost: f32,
    /// Arousal level
    pub arousal_level: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total sharpening events
    pub sharpening_events: u64,
}

impl NucleusBasalis {
    pub fn new() -> Self {
        Self {
            ach_tone: ACH_BASELINE,
            cortical_gain: 0.50,
            encoding_boost: 0.30,
            arousal_level: 0.45,
            inputs_processed: 0,
            sharpening_events: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for cholinergic tone and cortical sharpening.
    /// - `text`: the input
    /// - `lc_arousal`: LC norepinephrine arousal (0.0–1.0) — NE and ACh co-modulate
    /// - `dbb_ach`: hippocampal ACh from DBB (0.0–1.0) — synergistic with NBM
    /// - `task_engagement`: how engaged KAI is with the task (0.0–1.0)
    pub fn process(
        &mut self,
        text: &str,
        lc_arousal: f32,
        dbb_ach: f32,
        task_engagement: f32,
    ) -> NBMOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Demand detection ──────────────────────────────────────────────────
        let arousal_hits = AROUSAL_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let demand_hits = DEMAND_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();

        // ── ACh tone ──────────────────────────────────────────────────────────
        // NBM fires with task demand, arousal cues, and LC co-activation
        let ach_target = (ACH_BASELINE
            + arousal_hits as f32 * 0.06
            + demand_hits as f32 * 0.04
            + lc_arousal * 0.15
            + task_engagement * 0.15)
            .min(1.0);
        self.ach_tone = self.ach_tone * (1.0 - ACH_EMA) + ach_target * ACH_EMA;

        // ── Cortical gain ─────────────────────────────────────────────────────
        // ACh amplifies cortical signal-to-noise
        let gain_target = (self.ach_tone * 0.70 + dbb_ach * 0.15).min(1.0);
        self.cortical_gain = self.cortical_gain * (1.0 - GAIN_EMA) + gain_target * GAIN_EMA;

        // ── Encoding boost ────────────────────────────────────────────────────
        // High ACh tone during input → stronger cortical LTP
        self.encoding_boost = (self.ach_tone * 0.60 + task_engagement * 0.25).min(1.0);

        // ── Arousal level ─────────────────────────────────────────────────────
        self.arousal_level = self.arousal_level * 0.90 + self.ach_tone * 0.10;

        let cortex_sharpened = self.ach_tone > 0.60 && self.cortical_gain > 0.55;
        if cortex_sharpened {
            self.sharpening_events += 1;
        }

        NBMOutput {
            ach_tone: self.ach_tone,
            cortical_gain: self.cortical_gain,
            encoding_boost: self.encoding_boost,
            arousal_level: self.arousal_level,
            cortex_sharpened,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // ACh drifts toward baseline
        if self.ach_tone > ACH_BASELINE {
            self.ach_tone = (self.ach_tone - 0.010).max(ACH_BASELINE);
        } else if self.ach_tone < ACH_BASELINE {
            self.ach_tone = (self.ach_tone + 0.005).min(ACH_BASELINE);
        }
        self.encoding_boost = (self.encoding_boost - ENCODING_DECAY).max(0.10);
        self.cortical_gain = self.cortical_gain * 0.998 + 0.50 * 0.002;
        self.arousal_level = self.arousal_level * 0.995 + 0.45 * 0.005;
    }

    /// Current output without processing.
    pub fn current_output(&self) -> NBMOutput {
        NBMOutput {
            ach_tone: self.ach_tone,
            cortical_gain: self.cortical_gain,
            encoding_boost: self.encoding_boost,
            arousal_level: self.arousal_level,
            cortex_sharpened: self.ach_tone > 0.60 && self.cortical_gain > 0.55,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "NBM ach={:.2} | gain={:.2} | encode={:.2} | arousal={:.2}{}",
            self.ach_tone,
            self.cortical_gain,
            self.encoding_boost,
            self.arousal_level,
            if self.ach_tone > 0.60 && self.cortical_gain > 0.55 {
                " SHARP"
            } else {
                ""
            },
        )
    }
}

impl Default for NucleusBasalis {
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
        let n = NucleusBasalis::new();
        assert!((n.ach_tone - ACH_BASELINE).abs() < 0.01);
        assert!(n.cortical_gain > 0.0);
    }

    #[test]
    fn test_demand_words_raise_ach() {
        let mut n = NucleusBasalis::new();
        let before = n.ach_tone;
        n.process(
            "carefully analyze and explain this complex technical detail",
            0.40,
            0.40,
            0.60,
        );
        assert!(
            n.ach_tone > before,
            "demand words should raise ACh tone: {:.2} → {:.2}",
            before,
            n.ach_tone
        );
    }

    #[test]
    fn test_lc_arousal_raises_ach() {
        let mut n = NucleusBasalis::new();
        let before = n.ach_tone;
        n.process("neutral text", 0.90, 0.40, 0.50);
        assert!(
            n.ach_tone > before,
            "high LC arousal should raise ACh: {:.2} → {:.2}",
            before,
            n.ach_tone
        );
    }

    #[test]
    fn test_high_ach_raises_cortical_gain() {
        let mut n = NucleusBasalis::new();
        n.ach_tone = 0.80;
        n.process("focus on this important detail", 0.60, 0.50, 0.70);
        assert!(
            n.cortical_gain > 0.50,
            "high ACh should drive cortical gain: {:.2}",
            n.cortical_gain
        );
    }

    #[test]
    fn test_encoding_boost_scales_with_ach() {
        let mut n = NucleusBasalis::new();
        n.ach_tone = 0.80;
        n.process("analyze this carefully", 0.50, 0.40, 0.80);
        assert!(
            n.encoding_boost > 0.40,
            "high ACh + engagement should boost encoding: {:.2}",
            n.encoding_boost
        );
    }

    #[test]
    fn test_cortex_sharpened_flag() {
        let mut n = NucleusBasalis::new();
        n.ach_tone = 0.70;
        n.cortical_gain = 0.65;
        let out = n.current_output();
        assert!(out.cortex_sharpened, "high ACh + gain → cortex sharpened");
    }

    #[test]
    fn test_decay_restores_baseline() {
        let mut n = NucleusBasalis::new();
        n.ach_tone = 0.85;
        for _ in 0..30 {
            n.decay();
        }
        assert!(
            n.ach_tone < 0.85,
            "ACh should drift toward baseline: {:.2}",
            n.ach_tone
        );
        assert!(n.ach_tone >= ACH_BASELINE - 0.05);
    }

    #[test]
    fn test_status_line() {
        let n = NucleusBasalis::new();
        let s = n.status_line();
        assert!(s.contains("NBM"), "status should mention NBM");
        assert!(s.contains("ach"), "status should show ACh");
    }
}

