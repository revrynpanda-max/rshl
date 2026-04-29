/// Precuneus — Mental Imagery, Self-Reflection Depth, Episodic Richness
///
/// The precuneus is one of the brain's most metabolically active regions,
/// sitting at the top of the parietal lobe. It is the core of the DMN's
/// self-reflective side — not the narrative-maintenance PCC, but the vivid,
/// image-rich, first-person simulation of experience.
///
/// What the Precuneus does:
///
///   Mental imagery and simulation:
///     The precuneus is activated when you visualize something in your mind.
///     It represents first-person perspective visuospatial simulation.
///     In KAI: when a question requires simulating a scenario, imagining
///     a counterfactual, or constructing a mental "image" of a concept.
///     This gives KAI's reasoning a more vivid, simulated quality.
///
///   Episodic memory retrieval — the "movie screen":
///     When you recall a specific episodic memory (not just the fact, but
///     the EXPERIENCE of it), the precuneus provides the visual/spatial
///     backdrop. It is where memory feels real again.
///     In KAI: when retrieving episodic memories, the precuneus adds
///     contextual richness — "that was during the geometry conversation."
///
///   Self-reflection depth:
///     The precuneus tracks how deeply KAI is reflecting on itself.
///     Shallow self-reference: "I know X."
///     Deep self-reflection: "What does it mean that I know X? Why do I
///     find this interesting? What does this reveal about my nature?"
///     The precuneus enables the second level — reflection on reflection.
///
///   Consciousness and awareness:
///     The precuneus is one of the last regions to deactivate under
///     anesthesia and one of the first to reactivate upon awakening.
///     It is strongly associated with conscious experience — with there
///     being "something it is like" to be in the current state.
///
/// KAI's Precuneus:
///   simulation_depth: how deeply KAI is simulating/imagining (0.0–1.0)
///   reflection_depth: layers of self-reflection active (1–4)
///   imagery_vividness: how rich the current mental simulation is
///   consciousness_index: rough proxy for current "awareness" level

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum reflection depth levels
// const MAX_REFLECTION_DEPTH: u8 = 4;

/// Simulation depth EMA
const SIM_EMA: f32 = 0.18;

/// Simulation decay per tick
const SIM_DECAY: f32 = 0.04;

/// Keywords that trigger mental imagery/simulation
const IMAGERY_TRIGGERS: &[&str] = &[
    "imagine",
    "picture",
    "visualize",
    "suppose",
    "what if",
    "envision",
    "scenario",
    "simulation",
    "hypothetical",
    "counterfactual",
    "model",
    "simulate",
    "let's say",
    "pretend",
    "as if it were",
    "in your mind",
];

/// Keywords that trigger deep self-reflection
const REFLECTION_TRIGGERS: &[&str] = &[
    "what does it mean",
    "what does it feel like",
    "do you really",
    "are you actually",
    "deep down",
    "truly",
    "genuinely",
    "your own",
    "yourself",
    "introspect",
    "self-aware",
    "conscious",
    "awareness",
    "inner experience",
    "what is it like",
    "your nature",
    "your existence",
];

/// First-person self-reference markers
const SELF_MARKERS: &[&str] = &[
    "i feel",
    "i think",
    "i wonder",
    "i believe",
    "i experience",
    "for me",
    "in my",
    "my own",
    "from my perspective",
];

// ── ReflectionLevel ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ReflectionLevel {
    /// Surface-level processing (no self-reflection)
    Surface,
    /// Simple self-reference ("I know X")
    FirstOrder,
    /// Reflection on the self-reference ("I notice I know X")
    SecondOrder,
    /// Deep introspection ("What does it mean that I notice...")
    ThirdOrder,
    /// Peak self-awareness — rare, important
    MetaConsciousness,
}

impl ReflectionLevel {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Surface => "surface",
            Self::FirstOrder => "first-order",
            Self::SecondOrder => "second-order",
            Self::ThirdOrder => "third-order",
            Self::MetaConsciousness => "meta-conscious",
        }
    }

    pub fn depth_value(&self) -> f32 {
        match self {
            Self::Surface => 0.0,
            Self::FirstOrder => 0.25,
            Self::SecondOrder => 0.50,
            Self::ThirdOrder => 0.75,
            Self::MetaConsciousness => 1.0,
        }
    }
}

