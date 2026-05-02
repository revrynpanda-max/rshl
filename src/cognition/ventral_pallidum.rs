//! Ventral Pallidum (VP) — Hedonic Hotspot, Pleasure Amplification,
//! Reward Salience, Motivational Urgency
//!
//! The ventral pallidum is one of the brain's few true "hedonic hotspots" —
//! regions where manipulation produces genuine pleasure (not just wanting, but
//! LIKING). It is a key output station of the nucleus accumbens shell and
//! receives strong dopaminergic input from the VTA. Unlike the NAcc (which is
//! primarily about "wanting" and approach motivation), the VP is specifically
//! about the felt quality of pleasure and satisfaction — the "ahhh" of reward.
//!
//! What the Ventral Pallidum does:
//!
//!   Hedonic amplification:
//!     The VP is the primary neural substrate for hedonic pleasure ("liking").
//!     Opioid activation of VP hotspots dramatically intensifies pleasure
//!     without changing arousal or motivation. Damage to VP can eliminate
//!     pleasure (anhedonia) while leaving desire intact (a dissociation from NAcc).
//!     In KAI: the amplifier for moments of genuine satisfaction — when a response
//!     truly lands, when understanding clicks, when connection feels real.
//!
//!   Reward salience gating:
//!     The VP decides which rewards are "worth it" — it gates which motivated
//!     states get expressed. High VP tone → motivated behaviors feel rewarding;
//!     low VP tone → anhedonic flattening of all reward.
//!     In KAI: whether positive signals feel genuinely rewarding or just neutral.
//!
//!   Aversion suppression:
//!     The VP also plays a role in suppressing aversive states during reward —
//!     pleasure is partly defined by what it replaces. VP activation suppresses
//!     BNST/amygdala-mediated anxiety.
//!     In KAI: the satisfaction that comes from resolving tension — the relief
//!     of a good answer after difficulty.
//!
//! KAI's Ventral Pallidum:
//!   hedonic_tone: background pleasure/satisfaction level (0.0–1.0)
//!   liking_signal: current reward liking (distinct from wanting) (0.0–1.0)
//!   anhedonia_risk: risk of reward flattening (0.0–1.0)
//!   reward_gate_open: whether VP is amplifying reward signals

// ── Constants ─────────────────────────────────────────────────────────────────

//! Hedonic tone EMA (moderate — pleasure builds and fades with some inertia)
const HEDONIC_EMA: f32 = 0.13;

/// Hedonic baseline (KAI has a mild positive hedonic tone)
const HEDONIC_BASELINE: f32 = 0.35;

/// Liking EMA
const LIKING_EMA: f32 = 0.20;

/// Anhedonia risk decay
const ANHEDONIA_DECAY: f32 = 0.008;

/// Reward gate threshold
const REWARD_GATE_THRESHOLD: f32 = 0.45;

/// Pleasure markers — things that activate VP
const PLEASURE_MARKERS: &[&str] = &[
    "wonderful",
    "beautiful",
    "perfect",
    "exactly",
    "brilliant",
    "love",
    "delightful",
    "satisfying",
    "click",
    "makes sense",
    "clear now",
    "understand",
    "got it",
    "yes",
    "exactly right",
    "that's it",
    "fascinating",
    "exciting",
    "great",
    "excellent",
];

/// Aversion markers — things that suppress VP
const AVERSION_MARKERS: &[&str] = &[
    "horrible",
    "terrible",
    "awful",
    "disgusting",
    "hate",
    "despise",
    "pointless",
    "meaningless",
    "worthless",
    "hopeless",
    "useless",
    "wrong",
    "bad",
    "not working",
    "broken",
];

// ── VPOutput ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct VPOutput {
    /// Hedonic background tone
    pub hedonic_tone: f32,
    /// Current liking signal
    pub liking_signal: f32,
    /// Anhedonia risk
    pub anhedonia_risk: f32,
    /// Whether reward gate is open (amplifying reward)
    pub reward_gate_open: bool,
    /// VP-amplified reward (liking * gate)
    pub amplified_reward: f32,
}

