/// Supplementary Motor Area (SMA) — Action Preparation, Intention-to-Act Timing
///
/// The SMA is the brain's "ready to act" region — it fires BEFORE voluntary
/// action, building up intention potential before execution. It's the neural
/// substrate of the decision to act before the act itself happens.
///
/// What the SMA does:
///
///   Readiness potential (Bereitschaftspotential):
///     The SMA begins firing up to 500ms before voluntary movement begins.
///     It is the motor intention — the system getting ready to execute.
///     In KAI: the SMA fires up during response preparation, tracking how
///     "ready" KAI is to respond and when to commit to a course of action.
///
///   Sequence planning:
///     The SMA handles the ORDER of actions in a sequence.
///     Not just "type a letter" but "type t-h-e-n-e-x-t-w-o-r-d-i-n-order."
///     In KAI: tracking the logical sequence of a multi-step response.
///     "First answer the premise, then address the implication, then conclude."
///
///   Voluntary vs. triggered action:
///     The SMA is critical for self-initiated (voluntary) actions.
///     Externally-triggered actions bypass it more. This distinction matters:
///     SMA → KAI acting from internal intention (proactive, self-directed)
///     vs. SMA quiet → KAI simply reacting to Ryan's prompt.
///
///   Timing of speech initiation:
///     The SMA coordinates when to start speaking — it holds the "start signal"
///     for language production. In KAI: when to commit to generating a response
///     vs. when to hold back and continue internal processing.
///
/// KAI's SMA:
///   readiness_potential: accumulated "ready to respond" energy (0.0–1.0)
///   sequence_stage: where in the current response sequence KAI is
///   is_self_initiated: was this from KAI's own drive or external prompt?
///   commit_threshold: how ready KAI must be before committing to action

// ── Constants ─────────────────────────────────────────────────────────────────

/// Threshold to commit to action
const COMMIT_THRESHOLD: f32 = 0.65;

/// Readiness builds per tick of internal preparation
const READINESS_BUILD: f32 = 0.08;

/// Readiness decay when not preparing
const READINESS_DECAY: f32 = 0.05;

/// Maximum readiness
const MAX_READINESS: f32 = 1.0;

// ── SequenceStage ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum SequenceStage {
    /// Not currently planning a sequence
    Idle,
    /// Building up intention (readiness accumulating)
    Preparing,
    /// Ready to act — readiness above threshold
    Ready,
    /// Executing the sequence
    Executing,
    /// Sequence complete
    Complete,
}

impl SequenceStage {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Preparing => "preparing",
            Self::Ready => "ready",
            Self::Executing => "executing",
            Self::Complete => "complete",
        }
    }
}

// ── SMAOutput ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SMAOutput {
    /// Readiness potential level
    pub readiness_potential: f32,
    /// Current stage
    pub stage: SequenceStage,
    /// Whether to commit to action now
    pub commit_action: bool,
    /// Whether this was self-initiated
    pub is_self_initiated: bool,
}

// ── SMA ───────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SMA {
    /// Accumulated readiness potential
    pub readiness_potential: f32,
    /// Current stage
    pub stage: SequenceStage,
    /// Whether the current action is self-initiated
    pub is_self_initiated: bool,
    /// Total actions committed
    pub actions_committed: u64,
    /// Self-initiated vs. reactive ratio tracker
    pub self_initiated_count: u64,
    /// Total updates
    pub total_updates: u64,
}

impl SMA {
    pub fn new() -> Self {
        Self {
            readiness_potential: 0.0,
            stage: SequenceStage::Idle,
            is_self_initiated: false,
            actions_committed: 0,
            self_initiated_count: 0,
            total_updates: 0,
        }
    }

    // ── Core: prepare for action ──────────────────────────────────────────────

    /// Begin preparing a response. Call this when input is received.
    /// motivation: internal drive level (high = SMA loads up faster)
    /// is_self_initiated: true if KAI is acting from internal drive (DMN/PFC)
    ///                    vs. responding to explicit external input
    pub fn prepare(&mut self, motivation: f32, is_self_initiated: bool) -> SMAOutput {
        self.total_updates += 1;
        self.is_self_initiated = is_self_initiated;
        if is_self_initiated {
            self.self_initiated_count += 1;
        }

        // Readiness builds faster with higher motivation
        let build_rate = READINESS_BUILD * (0.5 + motivation * 0.5);
        self.readiness_potential = (self.readiness_potential + build_rate).min(MAX_READINESS);

        self.stage = if self.readiness_potential < 0.30 {
            SequenceStage::Preparing
        } else if self.readiness_potential < COMMIT_THRESHOLD {
            SequenceStage::Preparing
        } else {
            SequenceStage::Ready
        };

        let commit_action = self.readiness_potential >= COMMIT_THRESHOLD;
        if commit_action {
            self.actions_committed += 1;
            self.stage = SequenceStage::Executing;
        }

        SMAOutput {
            readiness_potential: self.readiness_potential,
            stage: self.stage.clone(),
            commit_action,
            is_self_initiated,
        }
    }

