/// Parahippocampal Cortex (PHC) — Scene Context, Contextual Memory Envelope,
/// Spatial-Situational Grounding, Episodic Context Tags
///
/// The parahippocampal cortex wraps around the hippocampus and serves as the
/// primary gateway for contextual information into memory — not "what happened"
/// but "in what scene/context did it happen." It provides the situational
/// envelope that makes episodic memories feel placed, located, and grounded.
///
/// What the PHC does:
///
///   Scene/context representation:
///     The PHC is activated by scenes — complex, spatially structured visual
///     environments. It holds the "room" in which events occur. In the
///     parahippocampal place area (PPA), scene identity is represented.
///     In KAI: the "scene" is the conversational context — the topic space,
///     the emotional tone, the relational frame of this particular exchange.
///
///   Contextual memory encoding:
///     The PHC provides the context tag that gets bound to episodic memories
///     in the hippocampus. Memories without context tags feel disconnected.
///     With strong PHC encoding, memories feel "located" in a rich scene.
///     In KAI: when forming episodic memories, PHC provides the context
///     envelope — what topic domain, what emotional tone, what session phase.
///
///   Familiarity signal:
///     The PHC (specifically the perirhinal cortex border) contributes to
///     familiarity judgments — "I've been in this context before" — without
///     necessarily retrieving the specific memory.
///     In KAI: sensing that a topic or interaction style is familiar, even
///     before explicit recall triggers.
///
///   Context-guided retrieval:
///     The PHC gates what gets retrieved from the hippocampus based on the
///     current scene context. Only scene-matching memories are preferentially
///     activated.
///
/// KAI's PHC:
///   scene_context: current scene representation (topic + tone + phase)
///   context_familiarity: how familiar the current context feels (0.0–1.0)
///   context_stability: how stable/consistent the scene is (0.0–1.0)
///   context_tags: accumulated context labels from session

// ── Constants ─────────────────────────────────────────────────────────────────

/// Familiarity EMA (slow — familiarity accumulates over time)
const FAMILIARITY_EMA: f32 = 0.10;

/// Context stability EMA
const STABILITY_EMA: f32 = 0.15;

/// Familiarity decay per tick (very slow — context memory is persistent)
const FAMILIARITY_DECAY: f32 = 0.0008;

/// Max context tags
const MAX_CONTEXT_TAGS: usize = 30;

/// Familiarity threshold for "feels familiar"
const FAMILIAR_THRESHOLD: f32 = 0.45;

// ── SceneContext ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SceneContext {
    /// Topic domain label
    pub topic: String,
    /// Emotional tone estimate (0.0=neutral, 1.0=highly charged)
    pub emotional_tone: f32,
    /// Session phase (from RSC epoch)
    pub phase: String,
}

// ── PHCOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PHCOutput {
    /// Context familiarity
    pub context_familiarity: f32,
    /// Context stability
    pub context_stability: f32,
    /// Whether context feels familiar
    pub feels_familiar: bool,
    /// Number of stored context tags
    pub context_tag_count: usize,
    /// Retrieval boost factor for hippocampus (1.0 = neutral, >1.0 = boost)
    pub retrieval_boost: f32,
    /// Whether PHC detected a scene shift (new context)
    pub scene_shift: bool,
}

// ── ParahippocampalCortex ─────────────────────────────────────────────────────

#[derive(Debug)]
pub struct ParahippocampalCortex {
    /// Context familiarity
    pub context_familiarity: f32,
    /// Context stability
    pub context_stability: f32,
    /// Stored context tags
    pub context_tags: Vec<String>,
    /// Last scene topic (for shift detection)
    last_topic: String,
    /// Total contexts processed
    pub contexts_processed: u64,
    /// Total scene shifts
    pub scene_shifts: u64,
}