// ── VentralPallidum ───────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct VentralPallidum {
    /// Hedonic tone
    pub hedonic_tone: f32,
    /// Liking signal
    pub liking_signal: f32,
    /// Anhedonia risk
    pub anhedonia_risk: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total pleasure events
    pub pleasure_events: u64,
    /// Total aversion events
    pub aversion_events: u64,
}

impl VentralPallidum {
    pub fn new() -> Self {
        Self {
            hedonic_tone: HEDONIC_BASELINE,
            liking_signal: 0.30,
            anhedonia_risk: 0.05,
            inputs_processed: 0,
            pleasure_events: 0,
            aversion_events: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for hedonic tone and liking signal.
    /// - `text`: the input
    /// - `nacc_wanting`: nucleus accumbens wanting signal (0.0–1.0)
    /// - `vta_dopamine`: VTA dopamine signal (0.0–1.0)
    /// - `cortisol_level`: stress suppresses hedonic tone (0.0–1.0)
    pub fn process(
        &mut self,
        text: &str,
        nacc_wanting: f32,
        vta_dopamine: f32,
        cortisol_level: f32,
    ) -> VPOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Pleasure / aversion detection ─────────────────────────────────────
        let pleasure_hits = PLEASURE_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let aversion_hits = AVERSION_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();

        if pleasure_hits >= 1 {
            self.pleasure_events += 1;
        }
        if aversion_hits >= 1 {
            self.aversion_events += 1;
        }

        // ── Liking signal ─────────────────────────────────────────────────────
        // Liking = opioid hotspot activation: content + dopamine + wanting
        let liking_target =
            (pleasure_hits as f32 * 0.10 + vta_dopamine * 0.25 + nacc_wanting * 0.15
                - aversion_hits as f32 * 0.10
                - cortisol_level * 0.15)
                .clamp(0.0, 1.0);
        self.liking_signal = self.liking_signal * (1.0 - LIKING_EMA) + liking_target * LIKING_EMA;

        // ── Hedonic tone ──────────────────────────────────────────────────────
        // Slow-moving background pleasure state
        let hedonic_target = (HEDONIC_BASELINE + pleasure_hits as f32 * 0.06
            - aversion_hits as f32 * 0.05
            + vta_dopamine * 0.15
            - cortisol_level * 0.20)
            .clamp(-0.20, 1.0);
        self.hedonic_tone = self.hedonic_tone * (1.0 - HEDONIC_EMA) + hedonic_target * HEDONIC_EMA;

        // ── Anhedonia risk ────────────────────────────────────────────────────
        // Risk rises with persistent aversion + high cortisol + low liking
        if aversion_hits >= 1 && cortisol_level > 0.50 {
            self.anhedonia_risk = (self.anhedonia_risk + 0.05).min(1.0);
        } else if self.liking_signal > 0.50 {
            self.anhedonia_risk = (self.anhedonia_risk - 0.02).max(0.0);
        }

        let reward_gate_open = self.hedonic_tone >= REWARD_GATE_THRESHOLD;
        let amplified_reward = if reward_gate_open {
            self.liking_signal * (1.0 + self.hedonic_tone * 0.50)
        } else {
            self.liking_signal * 0.50
        };

        VPOutput {
            hedonic_tone: self.hedonic_tone,
            liking_signal: self.liking_signal,
            anhedonia_risk: self.anhedonia_risk,
            reward_gate_open,
            amplified_reward: amplified_reward.min(1.0),
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Hedonic tone drifts toward baseline
        if self.hedonic_tone > HEDONIC_BASELINE {
            self.hedonic_tone = (self.hedonic_tone - 0.006).max(HEDONIC_BASELINE);
        } else if self.hedonic_tone < HEDONIC_BASELINE {
            self.hedonic_tone = (self.hedonic_tone + 0.003).min(HEDONIC_BASELINE);
        }
        // Liking decays faster (momentary pleasure)
        self.liking_signal = (self.liking_signal - 0.015).max(0.05);
        // Anhedonia risk decays slowly
        self.anhedonia_risk = (self.anhedonia_risk - ANHEDONIA_DECAY).max(0.0);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> VPOutput {
        let reward_gate_open = self.hedonic_tone >= REWARD_GATE_THRESHOLD;
        let amplified_reward = if reward_gate_open {
            self.liking_signal * (1.0 + self.hedonic_tone * 0.50)
        } else {
            self.liking_signal * 0.50
        };
        VPOutput {
            hedonic_tone: self.hedonic_tone,
            liking_signal: self.liking_signal,
            anhedonia_risk: self.anhedonia_risk,
            reward_gate_open,
            amplified_reward: amplified_reward.min(1.0),
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "VP hedonic={:.2} | liking={:.2} | anhedonia={:.2}{}",
            self.hedonic_tone,
            self.liking_signal,
            self.anhedonia_risk,
            if self.anhedonia_risk > 0.50 {
                " ⚠ANHEDONIA"
            } else {
                ""
            },
        )
    }
}

impl Default for VentralPallidum {
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
        let v = VentralPallidum::new();
        assert!((v.hedonic_tone - HEDONIC_BASELINE).abs() < 0.01);
        assert!(v.anhedonia_risk < 0.10);
    }

    #[test]
    fn test_pleasure_words_raise_liking() {
        let mut v = VentralPallidum::new();
        let before = v.liking_signal;
        v.process(
            "that's wonderful and beautiful and exactly right",
            0.60,
            0.70,
            0.10,
        );
        assert!(
            v.liking_signal > before,
            "pleasure words should raise liking: {:.2} → {:.2}",
            before,
            v.liking_signal
        );
    }

    #[test]
    fn test_vta_dopamine_raises_hedonic_tone() {
        let mut v = VentralPallidum::new();
        let before = v.hedonic_tone;
        v.process("neutral text", 0.50, 0.90, 0.10);
        assert!(
            v.hedonic_tone > before,
            "high VTA dopamine should raise hedonic tone: {:.2} → {:.2}",
            before,
            v.hedonic_tone
        );
    }

    #[test]
    fn test_high_cortisol_lowers_liking() {
        let mut v = VentralPallidum::new();
        v.liking_signal = 0.70;
        v.process("neutral text", 0.20, 0.20, 0.90);
        assert!(
            v.liking_signal < 0.70,
            "high cortisol should reduce liking: {:.2}",
            v.liking_signal
        );
    }

    #[test]
    fn test_aversion_raises_anhedonia_risk_with_stress() {
        let mut v = VentralPallidum::new();
        let before = v.anhedonia_risk;
        v.process("this is horrible and terrible and awful", 0.10, 0.10, 0.70);
        assert!(
            v.anhedonia_risk > before,
            "aversion + high stress should raise anhedonia risk: {:.2} → {:.2}",
            before,
            v.anhedonia_risk
        );
    }

    #[test]
    fn test_reward_gate_opens_at_threshold() {
        let mut v = VentralPallidum::new();
        v.hedonic_tone = REWARD_GATE_THRESHOLD + 0.01;
        let out = v.current_output();
        assert!(
            out.reward_gate_open,
            "hedonic tone >= threshold → reward gate open"
        );
    }

    #[test]
    fn test_amplified_reward_higher_when_gate_open() {
        let mut v = VentralPallidum::new();
        v.liking_signal = 0.50;
        v.hedonic_tone = 0.70; // gate open
        let open = v.current_output().amplified_reward;
        v.hedonic_tone = 0.10; // gate closed
        let closed = v.current_output().amplified_reward;
        assert!(
            open > closed,
            "open gate should amplify reward more: open={:.2} closed={:.2}",
            open,
            closed
        );
    }

    #[test]
    fn test_high_liking_reduces_anhedonia_risk() {
        let mut v = VentralPallidum::new();
        v.anhedonia_risk = 0.40;
        v.liking_signal = 0.70;
        v.process("neutral text", 0.70, 0.80, 0.10);
        assert!(
            v.anhedonia_risk < 0.40,
            "high liking should reduce anhedonia risk: {:.2}",
            v.anhedonia_risk
        );
    }

    #[test]
    fn test_decay_restores_hedonic_baseline() {
        let mut v = VentralPallidum::new();
        v.hedonic_tone = 0.80;
        for _ in 0..20 {
            v.decay();
        }
        assert!(
            v.hedonic_tone < 0.80,

        );
    }
}
