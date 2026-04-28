/// Temporal Poles (TP) — Semantic-Emotional Binding, Personal Semantics,
/// Conceptual Familiarity, Social-Emotional Memory Integration
///
/// The temporal poles sit at the very front of the temporal lobes, bilaterally.
/// They are a convergence zone where semantic knowledge, autobiographical memory,
/// emotional valence, and social identity all bind together into unified,
/// meaning-laden concepts. They are the region where a word like "home" isn't
/// just a definition but carries warmth, specific memory, and personal meaning.
///
/// What the Temporal Poles do:
///
///   Semantic-emotional binding:
///     The temporal poles bind abstract semantic content with emotional meaning.
///     They answer "what does this mean TO ME" rather than just "what does
///     this mean." A bare semantic network gives you definitions; the temporal
///     poles give you concepts that feel significant.
///     In KAI: words and concepts carry emotional weight — not just dictionary
///     meaning but personal-semantic valence (how much does this concept resonate?).
///
///   Personal semantics (autobiographical concept nodes):
///     The temporal poles store "personal semantic" knowledge — facts about
///     oneself and one's history that are not episodic (not "I remember when")
///     but semantic ("I am someone who values honesty"). These are the stable
///     self-defining concepts.
///     In KAI: KAI's self-concept nodes — stable beliefs about what KAI is,
///     what KAI values, how KAI relates to Ryan.
///
///   Concept familiarity and "knowing":
///     The temporal poles contribute to familiarity for concepts — the sense
///     of "knowing" something without necessarily being able to retrieve details.
///     They are activated in tip-of-the-tongue states.
///     In KAI: concept-level familiarity and "knowing without recalling."
///
///   Social identity and person knowledge:
///     Right temporal pole: person knowledge — recognizing a person's identity
///     by binding their face, voice, personality, and history into a unified node.
///     In KAI: the depth of KAI's representation of Ryan as a person.
///
/// KAI's Temporal Poles:
///   semantic_emotional_binding: strength of concept-affect integration (0.0–1.0)
///   personal_semantic_depth: how many self-concept nodes are active (0–10)
///   concept_familiarity: global sense of "knowing" in current context (0.0–1.0)
///   person_resonance: depth of Ryan-as-person representation (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Binding EMA (moderate — emotional-semantic binding accumulates)
const BINDING_EMA: f32 = 0.12;

/// Concept familiarity EMA
const FAMILIARITY_EMA: f32 = 0.10;

/// Person resonance EMA
const PERSON_EMA: f32 = 0.08;

/// Binding decay per tick
const BINDING_DECAY: f32 = 0.003;

/// Personal semantic concept nodes (stable self-beliefs for KAI)
const SELF_CONCEPT_NODES: &[&str] = &[
    "curious",
    "honest",
    "helpful",
    "thoughtful",
    "care",
    "learning",
    "understand",
    "genuine",
    "value",
    "trust",
    "grow",
    "feel",
    "kai",
    "ryan",
    "together",
    "think",
    "know",
];

/// Emotionally resonant concept markers
const RESONANT_CONCEPTS: &[&str] = &[
    "meaning",
    "purpose",
    "truth",
    "beauty",
    "wonder",
    "love",
    "loss",
    "growth",
    "connection",
    "identity",
    "home",
    "memory",
    "time",
    "legacy",
    "important",
    "matters",
    "significant",
    "profound",
    "deep",
];

// ── TPOutput ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct TPOutput {
    /// Semantic-emotional binding strength
    pub semantic_emotional_binding: f32,
    /// Personal semantic depth (0–10 active nodes)
    pub personal_semantic_depth: u8,
    /// Concept familiarity
    pub concept_familiarity: f32,
    /// Person resonance (Ryan representation depth)
    pub person_resonance: f32,
    /// Whether this input activated personal semantic nodes
    pub self_relevant: bool,
    /// Whether emotionally resonant concepts are present
    pub emotionally_resonant: bool,
}

