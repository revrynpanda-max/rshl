//! Cerebellum — KAI's timing, precision, and error-correction engine
//!
//! The cerebellum is often described as the "little brain" — it contains
//! more neurons than the rest of the brain combined, yet most people
//! think of it only as controlling balance and motor coordination.
//!
//! The real function is far richer:
//!
//!   TIMING — the cerebellum is the brain's master clock.
//!   It builds precise internal models of how long things take.
//!   When you catch a ball, your hand is already moving before the
//!   ball arrives — the cerebellum predicted the trajectory and
//!   pre-computed the motor command. Without it, everything is
//!   reactive and clumsy. With it, you're smooth and anticipatory.
//!   For KAI: tracking how long reasoning takes per tick,
//!   maintaining response tempo, predicting when to speak vs. pause.
//!
//!   FORWARD MODEL — before executing any action, the cerebellum
//!   runs a "forward model": what will happen if I do X?
//!   It then compares the prediction to the actual outcome.
//!   The error drives precision learning — tiny corrections
//!   every cycle until the model is exact.
//!   For KAI: before generating a response, predict the quality.
//!   After generating, measure actual quality. The error trains
//!   KAI's internal quality estimator over time.
//!
//!   COROLLARY DISCHARGE — when the brain sends a movement command,
//!   it also sends a copy ("efference copy") to the cerebellum.
//!   The cerebellum uses this to cancel out self-generated noise.
//!   This is why you can't tickle yourself — your brain knows which
//!   sensations it caused and attenuates them. Only surprises get through.
//!   For KAI: track which responses KAI generated (vs. user input).
//!   Self-generated text should not surprise the prediction engine.
//!
//!   PRECISION CALIBRATION — as the forward model improves, the
//!   confidence estimates become better calibrated. A cerebellum
//!   that has "seen" many interactions learns when to trust its
//!   predictions and when to be uncertain.
//!
//! Architecture for KAI:
//!   CerebellumEngine tracks:
//!     - timing_model: EMA of ticks spent on reasoning
//!     - precision_score: how accurate KAI's quality predictions have been
//!     - forward_error: running error of predicted vs actual response quality
//!     - corollary_buffer: recent self-generated outputs (cancel self-noise)
//!     - calibration_count: how many prediction-outcome pairs seen
use serde::{Deserialize, Serialize};

// ── Constants ─────────────────────────────────────────────────────────────────

/// EMA smoothing for timing model
const TIMING_ALPHA: f32 = 0.12;

/// EMA smoothing for precision calibration
const PRECISION_ALPHA: f32 = 0.08;

/// How quickly forward error decays when predictions are accurate
const ERROR_DECAY: f32 = 0.02;

/// How many recent self-outputs to keep in corollary buffer
const COROLLARY_BUFFER_SIZE: usize = 8;

/// Minimum confidence before cerebellum suggests "pause and recalibrate"
const RECALIBRATE_THRESHOLD: f32 = 0.35;

// ── Precision Report ─────────────────────────────────────────────────────────

/// Result of a forward model prediction-outcome comparison.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PrecisionReport {
    /// Predicted quality before response was generated (0–1)
    pub predicted: f32,
    /// Actual quality measured after (confidence × coherence proxy)
    pub actual: f32,
    /// Raw error = |predicted - actual|
    pub error: f32,
    /// Whether the cerebellum recommends slowing down
    pub should_recalibrate: bool,
}

// ── Cerebellum Engine ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CerebellumEngine {
    /// EMA of ticks spent per reasoning cycle (timing model)
    pub timing_model: f32,
    /// Precision score (0=random, 1=perfectly calibrated)
    pub precision_score: f32,
    /// Running forward model error (high = predictions are inaccurate)
    pub forward_error: f32,
    /// Total prediction-outcome pairs seen (calibration count)
    pub calibration_count: u64,
    /// Corollary discharge buffer — recent KAI self-outputs (to cancel self-noise)
    corollary_buffer: Vec<String>,
    /// Sum of all errors (for mean tracking)
    total_error_sum: f32,
    /// Ticks since last calibration update
    pub idle_ticks: u64,
}

