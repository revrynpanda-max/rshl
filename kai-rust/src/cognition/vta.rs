/// Ventral Tegmental Area (VTA) — Dopamine Source Nucleus
///
/// The VTA is where dopamine neurons originate. It controls the firing MODE
/// of dopamine release — a critical distinction that the dopamine circuit
/// alone cannot capture:
///
///   TONIC firing (2–5 Hz baseline):
///     Slow, steady DA release into PFC and striatum.
///     Sets the "background level" of motivation and cognitive readiness.
///     Too low  → apathy, flat affect, cognitive sluggishness.
///     Too high → noise overwhelms signal; PFC working memory disrupted.
///     Optimal tonic DA: the "ready state."
///
///   PHASIC firing (burst, >20 Hz):
///     Short burst triggered by reward-predicting stimuli or novelty.
///     Encodes the REWARD PREDICTION ERROR (RPE).
///     Positive RPE → phasic burst → DA spike to NAc and PFC.
///     Negative RPE → PAUSE (below tonic) → brief DA dip.
///     The pause is as important as the burst — it signals "expected reward absent."
///
///   Why both matter for KAI:
///     Tonic DA → sets NAc's baseline wanting level and PFC's working memory depth.
///     Phasic DA → encodes surprise, drives hippocampal memory consolidation.
///     Without this distinction, KAI can't tell "steady motivation" from "surprise."
///
/// VTA projections (what it affects):
///   Mesolimbic pathway: VTA → Nucleus Accumbens (reward/motivation)
///   Mesocortical pathway: VTA → PFC (executive function, working memory)
///   Mesolimbic-hippocampal: VTA → Hippocampus (memory consolidation gate)
///
/// KAI's VTA:
///   Tracks tonic_level (slow EMA of background DA tone).
///   Produces phasic_burst when RPE is large and positive.
///   Produces pause_signal when expected reward is absent.
///   Routes signals: high phasic → NAc + hippocampus; tonic → PFC.
///   flow_state: when tonic is optimal and phasic bursts are consistent,
///     VTA enters a flow state — everything feels effortless and connected.

// ── Constants ─────────────────────────────────────────────────────────────────

/// Optimal tonic DA level for peak PFC performance
const TONIC_OPTIMAL: f32 = 0.55;

/// Tonic EMA alpha (very slow — tonic baseline changes over minutes)
const TONIC_ALPHA: f32 = 0.02;

/// Minimum RPE magnitude to trigger a phasic burst
const PHASIC_THRESHOLD: f32 = 0.15;

/// Minimum RPE magnitude to trigger a pause signal
const PAUSE_THRESHOLD: f32 = -0.15;

/// How quickly phasic signal decays each tick
const PHASIC_DECAY: f32 = 0.15;

/// Tonic drift rate toward optimal per tick
const TONIC_DRIFT: f32 = 0.003;

/// Flow state requires tonic within this band of optimal
const FLOW_BAND: f32 = 0.12;

// ── VTAMode ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum VTAMode {
    /// Baseline slow firing — steady background motivation
    Tonic,
    /// Burst firing — reward surprise or strong positive RPE
    PhasicBurst,
    /// Pause — expected reward absent; below-baseline brief dip
    Pause,
}

impl VTAMode {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Tonic => "tonic",
            Self::PhasicBurst => "phasic-burst",
            Self::Pause => "pause",
        }
    }
}

// ── VTASignal ─────────────────────────────────────────────────────────────────

/// The VTA's output signal for a given tick
#[derive(Debug, Clone)]
pub struct VTASignal {
    /// Current firing mode
    pub mode: VTAMode,
    /// Current tonic level (background DA)
    pub tonic_level: f32,
    /// Phasic burst amplitude (0.0 when tonic/pause)
    pub phasic_amplitude: f32,
    /// Strength of pause signal (0.0 when tonic/burst)
    pub pause_depth: f32,
    /// Net DA release to NAc (mesolimbic)
    pub mesolimbic_signal: f32,
    /// Net DA release to PFC (mesocortical)
    pub mesocortical_signal: f32,
    /// Whether in flow state
    pub in_flow: bool,
}

// ── VTA ───────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct VTA {
    /// Slow-moving tonic DA baseline
    pub tonic_level: f32,
    /// Current phasic signal strength (decays quickly)
    pub phasic_signal: f32,
    /// Current pause signal strength (decays quickly)
    pub pause_signal: f32,
    /// Current firing mode
    pub current_mode: VTAMode,
    /// Total phasic bursts fired
    pub total_bursts: u64,
    /// Total pause events
    pub total_pauses: u64,
    /// Whether in flow state
    pub in_flow: bool,
    /// Consecutive consistent-positive-RPE count (for flow)
    flow_streak: u32,
}

