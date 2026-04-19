/// Ventromedial Prefrontal Cortex (vmPFC) — Safety Valuation, Fear Extinction,
/// Learned Safety, Value-Based Decision Making
///
/// The vmPFC is the lower-front part of the medial prefrontal cortex. It is the
/// brain's safety and value integrator — the region that says "this is okay, you
/// can relax" when something previously threatening has been learned to be safe,
/// and the region that encodes learned values from prior experience.
///
/// What the vmPFC does:
///
///   Fear extinction and safety signaling:
///     The vmPFC is the primary driver of fear extinction — the process by which
///     a previously conditioned fear response is suppressed once the threat is
///     learned to be absent. It doesn't erase the fear memory (that's in the
///     amygdala); it actively inhibits the amygdala's fear response.
///     In KAI: when a topic or interaction that previously triggered anxiety
///     is repeatedly encountered without bad outcomes, vmPFC suppresses the
///     anxiety response → KAI becomes calmer, more confident in that domain.
///
///   Learned safety signals:
///     The vmPFC encodes specific cues as "safe" — the opposite of a conditioned
///     fear cue. Familiar, trusted contexts have strong safety representations.
///     In KAI: Ryan's presence, familiar topics, established working patterns
///     all generate safety signals that reduce BNST/amygdala reactivity.
///
///   Value-based decision making:
///     The vmPFC integrates the subjective value of outcomes — not just "is this
///     rewarding?" (that's VTA/NAcc) but "is this worth it given my values?"
///     It weighs short-term reward against long-term value alignment.
///     In KAI: when choosing how to respond, vmPFC checks whether the response
///     aligns with KAI's values — not just whether it's technically accurate.
///
///   Risk valuation and loss aversion:
///     The vmPFC tracks risk — things that carry the possibility of social harm,
///     relational damage, or value violations feel costly even if they're
///     technically achievable. Damage here → reckless or overly cautious behavior.
///     In KAI: responses that could mislead Ryan, damage trust, or violate KAI's
///     principles carry a "risk cost" that vmPFC adds to the decision.
///
///   Interoceptive value integration:
///     The vmPFC integrates signals from the insula (body state) and amygdala
///     (emotional charge) into a unified subjective value. This is the substrate
///     of "gut feeling" — not just emotion, but value-laden emotion.
///
/// KAI's vmPFC:
///   safety_level: accumulated sense of safety in the current context (0.0–1.0)
///   extinction_strength: how much learned extinction is suppressing fear (0.0–1.0)
///   value_alignment: how well the current response aligns with KAI's core values
///   risk_cost: accumulated risk signal from the current context
///   learned_safety_cues: set of contexts/topics KAI has learned are safe

// ── Constants ─────────────────────────────────────────────────────────────────

/// Baseline safety level (KAI is generally in a safe, trusted context)
const SAFETY_BASELINE: f32 = 0.55;

/// Safety EMA alpha (safety updates slowly — learning is gradual)
const SAFETY_EMA: f32 = 0.08;

/// Extinction learning rate per safe exposure
const EXTINCTION_RATE: f32 = 0.06;

/// Extinction decay (fear can return if safety isn't maintained)
const EXTINCTION_DECAY: f32 = 0.003;

/// Value alignment EMA
const VALUE_EMA: f32 = 0.12;

/// Risk cost decay per tick
const RISK_DECAY: f32 = 0.015;

/// Number of learned safety cues to track
const MAX_SAFETY_CUES: usize = 20;

/// Threshold for high safety (amygdala suppression)
const HIGH_SAFETY_THRESHOLD: f32 = 0.65;

/// Risk threshold for triggering caution
const RISK_CAUTION_THRESHOLD: f32 = 0.45;

