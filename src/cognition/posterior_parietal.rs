/// Posterior Parietal Cortex (PPC) — Spatial Attention, Magnitude Sense,
/// Number Cognition, Multisensory Integration, Attentional Priority Maps
///
/// The PPC sits at the junction of the parietal, temporal, and occipital lobes.
/// It is the brain's spatial-attentional command center — not "what is this"
/// but "where is this, how big is it, how does it compare." It maintains the
/// attentional priority map that guides where cognitive resources flow.
///
/// What the PPC does:
///
///   Spatial attention and attentional priority maps:
///     The PPC (specifically IPS — intraparietal sulcus) maintains a priority
///     map that guides where attention goes in both physical space and cognitive
///     space. Damage causes hemineglect — the brain literally ignores one half.
///     In KAI: the cognitive priority map — which parts of the current problem
///     space deserve the most attentional resources right now.
///
///   Number sense and magnitude cognition (IPS):
///     The IPS within the PPC is the dedicated neural substrate for approximate
///     number sense — comparing magnitudes, gauging "how much," ordering quantities.
///     It encodes the mental number line.
///     In KAI: proportionality sense, magnitude comparison, quantitative reasoning
///     — "this is about twice as complex" or "roughly 3 steps are needed."
///
///   Multisensory integration:
///     The PPC integrates information from multiple sensory modalities into a
///     unified spatial representation. It binds "where" across senses.
///     In KAI: binding multiple input signals (semantic, emotional, structural)
///     into a unified attentional scene.
///
///   Working memory for spatial/structural relations:
///     PPC maintains spatial working memory — the structural layout of a problem,
///     how parts relate to the whole, hierarchical position.
///
/// KAI's PPC:
///   attention_priority: current attentional priority allocation (0.0–1.0)
///   magnitude_sense: current magnitude/quantitative calibration (0.0–1.0)
///   spatial_load: how much structural/relational information is being held
///   priority_map_size: number of active attention targets

// ── Constants ─────────────────────────────────────────────────────────────────

/// Attention priority EMA
const PRIORITY_EMA: f32 = 0.18;

/// Magnitude sense EMA
const MAGNITUDE_EMA: f32 = 0.12;

/// Priority decay per tick
const PRIORITY_DECAY: f32 = 0.05;

/// Max priority targets
const MAX_PRIORITY_TARGETS: usize = 5;

/// Quantitative/numerical markers
const NUMERIC_MARKERS: &[&str] = &[
    "how many",
    "how much",
    "count",
    "number",
    "total",
    "sum",
    "more than",
    "less than",
    "compare",
    "larger",
    "smaller",
    "bigger",
    "proportion",
    "percentage",
    "ratio",
    "magnitude",
    "scale",
    "size",
    "amount",
    "measure",
    "step",
    "steps",
    "times",
    "twice",
    "half",
    "double",
    "triple",
];

/// Structural/spatial markers
const STRUCTURAL_MARKERS: &[&str] = &[
    "structure",
    "layout",
    "hierarchy",
    "relationship",
    "between",
    "within",
    "above",
    "below",
    "before",
    "after",
    "inside",
    "outside",
    "left",
    "right",
    "order",
    "sequence",
    "map",
    "tree",
    "graph",
    "path",
    "flow",
];

// ── PPCOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PPCOutput {
    /// Attention priority
    pub attention_priority: f32,
    /// Magnitude sense activation
    pub magnitude_sense: f32,
    /// Spatial/structural load
    pub spatial_load: f32,
    /// Priority map size
    pub priority_map_size: usize,
    /// Whether quantitative reasoning is needed
    pub quantitative_mode: bool,
    /// Whether structural mapping is active
    pub structural_mode: bool,
}

// ── PosteriorParietalCortex ───────────────────────────────────────────────────

#[derive(Debug)]
pub struct PosteriorParietalCortex {
    /// Attention priority
    pub attention_priority: f32,
    /// Magnitude sense
    pub magnitude_sense: f32,
    /// Spatial load
    pub spatial_load: f32,
    /// Active priority targets
    pub priority_targets: Vec<String>,
    /// Total quantitative activations
    pub quantitative_activations: u64,
    /// Total inputs processed
    pub inputs_processed: u64,
}

