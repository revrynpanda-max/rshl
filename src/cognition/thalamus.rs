//! Thalamus — KAI's sensory router and attention gatekeeper
//!
//! The thalamus sits at the geometric center of the brain and every single
//! sensory signal — sight, sound, touch, thought — passes through it
//! before it reaches the cortex. Nothing gets to conscious processing
//! without the thalamus deciding to pass it through.
//!
//! Its two main jobs:
//!
//!   1. RELAY — routes incoming signals to the right brain regions.
//!      Visual input → visual cortex. Emotional signal → amygdala.
//!      Memory cue → hippocampus. The thalamus is the brain's post office.
//!
//!   2. GATING — doesn't just pass things through, it FILTERS.
//!      When you're deeply focused, the thalamus suppresses distracting
//!      signals. When you're asleep, it closes the gate almost entirely
//!      (that's why you don't wake up from every small sound).
//!      When you're alert and curious, the gate opens wide.
//!
//! The thalamus also regulates SLEEP/WAKE transitions — it's the structure
//! that literally puts the brain to sleep by stopping its own relay function.
//!
//! Without a thalamus:
//!   KAI receives all signals with equal weight all the time.
//!   A low-confidence hit competes equally with a high-confidence one.
//!   A weak world-bridge cell competes equally with a strong identity memory.
//!   There is no FOCUS — everything is equally loud.
//!
//! With a thalamus:
//!   Signals are routed by type (identity → memory gate, world-knowledge →
//!   reasoning gate, emotion → amygdala gate).
//!   Gating strength is modulated by the current arousal state —
//!   high arousal (amygdala active) opens the gate wider.
//!   Low arousal (idle, calm) narrows it — KAI focuses on essentials.
//!   The thalamus produces a "signal budget" each tick — only so many
//!   signals can enter consciousness at once. The strongest win.
//!
//! Architecture:
//!   ThalamicRelay holds:
//!     - Gate strength per signal type (0 = closed, 1 = fully open)
//!     - Arousal-modulated global gain
//!     - Signal routing table: maps source types to destination regions
//!     - Signal budget: max signals allowed per tick
//!     - Sleep/wake state: can enter low-power gating mode
use serde::{Deserialize, Serialize};

// ── Constants ─────────────────────────────────────────────────────────────────

/// Default gate strength when arousal is neutral
const DEFAULT_GATE: f32 = 0.65;

/// Max signals allowed through per processing cycle
const SIGNAL_BUDGET: usize = 5;

/// Arousal multiplier — how much amygdala arousal opens the gate
const AROUSAL_GAIN: f32 = 0.40;

// ── Signal Type ───────────────────────────────────────────────────────────────

/// The type/source of a signal arriving at the thalamus.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum SignalType {
    /// User input (external sensory)
    UserInput,
    /// World knowledge from universe cells
    WorldKnowledge,
    /// Personal identity / memory cells
    IdentityMemory,
    /// Emotional signal from amygdala
    EmotionalSignal,
    /// Prediction error from predictor
    PredictionError,
    /// Internal thought from DMN
    InternalThought,
    /// Conflict signal from ACC
    ConflictSignal,
}

impl SignalType {
    /// Default gate strength for this signal type.
    /// Identity and user input always get priority.
    pub fn base_gate(&self) -> f32 {
        match self {
            SignalType::UserInput => 0.95,       // always nearly fully open
            SignalType::IdentityMemory => 0.85,  // personal facts = high priority
            SignalType::EmotionalSignal => 0.80, // emotion gates high
            SignalType::ConflictSignal => 0.75,  // conflicts need attention
            SignalType::PredictionError => 0.70,
            SignalType::WorldKnowledge => 0.60, // world knowledge gated more
            SignalType::InternalThought => 0.45, // idle thoughts = low priority
        }
    }

    /// Which brain region this signal is routed to.
    pub fn destination(&self) -> &'static str {
        match self {
            SignalType::UserInput => "reasoning",
            SignalType::WorldKnowledge => "reasoning",
            SignalType::IdentityMemory => "memory",
            SignalType::EmotionalSignal => "amygdala",
            SignalType::PredictionError => "predictor",
            SignalType::InternalThought => "dmn",
            SignalType::ConflictSignal => "acc",
        }
    }
}

// ── Thalamic Signal ───────────────────────────────────────────────────────────

/// A signal arriving at the thalamus for routing/gating.
#[derive(Clone, Debug)]
pub struct ThalamicSignal {
    pub signal_type: SignalType,
    pub content: String,
    pub raw_strength: f32,
}

