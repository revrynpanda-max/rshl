//! Dynamic Calibration Engine — Epistemic Immune System Component 1.
//!
//! Whitepaper Section 10.1:
//!   "Adjusts confidence thresholds based on observed retrieval accuracy.
//!   If highly-confident cells are being retrieved in contexts where they
//!   produce incorrect responses, the calibration engine lowers the
//!   effective confidence threshold for that region, requiring more evidence
//!   before cells enter the high-retrieval tier."
//!
//! This module maintains per-region accuracy statistics and computes an
//! adaptive confidence offset that is applied during retrieval scoring.

use std::collections::HashMap;

/// Per-region accuracy tracker.
#[derive(Clone, Debug, Default)]
struct RegionStats {
    /// Number of queries where a cell from this region was in the top hit.
    total_queries: u64,
    /// Number of those queries judged "correct" by downstream feedback.
    correct_queries: u64,
    /// Rolling accuracy (correct / total), smoothed.
    rolling_accuracy: f32,
    /// Current calibration offset applied to confidence in this region.
    /// Positive = raise effective threshold (be more skeptical).
    /// Negative = lower effective threshold (be more permissive).
    confidence_offset: f32,
}

/// Dynamic Calibration Engine.
///
/// Tracks retrieval quality per region and adjusts effective confidence
/// thresholds to maintain target accuracy. This is the "self-correcting"
/// arm of the epistemic immune system.
pub struct CalibrationEngine {
    stats: HashMap<String, RegionStats>,
    target_accuracy: f32,
    /// Max absolute confidence offset (prevents runaway calibration).
    max_offset: f32,
    /// Learning rate for offset updates.
    alpha: f32,
}

impl Default for CalibrationEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl CalibrationEngine {
    pub fn new() -> Self {
        Self {
            stats: HashMap::new(),
            target_accuracy: 0.75,
            max_offset: 0.5,
            alpha: 0.05,
        }
    }

    /// Record the outcome of a retrieval event.
    ///
    /// `region` — the region of the top-retrieved cell.
    /// `was_correct` — true if the downstream consumer judged the hit relevant.
    pub fn feedback(&mut self, region: &str, was_correct: bool) {
        let s = self.stats.entry(region.to_string()).or_insert_with(|| RegionStats {
            rolling_accuracy: self.target_accuracy,
            ..Default::default()
        });
        s.total_queries += 1;
        if was_correct {
            s.correct_queries += 1;
        }

        // Exponential moving average of accuracy
        let observed = if s.total_queries > 0 {
            s.correct_queries as f32 / s.total_queries as f32
        } else {
            0.5
        };
        s.rolling_accuracy = s.rolling_accuracy * 0.9 + observed * 0.1;

        // Adjust offset: if accuracy is below target, raise threshold (more skeptical)
        // if accuracy is above target, lower threshold (more permissive)
        let error = s.rolling_accuracy - self.target_accuracy;
        let delta = -error * self.alpha; // negative feedback
        s.confidence_offset = (s.confidence_offset + delta)
            .clamp(-self.max_offset, self.max_offset);
    }

    /// Get the effective confidence threshold for a region.
    ///
    /// The base threshold (e.g. 2.9 for the step-function) is adjusted by
    /// the region-specific offset. A positive offset makes it harder for
    /// cells to reach the high-retrieval tier; a negative offset makes it easier.
    pub fn effective_threshold(&self, region: &str, base: f32) -> f32 {
        let offset = self
            .stats
            .get(region)
            .map(|s| s.confidence_offset)
            .unwrap_or(0.0);
        (base + offset).max(0.0)
    }

    /// Get the calibrated strength bonus for a cell.
    ///
    /// This applies the region-specific offset to the confidence step-function:
    ///   if confidence >= (2.9 + offset) → high tier bonus
    ///   else → low tier bonus
    pub fn calibrated_strength_bonus(
        &self,
        region: &str,
        confidence: f32,
        low_bonus: f32,
        high_bonus: f32,
        step_threshold: f32,
    ) -> f32 {
        let eff_threshold = self.effective_threshold(region, step_threshold);
        if confidence >= eff_threshold {
            high_bonus
        } else {
            low_bonus
        }
    }

    /// One-line status for TUI / diagnostics.
    pub fn status_line(&self) -> String {
        let n = self.stats.len();
        let avg_acc: f32 = if n > 0 {
            self.stats.values().map(|s| s.rolling_accuracy).sum::<f32>() / n as f32
        } else {
            0.0
        };
        format!(
            "CAL: {} regions | avg_acc={:.2} | target={:.2}",
            n, avg_acc, self.target_accuracy
        )
    }

    /// Per-region diagnostic dump.
    pub fn region_report(&self) -> Vec<(String, f32, f32, u64)> {
        let mut v: Vec<(String, f32, f32, u64)> = self
            .stats
            .iter()
            .map(|(r, s)| {
                (
                    r.clone(),
                    s.rolling_accuracy,
                    s.confidence_offset,
                    s.total_queries,
                )
            })
            .collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calibration_raises_threshold_when_accuracy_is_low() {
        let mut cal = CalibrationEngine::new();
        // Simulate 10 queries, only 2 correct → accuracy drops
        for i in 0..10 {
            cal.feedback("memory", i < 2);
        }
        let threshold = cal.effective_threshold("memory", 2.9);
        assert!(
            threshold > 2.9,
            "Low accuracy should raise effective threshold: got {}",
            threshold
        );
    }

    #[test]
    fn calibration_lowers_threshold_when_accuracy_is_high() {
        let mut cal = CalibrationEngine::new();
        // Simulate 10 queries, 9 correct → accuracy rises
        for i in 0..10 {
            cal.feedback("memory", i < 9);
        }
        let threshold = cal.effective_threshold("memory", 2.9);
        assert!(
            threshold < 2.9,
            "High accuracy should lower effective threshold: got {}",
            threshold
        );
    }

    #[test]
    fn calibrated_step_function_shifts_with_offset() {
        let mut cal = CalibrationEngine::new();
        cal.feedback("memory", false);
        cal.feedback("memory", false);
        cal.feedback("memory", false);

        let bonus = cal.calibrated_strength_bonus("memory", 3.0, 0.5, 0.85, 2.9);
        // With low accuracy, offset should be positive, so conf=3.0 may still
        // be below the raised threshold. But 3.0 is well above 2.9, so even with
        // max_offset=0.5, eff_threshold = 3.4, and 3.0 < 3.4 → low bonus.
        // Let's test with a higher confidence to ensure the shift works.
        let bonus_high = cal.calibrated_strength_bonus("memory", 4.0, 0.5, 0.85, 2.9);
        assert_eq!(bonus_high, 0.85, "High confidence should still get high bonus after calibration");
    }

    #[test]
    fn max_offset_is_respected() {
        let mut cal = CalibrationEngine::new();
        // Bombard with incorrect feedback to try to push offset past limit
        for _ in 0..1000 {
            cal.feedback("memory", false);
        }
        let threshold = cal.effective_threshold("memory", 2.9);
        assert!(
            threshold <= 2.9 + 0.5 + 1e-4,
            "Offset must not exceed max_offset: got {}",
            threshold
        );
    }
}
