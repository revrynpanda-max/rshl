//! Emotional Weighting Engine for the Epistemic Memory.
//!
//! Assigns emotional valence to claims based on:
//!   - Source trust & confidence   (resonance)
//!   - Contradiction with network   (conflict)
//!   - Novelty / information gain   (curiosity)
//!
//! This module is consumed by claim_store.rs and the Dream Cycle.

use crate::claim_store::{Claim, Confidence, EmotionalValence};
use std::collections::HashMap;

/// Compute a basic emotional weight without network context.
pub fn initial_emotional_weight(claim: &Claim) -> EmotionalValence {
    let resonance = (claim.confidence * 0.4 + claim.source_trust * 0.6).min(1.0);
    let curiosity = ((1.0 - claim.source_trust) * 0.5 + (claim.confidence * 0.3)).min(1.0);
    let conflict = 0.0; // zero without contradiction check
    EmotionalValence {
        curiosity,
        conflict,
        resonance,
    }
}

/// Adjust emotional weights when a claim contradicts existing claims.
/// `contradiction_strength` ∈ [0,1] indicates how strongly the new claim
/// contradicts the existing belief field.
pub fn apply_contradiction(valence: &mut EmotionalValence, contradiction_strength: f32) {
    if contradiction_strength > 0.0 {
        let delta = (contradiction_strength * 0.7).min(valence.resonance);
        valence.resonance -= delta;
        valence.conflict = (valence.conflict + contradiction_strength).min(1.0);
        valence.curiosity = (valence.curiosity + contradiction_strength * 0.3).min(1.0);
    }
}

/// Resonance boost after a successful recall (used by Dream Cycle).
pub fn reward_resonance(valence: &mut EmotionalValence, reward: f32) {
    valence.resonance = (valence.resonance + reward).min(1.0);
    valence.conflict *= 0.9; // decay conflict on reinforcement
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claim_store::{Polarity};

    #[test]
    fn test_initial_weight() {
        let c = Claim {
            id: "".into(),
            subject: "x".into(),
            relation: "y".into(),
            object: "z".into(),
            polarity: Polarity::Positive,
            confidence: 4.0,
            source: "test".into(),
            source_trust: 0.9,
            status: "Claim".into(),
            timestamp: 0,
            emotion: EmotionalValence::default(),
            user_hash: "".into(),
            tier: 0,
        };
        let w = initial_emotional_weight(&c);
        assert!(w.resonance > 0.8);
    }

    #[test]
    fn test_contradiction() {
        let mut v = EmotionalValence { curiosity: 0.3, conflict: 0.0, resonance: 0.9 };
        apply_contradiction(&mut v, 0.8);
        assert!(v.conflict > 0.5);
        assert!(v.resonance < 0.4);
    }
}
