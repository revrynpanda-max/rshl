/// Zona Incerta (ZI) — Attention Gate, Threat Salience Filter,
/// Action-Suppression and Behavioral Release
///
/// The zona incerta (literally "uncertain zone") is a subthalamic gray matter
/// region that was long mysterious but is now understood as a key gating
/// structure. It acts as a powerful INHIBITOR of sensory relay in the thalamus
/// and an attentional FILTER: when the ZI is active, it suppresses irrelevant
/// stimuli; when it releases, it permits behaviorally relevant signals to pass.
///
/// What the Zona Incerta does:
///
///   Attentional gating:
///     The ZI receives inputs from cortex and limbic structures and provides
///     GABAergic inhibition to the thalamus. It can "close the gate" on sensory
///     information — preventing irrelevant stimuli from reaching cortex — or
///     open it for threat-salient or reward-salient signals.
///     In KAI: the attentional filter that determines which signals get through
///     to higher processing. High ZI inhibition → narrow focused attention.
///     ZI release → broad, open attentional mode.
///
///   Threat detection and freeze:
///     ZI is activated by looming threats and predator cues, and its activation
///     produces freezing behavior and sensory hyper-focus (vigilance). It is
///     sometimes called the "behavioral urgency" circuit.
///     In KAI: when threat salience is high, ZI gates attention toward the
///     threat and suppresses background processing.
///
///   Action release (behavioral disinhibition):
///     The ZI can release the thalamus from inhibition during reward states,
///     allowing a broad sweep of environmental monitoring — relevant for
///     foraging and exploration. This is the "open" attentional mode.
///     In KAI: the release mode that allows wide-open, curious processing when
///     the environment is safe and rewarding.
///
///   Cross-modal integration:
///     ZI receives inputs from visual, auditory, and somatosensory pathways
///     simultaneously and integrates them into a unified salience signal.
///
/// KAI's Zona Incerta:
///   inhibition_level: how strongly ZI is gating thalamic relay (0.0–1.0)
///   threat_gate_open: whether ZI is passing threat signals through
///   release_mode: whether ZI is in broad-release attentional mode
///   salience_filter: attentional filter strength (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Inhibition EMA
const INHIBITION_EMA: f32 = 0.22;

/// Inhibition baseline (moderate resting state)
const INHIBITION_BASELINE: f32 = 0.35;

/// Salience filter EMA
const FILTER_EMA: f32 = 0.18;

/// Release mode threshold (ZI opens wide when safe + reward-rich)
const RELEASE_THRESHOLD: f32 = 0.25;

/// Threat gate threshold
const THREAT_GATE_THRESHOLD: f32 = 0.50;

/// Threat markers (ZI heightens inhibition → hyper-focus on threat)
const THREAT_MARKERS: &[&str] = &[
    "danger",
    "threat",
    "wrong",
    "error",
    "attack",
    "urgent",
    "critical",
    "alarm",
    "warning",
    "immediate",
    "now",
    "quickly",
    "emergency",
    "problem",
    "fail",
    "broken",
    "crash",
    "severe",
];

/// Safety / reward markers (ZI releases → open, exploratory mode)
const SAFETY_MARKERS: &[&str] = &[
    "safe",
    "good",
    "well",
    "clear",
    "understand",
    "makes sense",
    "right",
    "comfortable",
    "relaxed",
    "curious",
    "explore",
    "interesting",
    "wonder",
    "play",
    "open",
    "free",
    "easy",
];

// ── ZIOutput ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ZIOutput {
    /// Current inhibition level (high = narrowed attention)
    pub inhibition_level: f32,
    /// Salience filter strength
    pub salience_filter: f32,
    /// Whether threat gate is open (threat signals passing)
    pub threat_gate_open: bool,
    /// Whether in release mode (broad attentional opening)
    pub release_mode: bool,
    /// Effective attentional bandwidth (inverse of inhibition)
    pub attentional_bandwidth: f32,
}

// ── ZonaIncerta ───────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct ZonaIncerta {
    /// Inhibition level
    pub inhibition_level: f32,
    /// Salience filter
    pub salience_filter: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total threat gates opened
    pub threat_gates: u64,
    /// Total release events
    pub release_events: u64,
}

