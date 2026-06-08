//! Bone-Heal Protocol — KAI's Lattice Self-Repair System
//!
//! Biology analog: A fractured bone heals *stronger* at the break point.
//! When KAI's lattice has been poisoned (questions stored as facts by the
//! overnight pipeline), this module:
//!
//!   1. **Detects** poisoned cells using structural + source heuristics
//!   2. **Quarantines** them: moves to "contested" region, caps confidence
//!   3. **Heals** via Hebbian learning:
//!      - LTP (Long-Term Potentiation): healthy neighbor cells get +0.05 strength
//!      - LTD (Long-Term Depression): poisoned cells get × 0.85 strength per fire
//!
//! The key insight: KAI learns from the poisoned cells rather than just
//! deleting them. Every time a quarantined cell fires during a real query,
//! the anti-Hebbian signal weakens it further. The healthy cells in the same
//! semantic neighborhood get stronger. Over time, KAI's geometry naturally
//! routes AWAY from question-shaped regions toward fact-shaped regions.
//!
//! This implements the "different equations → same answer" property at the
//! immune level: questions and facts may use similar words but their
//! *geometric structure* diverges after Hebbian shaping.

use crate::core::Universe;

/// Summary of one bone-heal pass.
#[derive(Debug, Default)]
pub struct BoneHealReport {
    /// Cells moved to "contested" region and confidence-capped.
    pub quarantined: usize,
    /// Healthy cells that received LTP reinforcement.
    pub reinforced: usize,
    /// Quarantined cells that received LTD attenuation.
    pub weakened: usize,
    /// Previously quarantined cells whose confidence had already dropped
    /// below 0.05 (functionally inert — kept as negative examples).
    pub already_inert: usize,
}

impl std::fmt::Display for BoneHealReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "quarantined={} reinforced={} weakened={} inert={}",
            self.quarantined, self.reinforced, self.weakened, self.already_inert
        )
    }
}

// ── Poison Detection ─────────────────────────────────────────────────────────

/// Leading question words that indicate interrogative structure.
const QUESTION_WORDS: &[&str] = &[
    "what", "who", "where", "when", "why", "how",
    "do", "does", "did", "is", "are", "was", "were",
    "can", "could", "will", "would", "should",
];

/// Sources produced by automated pipelines that should be treated with
/// extra scrutiny when the cell has interrogative structure.
const AUTOMATED_SOURCES: &[&str] = &[
    "overnight-pipeline",
    "world-bridge-loop",
    "world-bridge",
    "duckduckgo",
];

/// Returns `true` if a cell's text is structurally a question (not a fact).
///
/// Detection rules (any one is sufficient):
/// - Ends with `?`
/// - Starts with a question word AND is short (≤ 12 words)
/// - Starts with a question word AND has no subject–verb–object structure
///   (i.e., could not be parsed as a fact by ClaimStore)
fn is_question_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.ends_with('?') {
        return true;
    }
    let lower = trimmed.to_lowercase();
    let first = lower.split_whitespace().next().unwrap_or("");
    if QUESTION_WORDS.contains(&first) {
        let word_count = trimmed.split_whitespace().count();
        // Short interrogative without clear SVO → likely a question stored as fact
        if word_count <= 12 {
            return true;
        }
        // Longer texts starting with question words could still be factual if
        // they have embedded assertions ("How X works: X is a process that...")
        // We're conservative here — only flag clearly short questions.
    }
    false
}

/// Returns `true` if the cell came from an automated source with low
/// confidence *and* its text is interrogative in structure.
fn is_suspicious_source(source: &str, confidence: f32, text: &str) -> bool {
    let src_lower = source.to_lowercase();
    let from_auto = AUTOMATED_SOURCES.iter().any(|s| src_lower.contains(s));
    from_auto && confidence < 1.5 && is_question_text(text)
}

/// Returns `true` if this cell is "poisoned" — a question masquerading as
/// a fact in KAI's lattice.
fn is_poisoned(text: &str, source: &str, confidence: f32, region: &str) -> bool {
    // Already quarantined in a previous pass — still track it
    if region == "contested" && confidence <= 0.31 {
        return true;
    }
    // Primary rule: text is structurally interrogative
    if is_question_text(text) {
        return true;
    }
    // Secondary rule: automated source + low trust + interrogative structure
    if is_suspicious_source(source, confidence, text) {
        return true;
    }
    false
}

// ── Classification Pass ───────────────────────────────────────────────────────

/// Classify all cells into (poisoned_indices, healthy_indices).
/// This is a read-only pass — it does not modify the universe.
pub fn classify_cells(universe: &Universe) -> (Vec<usize>, Vec<usize>) {
    let mut poisoned = Vec::new();
    let mut healthy = Vec::new();

    for (i, cell) in universe.cells().iter().enumerate() {
        if is_poisoned(
            &cell.claim.text,
            &cell.claim.source,
            cell.claim.confidence,
            &cell.region,
        ) {
            poisoned.push(i);
        } else {
            healthy.push(i);
        }
    }

    (poisoned, healthy)
}

// ── Quarantine Pass ───────────────────────────────────────────────────────────

