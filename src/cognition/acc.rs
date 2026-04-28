/// Anterior Cingulate Cortex — KAI's conflict detector and error monitor
///
/// The ACC sits at the intersection of emotion and cognition in the human brain.
/// It has two key jobs that nothing else in the brain does quite the same way:
///
///   1. CONFLICT DETECTION — when two things compete for control simultaneously,
///      the ACC notices and signals: "these don't fit together — resolve this."
///      Example: you want cake AND you want to lose weight. ACC fires hard.
///      For KAI: two universe cells contradict each other → ACC flags it.
///
///   2. ERROR MONITORING — the ACC tracks when things go wrong and alerts.
///      When KAI gives a wrong or uncertain answer, the ACC creates an
///      "error signal" that the rest of the system uses to recalibrate.
///      This is related to chi (contradiction pressure) in the field,
///      but where chi is a field-level metric, ACC is an active monitor
///      that takes specific action when it detects a problem.
///
///   3. ATTENTION ALLOCATION — when conflict is high, the ACC redirects
///      attention (tells the global workspace to prioritize resolution).
///
///   4. MOTIVATION-COGNITION INTEGRATION — the ACC bridges the emotional
///      drive system and the rational reasoning system. It decides when
///      emotion should override logic and vice versa.
///
/// Without ACC:
///   KAI never notices when his answers contradict each other.
///   He can say X in one turn and not-X in the next with no alarm.
///   There is no internal "wait, something's wrong here" signal.
///   Conflicts just silently produce incoherent output.
///
/// With ACC:
///   When two active hits or goals contradict, ACC fires.
///   A conflict record is created, the global workspace is alerted
///   with high salience, and KAI's inhibition rises so he slows down
///   before responding. In spectate mode, conflicts are visible.
///   Over time, frequently-conflicted topics get flagged as "uncertain zones."
///
/// Architecture:
///   AccMonitor tracks:
///     - Active conflict level (0 = none, 1 = maximum conflict)
///     - Recent error events (wrong, uncertain, contradicted)
///     - Per-topic conflict scores (which topics cause most confusion)
///     - Error Rate: ratio of error events to total
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Conflict threshold — above this, ACC fires a full alert
const CONFLICT_THRESHOLD: f32 = 0.55;

/// Decay rate for conflict level per tick
const CONFLICT_DECAY: f32 = 0.08;

/// Max topic conflict records
const MAX_TOPIC_CONFLICTS: usize = 64;

// ── Conflict Record ───────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConflictRecord {
    /// What two things conflicted
    pub item_a: String,
    pub item_b: String,
    /// Conflict intensity (0–1)
    pub intensity: f32,
    /// Whether this was resolved
    pub resolved: bool,
}

// ── ACC Monitor ───────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AccMonitor {
    /// Current conflict level (0 = clean, 1 = high conflict)
    pub conflict_level: f32,
    /// Smoothed average conflict (the ACC's resting tension)
    pub avg_conflict: f32,
    /// Recent unresolved conflict records (up to 10)
    recent_conflicts: Vec<ConflictRecord>,
    /// Per-topic conflict scores (which topics KAI consistently gets confused on)
    topic_conflicts: HashMap<String, f32>,
    /// Total error events ever detected
    pub total_errors: u64,
    /// Total conflicts detected
    pub total_conflicts: u64,
    /// Total resolved conflicts
    pub resolved_conflicts: u64,
    /// Whether the ACC is currently in a high-alert state
    pub is_alerting: bool,
}

impl AccMonitor {
    pub fn new() -> Self {
        Self {
            conflict_level: 0.0,
            avg_conflict: 0.0,
            recent_conflicts: Vec::with_capacity(10),
            topic_conflicts: HashMap::new(),
            total_errors: 0,
            total_conflicts: 0,
            resolved_conflicts: 0,
            is_alerting: false,
        }
    }

