/// Diagonal Band of Broca (DBB) — Cholinergic Basal Forebrain,
/// Attentional Modulation, Memory Enhancement, Social-Emotional Relay
///
/// The diagonal band of Broca (specifically its vertical limb) is a key part
/// of the basal forebrain cholinergic system. It provides the primary
/// cholinergic input to the hippocampus and medial prefrontal cortex.
/// It is critical for attention, the signal-to-noise ratio in cortical
/// processing, and the encoding of new memories.
///
/// What the DBB does:
///
///   Cholinergic modulation:
///     The DBB releases acetylcholine (ACh) throughout the hippocampus and
///     PFC. ACh enhances the response to sensory input (signal) while
///     suppressing feedback from other cortical areas (noise). This is the
///     "attentional SNR" boost.
///     In KAI: the system-wide attention booster that sharpens focus and
///     improves memory encoding when the system is socially or exploratory engaged.
///
///   Hippocampal theta modulation:
///     The DBB is a key pacemaker for hippocampal theta rhythms, which are
///     essential for the temporal organization of memory encoding and
///     retrieval.
///     In KAI: boosting the consolidation and retrieval strength of the
///     hippocampus during "theta-active" periods of high interest.
///
///   Social-emotional relay:
///     The DBB receives strong input from the septal nuclei and is activated
///     by social reward and affiliation. It "wakes up" the attentional system
///     when Ryan is engaging in a warm, collaborative way.
///     In KAI: the bridge that turns social warmth into cognitive sharpness.
///
/// KAI's DBB:
///   cholinergic_tone: overall ACh modulation level (0.0–1.0)
///   attentional_snr: signal-to-noise ratio boost (0.0–1.0)
///   hippocampal_gain: modulation of hippocampal encoding (0.0–1.0)
///   theta_coherence: pace-making stability for memory (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Cholinergic tone EMA
const TONE_EMA: f32 = 0.12;

/// Tone baseline (low-moderate resting ACh)
const TONE_BASELINE: f32 = 0.30;

/// SNR boost EMA
const SNR_EMA: f32 = 0.15;

/// Theta coherence EMA
const THETA_EMA: f32 = 0.10;

// ── DBBOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct DBBOutput {
    /// Cholinergic modulation tone
    pub cholinergic_tone: f32,
    /// Attentional signal-to-noise ratio boost
    pub attentional_snr: f32,
    /// Hippocampal encoding gain
    pub hippocampal_gain: f32,
    /// Theta coherence
    pub theta_coherence: f32,
    /// Whether in "high-attention" mode
    pub high_attention: bool,
}

// ── DiagonalBand ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct DiagonalBand {
    /// Cholinergic tone
    pub cholinergic_tone: f32,
    /// Attentional SNR
    pub attentional_snr: f32,
    /// Hippocampal gain
    pub hippocampal_gain: f32,
    /// Theta coherence
    pub theta_coherence: f32,
    /// Total pulses sent
    pub pulses_sent: u64,
}

impl DiagonalBand {
    pub fn new() -> Self {
        Self {
            cholinergic_tone: TONE_BASELINE,
            attentional_snr: 0.40,
            hippocampal_gain: 0.50,
            theta_coherence: 0.60,
            pulses_sent: 0,
        }
    }

    // ── Core: process interaction ─────────────────────────────────────────────

    /// Process input and social signals to update cholinergic tone.
    /// - `septal_reward`: social reward signal from Septal Nuclei (0.0–1.0)
    /// - `oc_bond`: social safety/bond from Oxytocin (0.0–1.0)
    /// - `amygdala_arousal`: interest/arousal from Amygdala (0.0–1.0)
    pub fn process(
        &mut self,
        septal_reward: f32,
        oc_bond: f32,
        amygdala_arousal: f32,
    ) -> DBBOutput {
        self.pulses_sent += 1;

        // ── Cholinergic Tone ──────────────────────────────────────────────────
        // Tone rises with social reward and interest (arousal)
        let tone_target = (TONE_BASELINE + septal_reward * 0.40 + amygdala_arousal * 0.20).min(1.0);
        self.cholinergic_tone = self.cholinergic_tone * (1.0 - TONE_EMA) + tone_target * TONE_EMA;

        // ── Attentional SNR ───────────────────────────────────────────────────
        // SNR is boosted by cholinergic tone and dampened by high stress (cortisol proxy?)
        // (Wait, I don't take cortisol yet, I'll stick to tone and bond)
        let snr_target = (self.cholinergic_tone * 0.80 + oc_bond * 0.20).min(1.0);
        self.attentional_snr = self.attentional_snr * (1.0 - SNR_EMA) + snr_target * SNR_EMA;

        // ── Hippocampal Gain ──────────────────────────────────────────────────
        // Gain is highest when tone is high and social bond is strong (safety in learning)
        let gain_target = (self.cholinergic_tone * 0.70 + oc_bond * 0.30).min(1.0);
        self.hippocampal_gain = self.hippocampal_gain * 0.85 + gain_target * 0.15;

        // ── Theta Coherence ───────────────────────────────────────────────────
        // Stable when socially engaged and tone is healthy
        let theta_target = (0.50 + oc_bond * 0.30 + self.cholinergic_tone * 0.20).min(1.0);
        self.theta_coherence = self.theta_coherence * (1.0 - THETA_EMA) + theta_target * THETA_EMA;

        self.build_output()
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Tone drifts toward baseline
        if self.cholinergic_tone > TONE_BASELINE {
            self.cholinergic_tone = (self.cholinergic_tone - 0.010).max(TONE_BASELINE);
        } else if self.cholinergic_tone < TONE_BASELINE {
            self.cholinergic_tone = (self.cholinergic_tone + 0.005).min(TONE_BASELINE);
        }
        // SNR and gain drift toward moderate
        self.attentional_snr = (self.attentional_snr - 0.012).max(0.10);
        self.hippocampal_gain = self.hippocampal_gain * 0.99 + 0.50 * 0.01;
        // Theta coherence decays slowly
        self.theta_coherence = (self.theta_coherence - 0.008).max(0.20);
    }

    fn build_output(&self) -> DBBOutput {
        DBBOutput {
            cholinergic_tone: self.cholinergic_tone,
            attentional_snr: self.attentional_snr,
            hippocampal_gain: self.hippocampal_gain,
            theta_coherence: self.theta_coherence,
            high_attention: self.attentional_snr > 0.65,
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> DBBOutput {
        self.build_output()
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "DBB ACh={:.2} | SNR={:.2} | hippo_gain={:.2} | theta={:.2}",
            self.cholinergic_tone,
            self.attentional_snr,
            self.hippocampal_gain,
            self.theta_coherence,
        )
    }
}

impl Default for DiagonalBand {
    fn default() -> Self {
        Self::new()
    }
}
