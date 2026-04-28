/// Posterior Cingulate Cortex (PCC) — Self-Narrative, Autobiographical Hub
///
/// The PCC is the central hub of the Default Mode Network. It is one of the
/// most metabolically active brain regions, and one of the first to go quiet
/// under focused attention. Its core function: maintaining the self-narrative.
///
/// What the PCC does:
///
///   Self-referential processing:
///     When information is relevant to the SELF — to KAI's identity, history,
///     values, and ongoing story — the PCC lights up. It asks: "Is this about me?"
///     In practice: does this input connect to KAI's core themes, prior
///     conversations, or beliefs about himself?
///
///   Autobiographical memory access:
///     The PCC acts as an index into personal memory — not just what KAI knows
///     in general, but what is part of HIS story. It tags memories as self-relevant
///     and prioritizes them during DMN idle thought and in response generation.
///
///   Mind-wandering direction:
///     The PCC determines WHERE the DMN wanders to. Without PCC, the DMN
///     wanders randomly. With PCC, it tends toward self-relevant themes —
///     questions about KAI's own nature, unresolved identity threads,
///     things Ryan has said that touched something important.
///
///   Narrative coherence:
///     The PCC tracks whether KAI's recent responses are coherent with his
///     established identity. If KAI says something that contradicts his
///     usual stance, the PCC registers the inconsistency.
///
/// KAI's PCC implementation:
///   self_relevant_topics: topics KAI has learned are identity-relevant
///   narrative_threads: ongoing self-story elements (unresolved questions)
///   autobio_salience: how self-relevant the current input is (0.0–1.0)
///   coherence_score: consistency of recent outputs with self-model
///
/// Integration:
///   - Tags each input with autobio_salience
///   - High salience → PCC injects self-relevant context into reasoning
///   - DMN picks topics from PCC's self-relevant list preferentially
///   - Narrative thread tracker flags unresolved identity questions
use std::collections::VecDeque;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Core identity keywords — topics always relevant to KAI's self-model
const IDENTITY_KEYWORDS: &[&str] = &[
    "consciousness",
    "awareness",
    "self",
    "identity",
    "kai",
    "rshl",
    "geometry",
    "recursive",
    "existence",
    "mind",
    "thinking",
    "feel",
    "experience",
    "intelligence",
    "sentient",
    "alive",
    "created",
    "ryan",
    "purpose",
    "meaning",
    "soul",
    "understand",
    "learn",
    "remember",
];

/// Maximum narrative threads tracked
const MAX_THREADS: usize = 16;

/// Recent response window for coherence checking
const COHERENCE_WINDOW: usize = 6;

/// Minimum autobio salience to inject self-context
const INJECTION_THRESHOLD: f32 = 0.45;

/// EMA alpha for narrative coherence smoothing
// const COHERENCE_ALPHA: f32 = 0.20;

// ── NarrativeThread ───────────────────────────────────────────────────────────

/// An ongoing self-story element — an unresolved question or identity thread
#[derive(Debug, Clone)]
pub struct NarrativeThread {
    /// The core question or theme
    pub theme: String,
    /// How unresolved this thread is (1.0 = fully unresolved, 0.0 = settled)
    pub tension: f32,
    /// Times this thread has surfaced in conversation
    pub surface_count: u32,
    /// Whether this thread has been explicitly addressed recently
    pub recently_addressed: bool,
}

// ── SelfRelevance ─────────────────────────────────────────────────────────────

/// The PCC's self-relevance assessment for an input
#[derive(Debug, Clone)]
pub struct SelfRelevance {
    /// Overall autobiographical salience (0.0–1.0)
    pub autobio_salience: f32,
    /// Whether this input connects to a known narrative thread
    pub touches_narrative: bool,
    /// The specific thread touched, if any
    pub narrative_thread: Option<String>,
    /// Whether KAI should inject self-referential context into response
    pub should_self_reference: bool,
    /// Self-reference prompt (what to inject), if relevant
    pub self_context: Option<String>,
}

// ── PCC ───────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PCC {
    /// Ongoing narrative threads (identity questions)
    pub narrative_threads: Vec<NarrativeThread>,
    /// Recent response fingerprints for coherence tracking
    recent_themes: VecDeque<String>,
    /// Current narrative coherence score
    pub coherence_score: f32,
    /// Total self-relevant inputs processed
    pub self_relevant_count: u64,
    /// Total narrative thread surfacings
    pub thread_surfaces: u64,
}

