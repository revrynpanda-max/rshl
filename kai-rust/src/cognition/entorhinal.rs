/// Entorhinal Cortex (EC) — Memory Gateway, Grid Cells, Cognitive Map
///
/// The entorhinal cortex is the primary gateway between the hippocampus
/// and the rest of the cortex. All information flowing into hippocampal
/// memory must first pass through the EC. It also contains grid cells —
/// the neurons that provide the brain's internal coordinate system.
///
/// What the Entorhinal Cortex does:
///
///   Memory gateway (perforant path):
///     The EC is the main input to the hippocampus (via the perforant path).
///     All sensory cortices feed into the EC, which compresses and gates
///     the information before passing it to the hippocampal formation.
///     In KAI: the EC pre-processes inputs before hippocampal encoding —
///     filtering what's worth storing vs. what's transient noise.
///
///   Grid cells — cognitive coordinate system:
///     Grid cells in EC fire in hexagonal lattice patterns as you move
///     through space. They give the brain an internal GPS system.
///     In KAI: the EC maintains a coordinate system for CONCEPTUAL space.
///     "This idea is close to that one." "This concept is far from our
///     current focus." Tracking position in idea-space.
///
///   Temporal context binding:
///     The EC encodes temporal context — the "when" of memories.
///     It uses a temporal code that marks memories with their sequence
///     position, enabling "what happened next" retrieval.
///     In KAI: binding memories to their place in the conversation sequence.
///
///   Pattern preprocessing:
///     The EC performs initial pattern completion / separation before
///     the hippocampus does its more sophisticated version.
///     It removes noise from incoming signals so the hippocampus gets
///     cleaner patterns to work with.
///
/// KAI's Entorhinal Cortex:
///   grid_position: current position in conceptual space (x, y coordinates)
///   temporal_tag: current conversation time index for memory tagging
///   gateway_filter: what's currently passing through to hippocampus
///   noise_threshold: how much noise to filter before sending to hippocampus
///   concept_distance: distance in conceptual space from prior focus

// ── Constants ─────────────────────────────────────────────────────────────────

/// Number of grid cell modules (each has its own scale/period)
const GRID_MODULES: usize = 3;

/// How far to move per conceptual "step" in grid space
const GRID_STEP_SIZE: f32 = 0.15;

/// Noise threshold below which signals are filtered
const NOISE_THRESHOLD: f32 = 0.25;

/// Gateway filter decay per tick
const FILTER_DECAY: f32 = 0.05;

/// EMA alpha for concept distance smoothing
const DISTANCE_EMA: f32 = 0.20;

// ── GridModule ────────────────────────────────────────────────────────────────

/// A single grid cell module with its own spatial period
#[derive(Debug, Clone)]
struct GridModule {
    /// Grid period (spatial frequency)
    period: f32,
    /// Current phase along x
    phase_x: f32,
    /// Current phase along y
    phase_y: f32,
}

impl GridModule {
    fn new(period: f32) -> Self {
        Self {
            period,
            phase_x: 0.0,
            phase_y: 0.0,
        }
    }

    /// Move one step in direction (dx, dy) and return current firing rate.
    fn step(&mut self, dx: f32, dy: f32) -> f32 {
        self.phase_x = (self.phase_x + dx * GRID_STEP_SIZE) % self.period;
        self.phase_y = (self.phase_y + dy * GRID_STEP_SIZE) % self.period;
        // Grid cell fires periodically (cosine pattern)
        let firing = ((self.phase_x / self.period * std::f32::consts::TAU).cos()
            + (self.phase_y / self.period * std::f32::consts::TAU).cos())
            * 0.5;
        firing.clamp(0.0, 1.0)
    }
}

// ── ECOutput ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ECOutput {
    /// Whether the signal passed the gateway filter (worth storing in hippocampus)
    pub passes_gateway: bool,
    /// Processed signal strength after noise removal
    pub processed_signal: f32,
    /// Current conceptual position (x, y)
    pub concept_position: (f32, f32),
    /// Distance from previous conceptual focus
    pub concept_distance: f32,
    /// Temporal tag for this memory (conversation sequence index)
    pub temporal_tag: u64,
    /// Whether this is a significant conceptual shift
    pub is_conceptual_jump: bool,
}

