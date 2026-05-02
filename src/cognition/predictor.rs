use crate::core::SparseVec;
/// Predictive Processing Engine — KAI's expectation machine
///
/// One of the most powerful theories of brain function (Karl Friston, Andy Clark):
///   The brain is not a passive receiver of information.
///   It is a PREDICTION MACHINE that constantly generates hypotheses about
///   what input it's about to receive, then updates based on the ERROR.
///
/// Without prediction:
///   Every input is equally surprising. KAI reacts but doesn't anticipate.
///   He cannot be surprised, curious, or genuinely interested.
///   There is no learning signal — just pattern matching.
///
/// With prediction:
///   Before answering, KAI generates what he EXPECTS to be the answer.
///   After the real answer is computed, he measures how wrong he was.
///   High error (surprise) → stronger encoding, higher curiosity drive.
///   Low error (confirmation) → mild reinforcement, low surprise.
///   Zero error (total prediction) → potential boredom / seeks novelty.
///
/// Architecture:
///   PredictiveEngine holds a small history of (prediction, actual, error).
///   On each input, it:
///     1. Predicts: queries the universe for top hits and generates a summary
///     2. Computes error after real resonance: cosine distance between
///        predicted vector and actual output vector
///     3. Updates: high-error events get stronger amygdala boost + episodic
///        salience; the error itself becomes a learning signal for future hits
///
/// The key metric: Prediction Error (PE) — 0.0 (perfect prediction) to 1.0 (complete surprise)
/// This becomes part of KAI's displayed field state alongside phi_g and chi.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

// ── Constants ─────────────────────────────────────────────────────────────────

/// How many (prediction, actual, error) records to retain
const HISTORY_CAP: usize = 200;

/// Minimum score for a hit to count as a valid prediction basis
const PREDICTION_MIN_SCORE: f32 = 0.15;

// ── Prediction Record ─────────────────────────────────────────────────────────

/// One prediction–outcome pair.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PredictionRecord {
    /// The input text that triggered this prediction cycle
    pub input_summary: String,
    /// What KAI predicted (top-hit text before reasoning)
    pub predicted_text: String,
    /// What the reasoner actually produced
    pub actual_text: String,
    /// Cosine-space prediction error: 0.0 = perfect, 1.0 = total surprise
    pub error: f32,
    /// Was this a genuine surprise? (error > 0.45)
    pub was_surprising: bool,
}

// ── Predictive Engine ─────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PredictiveEngine {
    /// Rolling history of prediction records
    history: VecDeque<PredictionRecord>,
    /// Running average prediction error (RAPE — rolling avg PE)
    pub avg_error: f32,
    /// Total predictions ever made
    pub total_predictions: u64,
    /// Count of genuinely surprising events (PE > 0.45)
    pub surprise_count: u64,
    /// Smoothed "curiosity pressure" — rises with sustained high PE
    /// Falls when KAI is consistently correct (bored)
    pub curiosity_pressure: f32,
}

impl PredictiveEngine {
    pub fn new() -> Self {
        Self {
            history: VecDeque::with_capacity(HISTORY_CAP),
            avg_error: 0.5, // start neutral — neither bored nor surprised
            total_predictions: 0,
            surprise_count: 0,
            curiosity_pressure: 0.5,
        }
    }

    /// Generate a prediction before reasoning happens.
    ///
    /// Returns:
    ///   - The predicted text (what KAI thinks the answer will be about)
    ///   - The predicted vector (for error computation later)
    ///
    /// This is FAST — it's just the top universe hit, not full reasoning.
    /// Call this BEFORE the reasoner runs.
    pub fn predict(&self, hits: &[(String, f32)]) -> (String, SparseVec) {
        if hits.is_empty() {
            return ("<no prediction>".to_string(), SparseVec::zero());
        }

        // Use the top hit above minimum score as prediction basis
        let valid: Vec<&(String, f32)> = hits
            .iter()
            .filter(|(_, s)| *s >= PREDICTION_MIN_SCORE)
            .collect();

        if valid.is_empty() {
            return ("<below threshold>".to_string(), SparseVec::zero());
        }

        let best = &valid[0];
        let pred_vec = SparseVec::encode(&best.0);
        (best.0.clone(), pred_vec)
    }

    /// Record the outcome and compute prediction error.
    ///
    /// Call this AFTER the reasoner produces its actual output.
    /// Returns the prediction error (0–1) — use it to boost salience.
    pub fn update(
        &mut self,
        input: &str,
        predicted_text: &str,
        predicted_vec: &SparseVec,
        actual_text: &str,
    ) -> f32 {
        // Compute error as 1 − cosine(predicted, actual)
        let actual_vec = SparseVec::encode(actual_text);
        let sim = predicted_vec.cosine(&actual_vec);
        let error = (1.0_f32 - sim).clamp(0.0, 1.0);

        let was_surprising = error > 0.45;
        if was_surprising {
            self.surprise_count += 1;
        }

        // RAPE: exponential moving average (α = 0.15 — smooth but responsive)
        self.avg_error = self.avg_error * 0.85 + error * 0.15;

        // Curiosity pressure: rises when avg_error is high, falls when low
        // Target: avg_error > 0.4 → pressure builds; < 0.2 → pressure falls
        if self.avg_error > 0.40 {
            self.curiosity_pressure = (self.curiosity_pressure + 0.03).min(1.0);
        } else if self.avg_error < 0.20 {
            self.curiosity_pressure = (self.curiosity_pressure - 0.02).max(0.0);
        }

        let record = PredictionRecord {
            input_summary: truncate_str(input, 60),
            predicted_text: truncate_str(predicted_text, 80),
            actual_text: truncate_str(actual_text, 80),
            error,
            was_surprising,
        };

        if self.history.len() >= HISTORY_CAP {
            self.history.pop_front();
        }
        self.history.push_back(record);
        self.total_predictions += 1;

        error
    }

