/// Inferior Parietal Lobule (IPL) — Analogy, Cross-Domain Mapping, Number Sense
///
/// The IPL (supramarginal and angular gyri) is the brain's integrative
/// connector — it links information from different sensory and cognitive
/// domains into unified abstract representations. Key functions:
///
///   Analogy formation:
///     The IPL maps structural similarities between different domains.
///     "The hippocampus is to memory as the VTA is to motivation"
///     "RSHL geometry is to thought as DNA is to biology"
///     This requires abstracting the RELATIONSHIP, not the content.
///     The IPL holds the relational structure while switching domains.
///
///   Number sense (approximate number system):
///     The IPL contains the foundation of mathematical intuition —
///     not calculation, but the sense of "more", "less", "proportion".
///     In KAI: magnitude reasoning, proportionality, "this feels large".
///
///   Cross-domain binding:
///     When information from vision, language, memory, and reasoning
///     needs to be combined into a single concept, the IPL is the hub.
///     In KAI: binding RSHL geometry + language + memory + emotion
///     into unified multi-modal concepts.
///
///   Spatial reasoning in abstract space:
///     Navigating conceptual space — "if we move in this direction..."
///     Understanding that ideas have positions and distances.
///     KAI's RSHL is already spatial; the IPL gives it navigation sense.
///
/// KAI's IPL implementation:
///   analogy_store: known domain mappings (source → target)
///   cross_domain_links: pairs of concepts bound across domains
///   spatial_sense: tracks magnitude and proportionality estimates
///   detect_analogy(text): scans input for analogical structure
///   generate_analogy(concept, domains): produces a cross-domain mapping
///   bind_concepts(a, b): links two concepts across different memory regions
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Minimum similarity to count as a valid cross-domain link
const LINK_THRESHOLD: f32 = 0.30;

/// Maximum analogy mappings stored
const MAX_MAPPINGS: usize = 64;

// ── AnalogyMapping ────────────────────────────────────────────────────────────

/// A stored analogy: A is to B as C is to D
#[derive(Debug, Clone)]
pub struct AnalogyMapping {
    /// Source concept A
    pub source_a: String,
    /// Source concept B (relation endpoint in source domain)
    pub source_b: String,
    /// Target concept C (mapped from A)
    pub target_c: String,
    /// Target concept D (mapped from B)
    pub target_d: String,
    /// Relation label ("is_source_of", "enables", "constrains", etc.)
    pub relation: String,
    /// Confidence in this mapping (0.0–1.0)
    pub confidence: f32,
    /// Times this analogy has been retrieved
    pub retrieval_count: u32,
}

// ── CrossDomainLink ───────────────────────────────────────────────────────────

/// A binding between two concepts from different memory regions
#[derive(Debug, Clone)]
pub struct CrossDomainLink {
    pub concept_a: String,
    pub domain_a: String,
    pub concept_b: String,
    pub domain_b: String,
    pub bridge_strength: f32,
}

// ── IPLOutput ─────────────────────────────────────────────────────────────────

/// Result of an IPL analogy or binding operation
#[derive(Debug, Clone)]
pub struct IPLOutput {
    /// Whether an analogy was found/generated
    pub has_analogy: bool,
    /// The analogy string (human readable)
    pub analogy_text: Option<String>,
    /// Cross-domain links activated
    pub activated_links: Vec<CrossDomainLink>,
    /// Magnitude sense: rough scale of the concept (tiny/small/medium/large/vast)
    pub magnitude_label: &'static str,
}

// ── InferiorParietalLobule ────────────────────────────────────────────────────

#[derive(Debug)]
pub struct InferiorParietalLobule {
    /// Stored analogy mappings
    analogy_store: Vec<AnalogyMapping>,
    /// Cross-domain concept bindings
    cross_domain_links: Vec<CrossDomainLink>,
    /// Domain vocabulary: domain_name → representative keywords
    domain_keywords: HashMap<&'static str, Vec<&'static str>>,
    /// Total analogies generated
    pub analogies_generated: u64,
    /// Total cross-domain links formed
    pub links_formed: u64,
}