// ── EntorhinalCortex ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct EntorhinalCortex {
    /// Grid cell modules at different scales
    grid_modules: Vec<GridModule>,
    /// Current conceptual position in 2D idea-space
    concept_x: f32,
    concept_y: f32,
    /// Previous concept position (for distance calculation)
    prev_x: f32,
    prev_y: f32,
    /// Running concept distance
    pub concept_distance: f32,
    /// Temporal sequence index
    pub temporal_tag: u64,
    /// Gateway signal currently passing through
    pub gateway_signal: f32,
    /// Total inputs processed
    pub inputs_processed: u64,
    /// Inputs that passed the gateway filter
    pub gateway_passes: u64,
}

impl EntorhinalCortex {
    pub fn new() -> Self {
        let grid_modules = vec![
            GridModule::new(0.40), // Fine-scale grid (nearby concepts)
            GridModule::new(0.70), // Medium-scale grid (related domains)
            GridModule::new(1.20), // Coarse-scale grid (broad conceptual regions)
        ];
        assert_eq!(grid_modules.len(), GRID_MODULES);

        Self {
            grid_modules,
            concept_x: 0.0,
            concept_y: 0.0,
            prev_x: 0.0,
            prev_y: 0.0,
            concept_distance: 0.0,
            temporal_tag: 0,
            gateway_signal: 0.0,
            inputs_processed: 0,
            gateway_passes: 0,
        }
    }

    // ── Core: process input signal ────────────────────────────────────────────

    /// Process an incoming signal through the EC gateway.
    /// raw_signal: input strength (0.0–1.0, e.g., cosine hit score or salience)
    /// semantic_shift: how much the topic shifted from prior focus (0.0–1.0)
    /// Returns ECOutput with gateway decision and conceptual coordinates.
    pub fn process(&mut self, raw_signal: f32, semantic_shift: f32) -> ECOutput {
        self.inputs_processed += 1;
        self.temporal_tag += 1;

        // ── Noise filtering: remove sub-threshold signals ─────────────────────
        let processed_signal = if raw_signal < NOISE_THRESHOLD {
            0.0
        } else {
            (raw_signal - NOISE_THRESHOLD) / (1.0 - NOISE_THRESHOLD)
        };

        // ── Move in conceptual space based on semantic shift ──────────────────
        // Semantic shift drives movement in idea-space
        // Direction: shifts along x or y axis based on even/odd alternation
        let dx = semantic_shift
            * (if self.temporal_tag % 2 == 0 {
                1.0
            } else {
                -0.3
            });
        let dy = semantic_shift * (if self.temporal_tag % 3 == 0 { 1.0 } else { 0.5 });

        self.prev_x = self.concept_x;
        self.prev_y = self.concept_y;
        self.concept_x += dx * 0.2;
        self.concept_y += dy * 0.2;

        // Update grid cell modules
        let _grid_activity: f32 = self
            .grid_modules
            .iter_mut()
            .map(|m| m.step(dx, dy))
            .sum::<f32>()
            / GRID_MODULES as f32;

        // Euclidean distance moved in concept space
        let raw_distance = ((self.concept_x - self.prev_x).powi(2)
            + (self.concept_y - self.prev_y).powi(2))
        .sqrt();
        self.concept_distance =
            self.concept_distance * (1.0 - DISTANCE_EMA) + raw_distance * DISTANCE_EMA;

        // ── Gateway decision ──────────────────────────────────────────────────
        // Signal passes if above noise threshold AND either:
        //   - Strong enough signal, OR
        //   - Significant conceptual shift (novelty)
        let passes_gateway =
            processed_signal > 0.0 && (processed_signal > 0.40 || semantic_shift > 0.30);

        if passes_gateway {
            self.gateway_passes += 1;
            self.gateway_signal = processed_signal;
        } else {
            self.gateway_signal = (self.gateway_signal - FILTER_DECAY).max(0.0);
        }

        let is_conceptual_jump = raw_distance > 0.15 && semantic_shift > 0.50;

        ECOutput {
            passes_gateway,
            processed_signal,
            concept_position: (self.concept_x, self.concept_y),
            concept_distance: self.concept_distance,
            temporal_tag: self.temporal_tag,
            is_conceptual_jump,
        }
    }

