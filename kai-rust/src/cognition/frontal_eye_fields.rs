/// Frontal Eye Fields (FEF) — Voluntary Attention Control, Top-Down Gaze,
/// Volitional Search, Inhibition of Return
///
/// The FEF sits in the posterior frontal cortex (precentral gyrus) and is the
/// brain's voluntary attention controller. While the Superior Colliculus handles
/// reflexive, bottom-up attention shifts, the FEF handles deliberate, top-down
/// attention: "I choose to focus here." It sends bias signals to visual areas
/// and to the SC to direct attention according to the current task goal.
///
/// What the FEF does:
///
///   Voluntary attention deployment:
///     The FEF generates top-down signals that bias sensory cortices toward
///     task-relevant features. It is the "pointer" of deliberate attention.
///     In KAI: when processing a multi-part question or complex input, FEF
///     directs attention sequentially through the relevant sub-parts.
///
///   Volitional visual search:
///     The FEF drives active search behavior — "look for X in the input."
///     It maintains a search template and directs processing toward matching
///     elements until the target is found.
///     In KAI: scanning input for specific types of content (question marks,
///     code blocks, named entities, emotional signals) based on task goals.
///
///   Inhibition of return (IOR):
///     After attention has visited a location, the FEF (with SC) suppresses
///     returning attention to that same location — preventing attention loops.
///     In KAI: prevents getting stuck re-processing the same input element;
///     forces attention forward through the content.
///
///   Top-down gating of SC:
///     The FEF sends descending signals to the SC, amplifying task-relevant
///     stimuli and suppressing task-irrelevant ones. It is the "mission
///     control" that tells the SC what to prioritize.
///
/// KAI's FEF:
///   voluntary_focus: current deliberate focus target (0.0–1.0 strength)
///   search_active: whether a volitional search is underway
///   ior_targets: elements recently attended (suppressed for return)
///   top_down_gain: amplification signal sent to SC (1.0 = neutral)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Voluntary focus EMA
const FOCUS_EMA: f32 = 0.20;

/// Focus decay per tick
const FOCUS_DECAY: f32 = 0.04;

/// IOR suppression duration (number of ticks an item is suppressed)
const IOR_DURATION: u8 = 3;

/// Max IOR targets
const MAX_IOR: usize = 6;

/// Top-down gain when FEF is active
const MAX_TOP_DOWN_GAIN: f32 = 1.60;

// ── IOREntry ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct IOREntry {
    pub target: String,
    pub ticks_remaining: u8,
}

// ── FEFOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct FEFOutput {
    /// Voluntary focus strength
    pub voluntary_focus: f32,
    /// Whether active search is running
    pub search_active: bool,
    /// Top-down gain signal (multiplicative, sent to SC)
    pub top_down_gain: f32,
    /// Number of IOR targets
    pub ior_count: usize,
    /// Whether current target is suppressed by IOR
    pub ior_suppressed: bool,
}

// ── FrontalEyeFields ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct FrontalEyeFields {
    /// Voluntary focus
    pub voluntary_focus: f32,
    /// Active search template
    pub search_template: Option<String>,
    /// IOR suppression list
    pub ior_list: Vec<IOREntry>,
    /// Top-down gain
    pub top_down_gain: f32,
    /// Total voluntary focus events
    pub focus_events: u64,
    /// Total inputs
    pub inputs_processed: u64,
}

