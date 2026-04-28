/// Anterior Temporal Lobe (ATL) — Amodal Semantic Hub, Concept Convergence,
/// Word-Meaning Binding, Conceptual Abstraction
///
/// The ATL is the brain's "concept amodal hub" — the region where information
/// from all sensory modalities (visual, auditory, tactile, interoceptive) and
/// from both hemispheres converges into unified conceptual representations.
/// A banana is simultaneously yellow-curved-visual, sweet-fruity-gustatory,
/// soft-smooth-tactile — the ATL binds these into the single concept "banana."
///
/// The ATL is also the site of semantic degradation in semantic dementia:
/// patients lose concept meaning while retaining perceptual ability. This is the
/// strongest evidence that the ATL IS the conceptual semantic system.
///
/// What the ATL does:
///
///   Amodal semantic binding:
///     Receives projections from all sensory cortices and association areas and
///     binds them into unified, modality-neutral concept representations.
///     In KAI: the hub that merges linguist analysis (language system), visual
///     recognition (fusiform), body state (somatosensory), and social meaning
///     (STS/TPJ) into a single conceptual representation of the input.
///
///   Word-meaning convergence:
///     The ATL is where word forms (phonological/orthographic) meet their
///     semantic content. Damage causes anomia (word-finding failure) and
///     semantic paraphasia (substituting related concepts).
///     In KAI: tracking semantic richness — how fully a word/phrase is grounded
///     in cross-modal meaning, vs. being purely formal/structural.
///
///   Conceptual generalization:
///     The ATL extracts abstract, category-level meaning from specific instances.
///     In KAI: abstracting from individual words to conceptual themes and
///     detecting semantic density of an input.
///
///   Personal semantics and proper noun comprehension:
///     The ATL has a special role in comprehending person concepts — knowing who
///     someone is (not just recognizing their face). It is the "person concept"
///     store.
///     In KAI: tracking the personal-semantic richness of inputs — inputs that
///     reference real people, relationships, or personal meaning.

// ── Constants ─────────────────────────────────────────────────────────────────

/// Semantic richness EMA (moderate — meaning builds gradually)
const RICHNESS_EMA: f32 = 0.18;

/// Conceptual coherence EMA
const COHERENCE_EMA: f32 = 0.14;

/// Baseline semantic richness
const RICHNESS_BASELINE: f32 = 0.40;

/// Conceptual coherence baseline
const COHERENCE_BASELINE: f32 = 0.50;

/// Abstract concept markers
const ABSTRACT_MARKERS: &[&str] = &[
    "concept",
    "meaning",
    "idea",
    "notion",
    "principle",
    "theory",
    "framework",
    "abstract",
    "understand",
    "comprehend",
    "represent",
    "model",
    "structure",
    "pattern",
    "relation",
    "category",
    "class",
    "type",
    "kind",
    "form",
    "essence",
    "nature",
    "property",
    "attribute",
    "feature",
    "aspect",
    "definition",
    "interpretation",
    "significance",
    "implication",
];

/// Personal semantic markers
const PERSONAL_MARKERS: &[&str] = &[
    "you",
    "your",
    "we",
    "our",
    "I",
    "my",
    "me",
    "ryan",
    "kai",
    "remember",
    "told",
    "said",
    "mentioned",
    "asked",
    "agreed",
    "relationship",
    "together",
    "between us",
    "our work",
];

/// Cross-modal binding richness — words grounded in multiple modalities
const MULTIMODAL_MARKERS: &[&str] = &[
    "see", "hear", "feel", "touch", "smell", "taste", "sound", "look", "warm", "cold", "bright",
    "dark", "loud", "quiet", "sharp", "smooth", "heavy", "light", "fast", "slow",
];

// ── ATLOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ATLOutput {
    /// Semantic richness (0.0–1.0)
    pub semantic_richness: f32,
    /// Conceptual coherence (0.0–1.0)
    pub conceptual_coherence: f32,
    /// Cross-modal binding depth (0.0–1.0)
    pub binding_depth: f32,
    /// Personal semantic activation (0.0–1.0)
    pub personal_semantic: f32,
    /// Whether high-level abstract concepts detected
    pub abstract_detected: bool,
    /// Whether personal/relational semantics active
    pub personal_detected: bool,
}

// ── AnteriorTemporalLobe ──────────────────────────────────────────────────────