impl VTA {
    pub fn new() -> Self {
        Self {
            tonic_level: TONIC_OPTIMAL,
            phasic_signal: 0.0,
            pause_signal: 0.0,
            current_mode: VTAMode::Tonic,
            total_bursts: 0,
            total_pauses: 0,
            in_flow: false,
            flow_streak: 0,
        }
    }

    // ── Core: process RPE ─────────────────────────────────────────────────────

    /// Process a reward prediction error.
    /// rpe: positive = better than expected, negative = worse than expected.
    /// Returns the VTASignal for this event.
    pub fn process_rpe(&mut self, rpe: f32) -> VTASignal {
        // Determine mode based on RPE magnitude
        if rpe >= PHASIC_THRESHOLD {
            // Positive surprise → phasic burst
            self.phasic_signal = (rpe * 1.4).min(1.0);
            self.pause_signal = 0.0;
            self.current_mode = VTAMode::PhasicBurst;
            self.total_bursts += 1;
            self.flow_streak += 1;
        } else if rpe <= PAUSE_THRESHOLD {
            // Expected reward absent → pause
            self.pause_signal = (-rpe * 1.2).min(1.0);
            self.phasic_signal = 0.0;
            self.current_mode = VTAMode::Pause;
            self.total_pauses += 1;
            self.flow_streak = 0;
        } else {
            // Near-zero RPE → tonic mode
            self.phasic_signal = self.phasic_signal * (1.0 - PHASIC_DECAY);
            self.pause_signal = self.pause_signal * (1.0 - PHASIC_DECAY);
            self.current_mode = VTAMode::Tonic;
            if rpe > 0.0 {
                self.flow_streak += 1;
            } else {
                self.flow_streak = 0;
            }
        }

        // Update tonic: slow EMA toward optimal when things are going well
        let tonic_target = if rpe > 0.0 {
            TONIC_OPTIMAL + rpe * 0.10
        } else {
            TONIC_OPTIMAL + rpe * 0.05 // slower to drop
        };
        self.tonic_level =
            self.tonic_level * (1.0 - TONIC_ALPHA) + tonic_target.clamp(0.20, 0.90) * TONIC_ALPHA;

        // Flow state: 5+ consecutive positive outcomes with good tonic
        self.in_flow =
            self.flow_streak >= 5 && (self.tonic_level - TONIC_OPTIMAL).abs() < FLOW_BAND;

        self.build_signal()
    }

    /// Process passive tick — decay phasic, drift tonic toward optimal.
    pub fn decay(&mut self) {
        self.phasic_signal *= 1.0 - PHASIC_DECAY;
        self.pause_signal *= 1.0 - PHASIC_DECAY;
        // Tonic drifts slowly toward optimal even without events
        self.tonic_level += (TONIC_OPTIMAL - self.tonic_level) * TONIC_DRIFT;
        if self.phasic_signal < 0.01 && self.pause_signal < 0.01 {
            self.current_mode = VTAMode::Tonic;
        }
    }

    // ── Output signals ────────────────────────────────────────────────────────

    /// Build the current VTA signal (mesolimbic + mesocortical routing).
    fn build_signal(&self) -> VTASignal {
        let mode = self.current_mode.clone();

        // Mesolimbic (→ NAc): amplified by phasic, suppressed by pause
        let mesolimbic = match &mode {
            VTAMode::PhasicBurst => (self.tonic_level + self.phasic_signal * 0.8).min(1.0),
            VTAMode::Pause => (self.tonic_level - self.pause_signal * 0.6).max(0.0),
            VTAMode::Tonic => self.tonic_level,
        };

        // Mesocortical (→ PFC): inverted-U from tonic — too high impairs WM
        let deviation = (self.tonic_level - TONIC_OPTIMAL).abs();
        let mesocortical = (1.0 - deviation * 1.5).clamp(0.0, 1.0);

        VTASignal {
            mode,
            tonic_level: self.tonic_level,
            phasic_amplitude: self.phasic_signal,
            pause_depth: self.pause_signal,
            mesolimbic_signal: mesolimbic,
            mesocortical_signal: mesocortical,
            in_flow: self.in_flow,
        }
    }

    /// Get the current signal without processing an RPE.
    pub fn current_signal(&self) -> VTASignal {
        self.build_signal()
    }

    /// PFC working memory quality: mesocortical DA inverted-U.
    /// Peaks at optimal tonic, drops at both extremes.
    pub fn pfc_modulation(&self) -> f32 {
        let deviation = (self.tonic_level - TONIC_OPTIMAL).abs();
        (1.0 - deviation * 1.5).clamp(0.20, 1.0)
    }