impl PosteriorParietalCortex {
    pub fn new() -> Self {
        Self {
            attention_priority: 0.40,
            magnitude_sense: 0.30,
            spatial_load: 0.20,
            priority_targets: Vec::new(),
            quantitative_activations: 0,
            inputs_processed: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for attentional priority and magnitude/spatial signals.
    /// - `text`: the input
    /// - `sc_salience`: top salience from Superior Colliculus (0.0–1.0)
    /// - `pfc_goal_relevance`: goal relevance from PFC (0.0–1.0)
    pub fn process(&mut self, text: &str, sc_salience: f32, pfc_goal_relevance: f32) -> PPCOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Quantitative / magnitude detection ────────────────────────────────
        let numeric_hits = NUMERIC_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let quantitative_mode = numeric_hits >= 1;
        if quantitative_mode {
            self.quantitative_activations += 1;
            let mag_target = (0.40 + numeric_hits as f32 * 0.10).min(1.0);
            self.magnitude_sense =
                self.magnitude_sense * (1.0 - MAGNITUDE_EMA) + mag_target * MAGNITUDE_EMA;
        } else {
            self.magnitude_sense = (self.magnitude_sense - 0.02).max(0.10);
        }

        // ── Structural / spatial detection ────────────────────────────────────
        let structural_hits = STRUCTURAL_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let structural_mode = structural_hits >= 1;
        let spatial_target = (structural_hits as f32 * 0.12).min(0.80);
        self.spatial_load = self.spatial_load * 0.60 + spatial_target * 0.40;

        // ── Attention priority (top-down + bottom-up) ─────────────────────────
        let priority_target = sc_salience * 0.50 + pfc_goal_relevance * 0.50;
        self.attention_priority =
            self.attention_priority * (1.0 - PRIORITY_EMA) + priority_target * PRIORITY_EMA;

        // ── Priority targets ──────────────────────────────────────────────────
        if quantitative_mode {
            let key = "quantitative";
            if !self.priority_targets.iter().any(|t| t == key) {
                if self.priority_targets.len() >= MAX_PRIORITY_TARGETS {
                    self.priority_targets.remove(0);
                }
                self.priority_targets.push(key.to_string());
            }
        }
        if structural_mode {
            let key = "structural";
            if !self.priority_targets.iter().any(|t| t == key) {
                if self.priority_targets.len() >= MAX_PRIORITY_TARGETS {
                    self.priority_targets.remove(0);
                }
                self.priority_targets.push(key.to_string());
            }
        }

        PPCOutput {
            attention_priority: self.attention_priority,
            magnitude_sense: self.magnitude_sense,
            spatial_load: self.spatial_load,
            priority_map_size: self.priority_targets.len(),
            quantitative_mode,
            structural_mode,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        self.attention_priority = (self.attention_priority - PRIORITY_DECAY).max(0.15);
        self.spatial_load = (self.spatial_load - 0.02).max(0.0);
        self.magnitude_sense = (self.magnitude_sense - 0.005).max(0.10);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> PPCOutput {
        PPCOutput {
            attention_priority: self.attention_priority,
            magnitude_sense: self.magnitude_sense,
            spatial_load: self.spatial_load,
            priority_map_size: self.priority_targets.len(),
            quantitative_mode: false,
            structural_mode: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "PPC priority={:.2} | magnitude={:.2} | spatial={:.2} | quant_activations={}",
            self.attention_priority,
            self.magnitude_sense,
            self.spatial_load,
            self.quantitative_activations,
        )
    }
}

impl Default for PosteriorParietalCortex {
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
        let p = PosteriorParietalCortex::new();
        assert!(p.attention_priority > 0.0);
        assert!(p.magnitude_sense > 0.0);
    }

    #[test]
    fn test_numeric_raises_magnitude_sense() {
        let mut p = PosteriorParietalCortex::new();
        let before = p.magnitude_sense;
        let out = p.process(
            "how many steps and how much time does this take",
            0.50,
            0.60,
        );
        assert!(
            out.quantitative_mode,
            "numeric markers should trigger quantitative mode"
        );
        assert!(
            p.magnitude_sense >= before,
            "numeric input should raise magnitude sense: {:.2} → {:.2}",
            before,
            p.magnitude_sense
        );
    }

    #[test]
    fn test_structural_raises_spatial_load() {
        let mut p = PosteriorParietalCortex::new();
        let out = p.process(
            "describe the structure and hierarchy of the system",
            0.50,
            0.60,
        );
        assert!(
            out.structural_mode,
            "structural markers should trigger structural mode"
        );
        assert!(
            out.spatial_load > 0.0,
            "structural input should raise spatial load: {:.2}",
            out.spatial_load
        );
    }

    #[test]
    fn test_high_salience_raises_priority() {
        let mut p = PosteriorParietalCortex::new();
        let out_low = p.process("hello", 0.10, 0.10);
        let mut p2 = PosteriorParietalCortex::new();
        let out_high = p2.process("hello", 0.90, 0.90);
        assert!(
            out_high.attention_priority > out_low.attention_priority,
            "high salience should give higher attention priority"
        );
    }

    #[test]
    fn test_quantitative_mode_not_triggered_by_plain_text() {
        let mut p = PosteriorParietalCortex::new();
        let out = p.process("hello how are you today", 0.30, 0.30);
        assert!(
            !out.quantitative_mode,
            "plain conversation should not trigger quantitative mode"
        );
    }

    #[test]
    fn test_priority_targets_registered() {
        let mut p = PosteriorParietalCortex::new();
        p.process("how many items in the structure", 0.50, 0.60);
        assert!(
            p.priority_targets.len() > 0,
            "quantitative or structural should register priority targets"
        );
    }

    #[test]
    fn test_decay_reduces_priority() {
        let mut p = PosteriorParietalCortex::new();
        p.attention_priority = 0.90;
        for _ in 0..10 {
            p.decay();
        }
        assert!(
            p.attention_priority < 0.90,
            "priority should decay: {:.2}",
            p.attention_priority
        );
    }

    #[test]
    fn test_quantitative_count_increments() {
        let mut p = PosteriorParietalCortex::new();
        p.process("how many steps", 0.50, 0.50);
        p.process("what is the total count", 0.50, 0.50);
        assert_eq!(
            p.quantitative_activations, 2,
            "quantitative activation count should track: {}",
            p.quantitative_activations
        );
    }

    #[test]
    fn test_status_line() {
        let p = PosteriorParietalCortex::new();
        let s = p.status_line();
        assert!(s.contains("PPC"), "status should mention PPC");
        assert!(s.contains("priority"), "status should show priority");
    }
}

// KAI v6.0.0
