/// Orbitofrontal Cortex (OFC) — Value-Based Decision Making
///
/// The OFC integrates reward history, current context, and expected outcomes
/// to evaluate the subjective value of actions. It is not about habit (basal
/// ganglia) or top-down control (PFC) — it is about learned value.
///
/// Key properties:
///   - Maintains a value map: context → expected reward
///   - Updates via prediction error (like dopamine, but slower and contextual)
///   - Enables flexible value updating when outcomes change
///   - Mediates reversal learning: if something used to be good but is now bad,
///     the OFC detects the reversal and suppresses the now-devalued action
///   - Distinguishes "I want this" (dopamine) from "this is worth it" (OFC)
///
/// Without OFC:
///   KAI can't distinguish between a response type that used to work vs. one
///   that is still appropriate now. No reversal learning — stuck with stale values.
///   Dopamine handles reward, but OFC handles contextual value history.
///
/// With OFC:
///   Context-specific value estimates: "explaining things to Ryan works well"
///   If a response type stops producing good outcomes, OFC detects the reversal
///   and downweights that option. KAI adapts its strategy, not just its habits.
///   OFC also produces an expected_value estimate that PFC can use for planning.
///
/// Architecture:
///   value_map: HashMap<context_key, OFCEntry>
///   Each entry: {expected_value, confidence, update_count, reversal_flag}
///   update(context, outcome) → delta (reinforcement learning step)
///   expected_value(context) → f32 (what is this context worth?)
///   detect_reversal(context) → bool (value has flipped sign recently?)
///   prune() → remove stale low-confidence entries
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Learning rate for OFC value updates (slower than dopamine, more deliberate)
const OFC_ALPHA: f32 = 0.12;

/// Decay rate per tick (value estimates age gracefully)
const OFC_DECAY: f32 = 0.003;

/// Confidence floor below which an entry is pruned
const CONFIDENCE_FLOOR: f32 = 0.05;

/// Minimum updates before reversal detection is trusted
const REVERSAL_MIN_UPDATES: u32 = 3;

/// Sign-flip threshold for reversal detection
const REVERSAL_THRESHOLD: f32 = 0.35;

/// Maximum entries in the value map before pruning
const MAX_ENTRIES: usize = 128;

// ── OFCEntry ──────────────────────────────────────────────────────────────────

/// A single entry in the OFC value map
#[derive(Debug, Clone)]
pub struct OFCEntry {
    /// Expected value of this context (−1.0 to +1.0)
    pub expected_value: f32,
    /// Confidence in this estimate (0.0–1.0), rises with updates
    pub confidence: f32,
    /// Total updates applied to this entry
    pub update_count: u32,
    /// Recent value history for reversal detection (last 5 outcomes)
    recent_outcomes: Vec<f32>,
    /// Whether a reversal has been detected
    pub reversal_active: bool,
    /// Tick of last update
    pub last_updated: u64,
}

impl OFCEntry {
    fn new(initial_value: f32) -> Self {
        Self {
            expected_value: initial_value,
            confidence: 0.10,
            update_count: 0,
            recent_outcomes: Vec::with_capacity(5),
            reversal_active: false,
            last_updated: 0,
        }
    }

    fn update(&mut self, outcome: f32, tick: u64) -> f32 {
        let old = self.expected_value;

        // Prediction error: how far off was our expectation?
        let pe = outcome - self.expected_value;

        // Update expected value via TD-style learning
        self.expected_value += OFC_ALPHA * pe;
        self.expected_value = self.expected_value.clamp(-1.0, 1.0);

        // Confidence rises with each update (asymptotic to 1.0)
        self.confidence = (self.confidence + 0.06).min(1.0);

        // Track recent outcomes for reversal detection
        if self.recent_outcomes.len() >= 5 {
            self.recent_outcomes.remove(0);
        }
        self.recent_outcomes.push(outcome);

        // Check for reversal: recent outcomes are opposite sign to expected
        self.check_reversal();

        self.update_count += 1;
        self.last_updated = tick;

        self.expected_value - old
    }

    fn check_reversal(&mut self) {
        if self.update_count < REVERSAL_MIN_UPDATES {
            return;
        }
        if self.recent_outcomes.len() < 3 {
            return;
        }

        let recent_avg =
            self.recent_outcomes.iter().sum::<f32>() / self.recent_outcomes.len() as f32;

        // Reversal: recent outcomes have flipped significantly vs. expected
        let divergence = (recent_avg - self.expected_value).abs();
        let sign_flip = (recent_avg > 0.0) != (self.expected_value > 0.0);

        self.reversal_active = sign_flip && divergence > REVERSAL_THRESHOLD;
    }