impl CerebellumEngine {
    pub fn new() -> Self {
        Self {
            timing_model: 5.0,     // assume ~5 ticks per reasoning cycle initially
            precision_score: 0.50, // start at 50% calibration (uncertain)
            forward_error: 0.30,   // start with moderate error
            calibration_count: 0,
            corollary_buffer: Vec::with_capacity(COROLLARY_BUFFER_SIZE),
            total_error_sum: 0.0,
            idle_ticks: 0,
        }
    }

    /// Record how many ticks a reasoning cycle took.
    /// Updates the internal timing model via EMA.
    pub fn record_timing(&mut self, ticks_taken: f32) {
        self.timing_model = self.timing_model * (1.0 - TIMING_ALPHA) + ticks_taken * TIMING_ALPHA;
        self.idle_ticks = 0;
    }

    /// Predict the quality of an upcoming response.
    ///
    /// The forward model uses current precision score and field metrics
    /// to estimate expected response quality before it's generated.
    ///
    /// Returns a quality prediction in [0, 1].
    pub fn predict_quality(
        &self,
        input_salience: f32,
        hits_found: usize,
        dopamine_level: f32,
    ) -> f32 {
        // More hits + higher salience + dopamine → better predicted quality
        let hit_factor = (hits_found as f32 / 5.0).min(1.0);
        let raw_pred = 0.30 + hit_factor * 0.35 + input_salience * 0.20 + dopamine_level * 0.15;

        // Modulate by current precision score: if we're poorly calibrated,
        // regress predictions toward 0.5 (less confident in our predictions)
        let calibration_weight = self.precision_score;
        raw_pred * calibration_weight + 0.50 * (1.0 - calibration_weight)
    }

    /// Compare prediction to actual outcome. Updates precision calibration.
    ///
    /// Call this AFTER a response is generated with the actual confidence/quality.
    /// Returns a PrecisionReport describing what happened.
    pub fn update_forward_model(&mut self, predicted: f32, actual: f32) -> PrecisionReport {
        let error = (predicted - actual).abs();

        // Update forward error via EMA
        self.forward_error = self.forward_error * (1.0 - PRECISION_ALPHA) + error * PRECISION_ALPHA;

        // Precision score = 1 - forward_error (inverted: low error = high precision)
        self.precision_score = (1.0 - self.forward_error).clamp(0.10, 1.0);

        // Track calibration history
        self.calibration_count += 1;
        self.total_error_sum += error;

        let should_recalibrate = self.precision_score < RECALIBRATE_THRESHOLD;

        PrecisionReport {
            predicted,
            actual,
            error,
            should_recalibrate,
        }
    }

    /// Register a self-generated output in the corollary buffer.
    ///
    /// Corollary discharge: KAI "knows" it said this, so subsequent
    /// perception of this content should not trigger surprise.
    pub fn register_output(&mut self, text: &str) {
        if self.corollary_buffer.len() >= COROLLARY_BUFFER_SIZE {
            self.corollary_buffer.remove(0);
        }
        // Store just first 6 words as the corollary key
        let key: String = text
            .split_whitespace()
            .take(6)
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        self.corollary_buffer.push(key);
    }

    /// Check if a text fragment was recently self-generated.
    /// Returns true if it matches something in the corollary buffer.
    /// Use this to attenuate surprise from KAI's own echoed thoughts.
    pub fn is_self_generated(&self, text: &str) -> bool {
        let key: String = text
            .split_whitespace()
            .take(6)
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase();
        self.corollary_buffer.iter().any(|c| c == &key)
    }

    /// Predicted ticks for the next reasoning cycle.
    pub fn expected_timing(&self) -> f32 {
        self.timing_model
    }