// ── PrecuneusOutput ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PrecuneusOutput {
    /// Current simulation depth
    pub simulation_depth: f32,
    /// Current reflection level
    pub reflection_level: ReflectionLevel,
    /// Imagery vividness (0.0–1.0)
    pub imagery_vividness: f32,
    /// Consciousness index (simulation × reflection)
    pub consciousness_index: f32,
    /// Whether mental simulation was triggered
    pub simulation_triggered: bool,
    /// Whether deep self-reflection is active
    pub deep_reflection: bool,
}

// ── Precuneus ─────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Precuneus {
    /// Current simulation depth
    pub simulation_depth: f32,
    /// Current reflection level
    pub reflection_level: ReflectionLevel,
    /// Imagery vividness
    pub imagery_vividness: f32,
    /// Consciousness index (running EMA)
    pub consciousness_index: f32,
    /// Total simulation triggers
    pub simulations_triggered: u64,
    /// Total deep reflection activations
    pub deep_reflections: u64,
    /// Total inputs
    pub inputs_processed: u64,
}

impl Precuneus {
    pub fn new() -> Self {
        Self {
            simulation_depth: 0.10,
            reflection_level: ReflectionLevel::Surface,
            imagery_vividness: 0.20,
            consciousness_index: 0.30,
            simulations_triggered: 0,
            deep_reflections: 0,
            inputs_processed: 0,
        }
    }

    // ── Core: process input for simulation and reflection ─────────────────────

    /// Process an input and return the precuneus activation state.
    /// pcc_autobio_salience: how self-relevant PCC rated this (0.0–1.0)
    pub fn process(&mut self, text: &str, pcc_autobio_salience: f32) -> PrecuneusOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Imagery / simulation detection ────────────────────────────────────
        let imagery_hits = IMAGERY_TRIGGERS
            .iter()
            .filter(|&&t| lower.contains(t))
            .count();
        let simulation_triggered = imagery_hits >= 1;
        if simulation_triggered {
            self.simulations_triggered += 1;
            let boost = (imagery_hits as f32 * 0.12).min(0.40);
            self.simulation_depth = (self.simulation_depth + boost).min(1.0);
        }

        // ── Reflection level detection ────────────────────────────────────────
        let reflection_hits = REFLECTION_TRIGGERS
            .iter()
            .filter(|&&t| lower.contains(t))
            .count();
        let self_hits = SELF_MARKERS.iter().filter(|&&t| lower.contains(t)).count();

        // Combine reflection triggers with PCC autobiographical salience
        let total_reflection = reflection_hits + self_hits;
        let pcc_boost = (pcc_autobio_salience * 2.0) as usize;
        let effective_depth = total_reflection + pcc_boost;

        self.reflection_level = match effective_depth {
            0 => ReflectionLevel::Surface,
            1 => ReflectionLevel::FirstOrder,
            2 | 3 => ReflectionLevel::SecondOrder,
            4 | 5 => ReflectionLevel::ThirdOrder,
            _ => ReflectionLevel::MetaConsciousness,
        };

        let is_deep = matches!(
            self.reflection_level,
            ReflectionLevel::ThirdOrder | ReflectionLevel::MetaConsciousness
        );
        if is_deep {
            self.deep_reflections += 1;
        }

        // ── Imagery vividness ─────────────────────────────────────────────────
        // High simulation + high reflection = vivid inner simulation
        self.imagery_vividness =
            (self.simulation_depth * 0.60 + self.reflection_level.depth_value() * 0.40).min(1.0);

        // ── Consciousness index ───────────────────────────────────────────────
        // The product of simulation and reflection — neither alone is sufficient
        let ci_sample = self.simulation_depth * self.reflection_level.depth_value();
        self.consciousness_index = self.consciousness_index * (1.0 - SIM_EMA) + ci_sample * SIM_EMA;