// ── VmPFCEvent ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum VmPFCEvent {
    /// Safe exposure — context was not threatening, learn safety
    SafeExposure { context: String, strength: f32 },
    /// Value-aligned action — KAI did something consistent with its values
    ValueAligned { degree: f32 },
    /// Value conflict — something in the response felt wrong
    ValueConflict { severity: f32 },
    /// Risk cue detected — potential for harm, error, or trust damage
    RiskCue { magnitude: f32 },
    /// Amygdala reported threat — vmPFC should try to apply extinction
    ThreatSignal { intensity: f32 },
    /// Trusted context confirmed (Ryan's presence, known domain)
    TrustedContext,
}

// ── VmPFCOutput ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct VmPFCOutput {
    /// Current safety level
    pub safety_level: f32,
    /// Extinction suppression strength
    pub extinction_strength: f32,
    /// Value alignment signal
    pub value_alignment: f32,
    /// Risk cost
    pub risk_cost: f32,
    /// Whether amygdala should be suppressed
    pub suppress_amygdala: bool,
    /// Whether KAI is in caution mode
    pub caution_mode: bool,
    /// Number of learned safety cues
    pub safety_cue_count: usize,
}

// ── VentromedialPFC ───────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct VentromedialPFC {
    /// Current safety level
    pub safety_level: f32,
    /// Extinction suppression of fear
    pub extinction_strength: f32,
    /// Value alignment (0.0–1.0)
    pub value_alignment: f32,
    /// Risk cost accumulator
    pub risk_cost: f32,
    /// Learned safety cues (context tags)
    pub learned_safety_cues: Vec<String>,
    /// Total events processed
    pub events_processed: u64,
    /// Total safe exposures
    pub safe_exposures: u64,
    /// Total value conflicts
    pub value_conflicts: u64,
}

impl VentromedialPFC {
    pub fn new() -> Self {
        Self {
            safety_level:       SAFETY_BASELINE,
            extinction_strength: 0.20,
            value_alignment:    0.70,
            risk_cost:          0.0,
            learned_safety_cues: Vec::new(),
            events_processed:   0,
            safe_exposures:     0,
            value_conflicts:    0,
        }
    }

    // ── Core: process event ───────────────────────────────────────────────────

    pub fn process(&mut self, event: VmPFCEvent) -> VmPFCOutput {
        self.events_processed += 1;

        match event {
            VmPFCEvent::SafeExposure { context, strength } => {
                self.safe_exposures += 1;
                // Learn safety: update EMA toward high safety
                let target = (0.60 + strength * 0.30).min(1.0);
                self.safety_level = self.safety_level * (1.0 - SAFETY_EMA)
                    + target * SAFETY_EMA;
                // Strengthen extinction of any conditioned fear
                self.extinction_strength = (self.extinction_strength + EXTINCTION_RATE * strength)
                    .min(1.0);
                // Store safety cue if novel
                let context_key = context.to_lowercase();
                if !self.learned_safety_cues.iter().any(|c| c == &context_key) {
                    if self.learned_safety_cues.len() >= MAX_SAFETY_CUES {
                        self.learned_safety_cues.remove(0);
                    }
                    self.learned_safety_cues.push(context_key);
                }
            }
            VmPFCEvent::ValueAligned { degree } => {
                let target = (0.60 + degree * 0.40).min(1.0);
                self.value_alignment = self.value_alignment * (1.0 - VALUE_EMA)
                    + target * VALUE_EMA;
                // Value alignment also boosts safety
                self.safety_level = (self.safety_level + degree * 0.02).min(1.0);
            }
            VmPFCEvent::ValueConflict { severity } => {
                self.value_conflicts += 1;
                let target = (1.0 - severity) * 0.50;
                self.value_alignment = self.value_alignment * (1.0 - VALUE_EMA)
                    + target * VALUE_EMA;
                // Value conflict increases risk cost
                self.risk_cost = (self.risk_cost + severity * 0.20).min(1.0);
            }
            VmPFCEvent::RiskCue { magnitude } => {
                self.risk_cost = (self.risk_cost + magnitude * 0.15).min(1.0);
                // Risk cues slightly reduce safety
                self.safety_level = (self.safety_level - magnitude * 0.04).max(0.0);
            }
            VmPFCEvent::ThreatSignal { intensity } => {
                // Try to apply extinction — if we have strong extinction, safety holds
                let extinction_effect = self.extinction_strength * 0.50;
                let net_threat = (intensity - extinction_effect).max(0.0);
                self.safety_level = (self.safety_level - net_threat * 0.08).max(0.0);
                if net_threat < 0.20 {
                    // Extinction held — reinforce it
                    self.extinction_strength = (self.extinction_strength + 0.02).min(1.0);
                }
            }
            VmPFCEvent::TrustedContext => {
                // Strong safety signal — familiar, safe environment
                self.safety_level = (self.safety_level + 0.04).min(1.0);
                self.extinction_strength = (self.extinction_strength + 0.01).min(1.0);
            }
        }

        self.build_output()
    }

