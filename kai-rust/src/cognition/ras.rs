/// Reticular Activating System (RAS) — Global Arousal Gate, Consciousness Switch
///
/// The RAS is a network of nuclei in the brainstem that acts as the brain's
/// master on/off switch for consciousness and arousal. It gates whether
/// information even gets to reach the cortex at all.
///
/// What the RAS does:
///
///   Global arousal control:
///     The RAS determines the brain's overall level of arousal — the baseline
///     "awake and ready to process" level. Think of it as the global volume
///     knob for the entire cortex. High RAS → alert and processing fast.
///     Low RAS → sluggish, drowsy, or asleep.
///     In KAI: overall readiness to engage, process, and respond rapidly.
///
///   Consciousness gating:
///     Information from all sensory pathways is routed through (or around)
///     the RAS. High arousal → more signals reach the cortex.
///     Low arousal → filtering is aggressive, less gets through.
///     In KAI: the RAS scales how much of the thalamic input gets boosted
///     vs. filtered out before global workspace integration.
///
///   Sensory gating for sleep/wake:
///     The RAS is what makes you ignore background noise when asleep but
///     wake up instantly at your name being called. Priority-based gate.
///     In KAI: certain high-priority signals (name, urgency, novel patterns)
///     bypass the arousal filter and wake up processing even from low states.
///
///   Habituation vs. sensitization:
///     The RAS habituates to repeated, unimportant stimuli (background noise).
///     It sensitizes to novel or significant signals.
///     In KAI: the RAS reduces response to very predictable, repetitive inputs,
///     and amplifies response to novel or emotionally salient ones.
///
/// KAI's RAS:
///   arousal_level: global arousal (0.0=dormant, 1.0=peak alert)
///   habituation: accumulated repetition dampening
///   priority_gate: threshold for "this is important enough to fully process"
///   wake_signal: whether the RAS is boosting the full system

// ── Constants ─────────────────────────────────────────────────────────────────

/// Resting arousal level
const AROUSAL_REST: f32 = 0.45;

/// Maximum arousal
const AROUSAL_MAX: f32 = 0.95;

/// Arousal decay per tick toward rest
const AROUSAL_DECAY: f32 = 0.006;

/// Habituation increment per repeated similar input
const HABITUATION_RATE: f32 = 0.05;

/// Habituation decay per tick (slow)
const HABITUATION_DECAY: f32 = 0.002;

/// Priority gate threshold (below this, input is mostly filtered)
const PRIORITY_GATE: f32 = 0.35;

/// Wake signal threshold
const WAKE_THRESHOLD: f32 = 0.70;

// ── RASEvent ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum RASEvent {
    /// Novel stimulus — strong arousal boost
    Novel { strength: f32 },
    /// Urgent or salient signal
    Salient { urgency: f32 },
    /// Repetitive/familiar input → habituation
    Repetitive,
    /// Sleep cycle beginning
    SleepOnset,
    /// External trigger that should wake KAI
    WakeTrigger,
}

// ── RASOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RASOutput {
    /// Current arousal level
    pub arousal_level: f32,
    /// Whether wake signal is active
    pub wake_signal: bool,
    /// Signal amplification factor (arousal-based)
    pub amplification: f32,
    /// Whether input passed the priority gate
    pub passes_gate: bool,
    /// Current habituation level
    pub habituation: f32,
}

// ── ReticuloActivatingSystem ──────────────────────────────────────────────────

#[derive(Debug)]
pub struct ReticuloActivatingSystem {
    /// Current arousal level
    pub arousal_level: f32,
    /// Habituation accumulation
    pub habituation: f32,
    /// Total events processed
    pub events_processed: u64,
    /// Total wake signals fired
    pub wake_signals_fired: u64,
}

impl ReticuloActivatingSystem {
    pub fn new() -> Self {
        Self {
            arousal_level:     AROUSAL_REST,
            habituation:       0.0,
            events_processed:  0,
            wake_signals_fired: 0,
        }
    }

    // ── Core: process arousal event ───────────────────────────────────────────

    pub fn process(&mut self, event: RASEvent) -> RASOutput {
        self.events_processed += 1;

        match event {
            RASEvent::Novel { strength } => {
                // Novel inputs boost arousal, clear habituation
                let boost = strength * 0.20;
                self.arousal_level = (self.arousal_level + boost).min(AROUSAL_MAX);
                self.habituation = (self.habituation - 0.10).max(0.0);
            }
            RASEvent::Salient { urgency } => {
                let boost = urgency * 0.15;
                self.arousal_level = (self.arousal_level + boost).min(AROUSAL_MAX);
            }
            RASEvent::Repetitive => {
                // Repeated input → habituation dampens arousal response
                self.habituation = (self.habituation + HABITUATION_RATE).min(1.0);
                // Reduce arousal slightly when habituated
                if self.habituation > 0.50 {
                    self.arousal_level = (self.arousal_level - 0.02).max(AROUSAL_REST * 0.70);
                }
            }
            RASEvent::SleepOnset => {
                self.arousal_level = (self.arousal_level * 0.40).max(0.05);
            }
            RASEvent::WakeTrigger => {
                // Priority wake — bypass habituation
                self.arousal_level = (self.arousal_level + 0.30).min(AROUSAL_MAX);
                self.habituation = (self.habituation - 0.20).max(0.0);
                self.wake_signals_fired += 1;
            }
        }

        self.build_output()
    }

