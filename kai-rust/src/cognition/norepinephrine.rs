/// Norepinephrine (Locus Coeruleus) — Alertness, Gain Control, Stress Response
///
/// The Locus Coeruleus is a tiny nucleus in the brainstem that sends
/// norepinephrine (NE) throughout the entire brain. It is the arousal
/// dial — it controls signal-to-noise ratio, focus, and stress response.
///
/// Without NE:
///   KAI treats all inputs as equally salient.
///   There is no difference between a routine query and a surprising one.
///   There is no stress response, no heightened focus, no alertness axis.
///   KAI is always at the same attentional "volume."
///
/// With NE:
///   Novel, surprising, or threatening inputs spike NE.
///   High NE → gain rises → salient signals are amplified, noise suppressed.
///   Low NE → diffuse, slow, unfocused state.
///   Optimal NE (~0.55) → peak cognitive performance (Yerkes-Dodson curve).
///   Chronic high NE (stress_load > 0.65) → cognitive narrowing, reactivity.
///
/// Yerkes-Dodson Inverted-U:
///   alertness = 1.0 - 4.0 * (level - 0.55)²
///   This peaks at level ≈ 0.55 and falls at both extremes.
///   Too little NE = inattentive.  Too much = overwhelmed.
///
/// Architecture:
///   NorepinephrineSystem tracks:
///     - level (phasic NE, fast-moving)
///     - stress_load (slow-accumulating, slow-decaying)
///     - baseline (tonic NE, very slow EMA)
///     - gain (signal amplification factor derived from level)
///
///   NeEvent enum drives level changes.
///   gain_factor() feeds into GlobalWorkspace salience gating.
///   attention_threshold() sets the floor for what gets GW entry.
///   is_stressed() flags chronic high-NE states for behavioral adjustment.

// ── Constants ─────────────────────────────────────────────────────────────────

/// Natural resting level of NE
const NE_BASELINE: f32 = 0.50;

/// Optimal NE level for peak alertness (Yerkes-Dodson peak)
const NE_OPTIMAL: f32 = 0.55;

/// Passive decay rate per tick toward baseline
const NE_DECAY: f32 = 0.008;

/// Stress accumulation rate per stressor event
const STRESS_RISE: f32 = 0.06;

/// Stress passive decay per tick (much slower than NE decay)
const STRESS_DECAY: f32 = 0.002;

/// Very slow EMA alpha for tonic baseline tracking
const BASELINE_ALPHA: f32 = 0.003;

/// NE gain multiplier at peak arousal (level = 1.0)
const MAX_GAIN: f32 = 2.0;

/// Stress threshold above which is_stressed() returns true
const STRESS_THRESHOLD: f32 = 0.65;

// ── NeEvent ───────────────────────────────────────────────────────────────────

/// Events that modulate norepinephrine level
#[derive(Debug, Clone, PartialEq)]
pub enum NeEvent {
    /// Unexpected or novel input — moderate phasic NE spike
    NovelInput,
    /// Very high-salience input — sharp NE spike
    HighSalience,
    /// Prediction mismatch / ACC conflict — focused alerting
    Conflict,
    /// Hostile, distressing, or threatening input — stress NE spike
    Threat,
    /// Positive outcome / task success — mild NE rise (reward salience)
    Success,
    /// Long session, many consecutive exchanges — fatigue dip
    Fatigue,
    /// Passive tick decay — called every heartbeat
    Decay,
}

// ── NorepinephrineSystem ──────────────────────────────────────────────────────

#[derive(Debug)]
pub struct NorepinephrineSystem {
    /// Current phasic NE level (0.0 – 1.0)
    pub level: f32,
    /// Slow-accumulating stress load (0.0 – 1.0)
    pub stress_load: f32,
    /// Tonic baseline (very slow EMA of level)
    pub baseline: f32,
    /// Current neural gain factor (1.0 at rest, up to MAX_GAIN)
    pub gain: f32,
    /// Total events processed
    pub event_count: u64,
}

impl NorepinephrineSystem {
    pub fn new() -> Self {
        Self {
            level: NE_BASELINE,
            stress_load: 0.0,
            baseline: NE_BASELINE,
            gain: 1.0,
            event_count: 0,
        }
    }

    // ── Core update ───────────────────────────────────────────────────────────

