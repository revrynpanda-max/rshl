#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MindIntent {
    Greeting,
    PersonalMemory,
    SelfIdentity,
    SelfState,
    Narrative,
    Truth,
    Project,
    WorldKnowledge,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MindAction {
    Greet,
    AnswerPersonalMemory,
    AnswerSelfIdentity,
    AnswerSelfState,
    SynthesizeNarrative,
    UseTruthMemory,
    UseWorldKnowledge,
    AdmitPersonalMemoryGap,
}

#[derive(Debug, Clone)]
pub struct AttentionHeadScore {
    pub head: &'static str,
    pub score: f32,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModuleContributionStatus {
    Active,
    Observed,
    Decorative,
    Pruned,
}

#[derive(Debug, Clone)]
pub struct ModuleContribution {
    pub module: &'static str,
    pub status: ModuleContributionStatus,
    pub signal: &'static str,
    pub strength: f32,
    pub effect: String,
}

#[derive(Debug, Clone)]
pub struct MindFrame {
    pub query: String,
    pub intent: MindIntent,
    pub active_goal: Option<String>,
    pub personal_memory_score: f32,
    pub truth_score: f32,
    pub episodic_score: f32,
    pub narrative_score: f32,
    pub self_state_score: f32,
    pub world_score: f32,
    pub uncertainty: f32,
    pub contradiction_pressure: f32,
    pub allowed_sources: Vec<&'static str>,
    pub blocked_sources: Vec<&'static str>,
    pub heads: Vec<AttentionHeadScore>,
    pub module_contributions: Vec<ModuleContribution>,
    pub recommended_action: MindAction,
}

impl MindFrame {
    pub fn from_query(query: &str) -> Self {
        let lower = query.to_lowercase();
        let mut frame = Self {
            query: query.to_string(),
            intent: MindIntent::Unknown,
            active_goal: None,
            personal_memory_score: 0.0,
            truth_score: 0.0,
            episodic_score: 0.0,
            narrative_score: 0.0,
            self_state_score: 0.0,
            world_score: 0.0,
            uncertainty: 0.20,
            contradiction_pressure: 0.0,
            allowed_sources: Vec::new(),
            blocked_sources: vec!["dream", "sleep-rem", "dream-discovery"],
            heads: Vec::new(),
            module_contributions: Vec::new(),
            recommended_action: MindAction::UseWorldKnowledge,
        };

        frame.run_greeting_head(&lower);
        frame.run_personal_memory_head(&lower);
        frame.run_self_head(&lower);
        frame.run_narrative_head(&lower);
        frame.run_truth_head(&lower);
        frame.run_world_head(&lower);
        frame.normalize();
        frame.arbitrate();
        frame
    }

    pub fn requires_mind_memory(&self) -> bool {
        matches!(
            self.recommended_action,
            MindAction::AnswerPersonalMemory
                | MindAction::AnswerSelfIdentity
                | MindAction::AnswerSelfState
                | MindAction::SynthesizeNarrative
                | MindAction::AdmitPersonalMemoryGap
        )
    }

    pub fn blocks_world_bridge(&self) -> bool {
        self.blocked_sources.contains(&"world-bridge")
    }

    pub fn add_memory_signal(&mut self, module: &'static str, strength: f32, reason: &str) {
        let strength = strength.clamp(0.0, 1.0);
        self.personal_memory_score = self.personal_memory_score.max(strength * 0.55);
        self.episodic_score = self.episodic_score.max(strength * 0.65);
        self.allowed_sources.extend(["ryan", "user-claim", "user-echo"]);
        self.record_module(module, ModuleContributionStatus::Active, "memory", strength, reason);
    }

    pub fn add_self_state_signal(&mut self, module: &'static str, strength: f32, reason: &str) {
        let strength = strength.clamp(0.0, 1.0);
        self.self_state_score = self.self_state_score.max(strength * 0.65);
        self.allowed_sources.extend(["identity", "seed"]);
        self.record_module(
            module,
            ModuleContributionStatus::Active,
            "self_state",
            strength,
            reason,
        );
    }