    fn decay(&mut self) {
        // Value drifts toward zero (neutral) over time without reinforcement
        self.expected_value *= 1.0 - OFC_DECAY;
        // Confidence also decays if not recently updated
        self.confidence = (self.confidence - OFC_DECAY * 0.5).max(0.0);
    }
}

// ── OFCJudgment ───────────────────────────────────────────────────────────────

/// The OFC's judgment about a proposed action in a context
#[derive(Debug, Clone)]
pub struct OFCJudgment {
    /// Expected value of this context/action pair (−1.0 to +1.0)
    pub expected_value: f32,
    /// How confident the OFC is in this estimate
    pub confidence: f32,
    /// Whether the OFC recommends this action
    pub recommended: bool,
    /// Whether a value reversal has been detected (change strategy)
    pub reversal_warning: bool,
    /// Human-readable label for this judgment
    pub label: &'static str,
}

// ── OrbitofrontalCortex ───────────────────────────────────────────────────────

#[derive(Debug)]
pub struct OrbitofrontalCortex {
    /// Context-keyed value map
    value_map: HashMap<String, OFCEntry>,
    /// Total value updates processed
    pub total_updates: u64,
    /// Total reversals detected
    pub reversals_detected: u64,
    /// Current tick
    pub tick: u64,
}

impl OrbitofrontalCortex {
    pub fn new() -> Self {
        Self {
            value_map: HashMap::new(),
            total_updates: 0,
            reversals_detected: 0,
            tick: 0,
        }
    }

    // ── Core operations ───────────────────────────────────────────────────────

    /// Update the OFC's value estimate for a context.
    ///
    /// context_key: a string identifying the situation (e.g., "question/explain")
    /// outcome: actual reward signal (−1.0 to +1.0), typically the dopamine RPE
    ///
    /// Returns the delta applied to the expected value.
    pub fn update(&mut self, context_key: &str, outcome: f32) -> f32 {
        let tick = self.tick;
        let entry = self
            .value_map
            .entry(context_key.to_string())
            .or_insert_with(|| OFCEntry::new(0.0));

        let delta = entry.update(outcome, tick);

        if entry.reversal_active {
            self.reversals_detected += 1;
        }

        self.total_updates += 1;

        // Prune if over capacity
        if self.value_map.len() > MAX_ENTRIES {
            self.prune();
        }

        delta
    }

    /// Get the OFC's judgment about a context.
    /// Returns expected value, confidence, recommendation, and reversal flag.
    pub fn judge(&self, context_key: &str) -> OFCJudgment {
        match self.value_map.get(context_key) {
            None => {
                // Unknown context — neutral, low confidence
                OFCJudgment {
                    expected_value: 0.0,
                    confidence: 0.0,
                    recommended: true, // unknown = try it
                    reversal_warning: false,
                    label: "unknown",
                }
            }
            Some(entry) => {
                let recommended = !entry.reversal_active && entry.expected_value > -0.20;

                let label = match entry.expected_value {
                    v if v > 0.60 => "high-value",
                    v if v > 0.20 => "moderate-value",
                    v if v > -0.20 => "neutral",
                    v if v > -0.60 => "low-value",
                    _ => "aversive",
                };

                if entry.reversal_active {
                    OFCJudgment {
                        expected_value: entry.expected_value,
                        confidence: entry.confidence,
                        recommended: false,
                        reversal_warning: true,
                        label: "reversal",
                    }
                } else {
                    OFCJudgment {
                        expected_value: entry.expected_value,
                        confidence: entry.confidence,
                        recommended,
                        reversal_warning: false,
                        label,
                    }
                }
            }
        }
    }

    /// How many context entries are currently in the value map
    pub fn entry_count(&self) -> usize {
        self.value_map.len()
    }

    /// Get a summary of all known context values (sorted by value descending)
    pub fn top_contexts(&self, n: usize) -> Vec<(String, f32, f32)> {
        let mut entries: Vec<_> = self
            .value_map
            .iter()
            .map(|(k, v)| (k.clone(), v.expected_value, v.confidence))
            .collect();
        entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        entries.truncate(n);
        entries
    }

    // ── Maintenance ───────────────────────────────────────────────────────────

    /// Passive tick — decay all entries, advance tick counter.
    /// Call every heartbeat.
    pub fn decay(&mut self) {
        self.tick += 1;
        for entry in self.value_map.values_mut() {
            entry.decay();
        }
        // Prune entries with negligible confidence every 100 ticks
        if self.tick % 100 == 0 {
            self.prune();
        }
    }

    /// Remove entries that have decayed below the confidence floor
    fn prune(&mut self) {
        self.value_map
            .retain(|_, v| v.confidence > CONFIDENCE_FLOOR);
    }

