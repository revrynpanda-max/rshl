/// Promotion — Belief formation / Long-term potentiation.
///
/// A dream candidate that meets ALL thresholds gets written into
/// the universe as durable memory — it becomes a belief.
use super::candidates::{CandidateBuffer, CandidateStatus};
use crate::core::Universe;

pub struct PromotionThresholds {
    pub seen_count: u32,
    pub best_c: f32,
    pub best_phi_g: f32,
    pub best_confidence: f32,
    pub max_chi: f32,
    pub max_chi_sd: f32,
    pub min_nsr: f32,
}

impl Default for PromotionThresholds {
    fn default() -> Self {
        Self {
            seen_count: 3,
            best_c: 0.015,
            best_phi_g: 0.024,
            best_confidence: 0.72,
            max_chi: 0.38,
            max_chi_sd: 0.28,
            min_nsr: 0.35,
        }
    }
}

#[derive(Debug)]
pub struct PromotionResult {
    pub promoted: Vec<PromotedBelief>,
    pub eligible: usize,
}

#[derive(Debug)]
pub struct PromotedBelief {
    pub text: String,
    pub seen_count: u32,
    pub best_c: f32,
    pub best_phi_g: f32,
    pub strength: f32,
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f32>() / v.len() as f32
}

fn stddev(v: &[f32]) -> f32 {
    if v.len() < 2 {
        return 0.0;
    }
    let m = mean(v);
    let var = v.iter().map(|x| (x - m).powi(2)).sum::<f32>() / v.len() as f32;
    var.sqrt()
}

#[allow(dead_code)]
fn score(e: &super::candidates::CandidateEntry) -> f32 {
    let nsr = if e.seen_count > 0 {
        e.non_source_count as f32 / e.seen_count as f32
    } else {
        0.0
    };
    let chi_mean = mean(&e.contradiction_history);
    let stability = (1.0 - stddev(&e.phi_history)).clamp(0.0, 1.0);
    e.best_phi_g * 0.30
        + e.best_c * 0.25
        + e.best_confidence * 0.15
        + nsr * 0.15
        + stability * 0.10
        + (1.0 - chi_mean).clamp(0.0, 1.0) * 0.05
}

/// Run promotion check on all candidates.
pub fn run_promotion(
    candidates: &mut CandidateBuffer,
    universe: &mut Universe,
    thresholds: &PromotionThresholds,
) -> PromotionResult {
    let all = candidates.get_all();
    let mut eligible_keys: Vec<String> = Vec::new();

    for entry in &all {
        if entry.status != CandidateStatus::Candidate {
            continue;
        }
        if entry.seen_count < thresholds.seen_count {
            continue;
        }
        if entry.best_c < thresholds.best_c {
            continue;
        }
        if entry.best_phi_g < thresholds.best_phi_g {
            continue;
        }
        if entry.best_confidence < thresholds.best_confidence {
            continue;
        }

        let chi_mean = mean(&entry.contradiction_history);
        if chi_mean > thresholds.max_chi {
            continue;
        }

        let chi_sd = stddev(&entry.contradiction_history);
        if chi_sd > thresholds.max_chi_sd {
            continue;
        }

        let nsr = if entry.seen_count > 0 {
            entry.non_source_count as f32 / entry.seen_count as f32
        } else {
            0.0
        };
        if nsr < thresholds.min_nsr {
            continue;
        }

        eligible_keys.push(entry.key.clone());
    }

    let eligible_count = eligible_keys.len();
    let mut promoted = Vec::new();

    // Competition: among eligible, resolve by vector similarity clusters
    // For now, promote all that pass (competition requires vector comparison)
    for key in &eligible_keys {
        let entry = candidates.get_all().into_iter().find(|e| e.key == *key);
        if let Some(entry) = entry {
            let stability = (1.0 - stddev(&entry.phi_history)).clamp(0.0, 1.0);
            let raw_strength =
                (entry.best_c * 2.5 + entry.best_phi_g * 1.5 + stability * 0.5).clamp(0.0, 1.0);
            let strength = 1.5 + raw_strength * 2.5; // maps [0,1] → [1.5, 4.0]

            universe.store(&entry.text, "memory", "promoted-dream", strength);

            promoted.push(PromotedBelief {
                text: entry.text.clone(),
                seen_count: entry.seen_count,
                best_c: entry.best_c,
                best_phi_g: entry.best_phi_g,
                strength,
            });
        }
    }

    for key in &eligible_keys {
        candidates.mark_promoted(key);
    }

    PromotionResult {
        promoted,
        eligible: eligible_count,
    }
}