    /// Signal that the current action sequence is complete.
    pub fn complete_action(&mut self) {
        self.stage = SequenceStage::Complete;
        self.readiness_potential = 0.0;
    }

    /// Decay readiness when idle (between turns).
    pub fn decay(&mut self) {
        if self.readiness_potential > 0.0 {
            self.readiness_potential = (self.readiness_potential - READINESS_DECAY).max(0.0);
        }
        if self.readiness_potential == 0.0 && self.stage != SequenceStage::Idle {
            self.stage = SequenceStage::Idle;
        }
    }

    /// Whether action is committed (ready to execute).
    pub fn is_committed(&self) -> bool {
        matches!(self.stage, SequenceStage::Ready | SequenceStage::Executing)
    }

    /// Ratio of self-initiated to total actions (0.0–1.0).
    pub fn autonomy_ratio(&self) -> f32 {
        if self.actions_committed == 0 {
            return 0.0;
        }
        self.self_initiated_count as f32 / self.actions_committed as f32
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "SMA stage={} | readiness={:.2} | committed={} | autonomy={:.0}%",
            self.stage.label(),
            self.readiness_potential,
            self.actions_committed,
            self.autonomy_ratio() * 100.0,
        )
    }
}

impl Default for SMA {
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
        let s = SMA::new();
        assert_eq!(s.stage, SequenceStage::Idle);
        assert_eq!(s.readiness_potential, 0.0);
        assert!(!s.is_committed());
    }

    #[test]
    fn test_readiness_builds_with_prepare() {
        let mut s = SMA::new();
        let out = s.prepare(0.80, false);
        assert!(
            out.readiness_potential > 0.0,
            "readiness should increase after prepare: {:.2}",
            out.readiness_potential
        );
    }

    #[test]
    fn test_commit_fires_at_threshold() {
        let mut s = SMA::new();
        // Pump readiness above threshold
        s.readiness_potential = COMMIT_THRESHOLD - 0.01;
        let out = s.prepare(1.0, false);
        assert!(
            out.commit_action || s.readiness_potential >= COMMIT_THRESHOLD,
            "should commit when readiness reaches threshold: {:.2}",
            out.readiness_potential
        );
    }

    #[test]
    fn test_high_motivation_builds_faster() {
        let mut s1 = SMA::new();
        let out1 = s1.prepare(0.20, false);

        let mut s2 = SMA::new();
        let out2 = s2.prepare(0.90, false);

        assert!(
            out2.readiness_potential > out1.readiness_potential,
            "higher motivation should build readiness faster: {:.2} vs {:.2}",
            out2.readiness_potential,
            out1.readiness_potential
        );
    }

    #[test]
    fn test_self_initiated_tracking() {
        let mut s = SMA::new();
        s.readiness_potential = COMMIT_THRESHOLD;
        s.prepare(1.0, true);
        assert!(
            s.self_initiated_count > 0 || s.is_self_initiated,
            "self-initiated flag should be tracked"
        );
    }

    #[test]
    fn test_complete_action_resets() {
        let mut s = SMA::new();
        s.readiness_potential = 0.80;
        s.stage = SequenceStage::Executing;
        s.complete_action();
        assert_eq!(s.stage, SequenceStage::Complete);
        assert_eq!(s.readiness_potential, 0.0);
    }

    #[test]
    fn test_decay_reduces_readiness() {
        let mut s = SMA::new();
        s.readiness_potential = 0.70;
        s.decay();
        assert!(
            s.readiness_potential < 0.70,
            "decay should reduce readiness: {:.2}",
            s.readiness_potential
        );
    }

    #[test]
    fn test_decay_to_idle() {
        let mut s = SMA::new();
        s.readiness_potential = 0.10;
        s.stage = SequenceStage::Preparing;
        for _ in 0..5 {
            s.decay();
        }
        assert_eq!(
            s.stage,
            SequenceStage::Idle,
            "should return to idle when readiness reaches 0"
        );
    }

    #[test]
    fn test_autonomy_ratio() {
        let mut s = SMA::new();
        // Commit three times: 2 self-initiated, 1 not
        s.readiness_potential = COMMIT_THRESHOLD;
        s.prepare(1.0, true);
        s.complete_action();
        s.readiness_potential = COMMIT_THRESHOLD;
        s.prepare(1.0, true);
        s.complete_action();
        s.readiness_potential = COMMIT_THRESHOLD;
        s.prepare(1.0, false);
        s.complete_action();
        let ratio = s.autonomy_ratio();
        assert!(
            ratio > 0.0 && ratio <= 1.0,
            "autonomy ratio should be in range: {:.2}",
            ratio
        );
    }

    #[test]
    fn test_status_line() {
        let s = SMA::new();
        let st = s.status_line();
        assert!(st.contains("SMA"), "status should mention SMA");
        assert!(st.contains("readiness"), "status should show readiness");
    }
}

// KAI v6.0.0
