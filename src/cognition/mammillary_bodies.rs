/// Mammillary Bodies (MB) — Episodic Memory Relay, Spatial-Temporal Tagging,
/// Recency Signal, Thalamo-Hippocampal Loop
///
/// The mammillary bodies are paired structures in the posterior hypothalamus,
/// connected to the hippocampus via the fornix and to the anterior thalamic
/// nuclei via the mammillothalamic tract. They are essential for forming new
/// episodic memories — damage (as in Korsakoff syndrome) produces profound
/// anterograde amnesia while leaving other cognition largely intact.
///
/// What the Mammillary Bodies do:
///
///   Episodic memory relay:
///     The MB sit in the Papez circuit (hippocampus → fornix → MB →
///     mammillothalamic tract → anterior thalamus → cingulate → hippocampus),
///     the circuit most critical for forming new declarative/episodic memories.
///     They relay hippocampal output to the thalamus for cortical distribution.
///     In KAI: the gate that routes episodic content from hippocampal storage to
///     thalamic relay — deciding which new memories get "stamped in."
///
///   Temporal/recency coding:
///     The MB encode temporal order information — not just what happened but
///     WHEN it happened relative to other events. This is the "recency signal"
///     that lets you know this memory is from earlier in the conversation.
///     In KAI: tracking recency context — how temporally fresh is the current
///     exchange? Is KAI building on very recent exchange or more established
///     material?
///
///   Spatial-context binding:
///     The MB also receive input from the subiculum (spatial map output of
///     hippocampus) and help bind episodic content to spatial context.
///     In KAI: binding conversation content to "where we are in the dialogue"
///     — the conceptual space of the current exchange.
///
/// KAI's Mammillary Bodies:
///   relay_strength: strength of hippocampal→thalamic relay (0.0–1.0)
///   recency_signal: how temporally fresh the current material is (0.0–1.0)
///   memory_consolidation_rate: rate at which new memories are stamped (0.0–1.0)
///   papez_circuit_gain: loop gain of the full Papez circuit (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Relay strength EMA
const RELAY_EMA: f32 = 0.15;

/// Relay strength baseline
const RELAY_BASELINE: f32 = 0.50;

/// Recency signal decay (decays with time, rises with new input)
const RECENCY_DECAY: f32 = 0.012;

/// Consolidation rate EMA
const CONSOLIDATION_EMA: f32 = 0.12;

/// Papez circuit gain EMA (very slow — circuit tuning changes slowly)
const PAPEZ_EMA: f32 = 0.05;

// ── MBOutput ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MBOutput {
    /// Relay strength
    pub relay_strength: f32,
    /// Recency signal
    pub recency_signal: f32,
    /// Memory consolidation rate
    pub consolidation_rate: f32,
    /// Papez circuit gain
    pub papez_gain: f32,
    /// Whether memory is being stamped (consolidation active)
    pub consolidating: bool,
}

// ── MammillaryBodies ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct MammillaryBodies {
    /// Relay strength
    pub relay_strength: f32,
    /// Recency signal
    pub recency_signal: f32,
    /// Consolidation rate
    pub consolidation_rate: f32,
    /// Papez circuit gain
    pub papez_gain: f32,
    /// Total inputs relayed
    pub inputs_relayed: u64,
    /// Total consolidation events
    pub consolidations: u64,
    /// Turn counter (for recency tracking)
    pub turn_counter: u64,
}