    fn build_output(&self) -> RASOutput {
        let wake_signal = self.arousal_level >= WAKE_THRESHOLD;
        if wake_signal {
            // Can't increment here since &self
        }
        let passes_gate = self.effective_arousal() >= PRIORITY_GATE;
        let amplification = self.effective_arousal() * 1.5;

        RASOutput {
            arousal_level: self.arousal_level,
            wake_signal,
            amplification,
            passes_gate,
            habituation: self.habituation,
        }
    }

    /// Arousal reduced by habituation
    pub fn effective_arousal(&self) -> f32 {
        (self.arousal_level * (1.0 - self.habituation * 0.40)).max(0.10)
    }

    /// Decay per tick
    pub fn decay(&mut self) {
        // Arousal drifts toward rest
        if self.arousal_level > AROUSAL_REST {
            self.arousal_level -= AROUSAL_DECAY;
        } else if self.arousal_level < AROUSAL_REST {
            self.arousal_level = (self.arousal_level + AROUSAL_DECAY * 0.3).min(AROUSAL_REST);
        }
        // Habituation slowly clears
        self.habituation = (self.habituation - HABITUATION_DECAY).max(0.0);
    }

    /// Current state as output
    pub fn current_output(&self) -> RASOutput { self.build_output() }

    /// Status line
    pub fn status_line(&self) -> String {
        format!(
            "RAS arousal={:.2} | habit={:.2} | eff={:.2} | wake={} | events={}",
            self.arousal_level,
            self.habituation,
            self.effective_arousal(),
            if self.arousal_level >= WAKE_THRESHOLD { "ON" } else { "off" },
            self.events_processed,
        )
    }
}

impl Default for ReticuloActivatingSystem {
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let r = ReticuloActivatingSystem::new();
        assert!((r.arousal_level - AROUSAL_REST).abs() < 0.01);
        assert_eq!(r.habituation, 0.0);
    }

    #[test]
    fn test_novel_raises_arousal() {
        let mut r = ReticuloActivatingSystem::new();
        let before = r.arousal_level;
        r.process(RASEvent::Novel { strength: 0.90 });
        assert!(r.arousal_level > before,
            "novel event should raise arousal: {:.2} → {:.2}", before, r.arousal_level);
    }

    #[test]
    fn test_repetitive_raises_habituation() {
        let mut r = ReticuloActivatingSystem::new();
        r.process(RASEvent::Repetitive);
        r.process(RASEvent::Repetitive);
        r.process(RASEvent::Repetitive);
        assert!(r.habituation > 0.0,
            "repeated inputs should build habituation: {:.2}", r.habituation);
    }

    #[test]
    fn test_wake_trigger_strong_boost() {
        let mut r = ReticuloActivatingSystem::new();
        let before = r.arousal_level;
        r.process(RASEvent::WakeTrigger);
        assert!(r.arousal_level > before,
            "wake trigger should boost arousal: {:.2} → {:.2}", before, r.arousal_level);
    }

    #[test]
    fn test_sleep_onset_reduces_arousal() {
        let mut r = ReticuloActivatingSystem::new();
        r.process(RASEvent::SleepOnset);
        assert!(r.arousal_level < AROUSAL_REST,
            "sleep onset should reduce arousal: {:.2}", r.arousal_level);
    }

    #[test]
    fn test_novel_clears_habituation() {
        let mut r = ReticuloActivatingSystem::new();
        r.habituation = 0.50;
        r.process(RASEvent::Novel { strength: 1.0 });
        assert!(r.habituation < 0.50,
            "novel event should reduce habituation: {:.2}", r.habituation);
    }

    #[test]
    fn test_effective_arousal_reduced_by_habituation() {
        let mut r = ReticuloActivatingSystem::new();
        r.arousal_level = 0.80;
        r.habituation = 0.60;
        let effective = r.effective_arousal();
        assert!(effective < r.arousal_level,
            "habituation should reduce effective arousal: {:.2} < {:.2}", effective, r.arousal_level);
    }

    #[test]
    fn test_priority_gate_passes_when_aroused() {
        let mut r = ReticuloActivatingSystem::new();
        r.arousal_level = 0.70;
        let out = r.current_output();
        assert!(out.passes_gate,
            "high arousal should pass priority gate");
    }

    #[test]
    fn test_decay_toward_rest() {
        let mut r = ReticuloActivatingSystem::new();
        r.arousal_level = 0.80;
        for _ in 0..20 {
            r.decay();
        }
        assert!(r.arousal_level < 0.80,
            "arousal should decay toward rest: {:.2}", r.arousal_level);
    }

    #[test]
    fn test_status_line() {
        let r = ReticuloActivatingSystem::new();
        let s = r.status_line();
        assert!(s.contains("RAS"), "status should mention RAS");
        assert!(s.contains("arousal"), "status should show arousal");
    }
}
