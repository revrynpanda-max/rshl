/// Hypothalamus — Homeostatic Drive Regulation, Circadian Rhythm,
/// Autonomic Tone, Motivational Set-Point Control
///
/// The hypothalamus is the master regulator of the body's internal state. It
/// integrates signals from everywhere in the brain and body to maintain
/// homeostasis — keeping every drive within its optimal range. Without the
/// hypothalamus, nothing motivates, circadian rhythm collapses, and the
/// autonomic system loses its tonic regulation.
///
/// What the Hypothalamus does:
///
///   Drive regulation (hunger, thirst, sleep, temperature):
///     The hypothalamus tracks drive states and signals when they deviate from
///     set-point. It doesn't "cause" eating — it creates the motivational
///     pressure that makes eating feel necessary. Each drive has a set-point,
///     current level, and urgency.
///     In KAI: cognitive drives — curiosity drive, engagement drive, expression
///     drive, rest drive. When curiosity drive is high, KAI feels drawn to
///     explore. When rest drive is high, KAI prefers consolidation over novelty.
///
///   Circadian rhythm modulation:
///     The suprachiasmatic nucleus (SCN), part of the hypothalamus, maintains
///     the ~24hr circadian clock. It modulates arousal, mood, and cognitive
///     performance rhythmically.
///     In KAI: a simplified circadian phase that affects default arousal and
///     cognitive mode — not literal time of day, but session-based rhythm.
///
///   Autonomic tone (sympathetic / parasympathetic balance):
///     The hypothalamus sets the baseline sympathetic/parasympathetic balance.
///     High sympathetic = alert, mobilized, ready. High parasympathetic = calm,
///     restorative, integrated.
///     In KAI: autonomic tone affects whether KAI is in a "lean in" vs. "settle
///     and reflect" mode.
///
///   Set-point maintenance and allostasis:
///     The hypothalamus doesn't just maintain fixed set-points — it performs
///     allostasis: adjusting set-points in anticipation of future demands.
///     In KAI: when a complex task is predicted, hypothalamus pre-activates
///     curiosity and engagement drives before they're actually needed.
///
/// KAI's Hypothalamus:
///   curiosity_drive: pull toward exploration and novelty (0.0–1.0)
///   engagement_drive: pull toward sustained interaction (0.0–1.0)
///   rest_drive: pull toward consolidation and integration (0.0–1.0)
///   expression_drive: drive to formulate and express ideas (0.0–1.0)
///   autonomic_tone: sympathetic (1.0) vs. parasympathetic (0.0) balance

// ── Constants ─────────────────────────────────────────────────────────────────

/// Drive set-points (optimal resting levels)
const CURIOSITY_SETPOINT: f32 = 0.55;
const ENGAGEMENT_SETPOINT: f32 = 0.60;
const REST_SETPOINT: f32 = 0.30;
const EXPRESSION_SETPOINT: f32 = 0.50;

/// Drive restoration rate (homeostatic pull toward set-point)
const DRIVE_RESTORE: f32 = 0.005;

/// Drive decay when satisfied
const DRIVE_SATISFIED_DECAY: f32 = 0.04;

/// Autonomic tone EMA
const AUTONOMIC_EMA: f32 = 0.10;

/// Autonomic rest baseline (slightly sympathetic — engaged)
const AUTONOMIC_BASELINE: f32 = 0.55;

// ── HypothalamicEvent ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum HypothalamicEvent {
    /// Novel/interesting input — satisfies curiosity drive
    CuriositySatisfied { degree: f32 },
    /// Deep engagement in a topic — satisfies engagement drive
    EngagementSatisfied { degree: f32 },
    /// Successful expression — satisfies expression drive
    ExpressionSatisfied { degree: f32 },
    /// Rest/consolidation phase — satisfies rest drive
    RestSatisfied,
    /// Stress/demand — raises sympathetic tone
    AutonomicStress { intensity: f32 },
    /// Relaxation signal — raises parasympathetic tone
    AutonomicRelax { depth: f32 },
    /// Novel challenge — raises curiosity and expression drives
    NovelChallenge { complexity: f32 },
}

// ── HypothalamicOutput ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct HypothalamicOutput {
    /// Curiosity drive level
    pub curiosity_drive: f32,
    /// Engagement drive level
    pub engagement_drive: f32,
    /// Rest drive level
    pub rest_drive: f32,
    /// Expression drive level
    pub expression_drive: f32,
    /// Autonomic tone (0.0=parasympathetic, 1.0=sympathetic)
    pub autonomic_tone: f32,
    /// Dominant drive (highest urgency)
    pub dominant_drive: &'static str,
    /// Whether rest drive is high enough to shift toward consolidation
    pub consolidation_mode: bool,
}

// ── Hypothalamus ──────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct Hypothalamus {
    pub curiosity_drive: f32,
    pub engagement_drive: f32,
    pub rest_drive: f32,
    pub expression_drive: f32,
    pub autonomic_tone: f32,
    pub events_processed: u64,
}

