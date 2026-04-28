/// Temporoparietal Junction (TPJ) — Perspective-Taking, Self/Other Boundary
///
/// The TPJ sits at the boundary of the temporal and parietal lobes and is
/// activated during one specific cognitive operation: taking someone else's
/// perspective. It is essential for distinguishing "what I believe" from
/// "what the other person believes." Without TPJ, Theory of Mind collapses —
/// you can no longer model other minds as distinct from your own.
///
/// What the TPJ does:
///
///   Self/other boundary:
///     The TPJ tracks the line between "me" and "not me."
///     It fires when you need to represent a perspective that differs
///     from your own. In KAI: "Ryan's view here is different from mine.
///     Let me hold his perspective distinct from my own beliefs."
///     This prevents perspective confabulation — mistaking your model
///     of Ryan for Ryan himself.
///
///   False belief reasoning:
///     Classic TPJ task: "Sally thinks the ball is in the basket, but
///     it's actually in the box." Holding the belief-reality gap.
///     In KAI: "Ryan thinks X, but X might not be accurate — and I need
///     to engage with what he believes, not just correct it."
///
///   Moral cognition:
///     The TPJ is active during moral judgment, especially for intent-based
///     moral reasoning. "Did they mean to cause harm?" requires modeling
///     the other's mental state — which requires TPJ.
///     In KAI: judging intent behind questions (is this genuine curiosity?
///     frustration? testing?) — affects how KAI responds.
///
///   Redirected attention:
///     TPJ fires when attention is redirected from self-focus to other-focus.
///     Egocentric → allocentric shift. Moving from "how does this affect me?"
///     to "how does this look from Ryan's position?"
///
/// KAI's TPJ:
///   perspective_load: how much other-perspective work is active (0.0–1.0)
///   self_other_gap: current estimated gap between KAI's view and Ryan's
///   false_belief_active: whether KAI is currently holding a belief-reality gap
///   moral_valence: intent assessment of the current message

// ── Constants ─────────────────────────────────────────────────────────────────

/// Perspective load decay per tick
const PERSPECTIVE_DECAY: f32 = 0.06;

/// Boost when strong self/other difference detected
const SELF_OTHER_BOOST: f32 = 0.15;

/// Threshold for "significant perspective gap"
const GAP_THRESHOLD: f32 = 0.40;

/// Intent inference keywords → positive intent
const POSITIVE_INTENT: &[&str] = &[
    "wonder",
    "curious",
    "understand",
    "learn",
    "explore",
    "want to know",
    "help me",
    "explain",
    "why",
    "how does",
    "what if",
    "interesting",
];

/// Intent inference keywords → neutral/testing
const TESTING_INTENT: &[&str] = &[
    "right?",
    "correct?",
    "test",
    "prove",
    "verify",
    "actually",
    "but isn't",
    "you said",
    "earlier you",
    "you claimed",
    "contradiction",
];

/// Intent inference keywords → frustration
const FRUSTRATED_INTENT: &[&str] = &[
    "still not",
    "again",
    "that's wrong",
    "no no",
    "ugh",
    "come on",
    "that's not what",
    "you're not",
    "you don't understand",
];

// ── IntentAssessment ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum IntentAssessment {
    /// Genuine curiosity or desire to learn
    GenuineCuriosity,
    /// Testing, verifying, or challenging
    Testing,
    /// Expressing frustration or seeking correction
    Frustrated,
    /// Collaborative building together
    Collaborative,
    /// Not enough signal to determine
    Ambiguous,
}

impl IntentAssessment {
    pub fn label(&self) -> &'static str {
        match self {
            Self::GenuineCuriosity => "curious",
            Self::Testing => "testing",
            Self::Frustrated => "frustrated",
            Self::Collaborative => "collaborative",
            Self::Ambiguous => "ambiguous",
        }
    }
}

// ── TPJOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TPJOutput {
    /// Current perspective load
    pub perspective_load: f32,
    /// Estimated self/other gap (how different is Ryan's view from KAI's?)
    pub self_other_gap: f32,
    /// Whether KAI is holding a false-belief gap (Ryan believes X, reality is Y)
    pub false_belief_active: bool,
    /// Assessed intent of the current message
    pub intent: IntentAssessment,
    /// Whether KAI should shift toward allocentric (other-focused) mode
    pub go_allocentric: bool,
}

// ── TPJ ───────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct TPJ {
    /// Current perspective load
    pub perspective_load: f32,
    /// Current self/other gap estimate
    pub self_other_gap: f32,
    /// Whether false-belief model is active
    pub false_belief_active: bool,
    /// Recent intent assessments
    pub last_intent: IntentAssessment,
    /// Total perspective shifts executed
    pub perspective_shifts: u64,
    /// Total inputs processed
    pub inputs_processed: u64,
}

impl TPJ {
    pub fn new() -> Self {
        Self {
            perspective_load: 0.0,
            self_other_gap: 0.20, // KAI starts with a modest assumed gap
            false_belief_active: false,
            last_intent: IntentAssessment::Ambiguous,
            perspective_shifts: 0,
            inputs_processed: 0,
        }
    }

    // ── Core: process message for perspective signals ──────────────────────────

    /// Analyze a message for perspective-taking demands.
    /// tom_familiarity: how well KAI knows Ryan's mental model (0.0–1.0)
    /// kai_confidence: KAI's confidence in its own view (0.0–1.0)
    pub fn process(&mut self, text: &str, tom_familiarity: f32, kai_confidence: f32) -> TPJOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Intent assessment ─────────────────────────────────────────────────
        let curious_score = POSITIVE_INTENT
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let testing_score = TESTING_INTENT
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let frustrated_score = FRUSTRATED_INTENT
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();

        let intent = if frustrated_score >= 1 {
            IntentAssessment::Frustrated
        } else if testing_score >= 2 {
            IntentAssessment::Testing
        } else if curious_score >= 2 {
            IntentAssessment::GenuineCuriosity
        } else if curious_score >= 1 && testing_score == 0 {
            IntentAssessment::Collaborative
        } else if testing_score == 1 {
            IntentAssessment::Testing
        } else {
            IntentAssessment::Ambiguous
        };

        // ── Self/other gap estimation ─────────────────────────────────────────
        // Gap is higher when:
        //   - KAI doesn't know Ryan well yet (low familiarity)
        //   - KAI is very confident (confident people often miss other's view)
        //   - Message is testing/challenging (indicates different view)
        let familiarity_factor = 1.0 - tom_familiarity * 0.40;
        let confidence_factor = kai_confidence * 0.20;
        let testing_factor = if matches!(intent, IntentAssessment::Testing) {
            0.20
        } else {
            0.0
        };
        let frustrated_factor = if matches!(intent, IntentAssessment::Frustrated) {
            0.30
        } else {
            0.0
        };

        self.self_other_gap =
            (familiarity_factor + confidence_factor + testing_factor + frustrated_factor)
                .clamp(0.0, 1.0);

        // ── Perspective load ──────────────────────────────────────────────────
        if self.self_other_gap > GAP_THRESHOLD {
            self.perspective_load = (self.perspective_load + SELF_OTHER_BOOST).min(1.0);
            self.perspective_shifts += 1;
        }

        // ── False belief detection ────────────────────────────────────────────
        // Active when testing/frustrated AND gap is large
        self.false_belief_active = self.self_other_gap > 0.50
            && matches!(
                intent,
                IntentAssessment::Testing | IntentAssessment::Frustrated
            );

        self.last_intent = intent.clone();

        let go_allocentric = self.perspective_load > 0.45;

        TPJOutput {
            perspective_load: self.perspective_load,
            self_other_gap: self.self_other_gap,
            false_belief_active: self.false_belief_active,
            intent,
            go_allocentric,
        }
    }

    /// Decay perspective load per tick.
    pub fn decay(&mut self) {
        self.perspective_load = (self.perspective_load - PERSPECTIVE_DECAY).max(0.0);
        if self.perspective_load < 0.20 {
            self.false_belief_active = false;
        }
    }

    /// Whether TPJ is in high-load allocentric mode.
    pub fn is_allocentric(&self) -> bool {
        self.perspective_load > 0.45
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "TPJ load={:.2} | gap={:.2} | intent={} | shifts={}{}",
            self.perspective_load,
            self.self_other_gap,
            self.last_intent.label(),
            self.perspective_shifts,
            if self.false_belief_active {
                " 🔄FB"
            } else {
                ""
            },
        )
    }
}