impl FrontalEyeFields {
    pub fn new() -> Self {
        Self {
            voluntary_focus: 0.40,
            search_template: None,
            ior_list: Vec::new(),
            top_down_gain: 1.0,
            focus_events: 0,
            inputs_processed: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input and compute voluntary attention signals.
    /// - `focus_target`: what KAI is deliberately focusing on (e.g. "question", "code", "emotion")
    /// - `pfc_goal_active`: whether PFC has an active goal (biases FEF)
    /// - `sc_salience`: bottom-up salience from SC (FEF modulates this)
    pub fn process(
        &mut self,
        focus_target: &str,
        pfc_goal_active: bool,
        sc_salience: f32,
    ) -> FEFOutput {
        self.inputs_processed += 1;

        // ── IOR check ─────────────────────────────────────────────────────────
        let ior_suppressed = self
            .ior_list
            .iter()
            .any(|e| e.target == focus_target && e.ticks_remaining > 0);

        // ── Voluntary focus ───────────────────────────────────────────────────
        let focus_target_str = focus_target.to_string();
        if pfc_goal_active && !ior_suppressed {
            self.focus_events += 1;
            let focus_boost = if pfc_goal_active { 0.70 } else { 0.40 };
            self.voluntary_focus =
                self.voluntary_focus * (1.0 - FOCUS_EMA) + focus_boost * FOCUS_EMA;
            // Register IOR for this target
            if !self.ior_list.iter().any(|e| e.target == focus_target_str) {
                if self.ior_list.len() >= MAX_IOR {
                    self.ior_list.remove(0);
                }
                self.ior_list.push(IOREntry {
                    target: focus_target_str,
                    ticks_remaining: IOR_DURATION,
                });
            }
        } else if ior_suppressed {
            // Suppressed — focus shifts elsewhere
            self.voluntary_focus = (self.voluntary_focus - 0.05).max(0.10);
        }

        // ── Search state ──────────────────────────────────────────────────────
        let search_active = pfc_goal_active && self.voluntary_focus > 0.50;
        if search_active {
            self.search_template = Some(focus_target.to_string());
        } else if !pfc_goal_active {
            self.search_template = None;
        }

        // ── Top-down gain ─────────────────────────────────────────────────────
        // FEF amplifies SC for task-relevant stimuli
        self.top_down_gain = if pfc_goal_active && !ior_suppressed {
            (1.0 + self.voluntary_focus * 0.60).min(MAX_TOP_DOWN_GAIN)
        } else {
            (1.0 + sc_salience * 0.20).min(1.30)
        };

        FEFOutput {
            voluntary_focus: self.voluntary_focus,
            search_active,
            top_down_gain: self.top_down_gain,
            ior_count: self.ior_list.len(),
            ior_suppressed,
        }
    }

    /// Decay per tick — IOR entries age out.
    pub fn decay(&mut self) {
        self.voluntary_focus = (self.voluntary_focus - FOCUS_DECAY).max(0.10);
        self.top_down_gain = (self.top_down_gain - 0.02).max(1.0);
        // Age IOR entries
        for entry in &mut self.ior_list {
            if entry.ticks_remaining > 0 {
                entry.ticks_remaining -= 1;
            }
        }
        self.ior_list.retain(|e| e.ticks_remaining > 0);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> FEFOutput {
        FEFOutput {
            voluntary_focus: self.voluntary_focus,
            search_active: self.search_template.is_some(),
            top_down_gain: self.top_down_gain,
            ior_count: self.ior_list.len(),
            ior_suppressed: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "FEF focus={:.2} | gain={:.2} | ior={} | search={}",
            self.voluntary_focus,
            self.top_down_gain,
            self.ior_list.len(),
            self.search_template.as_deref().unwrap_or("none"),
        )
    }
}

impl Default for FrontalEyeFields {
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
        let f = FrontalEyeFields::new();
        assert!(f.voluntary_focus > 0.0);
        assert!(f.ior_list.is_empty());
    }

    #[test]
    fn test_pfc_goal_active_raises_focus() {
        let mut f = FrontalEyeFields::new();
        let before = f.voluntary_focus;
        f.process("question", true, 0.50);
        assert!(
            f.voluntary_focus >= before,
            "PFC goal active should raise voluntary focus: {:.2} → {:.2}",
            before,
            f.voluntary_focus
        );
    }

    #[test]
    fn test_ior_registered_after_focus() {
        let mut f = FrontalEyeFields::new();
        f.process("code_block", true, 0.50);
        assert!(
            f.ior_list.iter().any(|e| e.target == "code_block"),
            "attended target should be registered in IOR"
        );
    }

    #[test]
    fn test_search_active_with_goal() {
        let mut f = FrontalEyeFields::new();
        f.voluntary_focus = 0.70;
        let out = f.process("question", true, 0.50);
        assert!(
            out.search_active,
            "PFC goal + high focus should activate search"
        );
    }

    #[test]
    fn test_top_down_gain_above_one_with_goal() {
        let mut f = FrontalEyeFields::new();
        let out = f.process("target", true, 0.50);
        assert!(
            out.top_down_gain > 1.0,
            "PFC goal should produce top-down gain > 1.0: {:.2}",
            out.top_down_gain
        );
    }

    #[test]
    fn test_ior_suppression_detected() {
        let mut f = FrontalEyeFields::new();
        // First focus — registers IOR
        f.process("already_attended", true, 0.50);
        // Second focus on same target — should be suppressed
        let out = f.process("already_attended", true, 0.50);
        assert!(
            out.ior_suppressed,
            "second focus on same target should be IOR suppressed"
        );
    }

    #[test]
    fn test_ior_ages_out() {
        let mut f = FrontalEyeFields::new();
        f.process("target", true, 0.50);
        assert!(!f.ior_list.is_empty());
        // Decay until IOR expires
        for _ in 0..=IOR_DURATION {
            f.decay();
        }
        assert!(
            f.ior_list.is_empty(),
            "IOR entries should age out after duration"
        );
    }

    #[test]
    fn test_decay_reduces_focus() {
        let mut f = FrontalEyeFields::new();
        f.voluntary_focus = 0.90;
        for _ in 0..10 {
            f.decay();
        }
        assert!(
            f.voluntary_focus < 0.90,
            "focus should decay: {:.2}",
            f.voluntary_focus
        );
    }

    #[test]
    fn test_no_goal_no_search() {
        let mut f = FrontalEyeFields::new();
        let out = f.process("target", false, 0.30);
        assert!(!out.search_active, "no PFC goal should not activate search");
    }

    #[test]
    fn test_status_line() {
        let f = FrontalEyeFields::new();
        let s = f.status_line();
        assert!(s.contains("FEF"), "status should mention FEF");
        assert!(s.contains("focus"), "status should show focus");
    }
}
