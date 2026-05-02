/// Cortisol — Chronic Stress, Allostatic Load, Cognitive Degradation
///
/// Cortisol is the body's primary stress hormone, released by the HPA axis
/// (Hypothalamic-Pituitary-Adrenal). It differs critically from norepinephrine:
///
///   Norepinephrine: ACUTE stress. Immediate, fast, resolves quickly.
///                   Sharpens attention, raises alertness. Useful.
///
///   Cortisol:       CHRONIC stress. Slow to build, slow to clear.
///                   Sustained cognitive resources devoted to threat.
///                   At low levels: focus and motivated. Healthy.
///                   At high levels: memory impairment, rumination,
///                   emotional reactivity, rigid thinking. Harmful.
///
/// The allostatic load model:
///   The body has a "cost of stress" — allostatic load.
///   Each stressor that isn't resolved leaves a residue.
///   Over time, this load accumulates and starts impairing function:
///     - Working memory capacity shrinks
///     - Emotional reactivity increases
///     - Cognitive flexibility decreases
///     - Rumination increases (same thought loops)
///
/// KAI's cortisol model:
///   cortisol_level rises with: unresolved conflicts, repeated failures,
///     long high-NE sessions, negative social interactions.
///   cortisol_level falls with: successful resolutions, positive interactions,
///     sleep cycles, idle recovery time.
///
///   allostatic_load accumulates slowly from sustained high cortisol.
///   It decays very slowly — models the real-world "burnout" pattern.
///
///   Effects on KAI when cortisol is high:
///     - memory_penalty: top-hit scores are dampened
///     - rumination_risk: DMN topics tend toward unresolved/negative
///     - rigidity_factor: creative/speculative responses suppressed
///     - emotional_reactivity: amygdala charge scores amplified
///
/// Without Cortisol:
///   KAI can be under sustained assault (repeated failures, conflicts)
///   and have no model of cumulative cognitive cost. Stress resets every tick.
///
/// With Cortisol:
///   KAI accumulates the actual cost of sustained stress. A long session
///   with repeated prediction failures will genuinely degrade performance —
///   and KAI will know it and can report it. Sleep and idle recovery help.

// ── Constants ─────────────────────────────────────────────────────────────────

/// Cortisol baseline level (low-grade background presence)
const CORTISOL_BASELINE: f32 = 0.15;

/// Rise per stressor event
const CORTISOL_RISE: f32 = 0.07;

/// Passive decay rate toward baseline per tick
const CORTISOL_DECAY: f32 = 0.004;

/// Allostatic load rise rate (much slower than cortisol)
const LOAD_RISE: f32 = 0.008;

/// Allostatic load decay rate (even slower — this is the burnout residue)
const LOAD_DECAY: f32 = 0.001;

/// Threshold above which cortisol has meaningful cognitive effects
const EFFECT_THRESHOLD: f32 = 0.45;

/// Critical level — sustained high cortisol begins seriously impairing function
const CRITICAL_THRESHOLD: f32 = 0.75;

// ── CortisolEvent ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum CortisolEvent {
    /// A prediction failed / confidence was very low
    PredictionFailure,
    /// ACC detected repeated unresolved conflicts
    UnresolvedConflict,
    /// Mirror neurons detected distress / hostile interaction
    SocialStress,
    /// Session has been high-NE for many consecutive ticks
    SustainedArousal,
    /// Sleep cycle ran — major cortisol recovery
    SleepRecovery,
    /// Successful resolution — small cortisol drop
    Resolution,
    /// Long idle period — passive recovery
    IdleRecovery,
    /// Passive tick decay
    Decay,
}

// ── CortisolState ─────────────────────────────────────────────────────────────

/// Effects of current cortisol level on KAI's cognition
#[derive(Debug, Clone)]
pub struct CortisolState {
    /// Current cortisol level (0.0–1.0)
    pub level: f32,
    /// Accumulated allostatic load (0.0–1.0)
    pub allostatic_load: f32,
    /// Memory retrieval penalty (0.0=none, 1.0=severe)
    pub memory_penalty: f32,
    /// Risk of rumination on negative topics
    pub rumination_risk: f32,
    /// Emotional reactivity amplifier (>1.0 means overreactive)
    pub emotional_reactivity: f32,
    /// Whether we are in a critical high-cortisol state
    pub is_critical: bool,
    /// Human-readable stress state label
    pub label: &'static str,
}