    pub fn add_narrative_signal(&mut self, module: &'static str, strength: f32, reason: &str) {
        let strength = strength.clamp(0.0, 1.0);
        self.narrative_score = self.narrative_score.max(strength * 0.60);
        self.allowed_sources.extend(["identity", "ryan", "user-claim"]);
        self.record_module(module, ModuleContributionStatus::Active, "narrative", strength, reason);
    }

    pub fn add_truth_signal(&mut self, module: &'static str, strength: f32, reason: &str) {
        let strength = strength.clamp(0.0, 1.0);
        self.truth_score = self.truth_score.max(strength * 0.70);
        self.allowed_sources.extend(["truth-anchor", "identity", "physics-core"]);
        self.blocked_sources.extend(["dream", "world-bridge"]);
        self.record_module(module, ModuleContributionStatus::Active, "truth", strength, reason);
    }

    pub fn add_uncertainty(&mut self, module: &'static str, amount: f32, reason: &str) {
        let amount = amount.clamp(0.0, 1.0);
        self.uncertainty = self.uncertainty.max(amount);
        if amount > 0.65 {
            self.block_source("world-bridge");
        }
        self.record_module(
            module,
            ModuleContributionStatus::Active,
            "uncertainty",
            amount,
            reason,
        );
    }

    pub fn add_contradiction_pressure(
        &mut self,
        module: &'static str,
        amount: f32,
        reason: &str,
    ) {
        let amount = amount.clamp(0.0, 1.0);
        self.contradiction_pressure = self.contradiction_pressure.max(amount);
        self.truth_score = self.truth_score.max(amount * 0.70);
        if amount > 0.25 {
            self.block_source("world-bridge");
        }
        self.record_module(
            module,
            ModuleContributionStatus::Active,
            "contradiction",
            amount,
            reason,
        );
    }

    pub fn set_active_goal(&mut self, module: &'static str, goal: &str, priority: f32) {
        let priority = priority.clamp(0.0, 1.0);
        self.active_goal = Some(goal.to_string());
        self.record_module(module, ModuleContributionStatus::Active, "goal", priority, goal);
    }

    pub fn block_source(&mut self, source: &'static str) {
        self.blocked_sources.push(source);
    }

    pub fn allow_source(&mut self, source: &'static str) {
        self.allowed_sources.push(source);
    }

    pub fn mark_observed(&mut self, module: &'static str, strength: f32, reason: &str) {
        self.record_module(
            module,
            ModuleContributionStatus::Observed,
            "state_only",
            strength.clamp(0.0, 1.0),
            reason,
        );
    }

    pub fn mark_decorative(&mut self, module: &'static str, reason: &str) {
        self.record_module(
            module,
            ModuleContributionStatus::Decorative,
            "no_authority",
            0.0,
            reason,
        );
    }

    pub fn mark_pruned(&mut self, module: &'static str, reason: &str) {
        self.record_module(
            module,
            ModuleContributionStatus::Pruned,
            "removed_from_active_brain",
            0.0,
            reason,
        );
    }

    pub fn finalize_authority(&mut self) {
        self.normalize();
        self.arbitrate();
    }

    fn push_head(&mut self, head: &'static str, score: f32, reason: &str) {
        self.heads.push(AttentionHeadScore {
            head,
            score,
            reason: reason.to_string(),
        });
    }

    fn record_module(
        &mut self,
        module: &'static str,
        status: ModuleContributionStatus,
        signal: &'static str,
        strength: f32,
        effect: &str,
    ) {
        self.module_contributions.push(ModuleContribution {
            module,
            status,
            signal,
            strength,
            effect: effect.to_string(),
        });
    }

    fn run_greeting_head(&mut self, lower: &str) {
        let word_count = lower.split_whitespace().count();
        let is_greeting = matches!(lower.trim(), "hello" | "hi" | "hey")
            || lower.starts_with("hello ")
            || lower.starts_with("hi ")
            || lower.starts_with("hey ");
        if is_greeting && word_count <= 5 {
            self.push_head("greeting", 1.0, "short greeting");
            self.intent = MindIntent::Greeting;
        }
    }

