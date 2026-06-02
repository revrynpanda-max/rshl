use std::collections::HashMap;

/// The dimensionality of KAI's Sequence Hypervectors.
pub const HDC_DIM: usize = 1024;

/// Represents a sequential chain of meaning.
#[derive(Debug, Clone)]
pub struct SequenceChain {
    pub vector: Vec<f32>,
    pub step_count: usize,
}

impl Default for SequenceChain {
    fn default() -> Self {
        Self::new()
    }
}

impl SequenceChain {
    pub fn new() -> Self {
        Self {
            vector: vec![0.0; HDC_DIM],
            step_count: 0,
        }
    }

    /// Permute (shift) the vector by 1 position. This is the core HDC operation 
    /// that makes order matter: A * B != B * A
    fn permute(v: &[f32]) -> Vec<f32> {
        let mut out = vec![0.0; v.len()];
        if v.is_empty() { return out; }
        
        // Cyclic shift right by 1
        out[0] = v[v.len() - 1];
        for i in 1..v.len() {
            out[i] = v[i - 1];
        }
        out
    }

    /// Bind a new word vector into the sequence.
    /// S_new = word_vector + permute(S_old)
    pub fn add_word(&mut self, word_vector: &[f32]) {
        assert_eq!(word_vector.len(), HDC_DIM, "Word vector must match HDC_DIM");
        
        let permuted_state = Self::permute(&self.vector);
        
        for i in 0..HDC_DIM {
            // Superposition (addition) of the permuted history and the new word
            self.vector[i] = permuted_state[i] + word_vector[i];
        }
        self.step_count += 1;
    }

    /// Anchor context metadata into the chain (e.g. Persona, Intent)
    /// This multiplies the state by the context, altering the trajectory.
    pub fn anchor_context(&mut self, context_vector: &[f32]) {
        assert_eq!(context_vector.len(), HDC_DIM, "Context vector must match HDC_DIM");
        
        for i in 0..HDC_DIM {
            // Pointwise multiplication (binding) with context
            self.vector[i] *= context_vector[i];
        }
    }
}

/// A simple dictionary to generate pseudo-random HDC vectors for words
/// until the full Lexicon is migrated to HDC_DIM.
pub struct TernaryDictionary {
    cache: HashMap<String, Vec<f32>>,
}

impl Default for TernaryDictionary {
    fn default() -> Self {
        Self::new()
    }
}

impl TernaryDictionary {
    pub fn new() -> Self {
        Self {
            cache: HashMap::new(),
        }
    }

    /// Retrieve or generate a deterministic Ternary Vector for a word
    pub fn get_word_vector(&mut self, word: &str) -> Vec<f32> {
        if let Some(v) = self.cache.get(word) {
            return v.clone();
        }

        // Generate deterministic pseudo-random ternary vector [-1.0, 0.0, 1.0]
        let mut v = vec![0.0; HDC_DIM];
        let mut hash = 5381u32;
        for c in word.chars() {
            hash = hash.wrapping_mul(33).wrapping_add(c as u32);
        }

        for i in 0..HDC_DIM {
            hash = hash.wrapping_mul(1664525).wrapping_add(1013904223);
            let val = (hash % 3) as i32 - 1; // -1, 0, 1
            v[i] = val as f32;
        }

        self.cache.insert(word.to_string(), v.clone());
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sequence_order_matters() {
        let mut dict = TernaryDictionary::new();
        let dog = dict.get_word_vector("dog");
        let bit = dict.get_word_vector("bit");
        let man = dict.get_word_vector("man");

        // Chain 1: dog bit man
        let mut chain1 = SequenceChain::new();
        chain1.add_word(&dog);
        chain1.add_word(&bit);
        chain1.add_word(&man);

        // Chain 2: man bit dog
        let mut chain2 = SequenceChain::new();
        chain2.add_word(&man);
        chain2.add_word(&bit);
        chain2.add_word(&dog);

        // They must NOT be equal because order matters
        assert_ne!(chain1.vector, chain2.vector);
    }
}
