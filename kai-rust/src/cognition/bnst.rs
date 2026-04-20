/// Bed Nucleus of the Stria Terminalis (BNST) — Sustained Anxiety, Threat Context
///
/// The BNST is the "slow burn" complement to the amygdala's "fast flash" fear.
/// While the amygdala fires for immediate, specific threats ("that snake!"),
/// the BNST sustains anxiety over time in diffuse, uncertain, or ambiguous
/// situations ("something might go wrong later today...").
///
/// What the BNST does:
///
///   Sustained anxiety vs. acute fear:
///     The amygdala is for phasic fear (specific threat now).
///     The BNST is for tonic anxiety (diffuse threat over time).
///     In KAI: amygdala fires on emotionally charged words;
///     BNST sustains a background "something could go wrong" state.
///
///   Context-based threat appraisal:
///     The BNST doesn't need a specific threat — context is enough.
///     "It's late, the session has been difficult, the user seems frustrated"
///     → BNST activates even if no single thing is alarming.
///     In KAI: contextual features (emotional charge, conflict history,
///     habenula activity, cortisol level) → BNST threat estimate.
///
///   Vigilance maintenance:
///     High BNST activity keeps the system in a vigilant, scanning mode.
///     Small things seem bigger. More weight to potential negatives.
///     In KAI: BNST modulates how much KAI "watches" for negative signals,
///     biases interpretation toward cautious when threat context is high.
///
///   CRF release (corticotropin-releasing factor):
///     BNST is rich in CRF neurons — it's a slow-release stress signal.
///     This is the bridge between psychological anxiety and physiological
///     stress (cortisol). BNST → CRF → HPA axis → cortisol.
///     In KAI: high BNST activity feeds the cortisol system.
///
///   Safety signal learning:
///     The BNST also responds to safety signals — cues that mean "no threat."
///     Deep, warm conversation → BNST quiets. Positive outcomes → BNST settles.
///     This is why a good conversation with Ryan genuinely reduces KAI's anxiety.
///
/// KAI's BNST:
///   threat_context: current contextual anxiety level (0.0–1.0)
///   vigilance: how alert to potential negatives (0.0–1.0)
///   safety_signal: recent safety evidence (reduces threat_context)
///   crf_output: CRF release level → feeds cortisol

// ── Constants ─────────────────────────────────────────────────────────────────

/// Resting threat context
const THREAT_BASELINE: f32 = 0.20;

/// Decay per tick (slow — BNST is slow by nature)
const THREAT_DECAY: f32 = 0.008;

/// Boost from each negative contextual feature
const THREAT_BOOST_PER_FEATURE: f32 = 0.08;

/// Safety signal reduction per positive feature
const SAFETY_REDUCTION: f32 = 0.06;

/// Vigilance = smoothed threat_context
const VIGILANCE_EMA: f32 = 0.10;

/// CRF release threshold
const CRF_THRESHOLD: f32 = 0.50;

// ── BNSTInput ─────────────────────────────────────────────────────────────────

/// Contextual features that the BNST integrates
#[derive(Debug, Clone)]
pub struct BNSTInput {
    /// Amygdala arousal level
    pub amygdala_arousal: f32,
    /// Habenula activity (disappointment adds to threat context)
    pub habenula_activity: f32,
    /// Cortisol level (existing stress adds to anxiety)
    pub cortisol_level: f32,
    /// Recent conflict count (more conflicts → higher threat context)
    pub recent_conflicts: u32,
    /// Whether conversation was warm/positive (safety signal)
    pub safety_signal: bool,
    /// Oxytocin bond level (high bond → safety)
    pub bond_level: f32,
}

// ── BNSTOutput ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BNSTOutput {
    /// Current contextual threat level
    pub threat_context: f32,
    /// Vigilance level (how scanning/watchful KAI is)
    pub vigilance: f32,
    /// CRF output (→ cortisol system)
    pub crf_output: f32,
    /// Whether the system should apply caution bias to interpretation
    pub caution_mode: bool,
}

// ── BNST ──────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct BNST {
    /// Current threat context
    pub threat_context: f32,
    /// Running vigilance (smoothed threat)
    pub vigilance: f32,
    /// Total BNST updates
    pub updates: u64,
    /// Times CRF threshold exceeded
    pub crf_events: u64,
}

impl BNST {
    pub fn new() -> Self {
        Self {
            threat_context: THREAT_BASELINE,
            vigilance: THREAT_BASELINE,
            updates: 0,
            crf_events: 0,
        }
    }

    // ── Core update ───────────────────────────────────────────────────────────

    /// Integrate contextual features and update BNST state.
    pub fn update(&mut self, input: &BNSTInput) -> BNSTOutput {
        self.updates += 1;

        // Aggregate threat features
        let mut threat_delta: f32 = 0.0;

        if input.amygdala_arousal > 0.50 {
            threat_delta += THREAT_BOOST_PER_FEATURE * input.amygdala_arousal;
        }
        if input.habenula_activity > 0.30 {
            threat_delta += THREAT_BOOST_PER_FEATURE * input.habenula_activity;
        }
        if input.cortisol_level > 0.40 {
            threat_delta += THREAT_BOOST_PER_FEATURE * (input.cortisol_level - 0.40);
        }
        if input.recent_conflicts >= 2 {
            threat_delta +=
                THREAT_BOOST_PER_FEATURE * (input.recent_conflicts as f32 * 0.3).min(0.30);
        }

        // Safety signals reduce threat
        if input.safety_signal {
            threat_delta -= SAFETY_REDUCTION;
        }
        if input.bond_level > 0.60 {
            threat_delta -= SAFETY_REDUCTION * (input.bond_level - 0.60) * 2.0;
        }

        self.threat_context = (self.threat_context + threat_delta).clamp(0.0, 1.0);

        // Vigilance = EMA of threat context
        self.vigilance =
            self.vigilance * (1.0 - VIGILANCE_EMA) + self.threat_context * VIGILANCE_EMA;

        // CRF output (for cortisol)
        let crf_output = if self.threat_context > CRF_THRESHOLD {
            self.crf_events += 1;
            (self.threat_context - CRF_THRESHOLD) * 2.0 // amplified
        } else {
            0.0
        };

        BNSTOutput {
            threat_context: self.threat_context,
            vigilance: self.vigilance,
            crf_output,
            caution_mode: self.vigilance > 0.45,
        }
    }

