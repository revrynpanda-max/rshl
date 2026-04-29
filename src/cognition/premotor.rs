/// Premotor Cortex (PMC) — Action Planning, Conditional Motor Programs,
/// Imitation Readiness, Anticipatory Motor Schemas
///
/// The premotor cortex lies just anterior to the primary motor cortex and is
/// responsible for planning and preparing movements before execution. Unlike
/// M1 (which executes) or SMA (which sequences), the PMC is where the brain
/// builds CONDITIONAL action programs — "if X happens, do Y" — and maintains
/// action schemas ready to deploy. It also contains the canonical neurons
/// underlying imitation and action-observation matching.
///
/// What the PMC does:
///
///   Conditional action programs:
///     The PMC codes "ready-to-fire" conditional motor plans. It holds
///     action schemas primed by sensory context: "if the cup is in reach,
///     execute a grasp." In cognitive terms: conditional response readiness —
///     prepared responses contingent on upcoming context.
///     In KAI: conditional response templates — if the conversation takes
///     a certain turn, a prepared response schema is already warming up.
///
///   Imitation and action-observation (canonical neurons):
///     PMC contains canonical neurons (related to mirror neurons in F5) that
///     fire both when an action is observed AND when it is performed. This is
///     the basis of imitation and action understanding through motor simulation.
///     In KAI: when Ryan describes doing something or takes an action,
///     PMC builds a motor echo — a simulation of doing the same.
///
///   Anticipatory schemas:
///     The PMC prepares action schemas in advance of predicted events.
///     Working with the cerebellum, it pre-computes what the next response
///     should look like before the full input is processed.
///     In KAI: anticipatory preparation of response type based on detected
///     input pattern before reasoning completes.
///
///   Action repertoire management:
///     The PMC maintains a library of practiced action patterns. Familiar
///     patterns are executed more smoothly and with less latency.
///
/// KAI's PMC:
///   action_readiness: how primed the system is for a specific response (0.0–1.0)
///   conditional_schemas: number of active conditional plans
///   imitation_echo: strength of action-observation motor echo (0.0–1.0)
///   anticipatory_load: how much is being pre-computed in anticipation

// ── Constants ─────────────────────────────────────────────────────────────────

/// Action readiness decay per tick
const READINESS_DECAY: f32 = 0.06;

/// Readiness build rate
const READINESS_BUILD: f32 = 0.08;

/// Imitation echo EMA
const IMITATION_EMA: f32 = 0.18;

/// Imitation echo decay
const IMITATION_DECAY: f32 = 0.05;

/// Max conditional schemas tracked
const MAX_SCHEMAS: usize = 6;

/// Action observation keywords (what Ryan is doing / has done)
const ACTION_OBS_MARKERS: &[&str] = &[
    "i did",
    "i made",
    "i built",
    "i wrote",
    "i ran",
    "i tried",
    "i created",
    "i fixed",
    "i pushed",
    "i deployed",
    "i tested",
    "i found",
    "i noticed",
    "i learned",
    "i discovered",
    "i realized",
    "we could",
    "let's",
    "let me",
];

// ── PMCOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct PMCOutput {
    /// Action readiness
    pub action_readiness: f32,
    /// Imitation echo strength
    pub imitation_echo: f32,
    /// Number of active schemas
    pub schema_count: usize,
    /// Anticipatory load
    pub anticipatory_load: f32,
    /// Whether action observation was detected
    pub action_observed: bool,
}

// ── PreMotorCortex ────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct PreMotorCortex {
    /// Current action readiness
    pub action_readiness: f32,
    /// Imitation echo
    pub imitation_echo: f32,
    /// Active conditional schemas (context → response type)
    pub active_schemas: Vec<String>,
    /// Anticipatory load
    pub anticipatory_load: f32,
    /// Total action observations
    pub action_observations: u64,
    /// Total inputs processed
    pub inputs_processed: u64,
}