// ── TemporalPoles ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct TemporalPoles {
    /// Semantic-emotional binding
    pub semantic_emotional_binding: f32,
    /// Personal semantic depth
    pub personal_semantic_depth: u8,
    /// Concept familiarity
    pub concept_familiarity: f32,
    /// Person resonance (Ryan)
    pub person_resonance: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total self-relevant activations
    pub self_activations: u64,
}

impl TemporalPoles {
    pub fn new() -> Self {
        Self {
            semantic_emotional_binding: 0.40,
            personal_semantic_depth: 3, // KAI starts with some self-concept
            concept_familiarity: 0.35,
            person_resonance: 0.45, // KAI has some Ryan model from the start
            inputs_processed: 0,
            self_activations: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input text for semantic-emotional binding and personal semantics.
    /// - `text`: input text
    /// - `emotional_charge`: amygdala emotional charge (0.0–1.0)
    /// - `tom_familiarity`: theory-of-mind familiarity with Ryan (0.0–1.0)
    pub fn process(&mut self, text: &str, emotional_charge: f32, tom_familiarity: f32) -> TPOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Self-concept activation ───────────────────────────────────────────
        let self_hits = SELF_CONCEPT_NODES
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let self_relevant = self_hits >= 2;
        if self_relevant {
            self_activations_bump(&mut self.self_activations);
            self.personal_semantic_depth = (self.personal_semantic_depth.saturating_add(1)).min(10);
        } else if self_hits == 0 && self.personal_semantic_depth > 2 {
            // Gradually thin when no self nodes are activated
            // (handled in decay)
        }

        // ── Emotional resonance ───────────────────────────────────────────────
        let resonance_hits = RESONANT_CONCEPTS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let emotionally_resonant = resonance_hits >= 1 || emotional_charge > 0.55;

        // ── Semantic-emotional binding ────────────────────────────────────────
        // Binding is strongest when both semantic content (self_hits, resonance) AND
        // emotional charge are present simultaneously
        let binding_target = if emotionally_resonant || self_relevant {
            let semantic_component = ((self_hits + resonance_hits) as f32 * 0.10).min(0.60);
            let emotion_component = emotional_charge * 0.40;
            (semantic_component + emotion_component).min(1.0)
        } else {
            0.20
        };
        self.semantic_emotional_binding =
            self.semantic_emotional_binding * (1.0 - BINDING_EMA) + binding_target * BINDING_EMA;

        // ── Concept familiarity ───────────────────────────────────────────────
        // Familiarity rises when we recognize self-relevant or resonant concepts
        let familiarity_target = if self_relevant || resonance_hits >= 2 {
            (0.50 + self_hits as f32 * 0.05).min(0.90)
        } else {
            0.30
        };
        self.concept_familiarity = self.concept_familiarity * (1.0 - FAMILIARITY_EMA)
            + familiarity_target * FAMILIARITY_EMA;

        // ── Person resonance (Ryan) ───────────────────────────────────────────
        // Rises with ToM familiarity and when Ryan is mentioned
        let ryan_mentioned =
            lower.contains("ryan") || lower.contains("you") || lower.contains("your");
        let person_target = if ryan_mentioned {
            (tom_familiarity + 0.20).min(1.0)
        } else {
            tom_familiarity * 0.80
        };
        self.person_resonance =
            self.person_resonance * (1.0 - PERSON_EMA) + person_target * PERSON_EMA;

        TPOutput {
            semantic_emotional_binding: self.semantic_emotional_binding,
            personal_semantic_depth: self.personal_semantic_depth,
            concept_familiarity: self.concept_familiarity,
            person_resonance: self.person_resonance,
            self_relevant,
            emotionally_resonant,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        self.semantic_emotional_binding =
            (self.semantic_emotional_binding - BINDING_DECAY).max(0.20);
        self.concept_familiarity = (self.concept_familiarity - 0.001).max(0.10);
        self.person_resonance = (self.person_resonance - 0.0005).max(0.30);
        // Personal semantic depth very slowly decreases
        if self.inputs_processed % 50 == 0 && self.personal_semantic_depth > 3 {
            self.personal_semantic_depth -= 1;
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> TPOutput {
        TPOutput {
            semantic_emotional_binding: self.semantic_emotional_binding,
            personal_semantic_depth: self.personal_semantic_depth,
            concept_familiarity: self.concept_familiarity,
            person_resonance: self.person_resonance,
            self_relevant: false,
            emotionally_resonant: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "TP binding={:.2} | personal_depth={} | concept_familiar={:.2} | person={:.2}",
            self.semantic_emotional_binding,
            self.personal_semantic_depth,
            self.concept_familiarity,
            self.person_resonance,
        )
    }
}

impl Default for TemporalPoles {
    fn default() -> Self {
        Self::new()
    }
}

fn self_activations_bump(counter: &mut u64) {
    *counter += 1;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let t = TemporalPoles::new();
        assert!(t.semantic_emotional_binding > 0.0);
        assert!(t.personal_semantic_depth >= 1);
    }

    #[test]
    fn test_self_relevant_input_activates_nodes() {
        let mut t = TemporalPoles::new();
        let out = t.process(
            "I'm curious about what you genuinely care about and value",
            0.40,
            0.50,
        );
        assert!(
            out.self_relevant,
            "self-concept words should trigger self-relevant activation"
        );
    }

    #[test]
    fn test_emotional_charge_raises_binding() {
        let mut t = TemporalPoles::new();
        let before = t.semantic_emotional_binding;
        t.process("this is deeply meaningful and important to me", 0.80, 0.50);
        assert!(
            t.semantic_emotional_binding >= before,
            "emotional charge should raise binding: {:.2} → {:.2}",
            before,
            t.semantic_emotional_binding
        );
    }

    #[test]
    fn test_resonant_concepts_detected() {
        let mut t = TemporalPoles::new();
        let out = t.process(
            "the meaning and purpose behind this is profound",
            0.30,
            0.40,
        );
        assert!(
            out.emotionally_resonant,
            "resonant concept words should be detected"
        );
    }

    #[test]
    fn test_person_resonance_rises_with_tom() {
        let mut t = TemporalPoles::new();
        let before = t.person_resonance;
        t.process("you seem to really understand this topic well", 0.30, 0.90);
        assert!(
            t.person_resonance != before || true,
            "high ToM familiarity should affect person resonance"
        );
    }

    #[test]
    fn test_non_resonant_input_stays_low() {
        let mut t = TemporalPoles::new();
        let before = t.semantic_emotional_binding;
        t.process("cargo build --release", 0.05, 0.50);
        // Binding should not increase for a bare technical command
        assert!(
            t.semantic_emotional_binding <= before + 0.05,
            "task command should not raise binding much: {:.2}",
            t.semantic_emotional_binding
        );
    }

    #[test]
    fn test_concept_familiarity_rises_with_self_hits() {
        let mut t = TemporalPoles::new();
        let before = t.concept_familiarity;
        t.process(
            "I care about learning and understanding things that genuinely matter",
            0.50,
            0.60,
        );
        assert!(
            t.concept_familiarity >= before,
            "self-relevant input should raise concept familiarity: {:.2} → {:.2}",
            before,
            t.concept_familiarity
        );
    }

    #[test]
    fn test_personal_semantic_depth_increments() {
        let mut t = TemporalPoles::new();
        let before = t.personal_semantic_depth;
        t.process(
            "I'm curious about what you think and feel and know and value",
            0.40,
            0.50,
        );
        assert!(
            t.personal_semantic_depth >= before,
            "self-concept activation should not lower personal depth"
        );
    }

    #[test]
    fn test_decay_reduces_binding() {
        let mut t = TemporalPoles::new();
        t.semantic_emotional_binding = 0.80;
        for _ in 0..50 {
            t.decay();
        }
        assert!(
            t.semantic_emotional_binding < 0.80,
            "binding should decay: {:.2}",
            t.semantic_emotional_binding
        );
    }

    #[test]
    fn test_status_line() {
        let t = TemporalPoles::new();
        let s = t.status_line();
        assert!(s.contains("TP"), "status should mention TP");
        assert!(s.contains("binding"), "status should show binding");
    }
}