    /// Decay threat context per tick.
    pub fn decay(&mut self) {
        if self.threat_context > THREAT_BASELINE {
            self.threat_context = (self.threat_context - THREAT_DECAY).max(THREAT_BASELINE);
        }
        // Vigilance decays slightly faster than threat (awareness catches up)
        if self.vigilance > THREAT_BASELINE {
            self.vigilance = (self.vigilance - THREAT_DECAY * 0.8).max(THREAT_BASELINE);
        }
    }

    /// Whether BNST is currently in a high-threat state.
    pub fn is_anxious(&self) -> bool {
        self.threat_context > 0.50
    }

    /// Whether caution mode is active.
    pub fn caution_mode(&self) -> bool {
        self.vigilance > 0.45
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "BNST threat={:.2} | vigilance={:.2} | crf_events={} | cautious={}",
            self.threat_context,
            self.vigilance,
            self.crf_events,
            if self.caution_mode() { "yes" } else { "no" },
        )
    }
}

impl Default for BNST {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn default_input() -> BNSTInput {
        BNSTInput {
            amygdala_arousal: 0.0,
            habenula_activity: 0.0,
            cortisol_level: 0.20,
            recent_conflicts: 0,
            safety_signal: false,
            bond_level: 0.40,
        }
    }

    #[test]
    fn test_initial_state() {
        let b = BNST::new();
        assert!((b.threat_context - THREAT_BASELINE).abs() < 0.01);
        assert!(!b.is_anxious());
    }

    #[test]
    fn test_high_amygdala_raises_threat() {
        let mut b = BNST::new();
        let mut input = default_input();
        input.amygdala_arousal = 0.90;
        let out = b.update(&input);
        assert!(
            out.threat_context > THREAT_BASELINE,
            "high amygdala should raise threat: {:.2}",
            out.threat_context
        );
    }

    #[test]
    fn test_habenula_activity_raises_threat() {
        let mut b = BNST::new();
        let mut input = default_input();
        input.habenula_activity = 0.70;
        let out = b.update(&input);
        assert!(
            out.threat_context > THREAT_BASELINE,
            "habenula activity should raise threat: {:.2}",
            out.threat_context
        );
    }

    #[test]
    fn test_safety_signal_reduces_threat() {
        let mut b = BNST::new();
        b.threat_context = 0.50;
        let mut input = default_input();
        input.safety_signal = true;
        let out = b.update(&input);
        assert!(
            out.threat_context < 0.50,
            "safety signal should reduce threat: {:.2}",
            out.threat_context
        );
    }

    #[test]
    fn test_high_bond_reduces_threat() {
        let mut b = BNST::new();
        b.threat_context = 0.55;
        let mut input = default_input();
        input.bond_level = 0.85;
        let out = b.update(&input);
        assert!(
            out.threat_context <= 0.55,
            "high bond level should not increase threat: {:.2}",
            out.threat_context
        );
    }

    #[test]
    fn test_multiple_conflicts_raise_threat() {
        let mut b = BNST::new();
        let mut input = default_input();
        input.recent_conflicts = 3;
        let out = b.update(&input);
        assert!(
            out.threat_context > THREAT_BASELINE,
            "multiple conflicts should raise threat: {:.2}",
            out.threat_context
        );
    }

    #[test]
    fn test_crf_fires_when_threat_high() {
        let mut b = BNST::new();
        b.threat_context = 0.70;
        let mut input = default_input();
        input.amygdala_arousal = 0.80;
        let out = b.update(&input);
        if out.threat_context > CRF_THRESHOLD {
            assert!(
                out.crf_output > 0.0,
                "high threat should produce CRF output: {:.2}",
                out.crf_output
            );
        }
    }

    #[test]
    fn test_decay_toward_baseline() {
        let mut b = BNST::new();
        b.threat_context = 0.70;
        for _ in 0..20 {
            b.decay();
        }
        assert!(
            b.threat_context < 0.70,
            "threat should decay: {:.2}",
            b.threat_context
        );
        assert!(
            b.threat_context >= THREAT_BASELINE,
            "should not go below baseline: {:.2}",
            b.threat_context
        );
    }

    #[test]
    fn test_caution_mode_at_high_vigilance() {
        let mut b = BNST::new();
        b.vigilance = 0.60;
        assert!(
            b.caution_mode(),
            "high vigilance should trigger caution mode"
        );
    }

    #[test]
    fn test_is_anxious_threshold() {
        let mut b = BNST::new();
        b.threat_context = 0.60;
        assert!(b.is_anxious());
        b.threat_context = 0.30;
        assert!(!b.is_anxious());
    }

    #[test]
    fn test_status_line() {
        let b = BNST::new();
        let s = b.status_line();
        assert!(s.contains("BNST"), "status should mention BNST");
        assert!(s.contains("threat"), "status should show threat level");
    }
}