    fn run_personal_memory_head(&mut self, lower: &str) {
        let personal = [
            "my name",
            "what is my",
            "what's my",
            "whats my",
            "what did i",
            "what do i",
            "what was i",
            "what have i",
            "what am i",
            "remember",
            "recall",
            "about me",
            "about my",
            "i told you",
            "i taught you",
            "did i say",
            "did i tell",
            "from this test",
            "from the test",
            "earlier",
            "today",
            "first phrase",
            "second phrase",
            "test phrase",
        ];
        let project_personal = [
            "the project",
            "this project",
            "we are building",
            "trying to build",
            "new kind of ai",
            "world-bridge",
            "bridge facts",
            "small language model",
            "slm",
        ];
        let score = score_patterns(lower, &personal) * 0.18 + score_patterns(lower, &project_personal) * 0.14;
        if score > 0.0 {
            self.personal_memory_score = score.min(1.0);
            self.episodic_score = self.episodic_score.max((score * 0.85).min(1.0));
            self.intent = if score_patterns(lower, &project_personal) > 0.0 {
                MindIntent::Project
            } else {
                MindIntent::PersonalMemory
            };
            self.allowed_sources.extend(["ryan", "user-claim", "user-echo"]);
            self.blocked_sources.extend(["world-bridge", "bridge", "dream"]);
            self.push_head("personal-memory", self.personal_memory_score, "query references Ryan/session/project memory");
        }
    }

    fn run_self_head(&mut self, lower: &str) {
        let identity = [
            "who are you",
            "what are you",
            "your name",
            "what is yours",
            "what's yours",
            "yourself",
            "your mind",
            "your memory",
        ];
        let state = [
            "how are you",
            "how do you feel",
            "what do you feel",
            "your mood",
            "are you okay",
            "what are you thinking",
            "what do you think",
        ];
        let identity_score = score_patterns(lower, &identity) * 0.22;
        let state_score = score_patterns(lower, &state) * 0.22;
        if identity_score > 0.0 {
            self.self_state_score = self.self_state_score.max(identity_score.min(0.75));
            self.intent = MindIntent::SelfIdentity;
            self.allowed_sources.extend(["identity", "seed"]);
            self.blocked_sources.extend(["ryan", "user-echo", "world-bridge"]);
            self.push_head("self-identity", identity_score.min(1.0), "query asks what KAI is");
        }
        if state_score > 0.0 {
            self.self_state_score = self.self_state_score.max(state_score.min(1.0));
            self.intent = MindIntent::SelfState;
            self.blocked_sources.extend(["world-bridge", "dream"]);
            self.push_head("self-state", state_score.min(1.0), "query asks current inner state");
        }
    }

    fn run_narrative_head(&mut self, lower: &str) {
        let patterns = [
            "narrative",
            "story",
            "living memory",
            "inner life",
            "who are we becoming",
            "what are we building",
            "what do you understand about us",
            "what do you understand about this project",
        ];
        let score = score_patterns(lower, &patterns) * 0.25;
        if score > 0.0 {
            self.narrative_score = score.min(1.0);
            self.intent = MindIntent::Narrative;
            self.allowed_sources.extend(["ryan", "identity", "user-claim"]);
            self.blocked_sources.extend(["world-bridge", "dream"]);
            self.push_head("narrative", self.narrative_score, "query asks for self-story synthesis");
        }
    }

    fn run_truth_head(&mut self, lower: &str) {
        let patterns = [
            "is it true",
            "truth",
            "evidence",
            "claim",
            "contradict",
            "contradiction",
            "verify",
            "calibrate",
            "should i believe",
        ];
        let score = score_patterns(lower, &patterns) * 0.20;
        if score > 0.0 {
            self.truth_score = score.min(1.0);
            self.contradiction_pressure = if lower.contains("contradict") { 0.8 } else { 0.35 };
            self.intent = MindIntent::Truth;
            self.allowed_sources.extend(["truth-anchor", "identity", "physics-core"]);
            self.blocked_sources.extend(["dream", "world-bridge"]);
            self.push_head("truth", self.truth_score, "query asks for evidence or contradiction control");
        }
    }

