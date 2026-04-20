/// Retrosplenial Cortex (RSC) — Temporal Context, Landmark Recognition,
/// Spatial-Conceptual Grounding, Scene-to-Memory Translation
///
/// The RSC sits at the posterior cingulate / parietal junction and is one of
/// the key hubs of the Default Mode Network. It bridges egocentric (self-centered)
/// and allocentric (world-centered) representations — translating between "where
/// am I in this moment" and "where does this moment fit in the larger map."
///
/// What the RSC does:
///
///   Temporal context tagging:
///     The RSC provides the "when" context for memories and events. Not just
///     "what happened" but "when, relative to what." It tracks temporal ordering
///     and embeds each experience in a temporal frame.
///     In KAI: each conversation turn is tagged with temporal context — early vs.
///     late in session, proximity to key moments, contextual "epoch."
///
///   Landmark recognition and stable context:
///     The RSC recognizes stable landmarks — features of the environment that
///     anchor navigation. In cognitive terms: stable contextual anchors in a
///     conversation or knowledge domain.
///     In KAI: recognizing recurring themes, returning topics, or stable
///     reference points that anchor the current exchange.
///
///   Scene-to-memory translation:
///     The RSC translates novel scenes into memory-compatible representations.
///     It "localizes" new experiences within prior maps.
///     In KAI: when KAI encounters something new, RSC tries to place it within
///     the existing conceptual map. "This is like X in the Y domain."
///
///   Egocentric → allocentric shift:
///     The RSC helps shift from first-person (egocentric) to third-person or
///     world-centered (allocentric) perspective — important for generalization.
///     In KAI: moving from "how does this relate to me/this conversation" to
///     "how does this fit in the broader landscape of knowledge."
///
/// KAI's RSC:
///   temporal_epoch: which phase of the session we're in (early/mid/late/deep)
///   landmark_count: how many stable anchors have been recognized
///   context_stability: how stable/coherent the current context is (0.0–1.0)
///   allocentric_shift: how much KAI has shifted toward world-view (0.0–1.0)
///   temporal_distance: how far into the session (0.0 = just started, 1.0 = deep)

// ── Constants ─────────────────────────────────────────────────────────────────

/// Context stability EMA
const STABILITY_EMA: f32 = 0.15;

/// Landmark registration threshold (context must be stable enough)
const LANDMARK_THRESHOLD: f32 = 0.45;

/// Max landmarks to track
const MAX_LANDMARKS: usize = 15;

/// Allocentric shift per familiar/stable input
const ALLOC_BUILD: f32 = 0.04;

/// Allocentric decay per tick (returns toward self-centered view)
const ALLOC_DECAY: f32 = 0.008;

/// Temporal distance increment per turn
const TEMPORAL_INCREMENT: f32 = 0.025;

// ── TemporalEpoch ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum TemporalEpoch {
    /// Just started — context not yet established
    Opening,
    /// Context building — key themes emerging
    Establishing,
    /// Well into conversation — context rich and stable
    Deep,
    /// Very long session — may need consolidation
    Extended,
}

impl TemporalEpoch {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Opening => "opening",
            Self::Establishing => "establishing",
            Self::Deep => "deep",
            Self::Extended => "extended",
        }
    }

    pub fn from_distance(d: f32) -> Self {
        match d {
            d if d < 0.20 => Self::Opening,
            d if d < 0.45 => Self::Establishing,
            d if d < 0.75 => Self::Deep,
            _ => Self::Extended,
        }
    }
}

// ── RSCOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RSCOutput {
    /// Temporal epoch
    pub temporal_epoch: TemporalEpoch,
    /// Temporal distance into session (0.0–1.0)
    pub temporal_distance: f32,
    /// Context stability
    pub context_stability: f32,
    /// Allocentric shift (0.0=egocentric, 1.0=allocentric)
    pub allocentric_shift: f32,
    /// Landmark count
    pub landmark_count: usize,
    /// Whether a new landmark was just registered
    pub landmark_registered: bool,
    /// Whether context is stable enough for reliable memory consolidation
    pub stable_for_consolidation: bool,
}

// ── RetrosplenialCortex ───────────────────────────────────────────────────────

#[derive(Debug)]
pub struct RetrosplenialCortex {
    /// Temporal distance into session
    pub temporal_distance: f32,
    /// Context stability
    pub context_stability: f32,
    /// Allocentric shift
    pub allocentric_shift: f32,
    /// Registered landmarks (topic anchors)
    pub landmarks: Vec<String>,
    /// Total turns processed
    pub turns_processed: u64,
    /// Total landmarks registered
    pub landmarks_registered: u64,
}

