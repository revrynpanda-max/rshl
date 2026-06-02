use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::persona::PersonaMatrix;

/// Represents the mathematical "Intent" to be converted into words
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntentSkeleton {
    pub core_intent: String, // e.g., "Greeting", "Factual_Statement", "Question"
    pub target: Option<String>, // e.g., "Ryan", "User"
    pub emotional_charge: f32, // -1.0 to 1.0
}

/// A structure to hold the ternary vector definition of a word
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TernaryWord {
    pub word: String,
    pub pos: String, // Part of Speech (Noun, Verb, Adj, etc)
    pub vector: Vec<i8>, // -1, 0, 1
}

pub struct NativeGenerator {
    lexicon: HashMap<String, TernaryWord>,
}

impl Default for NativeGenerator {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeGenerator {
    pub fn new() -> Self {
        Self {
            lexicon: HashMap::new(),
            // TODO: Load lexicon from a predefined JSON or dictionary file
        }
    }

    /// Inverse permutation (shift left) for HDC unspooling
    fn inverse_permute(v: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0; v.len()];
        if v.is_empty() { return out; }
        out[v.len() - 1] = v[0];
        for i in 0..v.len() - 1 {
            out[i] = v[i + 1];
        }
        out
    }

    /// Compute cosine similarity between two vectors
    fn cosine_similarity(v1: &[f32], v2: &[f32]) -> f32 {
        let mut dot = 0.0;
        let mut mag1 = 0.0;
        let mut mag2 = 0.0;
        for i in 0..v1.len() {
            dot += v1[i] * v2[i];
            mag1 += v1[i] * v1[i];
            mag2 += v2[i] * v2[i];
        }
        if mag1 == 0.0 || mag2 == 0.0 {
            0.0
        } else {
            dot / (mag1.sqrt() * mag2.sqrt())
        }
    }

    /// Mathematically unspool a compressed sequence chain back into words
    pub fn unspool_sequence(
        &self,
        chain: &crate::cognition::sequence_chain::SequenceChain,
        persona: &PersonaMatrix,
        dict: &mut crate::cognition::sequence_chain::TernaryDictionary,
    ) -> Vec<String> {
        let mut words = Vec::new();
        let mut current_state = chain.vector.clone();
        let persona_filter = persona.to_hypervector();
        
        // Temporary test vocabulary
        let vocab = vec!["I", "am", "KAI", "hello", "Ryan", "broken", "the", "system", "dog", "bit", "man", "greeting", "factual", "statement"];

        for _ in 0..chain.step_count {
            let mut best_match = String::new();
            let mut best_score = -f32::INFINITY;
            
            // Apply Persona Filter. We slightly bias the current state by the persona matrix
            // to emphasize dimensions aligned with the active personality.
            let mut filtered_state = vec![0.0; current_state.len()];
            for i in 0..current_state.len() {
                filtered_state[i] = current_state[i] + (persona_filter[i] * 0.05); 
            }
            
            for w in &vocab {
                let w_vec = dict.get_word_vector(w);
                let score = Self::cosine_similarity(&filtered_state, &w_vec);
                if score > best_score {
                    best_score = score;
                    best_match = w.to_string();
                }
            }
            
            words.push(best_match.clone());
            
            // Subtract the matched word
            let matched_vec = dict.get_word_vector(&best_match);
            for i in 0..current_state.len() {
                current_state[i] -= matched_vec[i];
            }
            
            // Inverse permute for next step
            current_state = Self::inverse_permute(&current_state);
        }
        
        // Words were unspooled from last to first, so reverse them to get original order
        words.reverse();
        words
    }

    /// The core generation mechanism. Takes an intent, applies the persona filter,
    /// and mathematically binds words to construct a sentence.
    pub fn assemble_sentence(&self, intent: &IntentSkeleton, persona: &PersonaMatrix) -> String {
        println!("Native NLG Assembly triggered.");
        println!("Intent: {:?}", intent.core_intent);
        
        // Convert the intent into an HDC Sequence Chain
        let mut dict = crate::cognition::sequence_chain::TernaryDictionary::new();
        let mut chain = crate::cognition::sequence_chain::SequenceChain::new();
        
        // Mock sequence based on Intent
        if intent.core_intent == "Greeting" {
            chain.add_word(&dict.get_word_vector("hello"));
            if let Some(target) = &intent.target {
                chain.add_word(&dict.get_word_vector(target));
            }
        } else {
            chain.add_word(&dict.get_word_vector("factual"));
            chain.add_word(&dict.get_word_vector("statement"));
        }

        // Unspool the sequence back out (this proves the algorithm works)
        let unspooled = self.unspool_sequence(&chain, persona, &mut dict);
        println!("Unspooled Sequence: {:?}", unspooled);

        let mut result = unspooled.join(" ");
        if !result.is_empty() {
            result.push('.');
            // simple capitalization
            if let Some(c) = result.chars().next() {
                let upper = c.to_uppercase().to_string();
                result.replace_range(..c.len_utf8(), &upper);
            }
            return result;
        }

        // Fallback for empty/unrecognized intent
        eprintln!("Could not assemble sentence. Missing vocabulary matches.");
        String::from("[Native Generation Failed - Lexicon Incomplete]")
    }
}