    /// Report a conflict between two pieces of information.
    ///
    /// Call this when the reasoner finds two contradicting cells,
    /// or when KAI's current response contradicts a prior statement.
    ///
    /// Returns the conflict intensity (0–1).
    pub fn report_conflict(&mut self, item_a: &str, item_b: &str, intensity: f32) -> f32 {
        let intensity = intensity.clamp(0.0, 1.0);

        // Raise conflict level
        self.conflict_level = (self.conflict_level + intensity * 0.40).min(1.0);
        self.avg_conflict = self.avg_conflict * 0.90 + self.conflict_level * 0.10;

        // Record conflict
        let record = ConflictRecord {
            item_a: truncate_str(item_a, 60),
            item_b: truncate_str(item_b, 60),
            intensity,
            resolved: false,
        };

        if self.recent_conflicts.len() >= 10 {
            self.recent_conflicts.remove(0);
        }
        self.recent_conflicts.push(record);

        // Update topic conflict scores
        let topic_key = extract_conflict_topic(item_a, item_b);
        let entry = self.topic_conflicts.entry(topic_key).or_insert(0.0);
        *entry = (*entry * 0.85 + intensity * 0.15).clamp(0.0, 1.0);

        // Prune if too large
        if self.topic_conflicts.len() > MAX_TOPIC_CONFLICTS {
            if let Some(min_key) = self
                .topic_conflicts
                .iter()
                .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                .map(|(k, _)| k.clone())
            {
                self.topic_conflicts.remove(&min_key);
            }
        }

        self.is_alerting = self.conflict_level > CONFLICT_THRESHOLD;
        self.total_conflicts += 1;

        intensity
    }

    /// Report an error event (wrong answer, low confidence, inhibited response).
    /// Less severe than a conflict — just a tracking signal.
    pub fn report_error(&mut self, topic: &str, severity: f32) {
        let severity = severity.clamp(0.0, 1.0);
        self.conflict_level = (self.conflict_level + severity * 0.15).min(1.0);
        self.avg_conflict = self.avg_conflict * 0.95 + self.conflict_level * 0.05;

        let topic_key = topic
            .split_whitespace()
            .filter(|w| w.len() >= 4)
            .take(2)
            .map(|w| w.to_lowercase())
            .collect::<Vec<_>>()
            .join("_");
        if !topic_key.is_empty() {
            let entry = self.topic_conflicts.entry(topic_key).or_insert(0.0);
            *entry = (*entry * 0.90 + severity * 0.10).clamp(0.0, 1.0);
        }

        self.is_alerting = self.conflict_level > CONFLICT_THRESHOLD;
        self.total_errors += 1;
    }

    /// Mark the most recent conflict as resolved.
    /// Call when KAI produces a coherent synthesizing response.
    pub fn resolve_recent(&mut self) {
        if let Some(c) = self.recent_conflicts.last_mut() {
            if !c.resolved {
                c.resolved = true;
                self.resolved_conflicts += 1;
                // Resolution reduces conflict level
                self.conflict_level = (self.conflict_level - 0.20).max(0.0);
            }
        }
        self.is_alerting = self.conflict_level > CONFLICT_THRESHOLD;
    }

    /// Scan two candidate texts for contradiction signals.
    ///
    /// Returns conflict intensity (0 = no conflict, 1 = strong contradiction).
    /// Heuristic: looks for negation asymmetry, "not" vs. absence of "not",
    /// contradictory polarity words.
    pub fn detect_contradiction(&self, text_a: &str, text_b: &str) -> f32 {
        let a = text_a.to_lowercase();
        let b = text_b.to_lowercase();

        let mut score: f32 = 0.0;

        // Negation asymmetry: one has "not/no/never", other doesn't
        let neg_words = [
            "not", "no", "never", "cannot", "can't", "doesn't", "isn't", "aren't",
        ];
        let a_has_neg = neg_words.iter().any(|n| a.contains(n));
        let b_has_neg = neg_words.iter().any(|n| b.contains(n));
        if a_has_neg != b_has_neg {
            // Only penalize if there is also word overlap (shared topic)
            let a_words: std::collections::HashSet<&str> = a.split_whitespace().collect();
            let b_words: std::collections::HashSet<&str> = b.split_whitespace().collect();
            if a_words.intersection(&b_words).count() >= 2 {
                score += 0.35;
            }
        }

        // Explicit contradiction words
        let contra_pairs = [
            ("true", "false"),
            ("always", "never"),
            ("is", "is not"),
            ("can", "cannot"),
            ("yes", "no"),
            ("good", "bad"),
            ("right", "wrong"),
            ("same", "different"),
        ];
        for (pos, neg) in &contra_pairs {
            if (a.contains(pos) && b.contains(neg)) || (a.contains(neg) && b.contains(pos)) {
                score += 0.30;
            }
        }

        // Shared topic words but opposite conclusions (weak signal)
        let a_words: std::collections::HashSet<&str> =
            a.split_whitespace().filter(|w| w.len() > 4).collect();
        let b_words: std::collections::HashSet<&str> =
            b.split_whitespace().filter(|w| w.len() > 4).collect();
        let overlap = a_words.intersection(&b_words).count();
        if overlap >= 2 && score > 0.0 {
            score += 0.15; // same topic, different conclusion = stronger conflict
        }

        score.clamp(0.0, 1.0)
    }

