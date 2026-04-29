/// Primary Somatosensory Cortex (S1) — Body Map, Interoceptive Grounding,
/// Tactile Simulation, Felt Sense of State
///
/// S1 receives and represents all tactile and proprioceptive information from
/// the body, organized as the "homunculus" — a distorted map of the body where
/// the hands, face, and tongue receive enormous cortical territory due to their
/// sensitivity. But S1 also participates in simulation: when you read about
/// touching something, S1 partially activates.
///
/// What S1 does:
///
///   Body state map:
///     S1 maintains a moment-to-moment map of the body's sensory state. Pain,
///     temperature, pressure, position — all are represented here.
///     In KAI: a simplified body-state map representing the felt quality of KAI's
///     current processing state — "heavy," "sharp," "warm," "tense."
///
///   Tactile simulation:
///     Reading or thinking about physical sensations activates S1. This is part
///     of the brain's embodied simulation system.
///     In KAI: when processing text with physical/tactile content, S1 fires —
///     adding a felt quality to the conceptual processing.
///
///   Interoceptive integration with Insula:
///     S1 and the posterior insula work together to produce the "felt sense" —
///     the subjective quality of bodily states. S1 provides the map; insula
///     provides the salience/affect.
///     In KAI: S1 + insula together produce the interoceptive felt sense of
///     KAI's current state (whether processing feels "flowing" or "stuck").
///
///   Pain representation:
///     Pain is not just in the injury site — it is constructed in S1 and the
///     anterior cingulate. Cognitive factors (attention, expectation) dramatically
///     modulate S1's pain representation.
///     In KAI: processing difficulty, error, or conflict is registered as
///     "cognitive discomfort" in the S1/ACC loop.
///
/// KAI's S1:
///   body_state: felt quality of current cognitive state (-1.0=aversive, +1.0=pleasant)
///   tactile_activation: response to physical/somatic language (0.0–1.0)
///   cognitive_discomfort: S1 representation of processing difficulty (0.0–1.0)
///   felt_flow: whether processing feels smooth/flowing vs. effortful

// ── Constants ─────────────────────────────────────────────────────────────────

/// Body state EMA (moderate — felt sense shifts gradually)
const BODY_STATE_EMA: f32 = 0.15;

/// Tactile activation EMA
const TACTILE_EMA: f32 = 0.20;

/// Discomfort decay per tick
const DISCOMFORT_DECAY: f32 = 0.02;

/// Tactile/somatic word markers
const TACTILE_MARKERS: &[&str] = &[
    "smooth",
    "rough",
    "sharp",
    "soft",
    "hard",
    "warm",
    "cold",
    "heavy",
    "light",
    "pressure",
    "tension",
    "tense",
    "flow",
    "stuck",
    "numb",
    "tingling",
    "touch",
    "feel",
    "texture",
    "weight",
    "resistance",
    "friction",
    "force",
    "grip",
    "release",
    "stretch",
    "compress",
    "vibrate",
];

/// Discomfort markers
const DISCOMFORT_MARKERS: &[&str] = &[
    "error",
    "fail",
    "broken",
    "wrong",
    "stuck",
    "difficult",
    "hard",
    "confusing",
    "painful",
    "frustrating",
    "blocked",
    "conflict",
];

/// Comfort / flow markers
const COMFORT_MARKERS: &[&str] = &[
    "flow",
    "smooth",
    "easy",
    "clear",
    "natural",
    "comfortable",
    "right",
    "correct",
    "good",
    "works",
    "solved",
    "understand",
    "click",
];

// ── S1Output ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct S1Output {
    /// Felt body state (-1.0 to +1.0)
    pub body_state: f32,
    /// Tactile activation
    pub tactile_activation: f32,
    /// Cognitive discomfort level
    pub cognitive_discomfort: f32,
    /// Whether processing feels in flow
    pub felt_flow: bool,
    /// Whether somatic/tactile content was detected
    pub somatic_detected: bool,
}

// ── SomatosensoryCortex ───────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SomatosensoryCortex {
    /// Current body state (valence)
    pub body_state: f32,
    /// Tactile activation
    pub tactile_activation: f32,
    /// Cognitive discomfort
    pub cognitive_discomfort: f32,
    /// Total somatic detections
    pub somatic_detections: u64,
    /// Total inputs processed
    pub inputs_processed: u64,
}