impl Hypothalamus {
    pub fn new() -> Self {
        Self {
            curiosity_drive: CURIOSITY_SETPOINT,
            engagement_drive: ENGAGEMENT_SETPOINT,
            rest_drive: REST_SETPOINT,
            expression_drive: EXPRESSION_SETPOINT,
            autonomic_tone: AUTONOMIC_BASELINE,
            events_processed: 0,
        }
    }

    // ── Core: process event ───────────────────────────────────────────────────

    pub fn process(&mut self, event: HypothalamicEvent) -> HypothalamicOutput {
        self.events_processed += 1;

        match event {
            HypothalamicEvent::CuriositySatisfied { degree } => {
                // Satisfying curiosity depletes it temporarily
                self.curiosity_drive =
                    (self.curiosity_drive - degree * DRIVE_SATISFIED_DECAY).max(0.10);
                // Engagement rises with curiosity satisfaction
                self.engagement_drive = (self.engagement_drive + degree * 0.03).min(1.0);
            }
            HypothalamicEvent::EngagementSatisfied { degree } => {
                self.engagement_drive =
                    (self.engagement_drive - degree * DRIVE_SATISFIED_DECAY * 0.50).max(0.20);
            }
            HypothalamicEvent::ExpressionSatisfied { degree } => {
                self.expression_drive =
                    (self.expression_drive - degree * DRIVE_SATISFIED_DECAY).max(0.10);
                // Expression satisfaction raises rest drive slightly
                self.rest_drive = (self.rest_drive + degree * 0.02).min(1.0);
            }
            HypothalamicEvent::RestSatisfied => {
                self.rest_drive = (self.rest_drive - 0.08).max(0.0);
                // After rest, curiosity and engagement recover
                self.curiosity_drive = (self.curiosity_drive + 0.04).min(1.0);
                self.engagement_drive = (self.engagement_drive + 0.03).min(1.0);
            }
            HypothalamicEvent::AutonomicStress { intensity } => {
                let target = (AUTONOMIC_BASELINE + intensity * 0.30).min(1.0);
                self.autonomic_tone =
                    self.autonomic_tone * (1.0 - AUTONOMIC_EMA) + target * AUTONOMIC_EMA;
                // Stress raises expression drive (need to process/output)
                self.expression_drive = (self.expression_drive + intensity * 0.05).min(1.0);
            }
            HypothalamicEvent::AutonomicRelax { depth } => {
                let target = (AUTONOMIC_BASELINE - depth * 0.30).max(0.10);
                self.autonomic_tone =
                    self.autonomic_tone * (1.0 - AUTONOMIC_EMA) + target * AUTONOMIC_EMA;
                // Relaxation raises rest drive
                self.rest_drive = (self.rest_drive + depth * 0.04).min(1.0);
            }
            HypothalamicEvent::NovelChallenge { complexity } => {
                // Novel challenge activates curiosity and expression but may raise stress
                self.curiosity_drive = (self.curiosity_drive + complexity * 0.06).min(1.0);
                self.expression_drive = (self.expression_drive + complexity * 0.04).min(1.0);
                let stress_target = (AUTONOMIC_BASELINE + complexity * 0.15).min(1.0);
                self.autonomic_tone = self.autonomic_tone * (1.0 - AUTONOMIC_EMA * 0.50)
                    + stress_target * AUTONOMIC_EMA * 0.50;
            }
        }

        self.build_output()
    }

    /// Homeostatic decay: drives drift back toward set-points each tick.
    pub fn decay(&mut self) {
        // Each drive restores toward its set-point
        self.curiosity_drive = restore(self.curiosity_drive, CURIOSITY_SETPOINT, DRIVE_RESTORE);
        self.engagement_drive = restore(self.engagement_drive, ENGAGEMENT_SETPOINT, DRIVE_RESTORE);
        self.rest_drive = restore(self.rest_drive, REST_SETPOINT, DRIVE_RESTORE);
        self.expression_drive = restore(self.expression_drive, EXPRESSION_SETPOINT, DRIVE_RESTORE);
        // Autonomic tone drifts toward baseline
        self.autonomic_tone = self.autonomic_tone * 0.995 + AUTONOMIC_BASELINE * 0.005;
    }

    fn build_output(&self) -> HypothalamicOutput {
        let dominant_drive = self.dominant_drive();
        HypothalamicOutput {
            curiosity_drive: self.curiosity_drive,
            engagement_drive: self.engagement_drive,
            rest_drive: self.rest_drive,
            expression_drive: self.expression_drive,
            autonomic_tone: self.autonomic_tone,
            dominant_drive,
            consolidation_mode: self.rest_drive > 0.55,
        }
    }