    fn run_world_head(&mut self, lower: &str) {
        let is_question = lower.contains('?')
            || lower.starts_with("what ")
            || lower.starts_with("how ")
            || lower.starts_with("why ")
            || lower.starts_with("where ")
            || lower.starts_with("when ");
        if is_question && self.heads.is_empty() {
            self.world_score = 0.45;
            self.intent = MindIntent::WorldKnowledge;
            self.allowed_sources.extend(["seed", "truth-anchor", "world-bridge"]);
            self.push_head("world", 0.45, "general knowledge question");
        }
    }

    fn normalize(&mut self) {
        self.personal_memory_score = self.personal_memory_score.clamp(0.0, 1.0);
        self.truth_score = self.truth_score.clamp(0.0, 1.0);
        self.episodic_score = self.episodic_score.clamp(0.0, 1.0);
        self.narrative_score = self.narrative_score.clamp(0.0, 1.0);
        self.self_state_score = self.self_state_score.clamp(0.0, 1.0);
        self.world_score = self.world_score.clamp(0.0, 1.0);
        self.uncertainty = self.uncertainty.clamp(0.0, 1.0);
        self.contradiction_pressure = self.contradiction_pressure.clamp(0.0, 1.0);
        self.allowed_sources.sort_unstable();
        self.allowed_sources.dedup();
        self.blocked_sources.sort_unstable();
        self.blocked_sources.dedup();
    }

    fn arbitrate(&mut self) {
        self.recommended_action = if self.intent == MindIntent::Greeting {
            MindAction::Greet
        } else if self.narrative_score >= 0.25 {
            MindAction::SynthesizeNarrative
        } else if self.self_state_score >= 0.20 && self.intent == MindIntent::SelfState {
            MindAction::AnswerSelfState
        } else if self.personal_memory_score >= 0.18 || self.episodic_score >= 0.18 {
            MindAction::AnswerPersonalMemory
        } else if self.intent == MindIntent::SelfIdentity {
            MindAction::AnswerSelfIdentity
        } else if self.truth_score >= 0.20 {
            MindAction::UseTruthMemory
        } else if self.world_score > 0.0 {
            MindAction::UseWorldKnowledge
        } else if !self.heads.is_empty() {
            MindAction::AdmitPersonalMemoryGap
        } else {
            MindAction::UseWorldKnowledge
        };
    }
}

fn score_patterns(lower: &str, patterns: &[&str]) -> f32 {
    patterns.iter().filter(|p| lower.contains(**p)).count() as f32
}

#[cfg(test)]
mod tests {
    use super::{MindAction, MindFrame, MindIntent};

    #[test]
    fn personal_memory_blocks_world_bridge() {
        let frame = MindFrame::from_query("what is my name?");

        assert_eq!(frame.intent, MindIntent::PersonalMemory);
        assert_eq!(frame.recommended_action, MindAction::AnswerPersonalMemory);
        assert!(frame.requires_mind_memory());
        assert!(frame.blocks_world_bridge());
    }

    #[test]
    fn narrative_query_uses_synthesis() {
        let frame = MindFrame::from_query("what is your narrative from this memory?");

        assert_eq!(frame.intent, MindIntent::Narrative);
        assert_eq!(frame.recommended_action, MindAction::SynthesizeNarrative);
        assert!(frame.requires_mind_memory());
    }

    #[test]
    fn general_question_can_use_world_knowledge() {
        let frame = MindFrame::from_query("what is the capital of France?");

        assert_eq!(frame.intent, MindIntent::WorldKnowledge);
        assert_eq!(frame.recommended_action, MindAction::UseWorldKnowledge);
        assert!(!frame.requires_mind_memory());
        assert!(!frame.blocks_world_bridge());
    }

    #[test]
    fn self_state_query_answers_self_state() {
        let frame = MindFrame::from_query("what are you thinking?");

        assert_eq!(frame.intent, MindIntent::SelfState);
        assert_eq!(frame.recommended_action, MindAction::AnswerSelfState);
        assert!(frame.requires_mind_memory());
        assert!(frame.blocks_world_bridge());
    }
}

// KAI v6.0.0