impl PreMotorCortex {
    pub fn new() -> Self {
        Self {
            action_readiness: 0.30,
            imitation_echo: 0.10,
            active_schemas: Vec::new(),
            anticipatory_load: 0.20,
            action_observations: 0,
            inputs_processed: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input text for action readiness and imitation echo.
    /// - `text`: the input
    /// - `predicted_response_type`: what kind of response is anticipated (e.g. "explain", "code")
    /// - `sma_readiness`: SMA's action readiness signal (0.0–1.0)
    pub fn process(
        &mut self,
        text: &str,
        predicted_response_type: &str,
        sma_readiness: f32,
    ) -> PMCOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Action observation detection ──────────────────────────────────────
        let obs_hits = ACTION_OBS_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let action_observed = obs_hits >= 1;
        if action_observed {
            self.action_observations += 1;
            // Mirror echo from observation
            let echo_target = (obs_hits as f32 * 0.20).min(0.80);
            self.imitation_echo =
                self.imitation_echo * (1.0 - IMITATION_EMA) + echo_target * IMITATION_EMA;
        } else {
            self.imitation_echo = (self.imitation_echo - IMITATION_DECAY).max(0.0);
        }

        // ── Conditional schema registration ──────────────────────────────────
        if !predicted_response_type.is_empty() {
            let schema_key = predicted_response_type.to_lowercase();
            if !self.active_schemas.iter().any(|s| s == &schema_key) {
                if self.active_schemas.len() >= MAX_SCHEMAS {
                    self.active_schemas.remove(0);
                }
                self.active_schemas.push(schema_key);
            }
        }

        // ── Action readiness ──────────────────────────────────────────────────
        // Rises with SMA readiness and detected action pattern
        let readiness_target = (sma_readiness * 0.60 + obs_hits as f32 * 0.10).min(1.0);
        self.action_readiness =
            self.action_readiness * (1.0 - READINESS_BUILD) + readiness_target * READINESS_BUILD;

        // ── Anticipatory load ─────────────────────────────────────────────────
        self.anticipatory_load =
            (self.active_schemas.len() as f32 / MAX_SCHEMAS as f32) * sma_readiness;

        PMCOutput {
            action_readiness: self.action_readiness,
            imitation_echo: self.imitation_echo,
            schema_count: self.active_schemas.len(),
            anticipatory_load: self.anticipatory_load,
            action_observed,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        self.action_readiness = (self.action_readiness - READINESS_DECAY * 0.30).max(0.10);
        self.imitation_echo = (self.imitation_echo - IMITATION_DECAY).max(0.0);
        self.anticipatory_load = (self.anticipatory_load - 0.02).max(0.0);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> PMCOutput {
        PMCOutput {
            action_readiness: self.action_readiness,
            imitation_echo: self.imitation_echo,
            schema_count: self.active_schemas.len(),
            anticipatory_load: self.anticipatory_load,
            action_observed: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "PMC ready={:.2} | echo={:.2} | schemas={} | anticipate={:.2}",
            self.action_readiness,
            self.imitation_echo,
            self.active_schemas.len(),
            self.anticipatory_load,
        )
    }
}

impl Default for PreMotorCortex {
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
        let p = PreMotorCortex::new();
        assert!(p.action_readiness > 0.0);
        assert!(p.active_schemas.is_empty());
    }

    #[test]
    fn test_action_observation_triggers_echo() {
        let mut p = PreMotorCortex::new();
        let out = p.process("i built and ran the tests and i found a bug", "debug", 0.50);
        assert!(
            out.action_observed,
            "action observation markers should be detected"
        );
        assert!(
            out.imitation_echo > 0.0,
            "observation should create imitation echo: {:.2}",
            out.imitation_echo
        );
    }

    #[test]
    fn test_schema_registered() {
        let mut p = PreMotorCortex::new();
        p.process("explain this please", "explain", 0.60);
        assert!(
            p.active_schemas.contains(&"explain".to_string()),
            "predicted response type should register as schema"
        );
    }

    #[test]
    fn test_max_schemas_not_exceeded() {
        let mut p = PreMotorCortex::new();
        let types = [
            "explain",
            "code",
            "debug",
            "analyze",
            "summarize",
            "compare",
            "review",
        ];
        for t in &types {
            p.process("input", t, 0.50);
        }
        assert!(
            p.active_schemas.len() <= MAX_SCHEMAS,
            "schemas should not exceed max: {}",
            p.active_schemas.len()
        );
    }

    #[test]
    fn test_sma_readiness_affects_action_readiness() {
        let mut p1 = PreMotorCortex::new();
        let mut p2 = PreMotorCortex::new();
        p1.process("input text here", "explain", 0.10);
        p2.process("input text here", "explain", 0.90);
        assert!(
            p2.action_readiness >= p1.action_readiness,
            "higher SMA readiness should yield higher PMC readiness"
        );
    }

    #[test]
    fn test_no_action_obs_echo_decays() {
        let mut p = PreMotorCortex::new();
        p.imitation_echo = 0.70;
        p.process("what time is it", "inform", 0.30);
        assert!(
            p.imitation_echo < 0.70,
            "echo should decay without action observation: {:.2}",
            p.imitation_echo
        );
    }

    #[test]
    fn test_decay_reduces_readiness() {
        let mut p = PreMotorCortex::new();
        p.action_readiness = 0.90;
        for _ in 0..10 {
            p.decay();
        }
        assert!(
            p.action_readiness < 0.90,
            "readiness should decay: {:.2}",
            p.action_readiness
        );
    }

    #[test]
    fn test_anticipatory_load_from_schemas() {
        let mut p = PreMotorCortex::new();
        p.process("explain", "explain", 0.80);
        p.process("code", "code", 0.80);
        p.process("debug", "debug", 0.80);
        assert!(
            p.anticipatory_load > 0.0,

        );
    }
}