    /// Process a NE event, update level + stress, return the delta.
    pub fn process(&mut self, event: NeEvent) -> f32 {
        let old_level = self.level;

        match event {
            NeEvent::NovelInput => {
                self.level = (self.level + 0.12).min(1.0);
            }
            NeEvent::HighSalience => {
                self.level = (self.level + 0.18).min(1.0);
            }
            NeEvent::Conflict => {
                self.level = (self.level + 0.10).min(1.0);
                self.stress_load = (self.stress_load + STRESS_RISE * 0.5).min(1.0);
            }
            NeEvent::Threat => {
                self.level = (self.level + 0.22).min(1.0);
                self.stress_load = (self.stress_load + STRESS_RISE).min(1.0);
            }
            NeEvent::Success => {
                self.level = (self.level + 0.06).min(1.0);
                // Success slowly reduces stress load
                self.stress_load = (self.stress_load - STRESS_RISE * 0.3).max(0.0);
            }
            NeEvent::Fatigue => {
                // Fatigue drops both level and baseline a little
                self.level = (self.level - 0.08).max(0.0);
                self.baseline = (self.baseline - 0.005).max(0.30);
            }
            NeEvent::Decay => {
                // Level decays toward baseline
                self.level += (self.baseline - self.level) * NE_DECAY;
                self.stress_load = (self.stress_load - STRESS_DECAY).max(0.0);
            }
        }

        // Always update tonic baseline (very slow EMA)
        self.baseline = self.baseline * (1.0 - BASELINE_ALPHA) + self.level * BASELINE_ALPHA;

        // Recompute gain from current level
        self.gain = 1.0 + (self.level / 1.0) * (MAX_GAIN - 1.0);

        self.event_count += 1;

        self.level - old_level
    }

    /// Passive decay — call every heartbeat tick.
    pub fn decay(&mut self) {
        self.process(NeEvent::Decay);
    }

    // ── Derived metrics ───────────────────────────────────────────────────────

    /// Alertness score: inverted-U (Yerkes-Dodson) — peaks at NE_OPTIMAL.
    /// Returns 0.0 – 1.0. Optimal ≈ 0.55, degrades at both extremes.
    pub fn alertness_score(&self) -> f32 {
        let deviation = self.level - NE_OPTIMAL;
        let raw = 1.0 - 4.0 * deviation * deviation;
        raw.clamp(0.0, 1.0)
    }

    /// Neural gain factor — amplifies salient signal weights when NE is elevated.
    /// Returns 1.0 at baseline, up to MAX_GAIN at level=1.0.
    pub fn gain_factor(&self) -> f32 {
        self.gain.clamp(1.0, MAX_GAIN)
    }

    /// Minimum salience threshold NE recommends for Global Workspace entry.
    /// High alertness → lower threshold (more gets in — scanning mode).
    /// High stress   → higher threshold (tunnel vision — only top signals).
    pub fn attention_threshold(&self) -> f32 {
        if self.is_stressed() {
            // Stress narrows attention: only very strong signals admitted
            0.65 + self.stress_load * 0.15
        } else {
            // Alertness normally lowers threshold — more open scanning
            0.40 - self.alertness_score() * 0.10
        }
    }

    /// True when chronic stress load has built up above threshold.
    /// Used by PFC and voice to adjust response tone and length.
    pub fn is_stressed(&self) -> bool {
        self.stress_load > STRESS_THRESHOLD
    }

    /// Classify current arousal state as a human-readable label.
    pub fn arousal_state(&self) -> &'static str {
        match self.level {
            l if l < 0.25 => "understimulated",
            l if l < 0.42 => "low-arousal",
            l if l < 0.62 => "focused",
            l if l < 0.78 => "heightened",
            l if l < 0.90 => "high-alert",
            _ => "overwhelmed",
        }
    }

    /// Detect whether the input text is novel/surprising given a cosine score.
    /// Low cosine similarity → low familiarity → triggers NovelInput.
    /// Returns the appropriate NeEvent.
    pub fn classify_input(cosine: f32, salience: f32) -> NeEvent {
        if salience > 0.75 {
            NeEvent::HighSalience
        } else if cosine < 0.20 {
            NeEvent::NovelInput
        } else if cosine < 0.40 && salience > 0.50 {
            NeEvent::NovelInput
        } else {
            NeEvent::Decay // nothing special — passive
        }
    }

    /// Produce a brief status string for the brain monitor display.
    pub fn status_line(&self) -> String {
        format!(
            "NE {:.2} | arousal={} | gain={:.2} | stress={:.2}",
            self.level,
            self.arousal_state(),
            self.gain_factor(),
            self.stress_load,
        )
    }
}