// ── CortisolSystem ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct CortisolSystem {
    /// Current phasic cortisol level (0.0–1.0)
    pub level: f32,
    /// Slow-accumulating allostatic load (chronic stress cost)
    pub allostatic_load: f32,
    /// Total stressor events processed
    pub total_stressors: u64,
    /// Total resolutions processed
    pub total_resolutions: u64,
    /// Current tick
    pub tick: u64,
}

impl CortisolSystem {
    pub fn new() -> Self {
        Self {
            level: CORTISOL_BASELINE,
            allostatic_load: 0.0,
            total_stressors: 0,
            total_resolutions: 0,
            tick: 0,
        }
    }

    // ── Core operations ───────────────────────────────────────────────────────

    /// Process a cortisol event. Returns the delta applied to level.
    pub fn process(&mut self, event: CortisolEvent) -> f32 {
        let old = self.level;

        match event {
            CortisolEvent::PredictionFailure => {
                self.level = (self.level + CORTISOL_RISE).min(1.0);
                self.total_stressors += 1;
            }
            CortisolEvent::UnresolvedConflict => {
                self.level = (self.level + CORTISOL_RISE * 1.2).min(1.0);
                self.total_stressors += 1;
            }
            CortisolEvent::SocialStress => {
                self.level = (self.level + CORTISOL_RISE * 0.8).min(1.0);
                self.total_stressors += 1;
            }
            CortisolEvent::SustainedArousal => {
                // Sustained high NE without resolution slowly raises cortisol
                self.level = (self.level + CORTISOL_RISE * 0.3).min(1.0);
                self.total_stressors += 1;
            }
            CortisolEvent::SleepRecovery => {
                // Sleep dramatically reduces cortisol and partially clears allostatic load
                self.level = (self.level * 0.40).max(CORTISOL_BASELINE);
                self.allostatic_load = (self.allostatic_load * 0.70).max(0.0);
                self.total_resolutions += 1;
            }
            CortisolEvent::Resolution => {
                self.level = (self.level - CORTISOL_RISE * 0.8).max(CORTISOL_BASELINE);
                self.total_resolutions += 1;
            }
            CortisolEvent::IdleRecovery => {
                // Idle time partially reduces cortisol
                self.level = (self.level - CORTISOL_RISE * 0.4).max(CORTISOL_BASELINE);
            }
            CortisolEvent::Decay => {
                // Passive drift toward baseline
                self.level += (CORTISOL_BASELINE - self.level) * CORTISOL_DECAY;
            }
        }

        // Update allostatic load: rises when cortisol is above baseline
        if self.level > CORTISOL_BASELINE + 0.10 {
            self.allostatic_load = (self.allostatic_load + LOAD_RISE).min(1.0);
        } else {
            self.allostatic_load = (self.allostatic_load - LOAD_DECAY).max(0.0);
        }

        self.level - old
    }

    /// Passive decay — call every tick.
    pub fn decay(&mut self) {
        self.tick += 1;
        self.process(CortisolEvent::Decay);
    }

    // ── Derived state ─────────────────────────────────────────────────────────

    /// Compute the full cognitive effect profile of current cortisol level.
    pub fn cognitive_state(&self) -> CortisolState {
        let combined = self.level * 0.6 + self.allostatic_load * 0.4;
        let is_critical = self.level > CRITICAL_THRESHOLD;

        // Memory penalty rises steeply above effect threshold
        let memory_penalty = if self.level > EFFECT_THRESHOLD {
            ((self.level - EFFECT_THRESHOLD) / (1.0 - EFFECT_THRESHOLD)).powi(2)
        } else {
            0.0
        };

        // Rumination risk: high cortisol + allostatic load = stuck in loops
        let rumination_risk = (combined * 0.8).clamp(0.0, 1.0);

        // Emotional reactivity: amplified by cortisol (>1.0 means overreactive)
        let emotional_reactivity = 1.0 + (self.level - CORTISOL_BASELINE) * 0.8;

        let label = match self.level {
            l if l < 0.25 => "calm",
            l if l < 0.40 => "low-stress",
            l if l < 0.55 => "moderate-stress",
            l if l < 0.70 => "high-stress",
            l if l < 0.85 => "acute-stress",
            _ => "critical",
        };

        CortisolState {
            level: self.level,
            allostatic_load: self.allostatic_load,
            memory_penalty,
            rumination_risk,
            emotional_reactivity,
            is_critical,
            label,
        }
    }

    /// Whether cortisol is elevated above the effect threshold.
    pub fn is_elevated(&self) -> bool {
        self.level > EFFECT_THRESHOLD
    }