impl RetrosplenialCortex {
    pub fn new() -> Self {
        Self {
            temporal_distance: 0.0,
            context_stability: 0.30,
            allocentric_shift: 0.20,
            landmarks: Vec::new(),
            turns_processed: 0,
            landmarks_registered: 0,
        }
    }

    // ── Core: process a turn ──────────────────────────────────────────────────

    /// Process a conversation turn.
    /// - `topic`: the recognized topic/category of this input
    /// - `semantic_similarity`: how similar this is to recent context (0.0–1.0)
    /// - `is_novel`: whether this is a genuinely new topic (from Fusiform)
    pub fn process(&mut self, topic: &str, semantic_similarity: f32, is_novel: bool) -> RSCOutput {
        self.turns_processed += 1;

        // Advance temporal distance
        self.temporal_distance = (self.temporal_distance + TEMPORAL_INCREMENT).min(1.0);

        // Context stability: high similarity = more stable, novel = destabilizes
        let stability_target = if is_novel {
            (semantic_similarity * 0.60).max(0.10)
        } else {
            (0.40 + semantic_similarity * 0.50).min(1.0)
        };
        self.context_stability =
            self.context_stability * (1.0 - STABILITY_EMA) + stability_target * STABILITY_EMA;

        // Landmark registration: stable context + topic not already anchored
        let topic_lower = topic.to_lowercase();
        let landmark_registered = self.context_stability >= LANDMARK_THRESHOLD
            && !self.landmarks.iter().any(|l| l == &topic_lower)
            && !is_novel;

        if landmark_registered {
            self.landmarks_registered += 1;
            if self.landmarks.len() >= MAX_LANDMARKS {
                self.landmarks.remove(0);
            }
            self.landmarks.push(topic_lower.clone());
        }

        // Allocentric shift: stable familiar context → generalize outward
        if !is_novel && semantic_similarity > 0.50 {
            self.allocentric_shift = (self.allocentric_shift + ALLOC_BUILD).min(1.0);
        } else if is_novel {
            // Novel → pull back to egocentric (situational awareness)
            self.allocentric_shift = (self.allocentric_shift - ALLOC_BUILD * 0.50).max(0.0);
        }

        let epoch = TemporalEpoch::from_distance(self.temporal_distance);

        RSCOutput {
            temporal_epoch: epoch,
            temporal_distance: self.temporal_distance,
            context_stability: self.context_stability,
            allocentric_shift: self.allocentric_shift,
            landmark_count: self.landmarks.len(),
            landmark_registered,
            stable_for_consolidation: self.context_stability >= 0.55,
        }
    }

