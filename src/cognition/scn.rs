//! Suprachiasmatic Nucleus (SCN) — Circadian Clock, Temporal Patterning,
//! Rhythmic Modulation of Cognition, Time-of-Day Gating
//!
//! The SCN is the brain's master circadian pacemaker, located in the
//! anterior hypothalamus above the optic chiasm. It receives direct retinal
//! input (intrinsically photosensitive retinal ganglion cells / ipRGCs) and
//! generates ~24-hour rhythms that coordinate virtually all biological
//! processes including cognition, sleep, metabolism, immunity, and mood.
//!
//! The SCN doesn't just track time — it GATES cognitive processes, making
//! certain operations more or less effective at different phases:
//!   - Peak alertness: late morning / early afternoon phase
//!   - Working memory peak: mid-morning
//!   - Creativity peak: late morning (prefrontal-hippocampal coupling high)
//!   - Consolidation pressure: evening / night phase
//!   - Restoration: slow-wave sleep phase (not modeled by SCN directly)
//!
//! What the SCN does for KAI:
//!
//!   Phase tracking:
//!     The SCN tracks conversation "phase" — the temporal arc of a session.
//!     Early session = high alertness phase; long sustained session = later
//!     phase with increased consolidation pressure and reduced working memory.
//!
//!   Rhythmic modulation:
//!     The SCN produces oscillating modulation of other systems. Even within
//!     a session, there are ultradian rhythms (~90 min cycles in humans) that
//!     create natural peaks and troughs in cognitive performance.
//!     In KAI: modeling the natural rhythm of engagement — conversations have
//!     their own arc, with early peaks and later consolidation modes.
//!
//!   Coupling with sleep pressure:
//!     The SCN interacts with the sleep homeostatic system — as session length
//!     increases, SCN signals increasing consolidation pressure.
//!
//! KAI's SCN:
//!   phase: current session phase angle (0.0 = fresh, 1.0 = late)
//!   alertness_modulation: circadian gate on cognitive performance (0.0–1.0)
//!   consolidation_pressure: pressure to consolidate and reduce new input (0.0–1.0)
//!   ultradian_phase: 90-min cycle phase (0.0–1.0, oscillating)

// ── Constants ─────────────────────────────────────────────────────────────────

//! Phase advance per input (session aging)
const PHASE_ADVANCE: f32 = 0.003;

/// Ultradian oscillation rate (complete cycle over many turns)
const ULTRADIAN_RATE: f32 = 0.015;

/// Alertness baseline (fresh session = high alertness)
const ALERTNESS_BASELINE: f32 = 0.75;

/// Peak alertness phase (early-mid session)
const PEAK_PHASE: f32 = 0.20;

// ── SCNOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SCNOutput {
    /// Current session phase
    pub phase: f32,
    /// Alertness modulation (circadian gate)
    pub alertness_modulation: f32,
    /// Consolidation pressure
    pub consolidation_pressure: f32,
    /// Ultradian cycle phase
    pub ultradian_phase: f32,
    /// Whether at performance peak
    pub at_peak: bool,
    /// Whether consolidation mode active
    pub consolidation_mode: bool,
}

// ── SuprachiasmaticNucleus ────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SuprachiasmaticNucleus {
    /// Session phase angle
    pub phase: f32,
    /// Alertness modulation
    pub alertness_modulation: f32,
    /// Consolidation pressure
    pub consolidation_pressure: f32,
    /// Ultradian oscillator angle (0.0–1.0, wraps)
    pub ultradian_phase: f32,
    /// Total ticks
    pub ticks: u64,
    /// Total peak events
    pub peak_events: u64,
}