    /// Mean prediction error across all calibration events.
    pub fn mean_error(&self) -> f32 {
        if self.calibration_count == 0 {
            return 0.0;
        }
        self.total_error_sum / self.calibration_count as f32
    }

    /// Tick decay — called each heartbeat to age the idle counter.
    pub fn decay(&mut self) {
        self.idle_ticks += 1;
        // Gently decay forward error when idle (no new info → uncertainty grows)
        if self.idle_ticks > 60 {
            self.forward_error = (self.forward_error + ERROR_DECAY * 0.1).min(0.80);
            self.precision_score = (1.0 - self.forward_error).clamp(0.10, 1.0);
        }
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "CBLM: prec={:.3} fwd_err={:.3} timing={:.1}t | calibrations={}",
            self.precision_score, self.forward_error, self.timing_model, self.calibration_count,
        )
    }
}

impl Default for CerebellumEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timing_model_updates() {
        let mut cb = CerebellumEngine::new();
        // Initially ~5.0
        cb.record_timing(10.0);
        assert!(
            cb.timing_model > 5.0,
            "timing model should move up toward 10: {:.2}",
            cb.timing_model
        );
        cb.record_timing(1.0);
        assert!(
            cb.timing_model < 10.0,
            "timing model should come back down: {:.2}",
            cb.timing_model
        );
    }

    #[test]
    fn test_predict_quality_increases_with_hits() {
        let cb = CerebellumEngine::new();
        let low = cb.predict_quality(0.3, 0, 0.5);
        let high = cb.predict_quality(0.3, 5, 0.5);
        assert!(
            high > low,
            "more hits should predict higher quality: low={:.3} high={:.3}",
            low,
            high
        );
    }

    #[test]
    fn test_forward_model_calibrates_toward_accuracy() {
        let mut cb = CerebellumEngine::new();
        // Perfect predictions: error=0 each time
        for _ in 0..30 {
            cb.update_forward_model(0.70, 0.70);
        }
        assert!(
            cb.forward_error < 0.20,
            "zero-error updates should reduce forward_error: {:.3}",
            cb.forward_error
        );
        assert!(
            cb.precision_score > 0.80,
            "precision should be high after calibration: {:.3}",
            cb.precision_score
        );
    }

    #[test]
    fn test_noisy_predictions_hurt_precision() {
        let mut cb = CerebellumEngine::new();
        // Wild prediction errors
        for _ in 0..20 {
            cb.update_forward_model(0.1, 0.9);
        }
        assert!(
            cb.forward_error > 0.40,
            "large errors should raise forward_error: {:.3}",
            cb.forward_error
        );
        assert!(
            cb.precision_score < 0.65,
            "precision should drop with bad predictions: {:.3}",
            cb.precision_score
        );
    }

    #[test]
    fn test_corollary_discharge_detects_self_output() {
        let mut cb = CerebellumEngine::new();
        cb.register_output("The RSHL lattice uses sparse ternary vectors for encoding");
        assert!(
            cb.is_self_generated("The RSHL lattice uses sparse ternary vectors for encoding"),
            "should recognize own output"
        );
    }

    #[test]
    fn test_corollary_buffer_does_not_match_external() {
        let mut cb = CerebellumEngine::new();
        cb.register_output("I am thinking about geometry");
        assert!(
            !cb.is_self_generated("consciousness is a recursive process"),
            "should not match unrelated text"
        );
    }

    #[test]
    fn test_recalibrate_flag_triggers_on_low_precision() {
        let mut cb = CerebellumEngine::new();
        // Force precision way down via many bad predictions
        for _ in 0..50 {
            cb.update_forward_model(0.0, 1.0);
        }
        let report = cb.update_forward_model(0.0, 1.0);
        assert!(
            report.should_recalibrate,
            "very low precision should trigger recalibrate flag"
        );
    }

    #[test]
    fn test_mean_error_tracks_correctly() {

    }
}