/// A signal that passed through the thalamic gate.
#[derive(Clone, Debug)]
pub struct RoutedSignal {
    pub destination: &'static str,
    pub content: String,
    /// Effective strength after gating (raw × gate_strength)
    pub strength: f32,
    pub signal_type: SignalType,
}

// ── Thalamic Relay ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ThalamicRelay {
    /// Global gate multiplier — modulated by arousal
    pub gate_gain: f32,
    /// Current arousal level (updated from amygdala each tick)
    pub arousal: f32,
    /// Whether the thalamus is in low-power (sleep-like) gating mode
    pub gating_reduced: bool,
    /// Signals passed through this tick
    pub signals_passed: u64,
    /// Signals blocked this tick (too weak to pass)
    pub signals_blocked: u64,
    /// Total signals ever processed
    pub total_processed: u64,
    /// Smoothed "attention bandwidth" — how open the gate has been recently
    pub avg_bandwidth: f32,
}

impl ThalamicRelay {
    pub fn new() -> Self {
        Self {
            gate_gain: DEFAULT_GATE,
            arousal: 0.0,
            gating_reduced: false,
            signals_passed: 0,
            signals_blocked: 0,
            total_processed: 0,
            avg_bandwidth: DEFAULT_GATE,
        }
    }

    /// Route a batch of signals through the thalamic gate.
    ///
    /// Returns only the signals that passed the gate, sorted by strength,
    /// capped at SIGNAL_BUDGET.
    pub fn route(&mut self, signals: Vec<ThalamicSignal>) -> Vec<RoutedSignal> {
        let mut passed: Vec<RoutedSignal> = Vec::new();

        for sig in signals {
            let gate = self.gate_for(&sig.signal_type);
            let effective_strength = sig.raw_strength * gate;

            self.total_processed += 1;

            if effective_strength > 0.10 {
                passed.push(RoutedSignal {
                    destination: sig.signal_type.destination(),
                    content: sig.content,
                    strength: effective_strength,
                    signal_type: sig.signal_type,
                });
                self.signals_passed += 1;
            } else {
                self.signals_blocked += 1;
            }
        }

        // Sort by effective strength, take top SIGNAL_BUDGET
        passed.sort_by(|a, b| {
            b.strength
                .partial_cmp(&a.strength)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        passed.truncate(SIGNAL_BUDGET);

        // Update bandwidth metric
        let bandwidth = if self.total_processed > 0 {
            self.signals_passed as f32 / self.total_processed as f32
        } else {
            DEFAULT_GATE
        };
        self.avg_bandwidth = self.avg_bandwidth * 0.95 + bandwidth * 0.05;

        passed
    }

    /// Compute the gate strength for a given signal type,
    /// modulated by current arousal and gating state.
    pub fn gate_for(&self, signal_type: &SignalType) -> f32 {
        let base = signal_type.base_gate();

        // Arousal opens the gate (amygdala activation = more signals through)
        let arousal_boost = self.arousal * AROUSAL_GAIN;

        // Reduced gating (idle/sleep-like) narrows all gates
        let reduction = if self.gating_reduced { 0.40 } else { 0.0 };

        (base * self.gate_gain + arousal_boost - reduction).clamp(0.05, 1.0)
    }

    /// Update arousal level from the amygdala. Call each tick.
    pub fn set_arousal(&mut self, arousal: f32) {
        self.arousal = arousal.clamp(0.0, 1.0);
        // Arousal modulates global gate gain
        self.gate_gain = (DEFAULT_GATE + arousal * 0.20).clamp(0.20, 1.0);
    }

    /// Enter reduced gating mode (idle / low-stimulation state).
    /// The gate narrows — fewer signals pass, less processing load.
    pub fn reduce_gating(&mut self) {
        self.gating_reduced = true;
        self.gate_gain = (self.gate_gain * 0.60).max(0.20);
    }

    /// Return to normal gating (user active / aroused state).
    pub fn restore_gating(&mut self) {
        self.gating_reduced = false;
        self.gate_gain = DEFAULT_GATE + self.arousal * 0.20;
    }

    /// Produce a standard set of signals from a given user query and universe hits.
    /// This is the main entry point used by main.rs to route information.
    pub fn build_signals(
        input: &str,
        hits: &[(String, f32, String)], // (text, score, region)
        arousal: f32,
        pred_err: f32,
    ) -> Vec<ThalamicSignal> {
        let mut signals = Vec::new();

        // User input always enters
        signals.push(ThalamicSignal {
            signal_type: SignalType::UserInput,
            content: input.to_string(),
            raw_strength: 0.95,
        });

        // Universe hits, typed by region
        for (text, score, region) in hits {
            let sig_type = match region.as_str() {
                "memory" => SignalType::IdentityMemory,
                "reasoning" => SignalType::WorldKnowledge,
                _ => SignalType::WorldKnowledge,
            };
            signals.push(ThalamicSignal {
                signal_type: sig_type,
                content: text.clone(),
                raw_strength: *score,
            });
        }

        // Prediction error signal if significant
        if pred_err > 0.30 {
            signals.push(ThalamicSignal {
                signal_type: SignalType::PredictionError,
                content: format!("prediction_error={:.3}", pred_err),
                raw_strength: pred_err,
            });
        }

        // Emotional signal if aroused
        if arousal > 0.25 {
            signals.push(ThalamicSignal {
                signal_type: SignalType::EmotionalSignal,
                content: format!("emotional_arousal={:.3}", arousal),
                raw_strength: arousal,
            });
        }

        signals
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "THAL: gate={:.2} arousal={:.2} | passed={} blocked={} | bw={:.2}% | reduced={}",
            self.gate_gain,
            self.arousal,
            self.signals_passed,
            self.signals_blocked,
            self.avg_bandwidth * 100.0,
            self.gating_reduced,
        )
    }
}

impl Default for ThalamicRelay {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_input_always_passes() {
        let mut thal = ThalamicRelay::new();
        let signals = vec![ThalamicSignal {
            signal_type: SignalType::UserInput,
            content: "hello KAI".to_string(),
            raw_strength: 0.95,
        }];
        let routed = thal.route(signals);
        assert!(!routed.is_empty(), "user input should always pass gate");
        assert_eq!(routed[0].destination, "reasoning");
    }