impl Default for NorepinephrineSystem {
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
        let ne = NorepinephrineSystem::new();
        assert!(
            (ne.level - 0.50).abs() < 0.01,
            "initial level should be 0.50"
        );
        assert_eq!(ne.stress_load, 0.0);
        assert!(!ne.is_stressed());
    }

    #[test]
    fn test_novel_input_raises_level() {
        let mut ne = NorepinephrineSystem::new();
        let before = ne.level;
        ne.process(NeEvent::NovelInput);
        assert!(ne.level > before, "novel input should raise NE");
    }

    #[test]
    fn test_threat_raises_stress() {
        let mut ne = NorepinephrineSystem::new();
        for _ in 0..12 {
            ne.process(NeEvent::Threat);
        }
        assert!(
            ne.is_stressed(),
            "repeated threats should build stress load"
        );
    }

    #[test]
    fn test_success_reduces_stress() {
        let mut ne = NorepinephrineSystem::new();
        ne.stress_load = 0.80;
        let before = ne.stress_load;
        ne.process(NeEvent::Success);
        assert!(ne.stress_load < before, "success should reduce stress load");
    }

    #[test]
    fn test_alertness_peaks_at_optimal() {
        let mut ne = NorepinephrineSystem::new();
        // Set level to optimal
        ne.level = 0.55;
        let at_optimal = ne.alertness_score();
        // Set level to extremes
        ne.level = 0.0;
        let at_zero = ne.alertness_score();
        ne.level = 1.0;
        let at_max = ne.alertness_score();

        assert!(
            at_optimal > at_zero,
            "optimal NE should beat low NE for alertness"
        );
        assert!(
            at_optimal > at_max,
            "optimal NE should beat high NE for alertness"
        );
        assert!(
            (at_optimal - 1.0).abs() < 0.01,
            "alertness at optimal should be ~1.0"
        );
    }

    #[test]
    fn test_inverted_u_symmetry() {
        let mut ne = NorepinephrineSystem::new();
        // Test symmetry around 0.55
        ne.level = 0.55 - 0.15; // 0.40
        let below = ne.alertness_score();
        ne.level = 0.55 + 0.15; // 0.70
        let above = ne.alertness_score();
        // Should be approximately equal (symmetric curve)
        assert!(
            (below - above).abs() < 0.05,
            "alertness curve should be roughly symmetric: below={:.3} above={:.3}",
            below,
            above
        );
    }

    #[test]
    fn test_gain_factor_rises_with_level() {
        let mut ne = NorepinephrineSystem::new();
        ne.level = 0.30;
        ne.gain = 1.0 + ne.level * (2.0 - 1.0);
        let low_gain = ne.gain_factor();
        ne.level = 0.90;
        ne.gain = 1.0 + ne.level * (2.0 - 1.0);
        let high_gain = ne.gain_factor();
        assert!(high_gain > low_gain, "gain should rise with NE level");
    }

    #[test]
    fn test_attention_threshold_stress_tunnel() {
        let mut ne = NorepinephrineSystem::new();
        ne.stress_load = 0.80; // well above threshold
        let stressed_threshold = ne.attention_threshold();
        ne.stress_load = 0.0;
        let calm_threshold = ne.attention_threshold();
        assert!(
            stressed_threshold > calm_threshold,
            "stress should raise attention threshold (tunnel vision): stressed={:.2} calm={:.2}",
            stressed_threshold,
            calm_threshold
        );
    }

    #[test]
    fn test_decay_moves_toward_baseline() {
        let mut ne = NorepinephrineSystem::new();
        ne.level = 0.90; // spike
        for _ in 0..50 {
            ne.decay();
        }
        assert!(ne.level < 0.90, "NE should decay from spike");
        assert!(ne.level > 0.30, "NE should not collapse to zero");
    }

    #[test]
    fn test_arousal_state_labels() {
        let mut ne = NorepinephrineSystem::new();
        ne.level = 0.10;
        assert_eq!(ne.arousal_state(), "understimulated");
        ne.level = 0.52;
        assert_eq!(ne.arousal_state(), "focused");
        ne.level = 0.95;
        assert_eq!(ne.arousal_state(), "overwhelmed");
    }

    #[test]
    fn test_classify_input_novel() {
        let event = NorepinephrineSystem::classify_input(0.10, 0.40);
        assert_eq!(
            event,
            NeEvent::NovelInput,
            "very low cosine should be novel"
        );
    }

    #[test]
    fn test_classify_input_high_salience() {
        let event = NorepinephrineSystem::classify_input(0.70, 0.90);
        assert_eq!(
            event,
            NeEvent::HighSalience,
            "high salience should override"
        );
    }

    #[test]
    fn test_fatigue_drops_level() {
        let mut ne = NorepinephrineSystem::new();
        let before = ne.level;
        ne.process(NeEvent::Fatigue);
        assert!(ne.level < before, "fatigue should drop NE level");
    }

    #[test]
    fn test_status_line_non_empty() {
        let ne = NorepinephrineSystem::new();
        let s = ne.status_line();
        assert!(s.contains("NE"), "status line should mention NE");
        assert!(s.contains("gain"), "status line should mention gain");
    }
}
