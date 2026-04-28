/// Perirhinal Cortex (PRC) — Object/Concept Recognition Memory,
/// Familiarity Signals, Novelty Detection, Recognition Without Recall
///
/// The perirhinal cortex lies at the medial temporal lobe border, adjacent to
/// the parahippocampal cortex and entorhinal cortex. It is the primary source
/// of familiarity-based recognition memory — the sense of "I've seen this before"
/// that comes WITHOUT requiring full episodic recall. It detects novelty at the
/// object/concept level (not scene level like PHC).
///
/// What the Perirhinal Cortex does:
///
///   Familiarity-based recognition:
///     The PRC is the "familiarity detector" at the item/concept level. You
///     recognize a word as familiar via PRC even if you can't remember where
///     you learned it. This is distinct from recollection (hippocampus).
///     In KAI: recognizing a concept, term, or question type as familiar
///     without necessarily retrieving a specific memory — the "I know this"
///     feeling before the "I remember when I learned this."
///
///   Novelty detection (mismatch signal):
///     PRC neurons fire strongly to novel stimuli and habituate rapidly to
///     repeated ones. This makes PRC a powerful novelty detector — it rapidly
///     builds an internal model of "what I've seen" and flags anything new.
///     In KAI: per-concept novelty tracking. After seeing a concept 2-3 times,
///     PRC marks it as familiar; brand new concepts fire a novelty signal.
///
///   Perceptual learning and conceptual sharpening:
///     Repeated exposure to a concept sharpens the PRC's representation of it,
///     making future recognition faster and more confident.
///     In KAI: the more KAI processes a concept, the sharper its recognition
///     and the higher the familiarity signal.
///
///   Gating recollection:
///     When familiarity is high (PRC signal strong), the hippocampus may not
///     need to generate a full recollection. The PRC provides a "shortcut."
///     In KAI: high familiarity → hippocampal retrieval is skipped or reduced.
///
/// KAI's PRC:
///   concept_familiarity_map: track familiarity per concept (via EMA counts)
///   global_familiarity: overall familiarity level in current context (0.0–1.0)
///   novelty_signal: strength of current novelty detection (0.0–1.0)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Familiarity EMA per concept (fast — PRC habituates quickly)
const CONCEPT_FAMILIARITY_EMA: f32 = 0.30;

/// Global familiarity EMA
const GLOBAL_EMA: f32 = 0.12;

/// Novelty signal decay
const NOVELTY_DECAY: f32 = 0.10;

/// Familiarity threshold for "recognized"
const RECOGNIZED_THRESHOLD: f32 = 0.45;

/// Max concepts to track in familiarity map
const MAX_CONCEPT_MAP: usize = 50;

// ── PRCOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PRCOutput {
    /// Global familiarity
    pub global_familiarity: f32,
    /// Novelty signal for current input
    pub novelty_signal: f32,
    /// Whether the current input is recognized (above threshold)
    pub recognized: bool,
    /// How many unique concepts are tracked
    pub concept_count: usize,
    /// Whether hippocampal recollection can be bypassed
    pub skip_recollection: bool,
}

// ── PerirhinalCortex ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PerirhinalCortex {
    /// Familiarity map: concept key → familiarity score
    pub concept_map: std::collections::HashMap<String, f32>,
    /// Global familiarity
    pub global_familiarity: f32,
    /// Current novelty signal
    pub novelty_signal: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Total novel detections
    pub novel_detections: u64,
}

impl PerirhinalCortex {
    pub fn new() -> Self {
        Self {
            concept_map: std::collections::HashMap::new(),
            global_familiarity: 0.20,
            novelty_signal: 0.30,
            inputs_processed: 0,
            novel_detections: 0,
        }
    }

    // ── Core: process concept/input ───────────────────────────────────────────

    /// Process an input and update familiarity for its key concepts.
    /// - `concepts`: list of concept keys extracted from input (e.g. from Fusiform)
    /// - `is_novel`: novelty flag from Fusiform
    pub fn process(&mut self, concepts: &[&str], is_novel: bool) -> PRCOutput {
        self.inputs_processed += 1;

        if is_novel {
            self.novel_detections += 1;
            // Novel inputs spike novelty signal
            self.novelty_signal = (self.novelty_signal + 0.40).min(1.0);
        } else {
            self.novelty_signal = (self.novelty_signal - NOVELTY_DECAY).max(0.0);
        }

        // Update per-concept familiarity
        let mut concept_familiarity_sum = 0.0_f32;
        for &concept in concepts {
            let lower = concept.to_lowercase();
            let entry = self.concept_map.entry(lower).or_insert(0.0);
            // EMA toward 1.0 with each exposure
            *entry = *entry * (1.0 - CONCEPT_FAMILIARITY_EMA) + 1.0 * CONCEPT_FAMILIARITY_EMA;
            concept_familiarity_sum += *entry;
        }

        // Trim map if too large (evict least familiar)
        if self.concept_map.len() > MAX_CONCEPT_MAP {
            let min_key = self
                .concept_map
                .iter()
                .min_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(k, _)| k.clone());
            if let Some(k) = min_key {
                self.concept_map.remove(&k);
            }
        }