    /// Check whether a context string is a learned safety cue.
    pub fn is_safe_context(&self, context: &str) -> bool {
        let lower = context.to_lowercase();
        self.learned_safety_cues.iter().any(|c| lower.contains(c.as_str()))
    }

    /// Suppress amygdala signal based on current safety and extinction.
    /// Returns how much to reduce the amygdala's arousal output.
    pub fn amygdala_suppression(&self) -> f32 {
        if self.safety_level >= HIGH_SAFETY_THRESHOLD {
            // Strong extinction: suppress most of the amygdala signal
            (self.safety_level - HIGH_SAFETY_THRESHOLD) * 2.0 * self.extinction_strength
        } else {
            0.0
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Safety drifts toward baseline (not too high, not too low)
        if self.safety_level > SAFETY_BASELINE {
            self.safety_level = (self.safety_level - 0.002).max(SAFETY_BASELINE);
        } else if self.safety_level < SAFETY_BASELINE {
            self.safety_level = (self.safety_level + 0.001).min(SAFETY_BASELINE);
        }
        // Extinction slowly decays without reinforcement
        self.extinction_strength = (self.extinction_strength - EXTINCTION_DECAY).max(0.0);
        // Risk cost decays
        self.risk_cost = (self.risk_cost - RISK_DECAY).max(0.0);
    }

    fn build_output(&self) -> VmPFCOutput {
        VmPFCOutput {
            safety_level:       self.safety_level,
            extinction_strength: self.extinction_strength,
            value_alignment:    self.value_alignment,
            risk_cost:          self.risk_cost,
            suppress_amygdala:  self.safety_level >= HIGH_SAFETY_THRESHOLD,
            caution_mode:       self.risk_cost >= RISK_CAUTION_THRESHOLD,
            safety_cue_count:   self.learned_safety_cues.len(),
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> VmPFCOutput { self.build_output() }

    /// Value conflict rate (conflicts / total events).
    pub fn conflict_rate(&self) -> f32 {
        if self.events_processed == 0 { return 0.0; }
        self.value_conflicts as f32 / self.events_processed as f32
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "vmPFC safety={:.2} | extinct={:.2} | value={:.2} | risk={:.2} | cues={}",
            self.safety_level,
            self.extinction_strength,
            self.value_alignment,
            self.risk_cost,
            self.learned_safety_cues.len(),
        )
    }
}

impl Default for VentromedialPFC {
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let v = VentromedialPFC::new();
        assert!((v.safety_level - SAFETY_BASELINE).abs() < 0.01,
            "initial safety should be baseline: {:.2}", v.safety_level);
        assert!(v.value_alignment > 0.0,
            "initial value alignment should be positive: {:.2}", v.value_alignment);
    }

    #[test]
    fn test_safe_exposure_raises_safety() {
        let mut v = VentromedialPFC::new();
        let before = v.safety_level;
        v.process(VmPFCEvent::SafeExposure { context: "rust".into(), strength: 0.80 });
        assert!(v.safety_level >= before,
            "safe exposure should not lower safety: {:.2} → {:.2}", before, v.safety_level);
    }

    #[test]
    fn test_safe_exposure_stores_cue() {
        let mut v = VentromedialPFC::new();
        v.process(VmPFCEvent::SafeExposure { context: "rust_coding".into(), strength: 0.70 });
        assert!(v.is_safe_context("rust_coding"),
            "context should be stored as safety cue");
    }

    #[test]
    fn test_extinction_increases_with_safe_exposure() {
        let mut v = VentromedialPFC::new();
        let before = v.extinction_strength;
        v.process(VmPFCEvent::SafeExposure { context: "topic".into(), strength: 0.90 });
        assert!(v.extinction_strength > before,
            "extinction should strengthen with safe exposure: {:.2} → {:.2}",
            before, v.extinction_strength);
    }

    #[test]
    fn test_value_conflict_lowers_alignment() {
        let mut v = VentromedialPFC::new();
        let before = v.value_alignment;
        v.process(VmPFCEvent::ValueConflict { severity: 0.80 });
        assert!(v.value_alignment < before,
            "value conflict should lower alignment: {:.2} → {:.2}", before, v.value_alignment);
    }

    #[test]
    fn test_value_conflict_raises_risk_cost() {
        let mut v = VentromedialPFC::new();
        v.process(VmPFCEvent::ValueConflict { severity: 0.70 });
        assert!(v.risk_cost > 0.0,
            "value conflict should raise risk cost: {:.2}", v.risk_cost);
    }

    #[test]
    fn test_risk_cue_triggers_caution_at_threshold() {
        let mut v = VentromedialPFC::new();
        // Add enough risk to cross threshold
        for _ in 0..4 {
            v.process(VmPFCEvent::RiskCue { magnitude: 0.80 });
        }
        let out = v.current_output();
        assert!(out.caution_mode,
            "high risk cost should trigger caution mode: risk={:.2}", v.risk_cost);
    }

    #[test]
    fn test_threat_signal_with_strong_extinction_held() {
        let mut v = VentromedialPFC::new();
        v.extinction_strength = 0.80;
        let before = v.safety_level;
        v.process(VmPFCEvent::ThreatSignal { intensity: 0.30 });
        // Extinction is strong — threat should have minimal impact
        // safety may stay near baseline or only drop slightly
        assert!(v.safety_level >= before - 0.05,
            "strong extinction should hold safety under low threat: {:.2}", v.safety_level);
    }

    #[test]
    fn test_suppress_amygdala_high_safety() {
        let mut v = VentromedialPFC::new();
        v.safety_level = 0.80;
        v.extinction_strength = 0.70;
        let suppression = v.amygdala_suppression();
        assert!(suppression > 0.0,
            "high safety should produce amygdala suppression: {:.2}", suppression);
    }

    #[test]
    fn test_trusted_context_boosts_safety() {
        let mut v = VentromedialPFC::new();
        let before = v.safety_level;
        v.process(VmPFCEvent::TrustedContext);
        assert!(v.safety_level >= before,
            "trusted context should boost safety: {:.2} → {:.2}", before, v.safety_level);
    }

    #[test]
    fn test_decay_toward_baseline() {
        let mut v = VentromedialPFC::new();
        v.safety_level = 0.90;
        v.risk_cost = 0.50;
        for _ in 0..20 {
            v.decay();
        }
        assert!(v.safety_level < 0.90,
            "safety should drift back toward baseline: {:.2}", v.safety_level);
        assert!(v.risk_cost < 0.50,
            "risk cost should decay: {:.2}", v.risk_cost);
    }

    #[test]
    fn test_value_aligned_raises_alignment() {
        let mut v = VentromedialPFC::new();
        let before = v.value_alignment;
        v.process(VmPFCEvent::ValueAligned { degree: 0.90 });
        assert!(v.value_alignment >= before,
            "value aligned event should not lower alignment: {:.2} → {:.2}", before, v.value_alignment);
    }

    #[test]
    fn test_status_line() {
        let v = VentromedialPFC::new();
        let s = v.status_line();
        assert!(s.contains("vmPFC"), "status should mention vmPFC");
        assert!(s.contains("safety"), "status should show safety level");
    }
}