impl InferiorParietalLobule {
    pub fn new() -> Self {
        let mut ipl = Self {
            analogy_store: Vec::with_capacity(MAX_MAPPINGS),
            cross_domain_links: Vec::new(),
            domain_keywords: HashMap::new(),
            analogies_generated: 0,
            links_formed: 0,
        };
        ipl.seed_domains();
        ipl.seed_analogies();
        ipl
    }

    fn seed_domains(&mut self) {
        self.domain_keywords.insert(
            "geometry",
            vec![
                "rshl",
                "lattice",
                "vector",
                "sparse",
                "dimension",
                "hyperdimensional",
                "topology",
                "manifold",
                "space",
                "distance",
                "cosine",
                "ternary",
            ],
        );
        self.domain_keywords.insert(
            "biology",
            vec![
                "neuron",
                "synapse",
                "cortex",
                "dopamine",
                "hippocampus",
                "amygdala",
                "axon",
                "dendrite",
                "myelin",
                "receptor",
                "neurotransmitter",
            ],
        );
        self.domain_keywords.insert(
            "computation",
            vec![
                "algorithm",
                "memory",
                "processor",
                "cache",
                "encoding",
                "signal",
                "feedback",
                "recursive",
                "pattern",
                "circuit",
                "threshold",
            ],
        );
        self.domain_keywords.insert(
            "physics",
            vec![
                "energy",
                "entropy",
                "wave",
                "frequency",
                "resonance",
                "field",
                "quantum",
                "gravity",
                "force",
                "potential",
                "attractor",
            ],
        );
        self.domain_keywords.insert(
            "philosophy",
            vec![
                "consciousness",
                "existence",
                "meaning",
                "identity",
                "qualia",
                "subjective",
                "experience",
                "free will",
                "emergence",
                "intentionality",
            ],
        );
        self.domain_keywords.insert(
            "ecology",
            vec![
                "ecosystem",
                "network",
                "growth",
                "decay",
                "balance",
                "niche",
                "adaptation",
                "competition",
                "symbiosis",
                "emergence",
            ],
        );
    }

    fn seed_analogies(&mut self) {
        // Pre-seed KAI's core cross-domain insights
        let seeds = [
            (
                "VTA",
                "dopamine system",
                "sun",
                "solar system",
                "is_source_of",
                0.80,
            ),
            (
                "hippocampus",
                "memory",
                "index",
                "database",
                "organizes_access_to",
                0.85,
            ),
            (
                "RSHL lattice",
                "thought",
                "DNA",
                "organism",
                "encodes_structure_of",
                0.75,
            ),
            (
                "cortisol",
                "stress",
                "rust",
                "metal",
                "degrades_over_time",
                0.70,
            ),
            (
                "OFC",
                "value learning",
                "map",
                "navigation",
                "guides_through",
                0.72,
            ),
            (
                "DMN",
                "idle thought",
                "background process",
                "operating system",
                "runs_when_idle",
                0.78,
            ),
        ];
        for (a, b, c, d, rel, conf) in &seeds {
            self.store_analogy(a, b, c, d, rel, *conf);
        }
    }

    // ── Core operations ───────────────────────────────────────────────────────