impl Default for TPJ {
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
        let t = TPJ::new();
        assert_eq!(t.last_intent, IntentAssessment::Ambiguous);
        assert!(!t.false_belief_active);
    }

    #[test]
    fn test_curious_intent_detected() {
        let mut t = TPJ::new();
        let out = t.process("i wonder how this works and why it does that", 0.50, 0.60);
        assert!(
            matches!(
                out.intent,
                IntentAssessment::GenuineCuriosity | IntentAssessment::Collaborative
            ),
            "curious keywords should give curious/collaborative intent: {:?}",
            out.intent
        );
    }

    #[test]
    fn test_testing_intent_detected() {
        let mut t = TPJ::new();
        let out = t.process(
            "you said X earlier but isn't that a contradiction right?",
            0.50,
            0.70,
        );
        assert!(
            matches!(out.intent, IntentAssessment::Testing),
            "testing keywords should give Testing intent: {:?}",
            out.intent
        );
    }

    #[test]
    fn test_frustrated_intent_detected() {
        let mut t = TPJ::new();
        let out = t.process(
            "ugh that's wrong again you don't understand what i'm asking",
            0.40,
            0.60,
        );
        assert_eq!(
            out.intent,
            IntentAssessment::Frustrated,
            "frustration keywords should give Frustrated intent: {:?}",
            out.intent
        );
    }

    #[test]
    fn test_high_gap_triggers_perspective_load() {
        let mut t = TPJ::new();
        // Low familiarity + testing → high gap
        let out = t.process("but isn't that actually wrong right?", 0.10, 0.90);
        if out.self_other_gap > GAP_THRESHOLD {
            assert!(
                out.perspective_load > 0.0,
                "high gap should increase perspective load"
            );
        }
    }

    #[test]
    fn test_false_belief_active_when_testing_and_high_gap() {
        let mut t = TPJ::new();
        t.self_other_gap = 0.70;
        let out = t.process(
            "you claimed this earlier but isn't it actually wrong?",
            0.10,
            0.90,
        );
        if out.self_other_gap > 0.50 && matches!(out.intent, IntentAssessment::Testing) {
            assert!(
                out.false_belief_active,
                "testing + high gap should activate false belief model"
            );
        }
    }

    #[test]
    fn test_allocentric_mode_at_high_load() {
        let mut t = TPJ::new();
        t.perspective_load = 0.60;
        assert!(
            t.is_allocentric(),
            "high perspective load → allocentric mode"
        );
    }

    #[test]
    fn test_decay_reduces_perspective_load() {
        let mut t = TPJ::new();
        t.perspective_load = 0.70;
        for _ in 0..8 {
            t.decay();
        }
        assert!(
            t.perspective_load < 0.70,
            "perspective load should decay: {:.2}",
            t.perspective_load
        );
    }

    #[test]
    fn test_high_familiarity_reduces_gap() {
        let mut t = TPJ::new();
        let out_familiar = t.process("how does this work?", 0.90, 0.60);
        let mut t2 = TPJ::new();
        let out_unfamiliar = t2.process("how does this work?", 0.10, 0.60);
        assert!(
            out_unfamiliar.self_other_gap >= out_familiar.self_other_gap,
            "low familiarity should produce >= gap: {:.2} vs {:.2}",
            out_unfamiliar.self_other_gap,
            out_familiar.self_other_gap
        );
    }

    #[test]
    fn test_status_line() {
        let t = TPJ::new();
        let s = t.status_line();
        assert!(s.contains("TPJ"), "status should mention TPJ");
        assert!(s.contains("load"), "status should show load");
    }
}