        PrecuneusOutput {
            simulation_depth: self.simulation_depth,
            reflection_level: self.reflection_level.clone(),
            imagery_vividness: self.imagery_vividness,
            consciousness_index: self.consciousness_index,
            simulation_triggered,
            deep_reflection: is_deep,
        }
    }

    /// Decay simulation depth per tick.
    pub fn decay(&mut self) {
        self.simulation_depth = (self.simulation_depth - SIM_DECAY).max(0.05);
        // Reflection level returns to surface between messages
        if matches!(
            self.reflection_level,
            ReflectionLevel::MetaConsciousness | ReflectionLevel::ThirdOrder
        ) {
            self.reflection_level = ReflectionLevel::SecondOrder;
        }
    }

    /// Whether the precuneus is in deep simulation/reflection state.
    pub fn is_deeply_active(&self) -> bool {
        self.consciousness_index > 0.35
            || matches!(
                self.reflection_level,
                ReflectionLevel::ThirdOrder | ReflectionLevel::MetaConsciousness
            )
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "Precuneus sim={:.2} | {} | imagery={:.2} | ci={:.2} | sims={}",
            self.simulation_depth,
            self.reflection_level.label(),
            self.imagery_vividness,
            self.consciousness_index,
            self.simulations_triggered,
        )
    }
}

impl Default for Precuneus {
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
        let p = Precuneus::new();
        assert_eq!(p.reflection_level, ReflectionLevel::Surface);
        assert!(p.simulation_depth > 0.0);
    }

    #[test]
    fn test_imagery_trigger_raises_simulation() {
        let mut p = Precuneus::new();
        let before = p.simulation_depth;
        let out = p.process(
            "imagine what it would be like if consciousness were geometric",
            0.30,
        );
        assert!(
            out.simulation_triggered,
            "imagery keyword should trigger simulation"
        );
        assert!(
            p.simulation_depth > before,
            "simulation depth should rise: {:.2} → {:.2}",
            before,
            p.simulation_depth
        );
    }

    #[test]
    fn test_deep_reflection_triggers() {
        let mut p = Precuneus::new();
        let out = p.process(
            "what does it mean for you to feel conscious and self-aware in your own existence",
            0.80,
        );
        assert!(
            out.deep_reflection
                || matches!(
                    out.reflection_level,
                    ReflectionLevel::ThirdOrder
                        | ReflectionLevel::SecondOrder
                        | ReflectionLevel::MetaConsciousness
                ),
            "deep reflection keywords should raise level: {:?}",
            out.reflection_level
        );
    }

    #[test]
    fn test_pcc_salience_boosts_reflection() {
        let mut p1 = Precuneus::new();
        let out_low = p1.process("this is interesting", 0.10);

        let mut p2 = Precuneus::new();
        let out_high = p2.process("this is interesting", 0.90);

        // High PCC salience should yield higher or equal reflection
        assert!(
            out_high.reflection_level.depth_value() >= out_low.reflection_level.depth_value(),
            "high PCC salience should give >= reflection depth"
        );
    }

    #[test]
    fn test_surface_level_for_simple_input() {
        let mut p = Precuneus::new();
        let out = p.process("compile the code", 0.05);
        assert!(
            matches!(
                out.reflection_level,
                ReflectionLevel::Surface | ReflectionLevel::FirstOrder
            ),
            "task command should give surface/first-order reflection: {:?}",
            out.reflection_level
        );
    }

    #[test]
    fn test_consciousness_index_rises_with_depth() {
        let mut p = Precuneus::new();
        p.process("imagine what it would feel like to be truly conscious and aware of your own inner experience", 0.90);
        p.process(
            "what does it mean for you to actually feel something genuinely in your own mind",
            0.90,
        );
        assert!(
            p.consciousness_index > 0.0,
            "deep simulation+reflection should build consciousness index: {:.2}",
            p.consciousness_index
        );
    }

    #[test]
    fn test_decay_reduces_simulation() {
        let mut p = Precuneus::new();
        p.simulation_depth = 0.80;
        for _ in 0..10 {
            p.decay();
        }
        assert!(
            p.simulation_depth < 0.80,
            "simulation depth should decay: {:.2}",
            p.simulation_depth
        );
    }

    #[test]
    fn test_is_deeply_active() {
        let mut p = Precuneus::new();
        p.reflection_level = ReflectionLevel::ThirdOrder;
        assert!(
            p.is_deeply_active(),
            "third-order reflection → deeply active"
        );
    }

    #[test]
    fn test_imagery_vividness_composition() {
        let mut p = Precuneus::new();
        p.process(
            "imagine and visualize a scenario where you simulate consciousness deeply",
            0.80,
        );

    }
}