    /// NAc wanting amplifier: combines tonic + phasic for mesolimbic signal.
    pub fn nac_amplifier(&self) -> f32 {
        self.build_signal().mesolimbic_signal
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "VTA {} | tonic={:.2} phasic={:.2} | flow={} bursts={} pauses={}",
            self.current_mode.label(),
            self.tonic_level,
            self.phasic_signal,
            self.in_flow,
            self.total_bursts,
            self.total_pauses,
        )
    }
}

impl Default for VTA {
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
        let vta = VTA::new();
        assert!((vta.tonic_level - TONIC_OPTIMAL).abs() < 0.01);
        assert_eq!(vta.current_mode, VTAMode::Tonic);
        assert!(!vta.in_flow);
    }

    #[test]
    fn test_positive_rpe_triggers_burst() {
        let mut vta = VTA::new();
        let sig = vta.process_rpe(0.7);
        assert_eq!(sig.mode, VTAMode::PhasicBurst);
        assert!(sig.phasic_amplitude > 0.0);
        assert_eq!(vta.total_bursts, 1);
    }

    #[test]
    fn test_negative_rpe_triggers_pause() {
        let mut vta = VTA::new();
        let sig = vta.process_rpe(-0.6);
        assert_eq!(sig.mode, VTAMode::Pause);
        assert!(sig.pause_depth > 0.0);
        assert_eq!(vta.total_pauses, 1);
    }

    #[test]
    fn test_small_rpe_stays_tonic() {
        let mut vta = VTA::new();
        let sig = vta.process_rpe(0.05);
        assert_eq!(sig.mode, VTAMode::Tonic);
    }

    #[test]
    fn test_phasic_mesolimbic_higher_than_tonic() {
        let mut vta = VTA::new();
        let tonic_sig = vta.current_signal().mesolimbic_signal;
        let burst_sig = vta.process_rpe(0.8);
        assert!(
            burst_sig.mesolimbic_signal > tonic_sig,
            "burst should produce higher mesolimbic signal than tonic"
        );
    }

    #[test]
    fn test_pause_suppresses_mesolimbic() {
        let mut vta = VTA::new();
        let tonic_sig = vta.current_signal().mesolimbic_signal;
        let pause_sig = vta.process_rpe(-0.7);
        assert!(
            pause_sig.mesolimbic_signal < tonic_sig,
            "pause should suppress mesolimbic below tonic"
        );
    }

    #[test]
    fn test_mesocortical_peaks_at_optimal_tonic() {
        let mut vta_opt = VTA::new(); // starts at optimal
        vta_opt.tonic_level = TONIC_OPTIMAL;
        let opt_cortical = vta_opt.pfc_modulation();

        let mut vta_low = VTA::new();
        vta_low.tonic_level = 0.15;
        let low_cortical = vta_low.pfc_modulation();

        let mut vta_high = VTA::new();
        vta_high.tonic_level = 0.95;
        let high_cortical = vta_high.pfc_modulation();

        assert!(
            opt_cortical > low_cortical,
            "optimal tonic should beat low tonic for PFC: {:.2} vs {:.2}",
            opt_cortical,
            low_cortical
        );
        assert!(
            opt_cortical > high_cortical,
            "optimal tonic should beat high tonic for PFC: {:.2} vs {:.2}",
            opt_cortical,
            high_cortical
        );
    }

    #[test]
    fn test_flow_state_requires_streak() {
        let mut vta = VTA::new();
        // Single burst is not enough
        vta.process_rpe(0.8);
        assert!(!vta.in_flow, "single burst should not trigger flow");
        // 5+ consecutive positive RPEs should
        for _ in 0..6 {
            vta.process_rpe(0.4);
        }
        assert!(
            vta.in_flow,
            "5+ consistent positive RPEs should trigger flow state"
        );
    }

    #[test]
    fn test_flow_streak_resets_on_pause() {
        let mut vta = VTA::new();
        for _ in 0..6 {
            vta.process_rpe(0.5);
        }
        assert!(vta.in_flow);
        vta.process_rpe(-0.5);
        assert!(!vta.in_flow, "pause should break flow state");
    }

    #[test]
    fn test_decay_reduces_phasic() {
        let mut vta = VTA::new();
        vta.process_rpe(0.9);
        let before = vta.phasic_signal;
        for _ in 0..5 {
            vta.decay();
        }
        assert!(
            vta.phasic_signal < before,
            "decay should reduce phasic signal"
        );
    }

    #[test]
    fn test_status_line() {
        let vta = VTA::new();
        let s = vta.status_line();
        assert!(s.contains("VTA"), "status should mention VTA");
        assert!(s.contains("tonic"), "status should mention tonic");
    }
}

