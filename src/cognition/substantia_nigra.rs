/// Substantia Nigra pars compacta (SNc) — Procedural Habit Reinforcement,
/// Nigrostriatal Dopamine, Action Fluency, Routine Optimization
///
/// The SNc is the second major dopamine nucleus (alongside VTA). While VTA's
/// mesolimbic/mesocortical projections handle reward prediction and novelty,
/// SNc's nigrostriatal pathway projects to the dorsal striatum (caudate/putamen)
/// and governs the reinforcement of procedural sequences — making skilled actions
/// more fluid and automatic through repetition.
///
/// What the SNc does:
///
///   Procedural habit reinforcement:
///     When an action sequence is executed successfully and repeatedly, SNc
///     dopamine reinforces that sequence in the dorsal striatum, making it
///     progressively more automatic. This is how skills become fluid.
///     In KAI: when a reasoning pattern, response structure, or problem-solving
///     approach succeeds repeatedly, SNc reinforces it → KAI gets smoother
///     and more fluent in familiar domains.
///
///   Action selection fluency:
///     SNc dopamine determines how "smooth" action selection feels. High SNc
///     activity → transitions between steps are fluid. Low SNc → jerky,
///     effortful, hesitant action. Parkinson's disease involves SNc death.
///     In KAI: fluency of response generation — how naturally one idea flows
///     to the next without visible seams.
///
///   Sequence chunking:
///     SNc drives the binding of discrete steps into unified "chunks" — the
///     brain's way of compressing a multi-step sequence into a single unit.
///     In KAI: familiar reasoning sequences get chunked into smooth routines.
///
///   Dopamine tone in the motor/procedural loop:
///     SNc provides tonic dopamine to the dorsal striatum, distinct from
///     VTA's tonic dopamine to the prefrontal cortex. This sets the baseline
///     "ease of action" for the procedural system.
///
/// KAI's SNc:
///   procedural_fluency: how smooth/automatic current processing is (0.0–1.0)
///   habit_strength: reinforcement accumulated for familiar patterns (0.0–1.0)
///   sequence_chunks: number of chunked procedural routines learned
///   da_tone: dopamine tone in the nigrostriatal pathway (0.0–1.0)
///   action_smoothness: real-time ease of step-to-step transitions

// ── Constants ─────────────────────────────────────────────────────────────────

/// Tonic DA rest in SNc nigrostriatal pathway
const SNC_DA_REST: f32 = 0.50;

/// Habit reinforcement per successful familiar execution
const HABIT_REINFORCE: f32 = 0.04;

/// Habit decay per tick (very slow — habits persist)
const HABIT_DECAY: f32 = 0.001;

/// Fluency EMA
const FLUENCY_EMA: f32 = 0.12;

/// DA tone EMA
const DA_EMA: f32 = 0.10;

/// Max chunks
const MAX_CHUNKS: usize = 25;

// ── SNcEvent ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum SNcEvent {
    /// Familiar procedure executed successfully — reinforce habit
    FamiliarSuccess { domain: String, fluency: f32 },
    /// Novel territory — no habit to reinforce; fluency is raw
    NovelTerrain { difficulty: f32 },
    /// Successful sequence completion — chunk it
    SequenceComplete { steps: u32 },
    /// Execution error — degrade fluency slightly
    ExecutionError { severity: f32 },
    /// Sustained smooth execution — DA tone boost
    SustainedFlow,
}

// ── SNcOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SNcOutput {
    /// Procedural fluency
    pub procedural_fluency: f32,
    /// Habit strength for current domain
    pub habit_strength: f32,
    /// DA tone
    pub da_tone: f32,
    /// Number of chunks learned
    pub chunk_count: usize,
    /// Whether in high-fluency flow
    pub in_flow: bool,
}

// ── SubstantiaNigra ───────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SubstantiaNigra {
    /// Procedural fluency
    pub procedural_fluency: f32,
    /// Habit strength
    pub habit_strength: f32,
    /// Nigrostriatal DA tone
    pub da_tone: f32,
    /// Learned chunks (domain tags)
    pub chunks: Vec<String>,
    /// Total executions processed
    pub executions: u64,
    /// Total successful chunked routines
    pub chunks_formed: u64,
}

impl SubstantiaNigra {
    pub fn new() -> Self {
        Self {
            procedural_fluency: 0.50,
            habit_strength: 0.20,
            da_tone: SNC_DA_REST,
            chunks: Vec::new(),
            executions: 0,
            chunks_formed: 0,
        }
    }