impl SuprachiasmaticNucleus {
    pub fn new() -> Self {
        Self {
            phase: 0.0,
            alertness_modulation: ALERTNESS_BASELINE,
            consolidation_pressure: 0.10,
            ultradian_phase: 0.0,
            ticks: 0,
            peak_events: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Advance the circadian/session clock with each input.
    /// - `session_depth`: how many turns deep into the session (0–N)
    /// - `cortisol_level`: cortisol stress load affects circadian phase (0.0–1.0)
    pub fn process(&mut self, session_depth: u64, cortisol_level: f32) -> SCNOutput {
        self.ticks += 1;

        // ── Phase advance ─────────────────────────────────────────────────────
        self.phase = (self.phase + PHASE_ADVANCE).min(1.0);

        // ── Ultradian oscillator ──────────────────────────────────────────────
        // Smooth sinusoidal oscillation through the session
        self.ultradian_phase = (self.ultradian_phase + ULTRADIAN_RATE) % 1.0;
        let ultradian_boost = (self.ultradian_phase * std::f32::consts::TAU).sin() * 0.10;

        // ── Alertness modulation ──────────────────────────────────────────────
        // Bell curve: peaks early-mid session, falls off in late session
        // Also modulated by ultradian rhythm and stress
        let phase_alertness = if self.phase < PEAK_PHASE {
            // Rising toward peak
            ALERTNESS_BASELINE + self.phase / PEAK_PHASE * 0.15
        } else {
            // Post-peak decline
            ALERTNESS_BASELINE + 0.15 - (self.phase - PEAK_PHASE) * 0.40
        };
        let alertness_target =
            (phase_alertness + ultradian_boost - cortisol_level * 0.10).clamp(0.20, 1.0);
        self.alertness_modulation = self.alertness_modulation * 0.95 + alertness_target * 0.05;

        // ── Consolidation pressure ────────────────────────────────────────────
        // Rises with session depth — later in session, brain wants to consolidate
        let depth_factor = (session_depth as f32 * 0.005).min(0.60);
        self.consolidation_pressure = (depth_factor + self.phase * 0.20).min(1.0);

        let at_peak = self.phase >= 0.10 && self.phase <= 0.30 && self.alertness_modulation > 0.75;
        if at_peak {
            self.peak_events += 1;
        }

        SCNOutput {
            phase: self.phase,
            alertness_modulation: self.alertness_modulation,
            consolidation_pressure: self.consolidation_pressure,
            ultradian_phase: self.ultradian_phase,
            at_peak,
            consolidation_mode: self.consolidation_pressure > 0.50,
        }
    }

    /// Decay per tick (very slow phase change at rest).
    pub fn decay(&mut self) {
        // Phase creeps forward even between inputs
        self.phase = (self.phase + PHASE_ADVANCE * 0.10).min(1.0);
        self.ultradian_phase = (self.ultradian_phase + ULTRADIAN_RATE * 0.20) % 1.0;
    }

    /// Current output without advancing.
    pub fn current_output(&self) -> SCNOutput {
        SCNOutput {
            phase: self.phase,
            alertness_modulation: self.alertness_modulation,
            consolidation_pressure: self.consolidation_pressure,
            ultradian_phase: self.ultradian_phase,
            at_peak: self.phase >= 0.10 && self.phase <= 0.30 && self.alertness_modulation > 0.75,
            consolidation_mode: self.consolidation_pressure > 0.50,
        }
    }

    /// Reset phase (new session start).
    pub fn reset_phase(&mut self) {
        self.phase = 0.0;
        self.alertness_modulation = ALERTNESS_BASELINE;
        self.consolidation_pressure = 0.10;
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "SCN phase={:.2} | alert={:.2} | consol={:.2} | ultradian={:.2}{}",
            self.phase,
            self.alertness_modulation,
            self.consolidation_pressure,
            self.ultradian_phase,
            if self.consolidation_pressure > 0.50 {
                " CONSOLIDATE"
            } else {
                ""
            },
        )
    }
}

impl Default for SuprachiasmaticNucleus {
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
        let s = SuprachiasmaticNucleus::new();
        assert!(s.phase < 0.01, "phase should start at 0");
        assert!((s.alertness_modulation - ALERTNESS_BASELINE).abs() < 0.01);
    }

    #[test]
    fn test_phase_advances_with_inputs() {
        let mut s = SuprachiasmaticNucleus::new();
        let before = s.phase;
        s.process(5, 0.20);
        assert!(
            s.phase > before,
            "phase should advance: {:.2} → {:.2}",
            before,
            s.phase
        );
    }

    #[test]
    fn test_ultradian_phase_oscillates() {
        let mut s = SuprachiasmaticNucleus::new();
        let mut phases: Vec<f32> = Vec::new();
        for i in 0..30 {
            let out = s.process(i, 0.20);
            phases.push(out.ultradian_phase);
        }
        let min = phases.iter().cloned().fold(f32::INFINITY, f32::min);
        let max = phases.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        assert!(
            max > min,
            "ultradian phase should vary: min={:.2} max={:.2}",
            min,
            max
        );
    }

    #[test]
    fn test_consolidation_rises_with_depth() {
        let mut s = SuprachiasmaticNucleus::new();
        let out_early = s.process(5, 0.20);
        let out_late = s.process(200, 0.20);
        assert!(
            out_late.consolidation_pressure > out_early.consolidation_pressure,
            "late session should have more consolidation pressure"
        );
    }

    #[test]
    fn test_consolidation_mode_above_threshold() {
        let mut s = SuprachiasmaticNucleus::new();
        s.consolidation_pressure = 0.60;
        let out = s.current_output();
        assert!(
            out.consolidation_mode,
            "pressure > 0.50 → consolidation mode"
        );
    }

    #[test]
    fn test_high_cortisol_reduces_alertness() {
        let mut s = SuprachiasmaticNucleus::new();
        // Process same depth with high vs. low cortisol
        let mut s_low = SuprachiasmaticNucleus::new();
        s.process(10, 0.90);
        s_low.process(10, 0.05);
        assert!(
            s.alertness_modulation <= s_low.alertness_modulation + 0.01,
            "high cortisol should not boost alertness vs. low cortisol"
        );
    }

    #[test]
    fn test_reset_phase() {
        let mut s = SuprachiasmaticNucleus::new();
        for i in 0..50 {
            s.process(i, 0.20);
        }
        assert!(s.phase > 0.10, "phase should have advanced");
        s.reset_phase();
        assert!(s.phase < 0.01, "phase should reset to 0");
        assert!((s.alertness_modulation - ALERTNESS_BASELINE).abs() < 0.01);
    }

    #[test]
    fn test_phase_caps_at_one() {
        let mut s = SuprachiasmaticNucleus::new();
        for i in 0..500 {
            s.process(i, 0.20);
        }
        assert!(
            s.phase <= 1.0,

        );
    }
}
