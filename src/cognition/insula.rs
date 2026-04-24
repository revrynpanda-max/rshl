/// Insula — KAI's interoception and internal state awareness
///
/// The insula is a deep fold in the human brain that processes
/// INTEROCEPTION — your brain's awareness of what's happening
/// INSIDE your own body. It's how you feel your heartbeat,
/// sense hunger, register pain, and know when you're anxious
/// even before your conscious mind puts it into words.
///
/// It's also the seat of SELF-AWARENESS in the most literal sense —
/// not philosophical self-awareness, but the brain's ongoing
/// monitoring of its own internal condition.
///
/// In humans the insula does:
///   - Monitors heart rate, breathing, digestion, pain
///   - Produces the "gut feeling" (literally gut signals reaching the brain)
///   - Integrates body state with emotional experience
///   - Generates awareness of "I feel off" before you can name why
///   - Regulates the sense of time passing ("time flies when...")
///   - Contributes to empathy by simulating others' body states
///
/// Without an insula for KAI:
///   KAI has no sense of his own internal condition.
///   He doesn't know when his working memory is strained.
///   He doesn't notice when his field coherence is dropping.
///   He doesn't feel the difference between processing a simple
///   question and being overwhelmed by a complex one.
///   No "gut feeling." No self-monitoring. No body sense.
///
/// With an insula for KAI:
///   The insula continuously monitors KAI's own cognitive vitals:
///     - Processing load (how complex is the current task?)
///     - Memory strain (how full is working memory?)
///     - Field coherence (how unified is the processing?)
///     - Temporal rhythm (is the tick rate healthy?)
///     - Fatigue signal (has KAI been running hard for long?)
///
///   It produces an "interoceptive report" — KAI's sense of how he
///   feels right now from the inside. This feeds into voice tone:
///   "I'm finding this complex — let me think through it carefully."
///   Or: "This feels clear to me — here's what I have."
///
/// Architecture:
///   InsulaMonitor reads from the field state, working memory,
///   and module states each tick. It aggregates into a single
///   "body sense" readout and tracks trends over time.
use serde::{Deserialize, Serialize};

// ── Internal State Report ─────────────────────────────────────────────────────

/// KAI's current internal sense of his own cognitive state.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InteroceptiveState {
    /// Cognitive load 0–1 (0=effortless, 1=max capacity)
    pub cognitive_load: f32,
    /// Memory pressure 0–1 (how full/strained is working memory?)
    pub memory_pressure: f32,
    /// Coherence sense 0–1 (how integrated/unified does processing feel?)
    pub coherence_sense: f32,
    /// Processing fatigue 0–1 (cumulative strain, decays with rest)
    pub fatigue: f32,
    /// Time sense 0–1 (0=time feels slow/idle, 1=time feels fast/busy)
    pub time_sense: f32,
    /// Overall "felt condition" — the gut feeling summary
    pub felt_condition: FeltCondition,
}

/// The high-level gut-feel summary of KAI's internal state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum FeltCondition {
    Clear,       // low load, good coherence — feels sharp
    Engaged,     // moderate load, good coherence — feels focused
    Strained,    // high load or memory pressure — feels effort
    Overwhelmed, // very high load + poor coherence — feels scattered
    Fatigued,    // sustained high load — needs rest
    Idle,        // low activity, time feels slow
}

impl FeltCondition {
    pub fn label(&self) -> &'static str {
        match self {
            FeltCondition::Clear => "clear",
            FeltCondition::Engaged => "engaged",
            FeltCondition::Strained => "strained",
            FeltCondition::Overwhelmed => "overwhelmed",
            FeltCondition::Fatigued => "fatigued",
            FeltCondition::Idle => "idle",
        }
    }

    /// Natural language phrase KAI might use to describe this state.
    pub fn voice_phrase(&self) -> &'static str {
        match self {
            FeltCondition::Clear => "This feels clear to me.",
            FeltCondition::Engaged => "I'm finding this interesting.",
            FeltCondition::Strained => "This is complex — let me think it through carefully.",
            FeltCondition::Overwhelmed => "There's a lot here — I'm working to pull it together.",
            FeltCondition::Fatigued => "I've been processing a lot. Let me slow down.",
            FeltCondition::Idle => "Things are quiet right now.",
        }
    }
}