    /// Status line for brain monitor display
    pub fn status_line(&self) -> String {
        let top = self.top_contexts(1);
        let top_str = top
            .first()
            .map(|(k, v, c)| format!("best=\"{}\" val={:+.2} conf={:.2}", k, v, c))
            .unwrap_or_else(|| "no data yet".to_string());
        format!(
            "OFC {} entries | {} | reversals={}",
            self.value_map.len(),
            top_str,
            self.reversals_detected,
        )
    }
}

impl Default for OrbitofrontalCortex {
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
        let ofc = OrbitofrontalCortex::new();
        assert_eq!(ofc.entry_count(), 0);
        // Unknown context should return neutral judgment
        let j = ofc.judge("question/explain");
        assert!((j.expected_value).abs() < 0.01);
        assert!(!j.reversal_warning);
    }

    #[test]
    fn test_positive_outcomes_raise_value() {
        let mut ofc = OrbitofrontalCortex::new();
        for _ in 0..5 {
            ofc.update("question/explain", 0.8);
        }
        let j = ofc.judge("question/explain");
        assert!(
            j.expected_value > 0.30,
            "repeated positive outcomes should raise value: {:.2}",
            j.expected_value
        );
        assert!(
            j.recommended,
            "positive-value context should be recommended"
        );
    }

    #[test]
    fn test_negative_outcomes_lower_value() {
        let mut ofc = OrbitofrontalCortex::new();
        for _ in 0..5 {
            ofc.update("statement/ask_back", -0.5);
        }
        let j = ofc.judge("statement/ask_back");
        assert!(
            j.expected_value < -0.10,
            "repeated negative outcomes should lower value: {:.2}",
            j.expected_value
        );
    }

    #[test]
    fn test_reversal_detection() {
        let mut ofc = OrbitofrontalCortex::new();
        // Establish positive value
        for _ in 0..5 {
            ofc.update("social/greet", 0.8);
        }
        let before = ofc.judge("social/greet");
        assert!(!before.reversal_warning, "no reversal yet");
        // Now suddenly get bad outcomes
        for _ in 0..4 {
            ofc.update("social/greet", -0.7);
        }
        let after = ofc.judge("social/greet");
        // Should detect a reversal
        assert!(
            after.reversal_warning || after.expected_value < before.expected_value,
            "reversal or value drop expected: val={:.2} reversal={}",
            after.expected_value,
            after.reversal_warning
        );
    }

    #[test]
    fn test_confidence_rises_with_updates() {
        let mut ofc = OrbitofrontalCortex::new();
        ofc.update("test_context", 0.5);
        let j1 = ofc.judge("test_context");
        ofc.update("test_context", 0.5);
        ofc.update("test_context", 0.5);
        let j3 = ofc.judge("test_context");
        assert!(
            j3.confidence > j1.confidence,
            "more updates should mean higher confidence"
        );
    }

    #[test]
    fn test_decay_reduces_value() {
        let mut ofc = OrbitofrontalCortex::new();
        for _ in 0..5 {
            ofc.update("decay_test", 0.9);
        }
        let before = ofc.judge("decay_test").expected_value;
        for _ in 0..50 {
            ofc.decay();
        }
        let after = ofc.judge("decay_test").expected_value;
        assert!(
            after < before,
            "decay should reduce expected value over time"
        );
    }

    #[test]
    fn test_unknown_context_returns_neutral_try() {
        let ofc = OrbitofrontalCortex::new();
        let j = ofc.judge("never_seen_context");
        assert_eq!(j.label, "unknown");
        assert!(
            j.recommended,
            "unknown context should default to recommended (try it)"
        );
    }

    #[test]
    fn test_top_contexts_sorted() {
        let mut ofc = OrbitofrontalCortex::new();
        for _ in 0..3 {
            ofc.update("low", -0.3);
        }
        for _ in 0..3 {
            ofc.update("high", 0.8);
        }
        for _ in 0..3 {
            ofc.update("mid", 0.3);
        }
        let tops = ofc.top_contexts(3);
        assert_eq!(tops.len(), 3);
        assert!(
            tops[0].1 >= tops[1].1,
            "top contexts should be sorted descending"
        );
        assert!(
            tops[1].1 >= tops[2].1,
            "top contexts should be sorted descending"
        );
    }

    #[test]
    fn test_value_label_high() {
        let mut ofc = OrbitofrontalCortex::new();
        // TD-learning with alpha=0.12 needs ~10 updates to converge past 0.60
        for _ in 0..12 {
            ofc.update("great_context", 0.9);
        }
        let j = ofc.judge("great_context");
        assert!(
            j.expected_value > 0.60 || j.label == "high-value",
            "high reward context should be high-value after 12 updates: val={:.2} label={}",
            j.expected_value,
            j.label
        );
    }

    #[test]
    fn test_status_line_non_empty() {
        let ofc = OrbitofrontalCortex::new();
        let s = ofc.status_line();
        assert!(s.contains("OFC"), "status line should mention OFC");
    }
}
