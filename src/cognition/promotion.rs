
use crate::cognition::candidates::{CandidateBuffer, CandidateStatus};
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
pub struct PromotedBelief {
    pub text: String,
    pub seen_count: u32,
    pub best_c: f32,
    pub best_phi_g: f32,
    pub strength: f32,
}

#[derive(Debug)]
pub struct PromotionResult {
    pub promoted: Vec<PromotedBelief>,
}

fn stddev(v: &[f32]) -> f32 {
    if v.len() < 2 { return 0.0; }
    let m = v.iter().sum::<f32>() / v.len() as f32;
    let var = v.iter().map(|x| (x - m).powi(2)).sum::<f32>() / v.len() as f32;
    var.sqrt()
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() { return 0.0; }
    v.iter().sum::<f32>() / v.len() as f32
}

pub fn run_promotion(
    buffer: &mut CandidateBuffer,
    universe: &mut Universe,
    thresholds: &PromotionThresholds,
) -> PromotionResult {
    let mut eligible_keys = Vec::new();
    
    // Direct access to pub entries to bypass any method resolution issues
    for entry in buffer.entries.values() {
        if entry.status == CandidateStatus::Candidate
            && entry.seen_count >= thresholds.seen_count &&
               entry.best_c >= thresholds.best_c &&
               entry.best_phi_g >= thresholds.best_phi_g &&
               entry.best_confidence >= thresholds.best_confidence {
                
                let chi_mean = mean(&entry.contradiction_history);
                if chi_mean <= thresholds.max_chi {
                    let nsr = if entry.seen_count > 0 {
                        entry.non_source_count as f32 / entry.seen_count as f32
                    } else {
                        0.0
                    };
                    if nsr >= thresholds.min_nsr {
                        eligible_keys.push(entry.key.clone());
                    }
                }
            }
    }

    let mut promoted = Vec::new();
    for key in eligible_keys {
        if let Some(found_entry) = buffer.entries.get(&key) {
            let stability = (1.0 - stddev(&found_entry.phi_history)).clamp(0.0, 1.0);
            let raw_strength = (found_entry.best_c * 2.5 + found_entry.best_phi_g * 1.5 + stability * 0.5).clamp(0.0, 1.0);
            let strength = 1.5 + raw_strength * 2.5;

            universe.store(&found_entry.label, "memory", "promoted-dream", strength);
            
            promoted.push(PromotedBelief {
                text: found_entry.label.clone(),
                seen_count: found_entry.seen_count,
                best_c: found_entry.best_c,
                best_phi_g: found_entry.best_phi_g,
                strength,
            });
            
            // We'll mark it promoted after the loop to avoid borrow checker issues 
            // if we were mutating the hashmap inside values() iteration.
            // But here we are using keys collected separately, so we can do it.
        }
        buffer.mark_promoted(&key);
    }

    PromotionResult { promoted }
}