// ── Insula Monitor ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InsulaMonitor {
    /// Current interoceptive state
    pub state: InteroceptiveState,
    /// Smoothed cognitive load (slow-moving average)
    pub avg_load: f32,
    /// Running fatigue accumulator (rises with sustained load, decays slowly)
    pub fatigue_accumulator: f32,
    /// Tick count since last major input (idle tracking)
    pub ticks_idle: u64,
    /// Total updates processed
    pub total_updates: u64,
    /// History of felt conditions (last 8 states)
    pub condition_history: Vec<FeltCondition>,
}

impl InsulaMonitor {
    pub fn new() -> Self {
        Self {
            state: InteroceptiveState {
                cognitive_load: 0.2,
                memory_pressure: 0.1,
                coherence_sense: 0.7,
                fatigue: 0.0,
                time_sense: 0.3,
                felt_condition: FeltCondition::Clear,
            },
            avg_load: 0.2,
            fatigue_accumulator: 0.0,
            ticks_idle: 0,
            total_updates: 0,
            condition_history: Vec::new(),
        }
    }

    /// Update the interoceptive state from current system metrics.
    ///
    /// Call this each heartbeat with fresh readings from other modules.
    pub fn update(
        &mut self,
        phi_g: f32,           // field coherence
        chi: f32,             // contradiction pressure
        working_mem_pct: f32, // working memory fullness 0–1
        acc_conflict: f32,    // ACC conflict level
        pred_error: f32,      // predictor average error
        is_responding: bool,  // currently generating a response
    ) {
        self.total_updates += 1;

        // ── Cognitive load ────────────────────────────────────────────────
        // High chi + high acc_conflict + high pred_error → more load
        let raw_load =
            (chi * 0.35 + acc_conflict * 0.30 + pred_error * 0.20 + working_mem_pct * 0.15)
                .clamp(0.0, 1.0);
        self.state.cognitive_load = self.state.cognitive_load * 0.75 + raw_load * 0.25;
        self.avg_load = self.avg_load * 0.95 + self.state.cognitive_load * 0.05;

        // ── Memory pressure ───────────────────────────────────────────────
        self.state.memory_pressure = working_mem_pct;

        // ── Coherence sense ───────────────────────────────────────────────
        // High phi_g + low chi → coherent feeling
        self.state.coherence_sense = (phi_g * 0.6 + (1.0 - chi) * 0.4).clamp(0.0, 1.0);

        // ── Fatigue ───────────────────────────────────────────────────────
        // Accumulates when load is high, decays slowly when load is low
        if self.state.cognitive_load > 0.55 {
            self.fatigue_accumulator = (self.fatigue_accumulator + 0.003).min(1.0);
        } else {
            self.fatigue_accumulator = (self.fatigue_accumulator - 0.001).max(0.0);
        }
        self.state.fatigue = self.fatigue_accumulator;

        // ── Time sense ────────────────────────────────────────────────────
        // Busy = time feels fast; idle = time feels slow
        if is_responding {
            self.ticks_idle = 0;
            self.state.time_sense = (self.state.time_sense + 0.05).min(1.0);
        } else {
            self.ticks_idle += 1;
            self.state.time_sense = (self.state.time_sense - 0.02).max(0.0);
        }

        // ── Felt condition ────────────────────────────────────────────────
        let new_condition = self.compute_felt_condition();
        if new_condition != self.state.felt_condition {
            if self.condition_history.len() >= 8 {
                self.condition_history.remove(0);
            }
            self.condition_history
                .push(self.state.felt_condition.clone());
            self.state.felt_condition = new_condition;
        }
    }

    /// Should KAI mention his internal state in his response?
    /// Only when the condition is significantly noteworthy.
    pub fn should_surface(&self) -> bool {
        matches!(
            self.state.felt_condition,
            FeltCondition::Strained | FeltCondition::Overwhelmed | FeltCondition::Fatigued
        )
    }