impl ZonaIncerta {
    pub fn new() -> Self {
        Self {
            inhibition_level: INHIBITION_BASELINE,
            salience_filter: 0.40,
            inputs_processed: 0,
            threat_gates: 0,
            release_events: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for attentional gating.
    /// - `text`: the input
    /// - `amygdala_arousal`: threat arousal from amygdala (0.0–1.0)
    /// - `superior_colliculus_salience`: top saliency from SC (0.0–1.0)
    /// - `oxytocin_bond`: social safety signal (0.0–1.0)
    pub fn process(
        &mut self,
        text: &str,
        amygdala_arousal: f32,
        superior_colliculus_salience: f32,
        oxytocin_bond: f32,
    ) -> ZIOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Threat detection ──────────────────────────────────────────────────
        let threat_hits = THREAT_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let safety_hits = SAFETY_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();

        // ── Inhibition level ──────────────────────────────────────────────────
        // High threat → high inhibition (hyper-focused, gates out irrelevant)
        // High safety → low inhibition (release mode, broad attention)
        let threat_drive = (amygdala_arousal * 0.40
            + threat_hits as f32 * 0.08
            + superior_colliculus_salience * 0.15)
            .min(0.90);
        let safety_drive = (oxytocin_bond * 0.20 + safety_hits as f32 * 0.05).min(0.40);
        let inhibition_target =
            (INHIBITION_BASELINE + threat_drive - safety_drive).clamp(0.10, 1.0);
        self.inhibition_level =
            self.inhibition_level * (1.0 - INHIBITION_EMA) + inhibition_target * INHIBITION_EMA;

        // ── Salience filter ───────────────────────────────────────────────────
        // Filter strength tracks inhibition — higher inhibition = stronger filtering
        let filter_target =
            (self.inhibition_level * 0.80 + superior_colliculus_salience * 0.20).min(1.0);
        self.salience_filter =
            self.salience_filter * (1.0 - FILTER_EMA) + filter_target * FILTER_EMA;

        // ── Threat gate ───────────────────────────────────────────────────────
        let threat_gate_open = amygdala_arousal >= THREAT_GATE_THRESHOLD || threat_hits >= 2;
        if threat_gate_open {
            self.threat_gates += 1;
        }

        // ── Release mode ──────────────────────────────────────────────────────
        let release_mode = self.inhibition_level <= RELEASE_THRESHOLD && oxytocin_bond > 0.50;
        if release_mode {
            self.release_events += 1;
        }

        ZIOutput {
            inhibition_level: self.inhibition_level,
            salience_filter: self.salience_filter,
            threat_gate_open,
            release_mode,
            attentional_bandwidth: 1.0 - self.inhibition_level,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Inhibition decays toward baseline (attention gradually opens)
        if self.inhibition_level > INHIBITION_BASELINE {
            self.inhibition_level = (self.inhibition_level - 0.015).max(INHIBITION_BASELINE);
        } else if self.inhibition_level < INHIBITION_BASELINE {
            self.inhibition_level = (self.inhibition_level + 0.008).min(INHIBITION_BASELINE);
        }
        // Salience filter decays toward moderate
        self.salience_filter = self.salience_filter * 0.99 + 0.40 * 0.01;
    }

    /// Current output without processing.
    pub fn current_output(&self) -> ZIOutput {
        ZIOutput {
            inhibition_level: self.inhibition_level,
            salience_filter: self.salience_filter,
            threat_gate_open: false,
            release_mode: self.inhibition_level <= RELEASE_THRESHOLD,
            attentional_bandwidth: 1.0 - self.inhibition_level,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "ZI inhibition={:.2} | filter={:.2} | bandwidth={:.2}{}",
            self.inhibition_level,
            self.salience_filter,
            1.0 - self.inhibition_level,
            if self.inhibition_level <= RELEASE_THRESHOLD {
                " RELEASE"
            } else {
                ""
            },
        )
    }
}

impl Default for ZonaIncerta {
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
        let z = ZonaIncerta::new();
        assert!((z.inhibition_level - INHIBITION_BASELINE).abs() < 0.01);
    }

    #[test]
    fn test_high_amygdala_raises_inhibition() {
        let mut z = ZonaIncerta::new();
        let before = z.inhibition_level;
        z.process("some neutral text", 0.90, 0.70, 0.20);
        assert!(
            z.inhibition_level > before,
            "high amygdala arousal should raise inhibition: {:.2} → {:.2}",
            before,
            z.inhibition_level
        );
    }

    #[test]
    fn test_threat_words_raise_inhibition() {
        let mut z = ZonaIncerta::new();
        let before = z.inhibition_level;
        z.process(
            "critical emergency error urgent warning danger",
            0.20,
            0.30,
            0.20,
        );
        assert!(
            z.inhibition_level > before,
            "threat words should raise inhibition: {:.2} → {:.2}",
            before,
            z.inhibition_level
        );
    }

    #[test]
    fn test_high_oxytocin_lowers_inhibition() {
        let mut z = ZonaIncerta::new();
        z.inhibition_level = 0.60;
        z.process("safe comfortable relaxed easy clear", 0.05, 0.10, 0.90);
        assert!(
            z.inhibition_level < 0.60,
            "high oxytocin + safety should reduce inhibition: {:.2}",
            z.inhibition_level
        );
    }

    #[test]
    fn test_threat_gate_opens_at_high_arousal() {
        let mut z = ZonaIncerta::new();
        let out = z.process("neutral", 0.80, 0.50, 0.30);
        assert!(
            out.threat_gate_open,
            "high amygdala arousal should open threat gate"
        );
    }

    #[test]
    fn test_release_mode_at_low_inhibition_high_bond() {
        let mut z = ZonaIncerta::new();
        z.inhibition_level = 0.20;
        let out = z.process("safe and comfortable", 0.05, 0.10, 0.80);
        assert!(
            out.release_mode,
            "low inhibition + high bond should trigger release mode"
        );
    }

    #[test]
    fn test_attentional_bandwidth_inverse_of_inhibition() {
        let z = ZonaIncerta::new();
        let out = z.current_output();
        assert!((out.attentional_bandwidth - (1.0 - z.inhibition_level)).abs() < 0.001);
    }

    #[test]
    fn test_decay_restores_baseline() {
        let mut z = ZonaIncerta::new();
        z.inhibition_level = 0.80;
        for _ in 0..30 {
            z.decay();
        }
        assert!(
            z.inhibition_level < 0.80,
            "inhibition should decay toward baseline: {:.2}",
            z.inhibition_level
        );
        assert!(z.inhibition_level >= INHIBITION_BASELINE - 0.05);
    }

    #[test]
    fn test_status_line() {
        let z = ZonaIncerta::new();
        let s = z.status_line();
        assert!(s.contains("ZI"), "status should mention ZI");
        assert!(s.contains("inhibition"), "status should show inhibition");
    }
}