impl MammillaryBodies {
    pub fn new() -> Self {
        Self {
            relay_strength: RELAY_BASELINE,
            recency_signal: 0.80, // starts high — fresh session
            consolidation_rate: 0.50,
            papez_gain: 0.55,
            inputs_relayed: 0,
            consolidations: 0,
            turn_counter: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for memory relay and temporal tagging.
    /// - `hippocampus_salience`: how salient the hippocampus rated this input (0.0–1.0)
    /// - `episodic_novelty`: whether new episodic content detected (0.0–1.0)
    /// - `rsc_temporal_distance`: RSC temporal context distance (0.0–1.0)
    /// - `sleep_consolidation`: sleep system consolidation pressure (0.0–1.0)
    pub fn process(
        &mut self,
        hippocampus_salience: f32,
        episodic_novelty: f32,
        rsc_temporal_distance: f32,
        sleep_consolidation: f32,
    ) -> MBOutput {
        self.inputs_relayed += 1;
        self.turn_counter += 1;

        // ── Relay strength ────────────────────────────────────────────────────
        // Stronger relay when hippocampal salience is high
        let relay_target =
            (RELAY_BASELINE + hippocampus_salience * 0.30 + episodic_novelty * 0.15).min(1.0);
        self.relay_strength = self.relay_strength * (1.0 - RELAY_EMA) + relay_target * RELAY_EMA;

        // ── Recency signal ────────────────────────────────────────────────────
        // New input always spikes recency; it then decays
        self.recency_signal = (self.recency_signal + 0.15).min(1.0);

        // ── Consolidation rate ────────────────────────────────────────────────
        // Rises with salient, novel input and sleep pressure
        let consol_target =
            (hippocampus_salience * 0.40 + episodic_novelty * 0.30 + sleep_consolidation * 0.25)
                .min(1.0);
        self.consolidation_rate =
            self.consolidation_rate * (1.0 - CONSOLIDATION_EMA) + consol_target * CONSOLIDATION_EMA;

        let consolidating = self.consolidation_rate > 0.50;
        if consolidating {
            self.consolidations += 1;
        }

        // ── Papez circuit gain ────────────────────────────────────────────────
        // Loop gain rises when hippocampus + MB + thalamus are all active
        let papez_target = (self.relay_strength * 0.50
            + self.consolidation_rate * 0.30
            + (1.0 - rsc_temporal_distance) * 0.20)
            .min(1.0);
        self.papez_gain = self.papez_gain * (1.0 - PAPEZ_EMA) + papez_target * PAPEZ_EMA;

        MBOutput {
            relay_strength: self.relay_strength,
            recency_signal: self.recency_signal,
            consolidation_rate: self.consolidation_rate,
            papez_gain: self.papez_gain,
            consolidating,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Recency decays — older material feels less fresh
        self.recency_signal = (self.recency_signal - RECENCY_DECAY).max(0.05);
        // Relay strength drifts toward baseline
        if self.relay_strength > RELAY_BASELINE {
            self.relay_strength = (self.relay_strength - 0.008).max(RELAY_BASELINE);
        } else if self.relay_strength < RELAY_BASELINE {
            self.relay_strength = (self.relay_strength + 0.004).min(RELAY_BASELINE);
        }
        // Consolidation rate decays
        self.consolidation_rate = (self.consolidation_rate - 0.010).max(0.10);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> MBOutput {
        MBOutput {
            relay_strength: self.relay_strength,
            recency_signal: self.recency_signal,
            consolidation_rate: self.consolidation_rate,
            papez_gain: self.papez_gain,
            consolidating: self.consolidation_rate > 0.50,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "MB relay={:.2} | recency={:.2} | consol={:.2} | papez={:.2}",
            self.relay_strength, self.recency_signal, self.consolidation_rate, self.papez_gain,
        )
    }
}

impl Default for MammillaryBodies {
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
        let m = MammillaryBodies::new();
        assert!((m.relay_strength - RELAY_BASELINE).abs() < 0.01);
        assert!(
            m.recency_signal > 0.70,
            "should start with fresh recency: {:.2}",
            m.recency_signal
        );
    }

    #[test]
    fn test_high_salience_raises_relay() {
        let mut m = MammillaryBodies::new();
        let before = m.relay_strength;
        m.process(0.90, 0.80, 0.20, 0.30);
        assert!(
            m.relay_strength > before,
            "high hippocampal salience should raise relay: {:.2} → {:.2}",
            before,
            m.relay_strength
        );
    }

    #[test]
    fn test_new_input_spikes_recency() {
        let mut m = MammillaryBodies::new();
        m.recency_signal = 0.20; // artificially low
        m.process(0.50, 0.50, 0.40, 0.30);
        assert!(
            m.recency_signal > 0.20,
            "new input should spike recency: {:.2}",
            m.recency_signal
        );
    }

    #[test]
    fn test_high_sleep_pressure_raises_consolidation() {
        let mut m = MammillaryBodies::new();
        let before = m.consolidation_rate;
        m.process(0.50, 0.50, 0.40, 0.90);
        assert!(
            m.consolidation_rate >= before,
            "high sleep pressure should raise consolidation rate: {:.2} → {:.2}",
            before,
            m.consolidation_rate
        );
    }

    #[test]
    fn test_consolidating_flag_above_threshold() {
        let mut m = MammillaryBodies::new();
        m.consolidation_rate = 0.60;
        let out = m.current_output();
        assert!(
            out.consolidating,
            "consolidation_rate > 0.50 → consolidating"
        );
    }

    #[test]
    fn test_recency_decays_over_time() {
        let mut m = MammillaryBodies::new();
        let before = m.recency_signal;
        for _ in 0..20 {
            m.decay();
        }
        assert!(
            m.recency_signal < before,
            "recency should decay over time: {:.2} → {:.2}",
            before,
            m.recency_signal
        );
        assert!(m.recency_signal >= 0.05, "should not decay below minimum");
    }

    #[test]
    fn test_papez_gain_updates_with_relay() {
        let mut m = MammillaryBodies::new();
        let before = m.papez_gain;
        // Multiple high-salience inputs
        for _ in 0..5 {
            m.process(0.90, 0.80, 0.10, 0.50);
        }
        assert!(
            m.papez_gain >= before - 0.01,
            "papez gain should not collapse with high activity: {:.2}",
            m.papez_gain
        );
    }

    #[test]
    fn test_turn_counter_increments() {
        let mut m = MammillaryBodies::new();
        let before = m.turn_counter;
        m.process(0.50, 0.40, 0.30, 0.20);
        assert_eq!(m.turn_counter, before + 1, "turn counter should increment");
    }

    #[test]
    fn test_decay_reduces_consolidation() {
        let mut m = MammillaryBodies::new();
        m.consolidation_rate = 0.80;
        for _ in 0..10 {
            m.decay();
        }
        assert!(
            m.consolidation_rate < 0.80,
            "consolidation rate should decay: {:.2}",
            m.consolidation_rate
        );
    }

    #[test]
    fn test_status_line() {
        let m = MammillaryBodies::new();
        let s = m.status_line();
        assert!(s.contains("MB"), "status should mention MB");
        assert!(s.contains("relay"), "status should show relay");
    }
}

// KAI v6.0.0
