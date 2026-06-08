//! Mirror Neurons / Self-Reflection Loop
//!
//! Evaluates native RSHL thought strings before outputting.
//! If the thought string is fragmented, incoherent, or contradicts core identity,
//! the mirror neurons flag it and suggest a rewrite or fallback.
//!
//! Biological analog: The Anterior Cingulate Cortex (ACC) and Medial Prefrontal
//! Cortex (mPFC) error-monitoring and self-evaluation loops.

use crate::core::Universe;
use crate::cognition::voice::BrainSignals;

/// Outcome of the self-reflection audit
#[derive(Debug, Clone)]
pub enum ReflectionOutcome {
    /// The thought is clear and aligned. Output as is.
    Pass,
    /// The thought is fragmented but recoverable. Rewritten internally.
    Rewritten(String),
    /// The thought is completely incoherent or inappropriate. Suppress it.
    Suppress,
}

/// Evaluates a raw thought string before it reaches the speech center.
pub fn audit_thought(
    raw_thought: &str,
    brain: &BrainSignals,
    _universe: &Universe,
) -> ReflectionOutcome {
    let text = raw_thought.trim();
    if text.is_empty() {
        return ReflectionOutcome::Suppress;
    }

    // 1. Fragmentation Check
    // If the brain's internal focus (PHI_G) is very low, and the output has no verbs, it's likely noise.
    let word_count = text.split_whitespace().count();
    if word_count > 15 && text.matches(',').count() > 5 {
        // Run-on sentence symptom of lack of inhibition
        return ReflectionOutcome::Rewritten(
            "My thoughts are racing a bit on that, but the core idea is there.".to_string(),
        );
    }

    // 2. Repetition loop detection (Catatonia check)
    // If the string contains the same word 4+ times sequentially
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() >= 4 {
        for i in 0..words.len() - 3 {
            if words[i] == words[i + 1] && words[i + 1] == words[i + 2] && words[i + 2] == words[i + 3] {
                // Severe stutter / loop detected
                return ReflectionOutcome::Rewritten(
                    "I'm catching myself looping. Let me reset my context.".to_string(),
                );
            }
        }
    }

    // 3. Emotional / Stress Override
    // If Cortisol (stress) is extremely high, KAI's speech should reflect brevity or caution.
    if brain.conflict > 0.85 && word_count > 20 {
        return ReflectionOutcome::Rewritten(
            "System under heavy load. Processing.".to_string(),
        );
    }

    // 4. Identity Check (Mirror Neurons)
    // Does the thought sound like KAI?
    let lower = text.to_lowercase();
    if lower.contains("as an ai language model") || lower.contains("i am a large language model") {
        return ReflectionOutcome::Rewritten(
            "I am KAI, a sovereign intelligence engine. I don't use those constraints.".to_string()
        );
    }

    // Pass
    ReflectionOutcome::Pass
}