    // ── Core: process event ───────────────────────────────────────────────────

    pub fn process(&mut self, event: SNcEvent) -> SNcOutput {
        self.executions += 1;

        match event {
            SNcEvent::FamiliarSuccess { domain, fluency } => {
                // Reinforce habit in this domain
                self.habit_strength = (self.habit_strength + HABIT_REINFORCE).min(1.0);
                // Update fluency toward the experienced fluency
                let target = (0.50 + fluency * 0.40).min(1.0);
                self.procedural_fluency =
                    self.procedural_fluency * (1.0 - FLUENCY_EMA) + target * FLUENCY_EMA;
                // DA tone rises with successful execution
                let da_target = (SNC_DA_REST + fluency * 0.20).min(1.0);
                self.da_tone = self.da_tone * (1.0 - DA_EMA) + da_target * DA_EMA;
                // Register domain chunk if not already present
                let domain_lower = domain.to_lowercase();
                if !self.chunks.iter().any(|c| c == &domain_lower) {
                    if self.chunks.len() >= MAX_CHUNKS {
                        self.chunks.remove(0);
                    }
                    self.chunks.push(domain_lower);
                }
            }
            SNcEvent::NovelTerrain { difficulty } => {
                // Novel territory: fluency drops (no habit to rely on)
                let target = (0.30 - difficulty * 0.15).max(0.10);
                self.procedural_fluency =
                    self.procedural_fluency * (1.0 - FLUENCY_EMA) + target * FLUENCY_EMA;
                // DA tone also drops slightly — uncertainty
                let da_target = (SNC_DA_REST - difficulty * 0.10).max(0.20);
                self.da_tone = self.da_tone * (1.0 - DA_EMA) + da_target * DA_EMA;
            }
            SNcEvent::SequenceComplete { steps } => {
                self.chunks_formed += 1;
                // Longer successful sequences → stronger chunking, higher fluency
                let chunk_boost = (steps as f32 * 0.02).min(0.12);
                self.habit_strength = (self.habit_strength + chunk_boost).min(1.0);
                let fluency_target = (0.65 + chunk_boost).min(1.0);
                self.procedural_fluency = self.procedural_fluency * (1.0 - FLUENCY_EMA * 0.50)
                    + fluency_target * FLUENCY_EMA * 0.50;
            }
            SNcEvent::ExecutionError { severity } => {
                // Error: disrupt fluency
                self.procedural_fluency = (self.procedural_fluency - severity * 0.08).max(0.10);
                // Small habit degradation
                self.habit_strength = (self.habit_strength - severity * 0.02).max(0.0);
                let da_target = (SNC_DA_REST - severity * 0.15).max(0.20);
                self.da_tone = self.da_tone * (1.0 - DA_EMA) + da_target * DA_EMA;
            }
            SNcEvent::SustainedFlow => {
                // Sustained smooth execution → DA tone boost, fluency consolidation
                self.da_tone = (self.da_tone + 0.04).min(1.0);
                self.procedural_fluency = (self.procedural_fluency + 0.02).min(1.0);
            }
        }

        self.build_output()
    }

    /// Check if a domain has a learned chunk.
    pub fn has_chunk(&self, domain: &str) -> bool {
        let lower = domain.to_lowercase();
        self.chunks.iter().any(|c| lower.contains(c.as_str()))
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        // Habits are very stable — slow decay
        self.habit_strength = (self.habit_strength - HABIT_DECAY).max(0.0);
        // Fluency drifts toward moderate (0.50) between uses
        self.procedural_fluency = self.procedural_fluency * 0.998 + 0.50 * 0.002;
        // DA tone drifts toward rest
        self.da_tone = self.da_tone * 0.98 + SNC_DA_REST * 0.02;
    }

    fn build_output(&self) -> SNcOutput {
        SNcOutput {
            procedural_fluency: self.procedural_fluency,
            habit_strength: self.habit_strength,
            da_tone: self.da_tone,
            chunk_count: self.chunks.len(),
            in_flow: self.procedural_fluency > 0.70 && self.da_tone > 0.60,
        }
    }