        // Global familiarity: average of processed concepts vs novelty
        let avg_familiarity = if concepts.is_empty() {
            0.20
        } else {
            (concept_familiarity_sum / concepts.len() as f32).min(1.0)
        };
        let familiarity_target = if is_novel { 0.10 } else { avg_familiarity };
        self.global_familiarity =
            self.global_familiarity * (1.0 - GLOBAL_EMA) + familiarity_target * GLOBAL_EMA;

        PRCOutput {
            global_familiarity: self.global_familiarity,
            novelty_signal: self.novelty_signal,
            recognized: self.global_familiarity >= RECOGNIZED_THRESHOLD,
            concept_count: self.concept_map.len(),
            skip_recollection: self.global_familiarity > 0.65 && !is_novel,
        }
    }

    /// Get familiarity for a specific concept (0.0 if unknown).
    pub fn concept_familiarity(&self, concept: &str) -> f32 {
        *self
            .concept_map
            .get(&concept.to_lowercase())
            .unwrap_or(&0.0)
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Novelty signal decays quickly
        self.novelty_signal = (self.novelty_signal - NOVELTY_DECAY).max(0.0);
        // Concept familiarity decays very slowly (recognition memory is persistent)
        for val in self.concept_map.values_mut() {
            *val = (*val - 0.0002).max(0.0);
        }
        // Global familiarity drifts slowly
        self.global_familiarity = (self.global_familiarity - 0.001).max(0.10);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> PRCOutput {
        PRCOutput {
            global_familiarity: self.global_familiarity,
            novelty_signal: self.novelty_signal,
            recognized: self.global_familiarity >= RECOGNIZED_THRESHOLD,
            concept_count: self.concept_map.len(),
            skip_recollection: self.global_familiarity > 0.65,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "PRC familiar={:.2} | novelty={:.2} | concepts={} | novel_detect={}",
            self.global_familiarity,
            self.novelty_signal,
            self.concept_map.len(),
            self.novel_detections,
        )
    }
}

impl Default for PerirhinalCortex {
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
        let p = PerirhinalCortex::new();
        assert!(p.global_familiarity < RECOGNIZED_THRESHOLD);
        assert!(p.concept_map.is_empty());
    }

    #[test]
    fn test_novel_raises_novelty_signal() {
        let mut p = PerirhinalCortex::new();
        let before = p.novelty_signal;
        let out = p.process(&["quantum_foam"], true);
        assert!(
            out.novelty_signal > before,
            "novel input should raise novelty signal: {:.2} → {:.2}",
            before,
            out.novelty_signal
        );
    }

    #[test]
    fn test_repeated_concept_builds_familiarity() {
        let mut p = PerirhinalCortex::new();
        for _ in 0..10 {
            p.process(&["rust", "coding"], false);
        }
        assert!(
            p.concept_familiarity("rust") > 0.40,
            "repeated concept should build familiarity: {:.2}",
            p.concept_familiarity("rust")
        );
    }

    #[test]
    fn test_novel_flag_lowers_global_familiarity() {
        let mut p = PerirhinalCortex::new();
        p.global_familiarity = 0.70;
        p.process(&["alien_concept"], true);
        assert!(
            p.global_familiarity < 0.70,
            "novel input should lower global familiarity: {:.2}",
            p.global_familiarity
        );
    }

    #[test]
    fn test_skip_recollection_high_familiarity() {
        let mut p = PerirhinalCortex::new();
        p.global_familiarity = 0.80;
        let out = p.current_output();
        assert!(
            out.skip_recollection,
            "high familiarity should allow skipping recollection"
        );
    }

    #[test]
    fn test_concept_count_grows() {
        let mut p = PerirhinalCortex::new();
        p.process(&["alpha", "beta", "gamma"], false);
        assert_eq!(
            p.concept_map.len(),
            3,
            "three unique concepts should be tracked"
        );
    }

    #[test]
    fn test_max_concept_map_not_exceeded() {
        let mut p = PerirhinalCortex::new();
        for i in 0..60 {
            let concept = format!("concept_{}", i);
            p.process(&[concept.as_str()], false);
        }
        assert!(
            p.concept_map.len() <= MAX_CONCEPT_MAP,
            "concept map should not exceed max: {}",
            p.concept_map.len()
        );
    }

    #[test]
    fn test_decay_reduces_novelty() {
        let mut p = PerirhinalCortex::new();
        p.novelty_signal = 0.80;
        p.decay();
        assert!(
            p.novelty_signal < 0.80,
            "novelty should decay: {:.2}",
            p.novelty_signal
        );
    }

    #[test]
    fn test_recognized_threshold() {
        let mut p = PerirhinalCortex::new();
        p.global_familiarity = 0.60;
        let out = p.current_output();
        assert!(
            out.recognized,
            "familiarity above threshold should give recognized signal"
        );
    }

    #[test]
    fn test_status_line() {
        let p = PerirhinalCortex::new();
        let s = p.status_line();
        assert!(s.contains("PRC"), "status should mention PRC");
        assert!(s.contains("familiar"), "status should show familiarity");
    }
}