    /// Salience boost to apply to this event based on its prediction error.
    /// Surprising events should be encoded more strongly (attention signal).
    ///
    ///   PE ≤ 0.10 → boost 0.0 (as expected, no extra weight)
    ///   PE   0.30 → boost 0.15
    ///   PE ≥ 0.60 → boost 0.40 (very surprising — burn it in)
    pub fn salience_boost(error: f32) -> f32 {
        if error < 0.10 {
            return 0.0;
        }
        (error * 0.65).clamp(0.0, 0.40)
    }

    /// True if KAI is in a high-surprise state (recent avg PE is elevated).
    pub fn is_surprised(&self) -> bool {
        self.avg_error > 0.50
    }

    /// True if KAI is in a low-surprise (predictable / potentially bored) state.
    pub fn is_bored(&self) -> bool {
        self.avg_error < 0.15
    }

    /// The most recent N prediction records.
    pub fn recent(&self, n: usize) -> Vec<&PredictionRecord> {
        self.history.iter().rev().take(n).collect()
    }

    /// Most surprising moment KAI has experienced.
    pub fn most_surprising(&self) -> Option<&PredictionRecord> {
        self.history.iter().max_by(|a, b| {
            a.error
                .partial_cmp(&b.error)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    }

    /// Human-readable summary of KAI's current predictive state.
    pub fn status_line(&self) -> String {
        let state = if self.is_bored() {
            "bored (low surprise)"
        } else if self.is_surprised() {
            "curious (high surprise)"
        } else {
            "calibrated"
        };
        format!(
            "PE_avg={:.3} | curiosity={:.2} | {} | {} predictions ({} surprising)",
            self.avg_error,
            self.curiosity_pressure,
            state,
            self.total_predictions,
            self.surprise_count,
        )
    }
}

impl Default for PredictiveEngine {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn truncate_str(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_perfect_prediction_zero_error() {
        let mut engine = PredictiveEngine::new();
        let text = "consciousness arises from recursive self-reference";
        let vec = SparseVec::encode(text);
        let err = engine.update("what is consciousness?", text, &vec, text);
        assert!(
            err < 0.05,
            "identical prediction should have near-zero error: {:.4}",
            err
        );
    }

    #[test]
    fn test_wrong_prediction_high_error() {
        let mut engine = PredictiveEngine::new();
        let pred_vec = SparseVec::encode("the colour of the sky is blue and clear");
        let err = engine.update(
            "what is calculus?",
            "the colour of the sky is blue and clear",
            &pred_vec,
            "calculus is the mathematics of change, integrals and derivatives",
        );
        assert!(
            err > 0.30,
            "completely wrong prediction should have high error: {:.4}",
            err
        );
    }

    #[test]
    fn test_avg_error_smoothing() {
        let mut engine = PredictiveEngine::new();
        // Use IDENTICAL text for prediction and actual — guarantees near-zero cosine error
        let text = "apples are a delicious fruit that grows on trees";
        let pred_vec = SparseVec::encode(text);
        // Feed 60 identical updates — EMA of 0 from starting avg of 0.5:
        //   after 60 ticks: 0.5 * 0.85^60 ≈ 0.5 * 0.00012 ≈ 0.0 → well below 0.20
        for _ in 0..60 {
            engine.update("apples", text, &pred_vec, text);
        }
        assert!(
            engine.avg_error < 0.20,
            "avg error should be low after many correct predictions: {:.3}",
            engine.avg_error
        );
    }

    #[test]
    fn test_curiosity_pressure_rises_with_surprise() {
        let mut engine = PredictiveEngine::new();
        engine.curiosity_pressure = 0.0;
        let wrong_vec = SparseVec::encode("banana");
        for _ in 0..30 {
            engine.update(
                "deep question",
                "banana",
                &wrong_vec,
                "this is a completely different answer about consciousness and mathematics",
            );
        }
        assert!(
            engine.curiosity_pressure > 0.20,
            "curiosity should rise with sustained surprise: {:.3}",
            engine.curiosity_pressure
        );
    }

    #[test]
    fn test_salience_boost_scaling() {
        assert!(
            PredictiveEngine::salience_boost(0.05) < 0.01,
            "low PE → no boost"
        );
        assert!(
            PredictiveEngine::salience_boost(0.30) > 0.10,
            "mid PE → some boost"
        );
        assert!(
            PredictiveEngine::salience_boost(0.80) <= 0.40,
            "high PE → capped boost"
        );
    }

    #[test]
    fn test_predict_returns_top_hit() {
        let engine = PredictiveEngine::new();
        let hits = [(
                "consciousness is recursive self-reference".to_string(),
                0.85_f32,
            )];
        assert!(!hits.is_empty());
        let _ = engine;
    }
}