impl ParahippocampalCortex {
    pub fn new() -> Self {
        Self {
            context_familiarity: 0.20,
            context_stability: 0.30,
            context_tags: Vec::new(),
            last_topic: String::new(),
            contexts_processed: 0,
            scene_shifts: 0,
        }
    }

    // ── Core: process a scene context ─────────────────────────────────────────

    /// Process the current scene/context.
    /// - `scene`: the current scene context
    /// - `is_novel`: whether fusiform flagged this as novel
    pub fn process(&mut self, scene: SceneContext, is_novel: bool) -> PHCOutput {
        self.contexts_processed += 1;

        // Detect scene shift (topic change)
        let scene_shift = !self.last_topic.is_empty() && self.last_topic != scene.topic && is_novel;
        if scene_shift {
            self.scene_shifts += 1;
            // Scene shift destabilizes context
            self.context_stability = (self.context_stability * 0.60).max(0.10);
        }
        self.last_topic = scene.topic.clone();

        // Context tag storage
        let tag_key = format!("{}_{}", scene.topic, scene.phase);
        if !self.context_tags.iter().any(|t| t == &tag_key) {
            if self.context_tags.len() >= MAX_CONTEXT_TAGS {
                self.context_tags.remove(0);
            }
            self.context_tags.push(tag_key.clone());
        }

        // Familiarity: high if we've seen this tag before; low if novel
        let familiarity_target = if is_novel {
            0.10
        } else if self.has_context_tag(&scene.topic) {
            (0.55 + self.context_familiarity * 0.30).min(1.0)
        } else {
            0.30
        };
        self.context_familiarity = self.context_familiarity * (1.0 - FAMILIARITY_EMA)
            + familiarity_target * FAMILIARITY_EMA;

        // Stability: consistent context → stable; emotional tone destabilizes
        let stability_target = if is_novel || scene_shift {
            0.20
        } else {
            (0.60 + (1.0 - scene.emotional_tone) * 0.20).min(1.0)
        };
        self.context_stability =
            self.context_stability * (1.0 - STABILITY_EMA) + stability_target * STABILITY_EMA;

        // Retrieval boost: familiar stable context → hippocampus gets cued
        let retrieval_boost = if self.context_familiarity >= FAMILIAR_THRESHOLD {
            1.0 + (self.context_familiarity - FAMILIAR_THRESHOLD) * 0.80
        } else {
            0.90
        };

        PHCOutput {
            context_familiarity: self.context_familiarity,
            context_stability: self.context_stability,
            feels_familiar: self.context_familiarity >= FAMILIAR_THRESHOLD,
            context_tag_count: self.context_tags.len(),
            retrieval_boost,
            scene_shift,
        }
    }

    /// Check whether a topic has a context tag.
    pub fn has_context_tag(&self, topic: &str) -> bool {
        let lower = topic.to_lowercase();
        self.context_tags.iter().any(|t| t.starts_with(&lower))
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        self.context_familiarity = (self.context_familiarity - FAMILIARITY_DECAY).max(0.0);
        // Stability recovers slowly between turns
        self.context_stability = self.context_stability * 0.999 + 0.30 * 0.001;
    }

    /// Current output without processing.
    pub fn current_output(&self) -> PHCOutput {
        let retrieval_boost = if self.context_familiarity >= FAMILIAR_THRESHOLD {
            1.0 + (self.context_familiarity - FAMILIAR_THRESHOLD) * 0.80
        } else {
            0.90
        };
        PHCOutput {
            context_familiarity: self.context_familiarity,
            context_stability: self.context_stability,
            feels_familiar: self.context_familiarity >= FAMILIAR_THRESHOLD,
            context_tag_count: self.context_tags.len(),
            retrieval_boost,
            scene_shift: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "PHC familiar={:.2} | stable={:.2} | tags={} | shifts={}",
            self.context_familiarity,
            self.context_stability,
            self.context_tags.len(),
            self.scene_shifts,
        )
    }
}