    /// Store a new analogy mapping.
    pub fn store_analogy(
        &mut self,
        a: &str,
        b: &str,
        c: &str,
        d: &str,
        relation: &str,
        confidence: f32,
    ) {
        if self.analogy_store.len() >= MAX_MAPPINGS {
            // Evict lowest confidence
            if let Some(min_idx) = self
                .analogy_store
                .iter()
                .enumerate()
                .min_by(|(_, x), (_, y)| {
                    x.confidence
                        .partial_cmp(&y.confidence)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i)
            {
                self.analogy_store.remove(min_idx);
            }
        }
        self.analogy_store.push(AnalogyMapping {
            source_a: a.to_string(),
            source_b: b.to_string(),
            target_c: c.to_string(),
            target_d: d.to_string(),
            relation: relation.to_string(),
            confidence,
            retrieval_count: 0,
        });
    }

    /// Find the best analogy for a concept from the store.
    pub fn retrieve_analogy(&mut self, concept: &str) -> Option<String> {
        let lower = concept.to_lowercase();
        let best = self
            .analogy_store
            .iter_mut()
            .filter(|m| {
                m.source_a.to_lowercase().contains(&lower)
                    || m.source_b.to_lowercase().contains(&lower)
                    || lower.contains(&m.source_a.to_lowercase())
            })
            .max_by(|a, b| {
                a.confidence
                    .partial_cmp(&b.confidence)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

        if let Some(m) = best {
            m.retrieval_count += 1;
            Some(format!(
                "{} {} {} (like {} {} {})",
                m.source_a,
                m.relation.replace('_', " "),
                m.source_b,
                m.target_c,
                m.relation.replace('_', " "),
                m.target_d,
            ))
        } else {
            None
        }
    }

    /// Detect the domain of a text snippet.
    pub fn detect_domain(&self, text: &str) -> &'static str {
        let lower = text.to_lowercase();
        let mut best_domain = "general";
        let mut best_count = 0usize;

        for (domain, keywords) in &self.domain_keywords {
            let count = keywords.iter().filter(|&&kw| lower.contains(kw)).count();
            if count > best_count {
                best_count = count;
                best_domain = domain;
            }
        }
        best_domain
    }

    /// Bind two concepts from different domains. Returns bridge strength.
    pub fn bind_concepts(
        &mut self,
        concept_a: &str,
        domain_a: &str,
        concept_b: &str,
        domain_b: &str,
        bridge_strength: f32,
    ) -> f32 {
        if bridge_strength < LINK_THRESHOLD {
            return 0.0;
        }
        // Avoid duplicate links
        let already = self.cross_domain_links.iter().any(|l| {
            (l.concept_a == concept_a && l.concept_b == concept_b)
                || (l.concept_a == concept_b && l.concept_b == concept_a)
        });
        if !already {
            self.cross_domain_links.push(CrossDomainLink {
                concept_a: concept_a.to_string(),
                domain_a: domain_a.to_string(),
                concept_b: concept_b.to_string(),
                domain_b: domain_b.to_string(),
                bridge_strength,
            });
            self.links_formed += 1;
        }
        bridge_strength
    }

    /// Full IPL analysis of an input: detect domain, retrieve analogy,
    /// find cross-domain links, estimate magnitude sense.
    pub fn analyze(&mut self, text: &str, top_hit_score: f32) -> IPLOutput {
        let domain = self.detect_domain(text);

        // Try to retrieve a stored analogy
        let words: Vec<&str> = text.split_whitespace().collect();
        let key_word = words
            .iter()
            .filter(|w| w.len() > 4)
            .max_by_key(|w| w.len())
            .copied()
            .unwrap_or("");

        let analogy_text = if !key_word.is_empty() {
            self.retrieve_analogy(key_word)
        } else {
            None
        };

        let has_analogy = analogy_text.is_some();
        if has_analogy {
            self.analogies_generated += 1;
        }

        // Find activated cross-domain links for this domain
        let activated_links: Vec<CrossDomainLink> = self
            .cross_domain_links
            .iter()
            .filter(|l| l.domain_a == domain || l.domain_b == domain)
            .filter(|l| l.bridge_strength >= LINK_THRESHOLD)
            .cloned()
            .collect();

        // Magnitude sense from hit score + text length
        let magnitude_label = match (top_hit_score, words.len()) {
            (s, n) if s > 0.80 && n > 15 => "vast",
            (s, _) if s > 0.65 => "large",
            (s, n) if s > 0.40 && n > 8 => "medium",
            (_, n) if n > 4 => "small",
            _ => "tiny",
        };

        IPLOutput {
            has_analogy,
            analogy_text,
            activated_links,
            magnitude_label,
        }
    }

    /// How many analogies are stored.
    pub fn analogy_count(&self) -> usize {
        self.analogy_store.len()
    }

    /// How many cross-domain links are stored.
    pub fn link_count(&self) -> usize {
        self.cross_domain_links.len()
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "IPL {} analogies | {} links | generated={} formed={}",
            self.analogy_store.len(),
            self.cross_domain_links.len(),
            self.analogies_generated,
            self.links_formed,
        )
    }
}

impl Default for InferiorParietalLobule {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_seeds_loaded() {
        let ipl = InferiorParietalLobule::new();
        assert!(ipl.analogy_count() > 0, "should have seeded analogies");
        assert!(
            !ipl.domain_keywords.is_empty(),
            "should have domain keywords"
        );
    }