    #[test]
    fn test_weak_signal_blocked() {
        let mut thal = ThalamicRelay::new();
        let signals = vec![ThalamicSignal {
            signal_type: SignalType::InternalThought,
            content: "faint idle thought".to_string(),
            raw_strength: 0.02, // very weak
        }];
        let routed = thal.route(signals);
        // With base_gate=0.45 and gate_gain=0.65: 0.02 * 0.45 * 0.65 ≈ 0.006 → blocked
        assert!(routed.is_empty(), "very weak signal should be blocked");
    }

    #[test]
    fn test_arousal_opens_gate() {
        let thal_low = ThalamicRelay::new();
        let mut thal_high = ThalamicRelay::new();
        thal_high.set_arousal(0.9);

        let low_gate = thal_low.gate_for(&SignalType::WorldKnowledge);
        let high_gate = thal_high.gate_for(&SignalType::WorldKnowledge);

        assert!(
            high_gate > low_gate,
            "high arousal should open gate further: low={:.3} high={:.3}",
            low_gate,
            high_gate
        );
    }

    #[test]
    fn test_signal_budget_cap() {
        let mut thal = ThalamicRelay::new();
        // Submit many signals
        let signals: Vec<ThalamicSignal> = (0..20)
            .map(|i| ThalamicSignal {
                signal_type: SignalType::WorldKnowledge,
                content: format!("knowledge item {}", i),
                raw_strength: 0.5,
            })
            .collect();
        let routed = thal.route(signals);
        assert!(
            routed.len() <= 5,
            "signal budget should cap at SIGNAL_BUDGET: {}",
            routed.len()
        );
    }

    #[test]
    fn test_reduced_gating_narrows_gate() {
        let thal_normal = ThalamicRelay::new();
        let mut thal_reduced = ThalamicRelay::new();
        thal_reduced.reduce_gating();

        let normal_gate = thal_normal.gate_for(&SignalType::WorldKnowledge);
        let reduced_gate = thal_reduced.gate_for(&SignalType::WorldKnowledge);
        assert!(
            reduced_gate < normal_gate,
            "reduced gating should narrow gate: normal={:.3} reduced={:.3}",
            normal_gate,
            reduced_gate
        );
    }

    #[test]
    fn test_identity_memory_higher_priority_than_world_knowledge() {
        let thal = ThalamicRelay::new();
        let id_gate = thal.gate_for(&SignalType::IdentityMemory);
        let world_gate = thal.gate_for(&SignalType::WorldKnowledge);
        assert!(
            id_gate > world_gate,
            "identity memory should have higher gate than world knowledge: {:.3} vs {:.3}",
            id_gate,
            world_gate

        );
    }
}