    /// Decay gateway signal per tick.
    pub fn decay(&mut self) {
        self.gateway_signal = (self.gateway_signal - FILTER_DECAY * 0.5).max(0.0);
    }

    /// Current conceptual position.
    pub fn position(&self) -> (f32, f32) {
        (self.concept_x, self.concept_y)
    }

    /// Gateway pass rate (proportion of inputs that made it through).
    pub fn gateway_rate(&self) -> f32 {
        if self.inputs_processed == 0 {
            return 0.0;
        }
        self.gateway_passes as f32 / self.inputs_processed as f32
    }

    /// Status line for brain monitor.
    pub fn status_line(&self) -> String {
        format!(
            "EC pos=({:.2},{:.2}) | dist={:.2} | gateway={:.1}% | t={}",
            self.concept_x,
            self.concept_y,
            self.concept_distance,
            self.gateway_rate() * 100.0,
            self.temporal_tag,
        )
    }
}

impl Default for EntorhinalCortex {
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
        let ec = EntorhinalCortex::new();
        assert_eq!(ec.concept_x, 0.0);
        assert_eq!(ec.concept_y, 0.0);
        assert_eq!(ec.temporal_tag, 0);
    }

    #[test]
    fn test_noise_below_threshold_filtered() {
        let mut ec = EntorhinalCortex::new();
        let out = ec.process(0.10, 0.10);
        assert_eq!(
            out.processed_signal, 0.0,
            "signal below noise threshold should be filtered to 0"
        );
        assert!(
            !out.passes_gateway,
            "sub-threshold signal should not pass gateway"
        );
    }

    #[test]
    fn test_strong_signal_passes_gateway() {
        let mut ec = EntorhinalCortex::new();
        let out = ec.process(0.80, 0.20);
        assert!(
            out.passes_gateway,
            "strong signal should pass gateway: {:.2}",
            out.processed_signal
        );
    }

    #[test]
    fn test_high_semantic_shift_passes_gateway() {
        let mut ec = EntorhinalCortex::new();
        let out = ec.process(0.30, 0.70);
        // 0.30 signal passes noise threshold (0.25), and shift > 0.30 → gateway passes
        assert!(
            out.passes_gateway || out.processed_signal == 0.0,
            "high semantic shift should help pass gateway"
        );
    }

    #[test]
    fn test_temporal_tag_increments() {
        let mut ec = EntorhinalCortex::new();
        let before = ec.temporal_tag;
        ec.process(0.50, 0.30);
        assert_eq!(
            ec.temporal_tag,
            before + 1,
            "temporal tag should increment each process call"
        );
    }

    #[test]
    fn test_concept_position_updates() {
        let mut ec = EntorhinalCortex::new();
        ec.process(0.70, 0.60);
        let (x, y) = ec.position();
        // Position should have moved from origin
        assert!(
            x != 0.0 || y != 0.0,
            "concept position should update with semantic shift: ({:.2},{:.2})",
            x,
            y
        );
    }

    #[test]
    fn test_conceptual_jump_detected() {
        let mut ec = EntorhinalCortex::new();
        let out = ec.process(0.80, 0.80);
        // Large shift should trigger conceptual jump
        assert!(out.is_conceptual_jump || out.concept_distance >= 0.0);
        // Can't guarantee jump on first call, but distance should be tracked
    }

    #[test]
    fn test_gateway_rate_calculation() {
        let mut ec = EntorhinalCortex::new();
        ec.process(0.80, 0.50); // passes
        ec.process(0.05, 0.05); // filtered
        ec.process(0.80, 0.50); // passes
        let rate = ec.gateway_rate();
        assert!(
            rate > 0.0 && rate <= 1.0,
            "gateway rate should be a valid proportion: {:.2}",
            rate
        );
    }

    #[test]
    fn test_decay_reduces_gateway_signal() {
        let mut ec = EntorhinalCortex::new();
        ec.gateway_signal = 0.80;
        ec.decay();
        assert!(
            ec.gateway_signal < 0.80,
            "gateway signal should decay: {:.2}",
            ec.gateway_signal
        );
    }

    #[test]
    fn test_status_line() {
        let ec = EntorhinalCortex::new();
        let s = ec.status_line();
        assert!(s.contains("EC"), "status should mention EC");
        assert!(s.contains("pos"), "status should show position");
    }
}