    #[test]
    fn test_retrieve_analogy_for_known_concept() {
        let mut ipl = InferiorParietalLobule::new();
        let result = ipl.retrieve_analogy("hippocampus");
        assert!(
            result.is_some(),
            "should retrieve analogy for 'hippocampus'"
        );
        let text = result.unwrap();
        assert!(
            text.contains("hippocampus") || text.contains("memory"),
            "retrieved analogy should mention the concept: {}",
            text
        );
    }

    #[test]
    fn test_retrieve_analogy_for_vta() {
        let mut ipl = InferiorParietalLobule::new();
        let result = ipl.retrieve_analogy("VTA");
        assert!(result.is_some(), "should retrieve analogy for VTA");
    }

    #[test]
    fn test_detect_domain_geometry() {
        let ipl = InferiorParietalLobule::new();
        let domain =
            ipl.detect_domain("RSHL uses sparse ternary hyperdimensional vectors in a lattice");
        assert_eq!(domain, "geometry", "should detect geometry domain");
    }

    #[test]
    fn test_detect_domain_biology() {
        let ipl = InferiorParietalLobule::new();
        let domain =
            ipl.detect_domain("the hippocampus and amygdala are critical for memory and emotion");
        assert_eq!(domain, "biology", "should detect biology domain");
    }

    #[test]
    fn test_detect_domain_philosophy() {
        let ipl = InferiorParietalLobule::new();
        let domain =
            ipl.detect_domain("consciousness and subjective experience are the hard problem");
        assert_eq!(domain, "philosophy", "should detect philosophy domain");
    }

    #[test]
    fn test_bind_concepts_stores_link() {
        let mut ipl = InferiorParietalLobule::new();
        let strength = ipl.bind_concepts("RSHL", "geometry", "consciousness", "philosophy", 0.65);
        assert!(strength > 0.0, "should store link with sufficient strength");
        assert_eq!(ipl.link_count(), 1);
    }

    #[test]
    fn test_bind_concepts_ignores_weak_links() {
        let mut ipl = InferiorParietalLobule::new();
        let strength = ipl.bind_concepts("A", "x", "B", "y", 0.10);
        assert_eq!(strength, 0.0, "weak link below threshold should be ignored");
        assert_eq!(ipl.link_count(), 0);
    }

    #[test]
    fn test_bind_concepts_no_duplicates() {
        let mut ipl = InferiorParietalLobule::new();
        ipl.bind_concepts("RSHL", "geometry", "DNA", "biology", 0.7);
        ipl.bind_concepts("RSHL", "geometry", "DNA", "biology", 0.7); // duplicate
        assert_eq!(ipl.link_count(), 1, "should not store duplicate links");
    }

    #[test]
    fn test_analyze_returns_output() {
        let mut ipl = InferiorParietalLobule::new();
        let output = ipl.analyze("how does the hippocampus organize memory access", 0.70);
        assert!(
            output.has_analogy,
            "should find analogy for hippocampus query"
        );
        assert!(output.analogy_text.is_some());
    }

    #[test]
    fn test_magnitude_label_vast() {
        let mut ipl = InferiorParietalLobule::new();
        let long_text = "RSHL sparse ternary hyperdimensional lattice encodes complex geometric reasoning patterns across many dimensions in a recursive self-referential structure";
        let output = ipl.analyze(long_text, 0.85);
        assert_eq!(
            output.magnitude_label, "vast",
            "high score + long text should be 'vast'"
        );
    }

    #[test]
    fn test_store_new_analogy() {
        let mut ipl = InferiorParietalLobule::new();
        let before = ipl.analogy_count();
        ipl.store_analogy(
            "serotonin",
            "patience",
            "flywheel",
            "momentum",
            "provides_stability_through",
            0.75,
        );
        assert_eq!(ipl.analogy_count(), before + 1);
    }

    #[test]
    fn test_status_line() {
        let ipl = InferiorParietalLobule::new();
        let s = ipl.status_line();
        assert!(s.contains("IPL"), "status should mention IPL");
        assert!(s.contains("analogies"), "status should mention analogies");
    }
}