    /// Decay conflict level back toward 0 each tick.
    pub fn decay(&mut self) {
        self.conflict_level = (self.conflict_level - CONFLICT_DECAY).max(0.0);
        self.avg_conflict = self.avg_conflict * 0.995; // very slow decay of baseline
        self.is_alerting = self.conflict_level > CONFLICT_THRESHOLD;
    }

    /// Topics that consistently cause KAI confusion.
    pub fn troubled_topics(&self, n: usize) -> Vec<(String, f32)> {
        let mut topics: Vec<(String, f32)> = self.topic_conflicts.clone().into_iter().collect();
        topics.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        topics.into_iter().take(n).collect()
    }

    /// Resolution rate — how often KAI resolves conflicts he detects.
    pub fn resolution_rate(&self) -> f32 {
        if self.total_conflicts == 0 {
            return 1.0;
        }
        self.resolved_conflicts as f32 / self.total_conflicts as f32
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "ACC: conflict={:.3} avg={:.3} | alert={} | errors={} resolved={}",
            self.conflict_level,
            self.avg_conflict,
            self.is_alerting,
            self.total_errors,
            self.resolved_conflicts,
        )
    }
}

impl Default for AccMonitor {
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

fn extract_conflict_topic(a: &str, b: &str) -> String {
    let combined = format!("{} {}", a, b);
    combined
        .split_whitespace()
        .filter(|w| w.len() >= 5)
        .take(2)
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join("_")
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_conflict_raises_level() {
        let mut acc = AccMonitor::new();
        assert!(acc.conflict_level < 0.01);
        acc.report_conflict("water is wet", "water is not wet", 0.8);
        assert!(
            acc.conflict_level > 0.0,
            "conflict should raise level: {:.3}",
            acc.conflict_level
        );
    }

    #[test]
    fn test_resolve_lowers_level() {
        let mut acc = AccMonitor::new();
        acc.report_conflict("X is true", "X is false", 1.0);
        let before = acc.conflict_level;
        acc.resolve_recent();
        assert!(
            acc.conflict_level < before,
            "resolution should lower conflict: {:.3} -> {:.3}",
            before,
            acc.conflict_level
        );
        assert_eq!(acc.resolved_conflicts, 1);
    }

    #[test]
    fn test_detect_negation_asymmetry() {
        let acc = AccMonitor::new();
        let score = acc.detect_contradiction("the sky is blue", "the sky is not blue");
        assert!(
            score > 0.20,
            "negation asymmetry should score as contradiction: {:.3}",
            score
        );
    }

    #[test]
    fn test_no_contradiction_similar_texts() {
        let acc = AccMonitor::new();
        let score = acc.detect_contradiction(
            "consciousness is a recursive process",
            "consciousness involves recursive self-reference",
        );
        assert!(score < 0.30, "similar texts should score low: {:.3}", score);
    }

    #[test]
    fn test_alert_fires_above_threshold() {
        let mut acc = AccMonitor::new();
        assert!(!acc.is_alerting);
        // Multiple conflicts in a row
        for _ in 0..4 {
            acc.report_conflict("A is true", "A is false", 0.8);
        }
        assert!(
            acc.is_alerting,
            "sustained conflict should trigger alert: level={:.3}",
            acc.conflict_level
        );
    }

    #[test]
    fn test_decay_reduces_conflict() {
        let mut acc = AccMonitor::new();
        acc.report_conflict("hot", "cold", 1.0);
        let before = acc.conflict_level;
        for _ in 0..20 {
            acc.decay();
        }
        assert!(
            acc.conflict_level < before,
            "conflict should decay over time: {:.3} -> {:.3}",
            before,
            acc.conflict_level
        );
    }

    #[test]
    fn test_troubled_topics_tracked() {
        let mut acc = AccMonitor::new();
        for _ in 0..5 {
            acc.report_conflict("calculus is hard", "calculus is easy", 0.7);
        }
        let troubled = acc.troubled_topics(3);
        assert!(!troubled.is_empty(), "should track troubled topics");
    }
}