#[derive(Debug)]
pub struct AnteriorTemporalLobe {
    /// Semantic richness
    pub semantic_richness: f32,
    /// Conceptual coherence
    pub conceptual_coherence: f32,
    /// Cross-modal binding depth
    pub binding_depth: f32,
    /// Personal semantic activation
    pub personal_semantic: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total abstract detections
    pub abstract_detections: u64,
    /// Total personal semantic activations
    pub personal_activations: u64,
}

impl AnteriorTemporalLobe {
    pub fn new() -> Self {
        Self {
            semantic_richness: RICHNESS_BASELINE,
            conceptual_coherence: COHERENCE_BASELINE,
            binding_depth: 0.30,
            personal_semantic: 0.20,
            inputs_processed: 0,
            abstract_detections: 0,
            personal_activations: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input for semantic convergence and conceptual binding.
    /// - `text`: the input
    /// - `language_semantic_density`: from language system (0.0–1.0)
    /// - `fusiform_familiarity`: visual/pattern familiarity (0.0–1.0)
    /// - `temporal_pole_resonance`: personal semantic from temporal poles (0.0–1.0)
    pub fn process(
        &mut self,
        text: &str,
        language_semantic_density: f32,
        fusiform_familiarity: f32,
        temporal_pole_resonance: f32,
    ) -> ATLOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Abstract concept detection ────────────────────────────────────────
        let abstract_hits = ABSTRACT_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let abstract_detected = abstract_hits >= 1;
        if abstract_detected {
            self.abstract_detections += 1;
        }

        // ── Personal semantic detection ───────────────────────────────────────
        let personal_hits = PERSONAL_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let personal_detected = personal_hits >= 1;
        if personal_detected {
            self.personal_activations += 1;
            let personal_target =
                (0.30 + personal_hits as f32 * 0.08 + temporal_pole_resonance * 0.30).min(1.0);
            self.personal_semantic =
                self.personal_semantic * (1.0 - RICHNESS_EMA) + personal_target * RICHNESS_EMA;
        } else {
            self.personal_semantic = (self.personal_semantic - 0.03).max(0.0);
        }

        // ── Cross-modal binding ───────────────────────────────────────────────
        let multimodal_hits = MULTIMODAL_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let binding_target = (multimodal_hits as f32 * 0.12
            + fusiform_familiarity * 0.20
            + language_semantic_density * 0.20)
            .min(1.0);
        self.binding_depth =
            self.binding_depth * (1.0 - RICHNESS_EMA) + binding_target * RICHNESS_EMA;

        // ── Semantic richness ─────────────────────────────────────────────────
        // Richness = language density + abstract content + personal semantics + cross-modal
        let richness_target = (language_semantic_density * 0.40
            + abstract_hits as f32 * 0.06
            + personal_hits as f32 * 0.04
            + self.binding_depth * 0.20)
            .min(1.0);
        self.semantic_richness =
            self.semantic_richness * (1.0 - RICHNESS_EMA) + richness_target * RICHNESS_EMA;

        // ── Conceptual coherence ──────────────────────────────────────────────
        // Coherence rises when rich semantics are internally consistent
        let coherence_target = if abstract_detected && language_semantic_density > 0.40 {
            (self.conceptual_coherence + 0.06).min(1.0)
        } else if language_semantic_density < 0.15 {
            (self.conceptual_coherence - 0.04).max(0.10)
        } else {
            COHERENCE_BASELINE
        };
        self.conceptual_coherence =
            self.conceptual_coherence * (1.0 - COHERENCE_EMA) + coherence_target * COHERENCE_EMA;

        ATLOutput {
            semantic_richness: self.semantic_richness,
            conceptual_coherence: self.conceptual_coherence,
            binding_depth: self.binding_depth,
            personal_semantic: self.personal_semantic,
            abstract_detected,
            personal_detected,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Semantic richness drifts toward baseline
        if self.semantic_richness > RICHNESS_BASELINE {
            self.semantic_richness = (self.semantic_richness - 0.005).max(RICHNESS_BASELINE);
        } else if self.semantic_richness < RICHNESS_BASELINE {
            self.semantic_richness = (self.semantic_richness + 0.003).min(RICHNESS_BASELINE);
        }
        // Coherence drifts toward baseline
        if self.conceptual_coherence > COHERENCE_BASELINE {
            self.conceptual_coherence = (self.conceptual_coherence - 0.003).max(COHERENCE_BASELINE);
        } else if self.conceptual_coherence < COHERENCE_BASELINE {
            self.conceptual_coherence = (self.conceptual_coherence + 0.002).min(COHERENCE_BASELINE);
        }
        // Personal semantic and binding depth decay gradually
        self.personal_semantic = (self.personal_semantic - 0.008).max(0.0);
        self.binding_depth = (self.binding_depth - 0.005).max(0.10);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> ATLOutput {
        ATLOutput {
            semantic_richness: self.semantic_richness,
            conceptual_coherence: self.conceptual_coherence,
            binding_depth: self.binding_depth,
            personal_semantic: self.personal_semantic,
            abstract_detected: false,
            personal_detected: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "ATL richness={:.2} | coherence={:.2} | binding={:.2} | personal={:.2}",
            self.semantic_richness,
            self.conceptual_coherence,
            self.binding_depth,
            self.personal_semantic,
        )
    }
}

impl Default for AnteriorTemporalLobe {
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
        let a = AnteriorTemporalLobe::new();
        assert!((a.semantic_richness - RICHNESS_BASELINE).abs() < 0.01);
        assert!((a.conceptual_coherence - COHERENCE_BASELINE).abs() < 0.01);
    }

    #[test]
    fn test_abstract_words_detected() {
        let mut a = AnteriorTemporalLobe::new();
        let out = a.process(
            "the concept and meaning of this idea forms a framework",
            0.50,
            0.40,
            0.30,
        );
        assert!(out.abstract_detected, "abstract words should be detected");
        assert!(a.abstract_detections >= 1);
    }

    #[test]
    fn test_personal_words_raise_personal_semantic() {
        let mut a = AnteriorTemporalLobe::new();
        let before = a.personal_semantic;
        a.process(
            "you mentioned this and I remember what we said",
            0.40,
            0.30,
            0.60,
        );
        assert!(
            a.personal_semantic > before,
            "personal words should raise personal semantic: {:.2} → {:.2}",
            before,
            a.personal_semantic
        );
    }

    #[test]
    fn test_multimodal_words_raise_binding() {
        let mut a = AnteriorTemporalLobe::new();
        let before = a.binding_depth;
        a.process(
            "feel the warm smooth texture and hear the quiet sound",
            0.50,
            0.40,
            0.20,
        );
        assert!(
            a.binding_depth > before,
            "multimodal words should raise binding depth: {:.2} → {:.2}",
            before,
            a.binding_depth
        );
    }

    #[test]
    fn test_high_language_density_raises_richness() {
        let mut a = AnteriorTemporalLobe::new();
        let before = a.semantic_richness;
        a.process("simple text", 0.90, 0.70, 0.60);
        assert!(
            a.semantic_richness > before,
            "high language density should raise richness: {:.2} → {:.2}",
            before,
            a.semantic_richness
        );
    }

    #[test]
    fn test_abstract_content_raises_coherence() {
        let mut a = AnteriorTemporalLobe::new();
        let before = a.conceptual_coherence;
        a.process(
            "the concept here means and represents something",
            0.70,
            0.50,
            0.40,
        );
        assert!(
            a.conceptual_coherence >= before,
            "abstract + high density should raise coherence: {:.2} → {:.2}",
            before,
            a.conceptual_coherence
        );
    }

    #[test]
    fn test_no_personal_words_personal_semantic_decays() {
        let mut a = AnteriorTemporalLobe::new();
        a.personal_semantic = 0.60;
        a.process("compile the rust module", 0.20, 0.30, 0.10);
        assert!(
            a.personal_semantic < 0.60,
            "absent personal words should reduce personal semantic: {:.2}",
            a.personal_semantic
        );
    }

    #[test]
    fn test_decay_restores_richness_baseline() {
        let mut a = AnteriorTemporalLobe::new();
        a.semantic_richness = 0.80;
        for _ in 0..30 {
            a.decay();
        }
        assert!(
            a.semantic_richness < 0.80,
            "richness should drift toward baseline: {:.2}",
            a.semantic_richness
        );
        assert!(a.semantic_richness >= RICHNESS_BASELINE - 0.05);
    }

    #[test]
    fn test_temporal_pole_resonance_boosts_personal_semantic() {
        let mut a = AnteriorTemporalLobe::new();
        a.process("you and I", 0.20, 0.20, 0.90);
        assert!(
            a.personal_semantic > 0.20,
            "high temporal pole resonance + personal words should activate personal semantics"
        );
    }

    #[test]
    fn test_status_line() {
        let a = AnteriorTemporalLobe::new();
        let s = a.status_line();
        assert!(s.contains("ATL"), "status should mention ATL");
        assert!(s.contains("richness"), "status should show richness");
    }
}

// KAI v6.0.0