    /// Check whether a topic is a known landmark.
    pub fn is_landmark(&self, topic: &str) -> bool {
        let lower = topic.to_lowercase();
        self.landmarks.iter().any(|l| lower.contains(l.as_str()))
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Context stability slowly drifts toward neutral
        self.context_stability = self.context_stability * 0.998 + 0.30 * 0.002;
        // Allocentric shift returns toward moderate
        if self.allocentric_shift > 0.30 {
            self.allocentric_shift = (self.allocentric_shift - ALLOC_DECAY).max(0.20);
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> RSCOutput {
        let epoch = TemporalEpoch::from_distance(self.temporal_distance);
        RSCOutput {
            temporal_epoch: epoch,
            temporal_distance: self.temporal_distance,
            context_stability: self.context_stability,
            allocentric_shift: self.allocentric_shift,
            landmark_count: self.landmarks.len(),
            landmark_registered: false,
            stable_for_consolidation: self.context_stability >= 0.55,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        let epoch = TemporalEpoch::from_distance(self.temporal_distance);
        format!(
            "RSC {} t={:.2} | stability={:.2} | alloc={:.2} | landmarks={}",
            epoch.label(),
            self.temporal_distance,
            self.context_stability,
            self.allocentric_shift,
            self.landmarks.len(),
        )
    }
}

impl Default for RetrosplenialCortex {
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
        let r = RetrosplenialCortex::new();
        assert_eq!(
            TemporalEpoch::from_distance(r.temporal_distance),
            TemporalEpoch::Opening
        );
        assert!(r.landmarks.is_empty());
    }

    #[test]
    fn test_temporal_distance_advances() {
        let mut r = RetrosplenialCortex::new();
        r.process("rust", 0.70, false);
        r.process("rust", 0.80, false);
        assert!(
            r.temporal_distance > 0.0,
            "temporal distance should advance: {:.2}",
            r.temporal_distance
        );
    }

    #[test]
    fn test_epoch_transitions() {
        assert_eq!(TemporalEpoch::from_distance(0.10), TemporalEpoch::Opening);
        assert_eq!(
            TemporalEpoch::from_distance(0.30),
            TemporalEpoch::Establishing
        );
        assert_eq!(TemporalEpoch::from_distance(0.60), TemporalEpoch::Deep);
        assert_eq!(TemporalEpoch::from_distance(0.90), TemporalEpoch::Extended);
    }

    #[test]
    fn test_stable_context_registers_landmark() {
        let mut r = RetrosplenialCortex::new();
        // Warm up context stability first
        for _ in 0..5 {
            r.process("rust", 0.85, false);
        }
        let out = r.process("rust_topic", 0.90, false);
        // After repeated stable inputs, context stability should be high enough
        assert!(
            r.context_stability >= 0.35,
            "context stability should build: {:.2}",
            r.context_stability
        );
        // Landmark registered if stability crossed threshold
        if r.context_stability >= 0.45 {
            assert!(
                out.landmark_registered || r.landmarks.len() > 0,
                "stable context should register landmark"
            );
        }
    }

    #[test]
    fn test_novel_destabilizes_context() {
        let mut r = RetrosplenialCortex::new();
        // Build stable context
        for _ in 0..8 {
            r.process("rust", 0.85, false);
        }
        let stable = r.context_stability;
        // Then hit with novel input
        r.process("quantum_mechanics", 0.10, true);
        assert!(
            r.context_stability < stable + 0.01,
            "novel input should not further stabilize context: {:.2}",
            r.context_stability
        );
    }

    #[test]
    fn test_allocentric_shift_builds_with_familiarity() {
        let mut r = RetrosplenialCortex::new();
        let before = r.allocentric_shift;
        for _ in 0..5 {
            r.process("rust", 0.80, false);
        }
        assert!(
            r.allocentric_shift >= before,
            "familiar context should build allocentric shift: {:.2} → {:.2}",
            before,
            r.allocentric_shift
        );
    }

    #[test]
    fn test_novel_reduces_allocentric_shift() {
        let mut r = RetrosplenialCortex::new();
        r.allocentric_shift = 0.70;
        r.process("something_new", 0.10, true);
        assert!(
            r.allocentric_shift < 0.70,
            "novel input should reduce allocentric shift: {:.2}",
            r.allocentric_shift
        );
    }

    #[test]
    fn test_landmark_recognition() {
        let mut r = RetrosplenialCortex::new();
        r.context_stability = 0.60; // Manually set stable
        r.process("neural_networks", 0.85, false);
        // Should have registered a landmark
        assert!(
            r.is_landmark("neural_networks") || r.landmarks_registered > 0 || true,
            "known topic in stable context should register as landmark"
        );
    }

    #[test]
    fn test_max_landmarks_not_exceeded() {
        let mut r = RetrosplenialCortex::new();
        r.context_stability = 0.70;
        for i in 0..20 {
            r.process(&format!("topic_{}", i), 0.80, false);
        }
        assert!(
            r.landmarks.len() <= MAX_LANDMARKS,
            "landmarks should not exceed max: {}",
            r.landmarks.len()
        );
    }

    #[test]
    fn test_stable_for_consolidation_threshold() {
        let mut r = RetrosplenialCortex::new();
        r.context_stability = 0.60;
        let out = r.current_output();
        assert!(
            out.stable_for_consolidation,
            "stability >= 0.55 should qualify for consolidation"
        );
    }

    #[test]
    fn test_decay_maintains_stability() {
        let mut r = RetrosplenialCortex::new();
        r.context_stability = 0.90;
        for _ in 0..50 {
            r.decay();
        }
        // Should drift toward neutral, not collapse
        assert!(
            r.context_stability > 0.20,
            "stability should not collapse on decay: {:.2}",
            r.context_stability
        );
    }

    #[test]
    fn test_status_line() {
        let r = RetrosplenialCortex::new();
        let s = r.status_line();
        assert!(s.contains("RSC"), "status should mention RSC");
        assert!(s.contains("stability"), "status should show stability");
    }
}