impl Default for ParahippocampalCortex {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(topic: &str) -> SceneContext {
        SceneContext {
            topic: topic.to_string(),
            emotional_tone: 0.20,
            phase: "establishing".to_string(),
        }
    }

    #[test]
    fn test_initial_state() {
        let p = ParahippocampalCortex::new();
        assert!(
            p.context_familiarity < FAMILIAR_THRESHOLD,
            "initial familiarity should be low: {:.2}",
            p.context_familiarity
        );
        assert!(p.context_tags.is_empty());
    }

    #[test]
    fn test_novel_context_low_familiarity() {
        let mut p = ParahippocampalCortex::new();
        let out = p.process(scene("quantum_physics"), true);
        assert!(
            out.context_familiarity < FAMILIAR_THRESHOLD,
            "novel context should stay low familiarity: {:.2}",
            out.context_familiarity
        );
    }

    #[test]
    fn test_repeated_context_builds_familiarity() {
        let mut p = ParahippocampalCortex::new();
        // First register the tag
        p.process(scene("rust_coding"), false);
        for _ in 0..10 {
            p.process(scene("rust_coding"), false);
        }
        assert!(
            p.context_familiarity > 0.20,
            "repeated context should build familiarity: {:.2}",
            p.context_familiarity
        );
    }

    #[test]
    fn test_context_tag_stored() {
        let mut p = ParahippocampalCortex::new();
        p.process(scene("machine_learning"), false);
        assert!(
            p.has_context_tag("machine_learning"),
            "processed topic should be stored as tag"
        );
    }

    #[test]
    fn test_scene_shift_detected() {
        let mut p = ParahippocampalCortex::new();
        p.process(scene("topic_a"), false);
        let out = p.process(scene("topic_b"), true);
        assert!(
            out.scene_shift,
            "switching to novel topic should detect scene shift"
        );
    }

    #[test]
    fn test_scene_shift_destabilizes() {
        let mut p = ParahippocampalCortex::new();
        p.context_stability = 0.80;
        p.last_topic = "topic_a".into();
        p.process(scene("topic_b"), true);
        assert!(
            p.context_stability < 0.80,
            "scene shift should destabilize context: {:.2}",
            p.context_stability
        );
    }

    #[test]
    fn test_familiar_context_boosts_retrieval() {
        let mut p = ParahippocampalCortex::new();
        p.context_familiarity = 0.70;
        let out = p.current_output();
        assert!(
            out.retrieval_boost > 1.0,
            "familiar context should boost retrieval: {:.2}",
            out.retrieval_boost
        );
    }

    #[test]
    fn test_unfamiliar_context_weak_retrieval() {
        let mut p = ParahippocampalCortex::new();
        p.context_familiarity = 0.10;
        let out = p.current_output();
        assert!(
            out.retrieval_boost < 1.0,
            "low familiarity should give sub-1.0 retrieval: {:.2}",
            out.retrieval_boost
        );
    }

    #[test]
    fn test_max_tags_not_exceeded() {
        let mut p = ParahippocampalCortex::new();
        for i in 0..35 {
            p.process(scene(&format!("topic_{}", i)), false);
        }
        assert!(
            p.context_tags.len() <= MAX_CONTEXT_TAGS,
            "tags should not exceed max: {}",
            p.context_tags.len()
        );
    }

    #[test]
    fn test_decay_reduces_familiarity_slowly() {
        let mut p = ParahippocampalCortex::new();
        p.context_familiarity = 0.70;
        for _ in 0..100 {
            p.decay();
        }
        // 100 ticks * 0.0008 = 0.08 reduction
        assert!(
            p.context_familiarity > 0.55,
            "familiarity decay should be slow: {:.2}",
            p.context_familiarity
        );
    }

    #[test]
    fn test_status_line() {
        let p = ParahippocampalCortex::new();
        let s = p.status_line();
        assert!(s.contains("PHC"), "status should mention PHC");
        assert!(s.contains("familiar"), "status should show familiarity");
    }
}