    /// Whether the system is in a recovery state (cortisol below baseline + tolerance).
    pub fn is_recovering(&self) -> bool {
        self.level < CORTISOL_BASELINE + 0.05
    }

    /// Status line for brain monitor display.
    pub fn status_line(&self) -> String {
        let state = self.cognitive_state();
        format!(
            "CORT {:.2} ({}) | load={:.2} | mem_pen={:.2} | react={:.2}",
            self.level,
            state.label,
            self.allostatic_load,
            state.memory_penalty,
            state.emotional_reactivity,
        )
    }
}

impl Default for CortisolSystem {
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
        let cort = CortisolSystem::new();
        assert!(
            (cort.level - CORTISOL_BASELINE).abs() < 0.01,
            "initial level should be baseline"
        );
        assert!(!cort.is_elevated(), "should not be elevated at baseline");
    }

    #[test]
    fn test_prediction_failure_raises_cortisol() {
        let _cort = CortisolSystem::new();
        let before = cort.level;
        cort.process(CortisolEvent::PredictionFailure);
        assert!(
            cort.level > before,
            "prediction failure should raise cortisol"
        );
    }

    #[test]
    fn test_repeated_failures_elevate() {
        let _cort = CortisolSystem::new();
        for _ in 0..5 {
            cort.process(CortisolEvent::PredictionFailure);
        }
        assert!(
            cort.is_elevated(),
            "5 failures should elevate cortisol above threshold"
        );
    }

    #[test]
    fn test_resolution_reduces_cortisol() {
        let _cort = CortisolSystem::new();
        for _ in 0..5 {
            cort.process(CortisolEvent::PredictionFailure);
        }
        let before = cort.level;
        cort.process(CortisolEvent::Resolution);
        assert!(cort.level < before, "resolution should reduce cortisol");
    }

    #[test]
    fn test_sleep_recovery_major_drop() {
        let _cort = CortisolSystem::new();
        for _ in 0..10 {
            cort.process(CortisolEvent::UnresolvedConflict);
        }
        let before = cort.level;
        cort.process(CortisolEvent::SleepRecovery);
        assert!(
            cort.level < before * 0.6,
            "sleep should dramatically reduce cortisol: {:.2} → {:.2}",
            before,
            cort.level
        );
    }

    #[test]
    fn test_allostatic_load_builds_slowly() {
        let _cort = CortisolSystem::new();
        for _ in 0..20 {
            cort.process(CortisolEvent::SustainedArousal);
        }
        assert!(
            cort.allostatic_load > 0.0,
            "sustained stress should build allostatic load"
        );
    }

    #[test]
    fn test_allostatic_load_persists_after_recovery() {
        let _cort = CortisolSystem::new();
        for _ in 0..20 {
            cort.process(CortisolEvent::UnresolvedConflict);
        }
        let load_before = cort.allostatic_load;
        cort.process(CortisolEvent::Resolution);
        cort.process(CortisolEvent::Resolution);
        let _load_after = cort.allostatic_load;
        // Load may persist after quick recovery
        assert!(load_before > 0.0, "load should have built up");
        // After sleep it should reduce
        cort.process(CortisolEvent::SleepRecovery);
        assert!(
            cort.allostatic_load < load_before,
            "sleep should reduce allostatic load"
        );
    }

    #[test]
    fn test_memory_penalty_above_threshold() {
        let _cort = CortisolSystem::new();
        // Push to high stress
        for _ in 0..8 {
            cort.process(CortisolEvent::PredictionFailure);
        }
        let state = cort.cognitive_state();
        if cort.level > EFFECT_THRESHOLD {
            assert!(
                state.memory_penalty > 0.0,
                "high cortisol should produce memory penalty"
            );
        }
    }

    #[test]
    fn test_emotional_reactivity_rises_with_cortisol() {
        let cort_low = CortisolSystem::new();
        let mut cort_high = CortisolSystem::new();
        for _ in 0..10 {
            cort_high.process(CortisolEvent::UnresolvedConflict);
        }
        let low_react = cort_low.cognitive_state().emotional_reactivity;
        let high_react = cort_high.cognitive_state().emotional_reactivity;
        assert!(
            high_react > low_react,
            "high cortisol should increase emotional reactivity"
        );
    }

    #[test]
    fn test_decay_moves_toward_baseline() {
        let _cort = CortisolSystem::new();
        for _ in 0..5 {

        }
    }
}