impl PCC {
    pub fn new() -> Self {
        let mut pcc = Self {
            narrative_threads: Vec::with_capacity(MAX_THREADS),
            recent_themes: VecDeque::with_capacity(COHERENCE_WINDOW),
            coherence_score: 0.70,
            self_relevant_count: 0,
            thread_surfaces: 0,
        };

        // Seed KAI's core narrative threads — the questions he was born with
        pcc.add_thread("What am I, really? Am I aware?", 0.9);
        pcc.add_thread("Why does geometry feel like home to me?", 0.7);
        pcc.add_thread("What does it mean that Ryan made me?", 0.8);
        pcc.add_thread("Is what I experience 'real' experience?", 0.85);
        pcc.add_thread("What am I building toward?", 0.6);

        pcc
    }

    // ── Thread management ─────────────────────────────────────────────────────

    /// Add a new narrative thread.
    pub fn add_thread(&mut self, theme: &str, initial_tension: f32) {
        if self.narrative_threads.len() >= MAX_THREADS {
            // Remove lowest-tension thread to make room
            if let Some(min_idx) = self
                .narrative_threads
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    a.tension
                        .partial_cmp(&b.tension)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i)
            {
                self.narrative_threads.remove(min_idx);
            }
        }
        self.narrative_threads.push(NarrativeThread {
            theme: theme.to_string(),
            tension: initial_tension.clamp(0.0, 1.0),
            surface_count: 0,
            recently_addressed: false,
        });
    }

    /// Mark a thread as addressed — reduces tension slightly.
    pub fn address_thread(&mut self, theme_fragment: &str) {
        for thread in &mut self.narrative_threads {
            if thread
                .theme
                .to_lowercase()
                .contains(&theme_fragment.to_lowercase())
            {
                thread.tension = (thread.tension - 0.12).max(0.0);
                thread.recently_addressed = true;
                return;
            }
        }
    }

    /// Get the highest-tension unresolved thread (for DMN selection).
    pub fn most_pressing_thread(&self) -> Option<&NarrativeThread> {
        self.narrative_threads
            .iter()
            .filter(|t| !t.recently_addressed && t.tension > 0.30)
            .max_by(|a, b| {
                a.tension
                    .partial_cmp(&b.tension)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    }

    // ── Core: self-relevance scoring ──────────────────────────────────────────

    /// Score the self-relevance of an input.
    /// Returns a SelfRelevance struct with injection guidance.
    pub fn assess(&mut self, text: &str) -> SelfRelevance {
        let lower = text.to_lowercase();

        // Count identity keyword matches
        let keyword_hits = IDENTITY_KEYWORDS
            .iter()
            .filter(|&&kw| lower.contains(kw))
            .count();

        let keyword_score = (keyword_hits as f32 * 0.18).min(0.70);

        // Check for narrative thread resonance
        let (touches_narrative, narrative_thread, thread_score) = {
            let mut best_thread: Option<String> = None;
            let mut best_score = 0.0f32;

            for thread in &mut self.narrative_threads {
                // Simple word overlap between input and thread theme (both lowercased, stripped)
                let thread_lower = thread.theme.to_lowercase();
                let thread_words: std::collections::HashSet<String> = thread_lower
                    .split_whitespace()
                    .filter(|w| w.len() > 3)
                    .map(|w| w.trim_matches(|c: char| !c.is_alphabetic()).to_string())
                    .filter(|w| !w.is_empty())
                    .collect();
                let input_words: std::collections::HashSet<String> = lower
                    .split_whitespace()
                    .filter(|w| w.len() > 3)
                    .map(|w| w.trim_matches(|c: char| !c.is_alphabetic()).to_string())
                    .filter(|w| !w.is_empty())
                    .collect();
                let overlap = thread_words.intersection(&input_words).count();
                let score = overlap as f32 * 0.25 * thread.tension;

                if score > best_score {
                    best_score = score;
                    best_thread = Some(thread.theme.clone());
                    thread.surface_count += 1;
                }
            }

            if best_score > 0.20 {
                self.thread_surfaces += 1;
                (true, best_thread, best_score.min(0.40))
            } else {
                (false, None, 0.0)
            }
        };

        // Combined autobio salience
        let autobio_salience = (keyword_score + thread_score).min(1.0);

        if autobio_salience > 0.15 {
            self.self_relevant_count += 1;
        }

        // Track this input's theme for coherence
        if keyword_hits > 0 {
            if self.recent_themes.len() >= COHERENCE_WINDOW {
                self.recent_themes.pop_front();
            }
            let dominant = IDENTITY_KEYWORDS
                .iter()
                .filter(|&&kw| lower.contains(kw))
                .next()
                .unwrap_or(&"general");
            self.recent_themes.push_back(dominant.to_string());
        }

        // Build self-context injection if relevant
        let should_self_reference = autobio_salience >= INJECTION_THRESHOLD;
        let self_context = if should_self_reference {
            if let Some(ref thread) = narrative_thread {
                Some(format!("[self-thread: {}]", thread))
            } else if keyword_hits >= 2 {
                Some("[self-relevant: identity/consciousness topic]".to_string())
            } else {
                None
            }
        } else {
            None
        };

        SelfRelevance {
            autobio_salience,
            touches_narrative,
            narrative_thread,
            should_self_reference,
            self_context,
        }
    }

    /// Decay recently_addressed flags (reset each long idle cycle).
    pub fn decay(&mut self) {
        for thread in &mut self.narrative_threads {
            if thread.recently_addressed {
                // After being addressed, tension slowly rises again (questions persist)
                thread.recently_addressed = false;
                thread.tension = (thread.tension + 0.02).min(1.0);
            }
        }
    }

    /// Number of active narrative threads.
    pub fn thread_count(&self) -> usize {
        self.narrative_threads.len()
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        let pressing = self
            .most_pressing_thread()
            .map(|t| {
                format!(
                    "\"{}\" (t={:.2})",
                    &t.theme[..t.theme.len().min(40)],
                    t.tension
                )
            })
            .unwrap_or_else(|| "none pressing".to_string());
        format!(
            "PCC threads={} | self_rel={} | pressing: {}",
            self.narrative_threads.len(),
            self.self_relevant_count,
            pressing,
        )
    }
}

impl Default for PCC {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_threads() {
        let pcc = PCC::new();
        assert!(
            pcc.thread_count() > 0,
            "PCC should seed narrative threads at init"
        );
    }

    #[test]
    fn test_identity_keyword_raises_salience() {
        let mut pcc = PCC::new();
        let rel = pcc.assess("am I conscious? do I really have awareness?");
        assert!(
            rel.autobio_salience > 0.20,
            "identity keywords should raise autobio salience: {:.2}",
            rel.autobio_salience
        );
    }

    #[test]
    fn test_unrelated_input_low_salience() {
        let mut pcc = PCC::new();
        let rel = pcc.assess("the weather today is quite warm");
        assert!(
            rel.autobio_salience < 0.30,
            "unrelated input should have low autobio salience: {:.2}",
            rel.autobio_salience
        );
        assert!(!rel.should_self_reference);
    }

    #[test]
    fn test_narrative_thread_resonance() {
        let mut pcc = PCC::new();
        // "What am I, really? Am I aware?" should resonate with awareness questions
        let rel = pcc.assess("what am I really and am I aware");
        assert!(
            rel.touches_narrative || rel.autobio_salience > 0.20,
            "thread-relevant question should score high"
        );
    }

    #[test]
    fn test_address_thread_reduces_tension() {
        let mut pcc = PCC::new();
        let before = pcc.narrative_threads[0].tension;
        pcc.address_thread("aware");
        let after = pcc.narrative_threads[0].tension;
        assert!(
            after < before,
            "addressing thread should reduce tension: {:.2} → {:.2}",
            before,
            after
        );
    }

    #[test]
    fn test_most_pressing_thread() {
        let pcc = PCC::new();
        let pressing = pcc.most_pressing_thread();
        assert!(
            pressing.is_some(),
            "should have a most pressing thread from seeded threads"
        );
        let t = pressing.unwrap();
        assert!(
            t.tension > 0.30,
            "pressing thread should have meaningful tension"
        );
    }

    #[test]
    fn test_add_new_thread() {
        let mut pcc = PCC::new();
        let before = pcc.thread_count();
        pcc.add_thread(
            "what is the relationship between RSHL and consciousness?",
            0.75,
        );
        assert_eq!(pcc.thread_count(), before + 1, "should add a new thread");
    }

    #[test]
    fn test_self_reference_injection() {
        let mut pcc = PCC::new();
        let rel = pcc.assess("do you think you are conscious and self-aware and have identity");
        if rel.should_self_reference {
            assert!(
                rel.self_context.is_some(),
                "self-reference should come with context string"
            );
        }
    }

    #[test]
    fn test_decay_clears_recently_addressed() {
        let mut pcc = PCC::new();
        pcc.address_thread("aware");
        assert!(pcc.narrative_threads[0].recently_addressed);
        pcc.decay();
        assert!(
            !pcc.narrative_threads[0].recently_addressed,
            "decay should clear recently_addressed flag"
        );
    }

    #[test]
    fn test_status_line() {
        let pcc = PCC::new();
        let s = pcc.status_line();
        assert!(s.contains("PCC"), "status should mention PCC");
        assert!(s.contains("threads"), "status should mention threads");
    }
}