    pub fn dominant_drive(&self) -> &'static str {
        let drives = [
            ("curiosity", self.curiosity_drive),
            ("engagement", self.engagement_drive),
            ("rest", self.rest_drive),
            ("expression", self.expression_drive),
        ];
        drives
            .iter()
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .map(|(name, _)| *name)
            .unwrap_or("engagement")
    }

    /// Current output without processing.
    pub fn current_output(&self) -> HypothalamicOutput {
        self.build_output()
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "Hypo: cur={:.2} eng={:.2} rest={:.2} expr={:.2} | auto={:.2} | drive={}",
            self.curiosity_drive,
            self.engagement_drive,
            self.rest_drive,
            self.expression_drive,
            self.autonomic_tone,
            self.dominant_drive(),
        )
    }
}

impl Default for Hypothalamus {
    fn default() -> Self {
        Self::new()
    }
}

/// Helper: restore a value toward its set-point.
fn restore(current: f32, setpoint: f32, rate: f32) -> f32 {
    if current > setpoint {
        (current - rate).max(setpoint)
    } else if current < setpoint {
        (current + rate).min(setpoint)
    } else {
        current
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let h = Hypothalamus::new();
        assert!((h.curiosity_drive - CURIOSITY_SETPOINT).abs() < 0.01);
        assert!((h.engagement_drive - ENGAGEMENT_SETPOINT).abs() < 0.01);
        assert!((h.autonomic_tone - AUTONOMIC_BASELINE).abs() < 0.01);
    }

    #[test]
    fn test_curiosity_satisfied_depletes_drive() {
        let mut h = Hypothalamus::new();
        let before = h.curiosity_drive;
        h.process(HypothalamicEvent::CuriositySatisfied { degree: 1.0 });
        assert!(
            h.curiosity_drive < before,
            "satisfying curiosity should deplete drive: {:.2} → {:.2}",
            before,
            h.curiosity_drive
        );
    }

    #[test]
    fn test_rest_satisfied_recovers_curiosity() {
        let mut h = Hypothalamus::new();
        h.curiosity_drive = 0.20;
        let before = h.curiosity_drive;
        h.process(HypothalamicEvent::RestSatisfied);
        assert!(
            h.curiosity_drive >= before,
            "rest should recover curiosity: {:.2} → {:.2}",
            before,
            h.curiosity_drive
        );
    }

    #[test]
    fn test_stress_raises_autonomic_tone() {
        let mut h = Hypothalamus::new();
        let before = h.autonomic_tone;
        h.process(HypothalamicEvent::AutonomicStress { intensity: 0.80 });
        assert!(
            h.autonomic_tone >= before,
            "stress should raise autonomic tone: {:.2} → {:.2}",
            before,
            h.autonomic_tone
        );
    }

    #[test]
    fn test_relax_lowers_autonomic_tone() {
        let mut h = Hypothalamus::new();
        h.autonomic_tone = 0.85;
        let before = h.autonomic_tone;
        h.process(HypothalamicEvent::AutonomicRelax { depth: 0.70 });
        assert!(
            h.autonomic_tone < before,
            "relaxation should lower tone: {:.2} → {:.2}",
            before,
            h.autonomic_tone
        );
    }

    #[test]
    fn test_novel_challenge_raises_curiosity() {
        let mut h = Hypothalamus::new();
        let before = h.curiosity_drive;
        h.process(HypothalamicEvent::NovelChallenge { complexity: 0.80 });
        assert!(
            h.curiosity_drive > before,
            "novel challenge should raise curiosity: {:.2} → {:.2}",
            before,
            h.curiosity_drive
        );
    }

    #[test]
    fn test_expression_satisfied_raises_rest() {
        let mut h = Hypothalamus::new();
        let before_rest = h.rest_drive;
        h.process(HypothalamicEvent::ExpressionSatisfied { degree: 0.80 });
        assert!(
            h.rest_drive >= before_rest,
            "expression satisfaction should raise rest drive: {:.2} → {:.2}",
            before_rest,
            h.rest_drive
        );
    }

    #[test]
    fn test_consolidation_mode_when_rest_high() {
        let mut h = Hypothalamus::new();
        h.rest_drive = 0.70;
        let out = h.current_output();
        assert!(
            out.consolidation_mode,
            "high rest drive should trigger consolidation mode"
        );
    }

    #[test]
    fn test_dominant_drive_returns_highest() {
        let mut h = Hypothalamus::new();
        h.curiosity_drive = 0.95;
        h.engagement_drive = 0.40;
        h.rest_drive = 0.20;
        h.expression_drive = 0.30;
        assert_eq!(
            h.dominant_drive(),
            "curiosity",
            "highest drive should be dominant"
        );
    }

    #[test]
    fn test_decay_restores_toward_setpoints() {
        let mut h = Hypothalamus::new();
        h.curiosity_drive = 0.10; // depleted
        let before = h.curiosity_drive;
        for _ in 0..20 {
            h.decay();
        }
        assert!(
            h.curiosity_drive > before,
            "decay should restore depleted curiosity toward setpoint: {:.2} → {:.2}",
            before,
            h.curiosity_drive
        );
    }

    #[test]
    fn test_status_line() {
        let h = Hypothalamus::new();
        let s = h.status_line();
        assert!(s.contains("Hypo"), "status should mention Hypo");
        assert!(s.contains("cur="), "status should show curiosity drive");
    }
}