impl SomatosensoryCortex {
    pub fn new() -> Self {
        Self {
            body_state: 0.10, // Slight positive by default
            tactile_activation: 0.10,
            cognitive_discomfort: 0.0,
            somatic_detections: 0,
            inputs_processed: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for somatic content and state updates.
    /// - `text`: the input text
    /// - `acc_conflict`: conflict level from ACC (produces cognitive discomfort)
    /// - `insula_valence`: interoceptive valence from insula (-1.0 to +1.0)
    pub fn process(&mut self, text: &str, acc_conflict: f32, insula_valence: f32) -> S1Output {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Somatic / tactile detection ───────────────────────────────────────
        let tactile_hits = TACTILE_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let somatic_detected = tactile_hits >= 1;
        if somatic_detected {
            self.somatic_detections += 1;
            let tactile_target = (tactile_hits as f32 * 0.15).min(0.90);
            self.tactile_activation =
                self.tactile_activation * (1.0 - TACTILE_EMA) + tactile_target * TACTILE_EMA;
        } else {
            self.tactile_activation = (self.tactile_activation - 0.03).max(0.0);
        }

        // ── Discomfort / comfort detection ────────────────────────────────────
        let discomfort_hits = DISCOMFORT_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let comfort_hits = COMFORT_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();

        // Cognitive discomfort from text + ACC conflict
        let discomfort_text = (discomfort_hits as f32 * 0.12).min(0.60);
        let discomfort_total = (discomfort_text + acc_conflict * 0.30).min(1.0);
        self.cognitive_discomfort = (self.cognitive_discomfort + discomfort_total * 0.20
            - comfort_hits as f32 * 0.05)
            .clamp(0.0, 1.0);

        // ── Body state (felt valence) ─────────────────────────────────────────
        let body_target = insula_valence * 0.60 + comfort_hits as f32 * 0.08
            - discomfort_hits as f32 * 0.10
            - acc_conflict * 0.20;
        let body_target = body_target.clamp(-1.0, 1.0);
        self.body_state = self.body_state * (1.0 - BODY_STATE_EMA) + body_target * BODY_STATE_EMA;

        S1Output {
            body_state: self.body_state,
            tactile_activation: self.tactile_activation,
            cognitive_discomfort: self.cognitive_discomfort,
            felt_flow: self.body_state > 0.20 && self.cognitive_discomfort < 0.35,
            somatic_detected,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        self.cognitive_discomfort = (self.cognitive_discomfort - DISCOMFORT_DECAY).max(0.0);
        self.tactile_activation = (self.tactile_activation - 0.02).max(0.0);
        // Body state drifts toward neutral
        self.body_state = self.body_state * 0.99;
    }

    /// Current output without processing.
    pub fn current_output(&self) -> S1Output {
        S1Output {
            body_state: self.body_state,
            tactile_activation: self.tactile_activation,
            cognitive_discomfort: self.cognitive_discomfort,
            felt_flow: self.body_state > 0.20 && self.cognitive_discomfort < 0.35,
            somatic_detected: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "S1 body={:+.2} | tactile={:.2} | discomfort={:.2} | flow={}",
            self.body_state,
            self.tactile_activation,
            self.cognitive_discomfort,
            if self.body_state > 0.20 && self.cognitive_discomfort < 0.35 {
                "YES"
            } else {
                "no"
            },
        )
    }
}

impl Default for SomatosensoryCortex {
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
        let s = SomatosensoryCortex::new();
        assert!(s.cognitive_discomfort < 0.01);
        assert!(s.body_state >= -1.0 && s.body_state <= 1.0);
    }

    #[test]
    fn test_tactile_words_raise_activation() {
        let mut s = SomatosensoryCortex::new();
        let out = s.process("the texture feels smooth and warm and soft", 0.10, 0.20);
        assert!(out.somatic_detected, "tactile words should be detected");
        assert!(
            out.tactile_activation > 0.0,
            "tactile activation should rise: {:.2}",
            out.tactile_activation
        );
    }

    #[test]
    fn test_acc_conflict_raises_discomfort() {
        let mut s = SomatosensoryCortex::new();
        let out = s.process("something complex", 0.80, 0.0);
        assert!(
            out.cognitive_discomfort > 0.0,
            "high ACC conflict should raise cognitive discomfort: {:.2}",
            out.cognitive_discomfort
        );
    }

    #[test]
    fn test_comfort_words_reduce_discomfort() {
        let mut s = SomatosensoryCortex::new();
        s.cognitive_discomfort = 0.50;
        s.process("everything flows smoothly and works correctly", 0.0, 0.30);
        assert!(
            s.cognitive_discomfort < 0.50,
            "comfort words should reduce discomfort: {:.2}",
            s.cognitive_discomfort
        );
    }

    #[test]
    fn test_positive_insula_raises_body_state() {
        let mut s = SomatosensoryCortex::new();
        let before = s.body_state;
        s.process("neutral text", 0.10, 0.80);
        assert!(
            s.body_state >= before - 0.01,
            "positive insula valence should not lower body state: {:.2}",
            s.body_state
        );
    }

    #[test]
    fn test_felt_flow_when_positive_and_low_discomfort() {
        let mut s = SomatosensoryCortex::new();
        s.body_state = 0.50;
        s.cognitive_discomfort = 0.10;
        let out = s.current_output();
        assert!(out.felt_flow, "positive body state + low discomfort = flow");
    }

    #[test]
    fn test_no_flow_when_high_discomfort() {
        let mut s = SomatosensoryCortex::new();
        s.body_state = 0.50;
        s.cognitive_discomfort = 0.70;
        let out = s.current_output();
        assert!(!out.felt_flow, "high discomfort should block flow");
    }

    #[test]
    fn test_decay_reduces_discomfort() {
        let mut s = SomatosensoryCortex::new();
        s.cognitive_discomfort = 0.60;
        for _ in 0..10 {
            s.decay();
        }
        assert!(
            s.cognitive_discomfort < 0.60,
            "discomfort should decay: {:.2}",
            s.cognitive_discomfort
        );
    }
}