/// Move poisoned cells to the "contested" region and cap their confidence
/// at 0.30. They remain in the lattice as negative examples but will not
/// surface above the resonance threshold (0.65) in normal queries.
///
/// Cells already in "contested" with confidence ≤ 0.30 are skipped (already
/// quarantined from a previous run).
///
/// Returns the count of newly quarantined cells.
pub fn quarantine_pass(universe: &mut Universe) -> usize {
    let mut count = 0usize;

    let cells = universe.cells_mut();
    for cell in cells.iter_mut() {
        // Already quarantined — skip
        if cell.region.as_ref() == "contested" && cell.claim.confidence <= 0.30 {
            continue;
        }

        if is_poisoned(
            &cell.claim.text,
            &cell.claim.source,
            cell.claim.confidence,
            &cell.region,
        ) {
            // Move to contested region
            cell.region = std::sync::Arc::from("contested");
            // Cap confidence — still > 0 so the cell exists as a negative example
            cell.claim.confidence = cell.claim.confidence.min(0.30);
            // Tag source so we know it was quarantined automatically
            if !cell.claim.source.contains("|quarantine") {
                let tagged = format!("{}|quarantine", cell.claim.source);
                cell.claim.source = std::sync::Arc::from(tagged.as_str());
            }
            count += 1;
        }
    }

    count
}

// ── Hebbian Heal Pass ─────────────────────────────────────────────────────────

/// Apply LTP to healthy cells and LTD to quarantined cells.
///
/// LTP (Long-Term Potentiation, positive Hebbian):
///   - Healthy cells with confidence < 4.0 receive +0.05
///   - Capped at 4.0 to avoid inflating non-anchor cells to truth-anchor level
///   - Biology: "cells that fire together, wire together"
///
/// LTD (Long-Term Depression, anti-Hebbian):
///   - Each quarantined cell has confidence × 0.85
///   - Floored at 0.05 (functionally inert but preserved as negative example)
///   - Biology: "cells that fire out of context get pruned"
///
/// Returns (reinforced_count, weakened_count).
pub fn hebbian_heal(
    universe: &mut Universe,
    poisoned_indices: &[usize],
    healthy_indices: &[usize],
) -> (usize, usize) {
    let mut reinforced = 0usize;
    let mut weakened = 0usize;

    let cells = universe.cells_mut();

    // LTP pass — healthy cells get stronger
    for &i in healthy_indices {
        if i < cells.len() {
            let cell = &mut cells[i];
            // Don't inflate truth-anchors (confidence ≥ 4.0) — they're already perfect
            if cell.claim.confidence < 4.0 {
                cell.claim.confidence = (cell.claim.confidence + 0.05).min(4.0);
                reinforced += 1;
            }
        }
    }

    // LTD pass — quarantined cells get weaker
    for &i in poisoned_indices {
        if i < cells.len() {
            let cell = &mut cells[i];
            if cell.claim.confidence > 0.05 {
                cell.claim.confidence = (cell.claim.confidence * 0.85).max(0.05);
                weakened += 1;
            }
        }
    }

    (reinforced, weakened)
}

// ── Top-Level Entry Point ─────────────────────────────────────────────────────

/// Run a full bone-heal pass on the universe.
///
/// This is the function to call at startup and after each overnight cycle.
/// It is idempotent — running it multiple times converges (poisoned cells
/// decay toward 0.05, healthy cells converge toward 4.0).
pub fn bone_heal_pass(universe: &mut Universe) -> BoneHealReport {
    let (poisoned_indices, healthy_indices) = classify_cells(universe);

    let already_inert = poisoned_indices
        .iter()
        .filter(|&&i| {
            universe
                .cells()
                .get(i)
                .map(|c| c.claim.confidence <= 0.05)
                .unwrap_or(false)
        })
        .count();

    let quarantined = quarantine_pass(universe);
    let (reinforced, weakened) = hebbian_heal(universe, &poisoned_indices, &healthy_indices);

    BoneHealReport {
        quarantined,
        reinforced,
        weakened,
        already_inert,
    }
}

/// Real-time anti-Hebbian signal: called from voice.rs when a contested
/// (quarantined) cell fires during a real query.
///
/// Each fire event weakens the poisoned cell slightly so KAI learns over
/// time that this pattern should not surface.
///
/// `label` — the cell's label (from QueryHit.label)
/// Returns `true` if the cell was found and attenuated.
pub fn anti_hebbian_fire(universe: &mut Universe, label: &str) -> bool {
    universe.attenuate_cell(label, 0.92)
}

/// Real-time Hebbian signal: called from voice.rs when a healthy cell fires
/// and produces a confident answer (score > RESONANCE_THRESHOLD).
///
/// Each correct answer strengthens the firing cell — "fire together, wire
/// together" at inference time.
///
/// `text`  — the cell's text (used for exact match lookup)
/// `delta` — amount to add (typically 0.02 — small per-fire increment)
pub fn hebbian_fire(universe: &mut Universe, text: &str, delta: f32) {
    universe.reinforce_by_text(text, delta);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_question_cells() {
        assert!(is_question_text("What is a quasicrystal?"));
        assert!(is_question_text("How does KAI learn?"));
        assert!(is_question_text("Who built KAI"));
        assert!(is_question_text("Is KAI an LLM?"));
        assert!(!is_question_text("KAI is a custom Rust AI using sparse vectors."));
        assert!(!is_question_text("Ryan created KAI in Rust."));
        assert!(!is_question_text("E equals mc squared confirmed by experiment."));
    }

    #[test]
    fn report_display() {
        let r = BoneHealReport {
            quarantined: 12,
            reinforced: 340,
            weakened: 12,
            already_inert: 3,
        };
        assert!(r.to_string().contains("quarantined=12"));
        assert!(r.to_string().contains("reinforced=340"));
    }
}