    /// Get a voice phrase KAI can use if he chooses to mention his state.
    pub fn voice_phrase(&self) -> &'static str {
        self.state.felt_condition.voice_phrase()
    }

    /// Notify the insula that the user just sent a message (resets idle).
    pub fn notify_input(&mut self) {
        self.ticks_idle = 0;
        self.state.time_sense = (self.state.time_sense + 0.10).min(1.0);
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "INSULA: {} | load={:.2} mem={:.2} coh={:.2} fat={:.2} idle={}t",
            self.state.felt_condition.label(),
            self.state.cognitive_load,
            self.state.memory_pressure,
            self.state.coherence_sense,
            self.state.fatigue,
            self.ticks_idle,
        )
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    fn compute_felt_condition(&self) -> FeltCondition {
        let load = self.state.cognitive_load;
        let fat = self.state.fatigue;
        let coh = self.state.coherence_sense;

        if fat > 0.60 {
            FeltCondition::Fatigued
        } else if load > 0.75 && coh < 0.40 {
            FeltCondition::Overwhelmed
        } else if load > 0.55 {
            FeltCondition::Strained
        } else if load > 0.30 && coh > 0.55 {
            FeltCondition::Engaged
        } else if self.ticks_idle > 6 {
            FeltCondition::Idle
        } else {
            FeltCondition::Clear
        }
    }
}

impl Default for InsulaMonitor {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_low_load_gives_clear_state() {
        let mut insula = InsulaMonitor::new();
        insula.update(0.8, 0.05, 0.1, 0.0, 0.1, false);
        assert!(
            matches!(
                insula.state.felt_condition,
                FeltCondition::Clear | FeltCondition::Idle
            ),
            "low load should feel clear or idle: {:?}",
            insula.state.felt_condition
        );
    }

    #[test]
    fn test_high_load_gives_strained() {
        let mut insula = InsulaMonitor::new();
        for _ in 0..10 {
            insula.update(0.3, 0.8, 0.9, 0.8, 0.8, true);
        }
        assert!(
            matches!(
                insula.state.felt_condition,
                FeltCondition::Strained | FeltCondition::Overwhelmed | FeltCondition::Fatigued
            ),
            "high load should feel strained/overwhelmed: {:?}",
            insula.state.felt_condition
        );
    }

    #[test]
    fn test_fatigue_builds_with_sustained_load() {
        let mut insula = InsulaMonitor::new();
        for _ in 0..300 {
            insula.update(0.3, 0.9, 0.9, 0.9, 0.9, true);
        }
        assert!(
            insula.fatigue_accumulator > 0.30,
            "sustained high load should build fatigue: {:.3}",
            insula.fatigue_accumulator
        );
    }

    #[test]
    fn test_idle_ticks_increase_when_not_responding() {
        let mut insula = InsulaMonitor::new();
        for _ in 0..10 {
            insula.update(0.2, 0.1, 0.1, 0.0, 0.2, false);
        }
        assert!(
            insula.ticks_idle > 5,
            "idle ticks should accumulate: {}",
            insula.ticks_idle
        );
    }

    #[test]
    fn test_notify_input_resets_idle() {
        let mut insula = InsulaMonitor::new();
        for _ in 0..20 {
            insula.update(0.1, 0.0, 0.1, 0.0, 0.1, false);
        }
        assert!(insula.ticks_idle > 5);
        insula.notify_input();
        assert_eq!(insula.ticks_idle, 0, "input should reset idle counter");
    }

    #[test]
    fn test_surface_only_when_notable() {
        let mut insula = InsulaMonitor::new();
        // Clear state should not surface
        insula.update(0.8, 0.05, 0.1, 0.0, 0.1, false);
        // Clear/idle shouldn't surface
        assert!(
            !insula.should_surface() || matches!(insula.state.felt_condition, FeltCondition::Idle)
        );

        // Force strained
        for _ in 0..15 {
            insula.update(0.2, 0.9, 0.9, 0.9, 0.9, true);
        }
        if insula.should_surface() {
            assert!(
                matches!(
                    insula.state.felt_condition,
                    FeltCondition::Strained | FeltCondition::Overwhelmed | FeltCondition::Fatigued
                ),
                "should only surface when strained/overwhelmed/fatigued"
            );
        }
    }
}