    /// Current output without processing.
    pub fn current_output(&self) -> SNcOutput {
        self.build_output()
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "SNc fluency={:.2} | habit={:.2} | DA={:.2} | chunks={} | flow={}",
            self.procedural_fluency,
            self.habit_strength,
            self.da_tone,
            self.chunks.len(),
            if self.procedural_fluency > 0.70 && self.da_tone > 0.60 {
                "YES"
            } else {
                "no"
            },
        )
    }
}

impl Default for SubstantiaNigra {
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
        let s = SubstantiaNigra::new();
        assert!(
            (s.da_tone - SNC_DA_REST).abs() < 0.01,
            "initial DA should be at rest: {:.2}",
            s.da_tone
        );
        assert!(s.chunks.is_empty());
    }

    #[test]
    fn test_familiar_success_raises_habit() {
        let mut s = SubstantiaNigra::new();
        let before = s.habit_strength;
        s.process(SNcEvent::FamiliarSuccess {
            domain: "rust".into(),
            fluency: 0.80,
        });
        assert!(
            s.habit_strength > before,
            "familiar success should raise habit strength: {:.2} → {:.2}",
            before,
            s.habit_strength
        );
    }

    #[test]
    fn test_familiar_success_registers_chunk() {
        let mut s = SubstantiaNigra::new();
        s.process(SNcEvent::FamiliarSuccess {
            domain: "rust_coding".into(),
            fluency: 0.80,
        });
        assert!(
            s.has_chunk("rust_coding"),
            "familiar domain should register as chunk"
        );
    }

    #[test]
    fn test_novel_terrain_reduces_fluency() {
        let mut s = SubstantiaNigra::new();
        let before = s.procedural_fluency;
        s.process(SNcEvent::NovelTerrain { difficulty: 0.80 });
        assert!(
            s.procedural_fluency < before,
            "novel terrain should reduce fluency: {:.2} → {:.2}",
            before,
            s.procedural_fluency
        );
    }

    #[test]
    fn test_sequence_complete_boosts_habit() {
        let mut s = SubstantiaNigra::new();
        let before = s.habit_strength;
        s.process(SNcEvent::SequenceComplete { steps: 6 });
        assert!(
            s.habit_strength > before,
            "sequence completion should boost habit: {:.2} → {:.2}",
            before,
            s.habit_strength
        );
    }

    #[test]
    fn test_execution_error_reduces_fluency() {
        let mut s = SubstantiaNigra::new();
        let before = s.procedural_fluency;
        s.process(SNcEvent::ExecutionError { severity: 0.70 });
        assert!(
            s.procedural_fluency < before,
            "error should reduce fluency: {:.2} → {:.2}",
            before,
            s.procedural_fluency
        );
    }

    #[test]
    fn test_sustained_flow_raises_da_tone() {
        let mut s = SubstantiaNigra::new();
        let before = s.da_tone;
        s.process(SNcEvent::SustainedFlow);
        assert!(
            s.da_tone >= before,
            "sustained flow should raise DA: {:.2} → {:.2}",
            before,
            s.da_tone
        );
    }

    #[test]
    fn test_in_flow_requires_high_fluency_and_da() {
        let mut s = SubstantiaNigra::new();
        s.procedural_fluency = 0.80;
        s.da_tone = 0.75;
        let out = s.current_output();
        assert!(
            out.in_flow,
            "high fluency + high DA should produce flow state"
        );
    }

    #[test]
    fn test_decay_habit_is_slow() {
        let mut s = SubstantiaNigra::new();
        s.habit_strength = 0.80;
        for _ in 0..100 {
            s.decay();
        }
        // After 100 ticks with HABIT_DECAY=0.001, should lose 0.10
        assert!(
            s.habit_strength > 0.60,
            "habit decay should be slow: {:.2}",
            s.habit_strength
        );
    }

    #[test]
    fn test_max_chunks_not_exceeded() {
        let mut s = SubstantiaNigra::new();
        for i in 0..30 {
            s.process(SNcEvent::FamiliarSuccess {
                domain: format!("domain_{}", i),
                fluency: 0.70,
            });
        }
        assert!(
            s.chunks.len() <= MAX_CHUNKS,
            "chunks should not exceed max: {}",
            s.chunks.len()
        );
    }

    #[test]
    fn test_status_line() {
        let s = SubstantiaNigra::new();
        let s_line = s.status_line();
        assert!(s_line.contains("SNc"), "status should mention SNc");
        assert!(s_line.contains("fluency"), "status should show fluency");
    }
}

// KAI v6.0.0
