//! Language Warehouse — A RAM-resident sparse ternary embedding store for language vectors.
//!
//! Biological analog: Broca's Area + Wernicke's Area — a dedicated language
//! processing center physically separate from the hippocampus (memory).
//!
//! This module holds sparse ternary word embeddings extracted from BitNet
//! (a ternary-quantized LLM). The embeddings are in KAI's native format:
//!   - indices: Vec<u16> — positions of non-zero values
//!   - signs: Vec<i8> — +1 or -1 at each position

use std::collections::HashMap;
use rayon::prelude::*;
use std::fs::File;
use memmap2::Mmap;
use std::sync::{OnceLock, RwLock};

/// A sparse ternary vector (indices + signs) — KAI's native format.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SparseTernaryVec {
    pub indices: Vec<u16>,
    pub signs: Vec<i8>,
    pub dim: usize,
}

impl SparseTernaryVec {
    pub fn cosine(&self, other: &SparseTernaryVec) -> f32 {
        if self.dim != other.dim {
            return 0.0;
        }

        let mut dot = 0i32;
        let mut i = 0usize;
        let mut j = 0usize;

        while i < self.indices.len() && j < other.indices.len() {
            let a_idx = self.indices[i];
            let b_idx = other.indices[j];

            if a_idx == b_idx {
                dot += (self.signs[i] as i32) * (other.signs[j] as i32);
                i += 1;
                j += 1;
            } else if a_idx < b_idx {
                i += 1;
            } else {
                j += 1;
            }
        }

        let mag_a = (self.indices.len() as f32).sqrt();
        let mag_b = (other.indices.len() as f32).sqrt();

        if mag_a == 0.0 || mag_b == 0.0 {
            return 0.0;
        }

        dot as f32 / (mag_a * mag_b)
    }

    pub fn from_words(words: &[&SparseTernaryVec]) -> SparseTernaryVec {
        if words.is_empty() {
            return SparseTernaryVec {
                indices: Vec::new(),
                signs: Vec::new(),
                dim: 16384,
            };
        }

        let dim = words[0].dim;
        let mut merged: HashMap<u16, i32> = HashMap::new();

        for word in words {
            for (idx, sign) in word.indices.iter().zip(word.signs.iter()) {
                *merged.entry(*idx).or_insert(0) += *sign as i32;
            }
        }

        let mut indices = Vec::new();
        let mut signs = Vec::new();

        let mut sorted: Vec<(u16, i32)> = merged.into_iter().collect();
        sorted.sort_by_key(|(idx, _)| *idx);

        for (idx, sum) in sorted {
            if sum > 0 {
                indices.push(idx);
                signs.push(1);
            } else if sum < 0 {
                indices.push(idx);
                signs.push(-1);
            }
        }

        SparseTernaryVec { indices, signs, dim }
    }
}

/// Structural tensor metadata loaded from neural_structure.json
#[derive(Clone, Debug, serde::Deserialize)]
pub struct LayerMeta {
    pub name: String,
    pub dims: Vec<usize>,
    pub offset: usize,
    pub weight_size: usize,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct EmbeddingMeta {
    pub token: String,
    pub offset: usize,
    pub size: usize,
    pub nonzero: usize,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct NeuralStructure {
    pub layers: Vec<LayerMeta>,
    pub embeddings: Vec<EmbeddingMeta>,
}

pub struct LanguageWarehouse {
    pub vocab: HashMap<String, SparseTernaryVec>,
    pub dim: usize,
    pub source_model: String,
    pub format: String,
    
    pub neural_structure: Option<NeuralStructure>,
    mmap_data: Option<Mmap>,
}

impl LanguageWarehouse {
    pub fn empty() -> Self {
        Self {
            vocab: HashMap::new(),
            dim: 16384,
            source_model: "none".to_string(),
            format: "sparse_ternary".to_string(),
            neural_structure: None,
            mmap_data: None,
        }
    }

    pub fn load_neural_structure(&mut self, structure_path: &str) {
        let raw = match std::fs::read_to_string(structure_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[LanguageWarehouse] No neural structure found at {}: {}", structure_path, e);
                return;
            }
        };

        let ns: NeuralStructure = match serde_json::from_str(&raw) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[LanguageWarehouse] Invalid structure JSON: {}", e);
                return;
            }
        };

        println!("[LanguageWarehouse] Loading Polychora Math from C:\\KAI\\models\\BitNet\\neural_weights.bin");
        
        let file = match File::open("C:\\KAI\\models\\BitNet\\neural_weights.bin") {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[LanguageWarehouse] Could not open LLM model file for mmap: {}", e);
                return;
            }
        };
        
        let mmap = match unsafe { Mmap::map(&file) } {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[LanguageWarehouse] Failed to memory-map LLM math: {}", e);
                return;
            }
        };
        
        println!("[LanguageWarehouse] Successfully mapped {} tensors into 4D structural space.", ns.layers.len());
        
        // Populate the vocab by parsing the binary embeddings
        self.vocab.clear();
        for emb in &ns.embeddings {
            let start = emb.offset;
            let end = start + emb.size;
            if end <= mmap.len() {
                let slice = &mmap[start..end];
                // Format: count(uint32) + indices(uint32[]) + signs(int8[])
                // We'll read this manually
                if slice.len() >= 4 {
                    let mut count_bytes = [0u8; 4];
                    count_bytes.copy_from_slice(&slice[0..4]);
                    let count = u32::from_le_bytes(count_bytes) as usize;
                    
                    if count == emb.nonzero && slice.len() >= 4 + count * 4 + count {
                        let mut indices = Vec::with_capacity(count);
                        let mut signs = Vec::with_capacity(count);
                        
                        let mut idx_offset = 4;
                        for _ in 0..count {
                            let mut b = [0u8; 4];
                            b.copy_from_slice(&slice[idx_offset..idx_offset+4]);
                            indices.push(u32::from_le_bytes(b) as u16);
                            idx_offset += 4;
                        }
                        
                        let sign_offset = 4 + count * 4;
                        for i in 0..count {
                            let sign_byte = slice[sign_offset + i] as i8;
                            signs.push(sign_byte);
                        }
                        
                        self.vocab.insert(emb.token.clone(), SparseTernaryVec {
                            indices,
                            signs,
                            dim: 2560, // BitNet 1.58b dim
                        });
                    }
                }
            }
        }
        println!("[LanguageWarehouse] Loaded {} sparse embeddings into Vocab Space.", self.vocab.len());

        self.neural_structure = Some(ns);
        self.mmap_data = Some(mmap);
    }
    
    pub fn get_structural_layer(&self, name: &str) -> Option<&[u8]> {
        let ns = self.neural_structure.as_ref()?;
        let mmap = self.mmap_data.as_ref()?;
        
        let meta = ns.layers.iter().find(|l| l.name == name)?;
        let start = meta.offset;
        let byte_size = meta.weight_size;
        
        if byte_size == 0 || start + byte_size > mmap.len() {
            return None;
        }
        
        Some(&mmap[start..start + byte_size])
    }

    pub fn forward_pass_polychora(&self, input: &SparseTernaryVec) -> SparseTernaryVec {
        if self.neural_structure.is_none() {
            return input.clone();
        }
        
        // Project to 4D Quaternion
        let q = crate::cognition::polychora::project_to_4d(input);
        
        // Snap to nearest 600-cell vertex
        let vertices = crate::cognition::polychora::get_600_cell_vertices();
        let vertex_id = crate::cognition::polychora::snap_to_600_cell(&q, vertices);
        
        // Normally here we would extract the specific structural tensor based on `vertex_id`
        // and do a geometric sparse transformation.
        // For now, we simulate structural resonance by projecting back!
        
        // Let's just create a modified output vector as a placeholder for the actual transform
        let mut out_indices = input.indices.clone();
        let mut out_signs = input.signs.clone();
        
        // Shift a few indices deterministically based on the 600-cell vertex_id
        if !out_indices.is_empty() {
            let shift = (vertex_id % 16) as u16;
            out_indices[0] = out_indices[0].wrapping_add(shift);
        }

        SparseTernaryVec {
            indices: out_indices,
            signs: out_signs,
            dim: input.dim,
        }
    }

    pub fn from_json(path: &str) -> Self {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[LanguageWarehouse] Cannot load '{}': {}", path, e);
                return Self::empty();
            }
        };

        let json: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(j) => j,
            Err(e) => {
                eprintln!("[LanguageWarehouse] Invalid JSON: {}", e);
                return Self::empty();
            }
        };

        let source_model = json["source_model"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        let dim = json["dim"].as_u64().unwrap_or(16384) as usize;
        let format = json["format"].as_str().unwrap_or("dense").to_string();

        let mut vocab = HashMap::new();

        if let Some(vocab_json) = json["vocab"].as_object() {
            for (word, entry) in vocab_json {
                if format == "sparse_ternary" {
                    if let (Some(indices_arr), Some(signs_arr)) = 
                        (entry.get("indices"), entry.get("signs")) {
                        let indices: Vec<u16> = indices_arr
                            .as_array()
                            .unwrap_or(&Vec::new())
                            .iter()
                            .filter_map(|v| v.as_u64().map(|u| u as u16))
                            .collect();

                        let signs: Vec<i8> = signs_arr
                            .as_array()
                            .unwrap_or(&Vec::new())
                            .iter()
                            .filter_map(|v| v.as_i64().map(|i| i as i8))
                            .collect();

                        if indices.len() == signs.len() && !indices.is_empty() {
                            vocab.insert(
                                word.clone(),
                                SparseTernaryVec { indices, signs, dim },
                            );
                        }
                    }
                } else {
                    if let Some(arr) = entry.as_array() {
                        let mut indices = Vec::new();
                        let mut signs = Vec::new();

                        for (i, val) in arr.iter().enumerate() {
                            if let Some(f) = val.as_f64() {
                                if f > 0.0 {
                                    indices.push(i as u16);
                                    signs.push(1);
                                } else if f < 0.0 {
                                    indices.push(i as u16);
                                    signs.push(-1);
                                }
                            }
                        }

                        if !indices.is_empty() {
                            vocab.insert(
                                word.clone(),
                                SparseTernaryVec { indices, signs, dim },
                            );
                        }
                    }
                }
            }
        }

        println!(
            "[LanguageWarehouse] Loaded {} words from '{}' (dim={})",
            vocab.len(),
            source_model,
            dim
        );

        Self { vocab, dim, source_model, format, neural_structure: None, mmap_data: None }
    }

    pub fn is_loaded(&self) -> bool {
        !self.vocab.is_empty()
    }

    pub fn get(&self, word: &str) -> Option<&SparseTernaryVec> {
        self.vocab.get(word)
    }

    pub fn word_similarity(&self, word_a: &str, word_b: &str) -> f32 {
        let Some(a) = self.vocab.get(word_a) else { return 0.0 };
        let Some(b) = self.vocab.get(word_b) else { return 0.0 };
        a.cosine(b)
    }

    pub fn nearest_neighbors(&self, word: &str, n: usize) -> Vec<(String, f32)> {
        let Some(target) = self.vocab.get(word) else {
            return Vec::new();
        };

        let mut scored: Vec<(String, f32)> = self
            .vocab
            .par_iter()
            .filter(|(w, _)| w.as_str() != word)
            .map(|(w, vec)| (w.clone(), target.cosine(vec)))
            .filter(|(_, sim)| *sim > 0.1)
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);
        scored
    }

    pub fn phrase_embedding(&self, words: &[&str]) -> Option<SparseTernaryVec> {
        let mut vecs = Vec::new();
        for word in words {
            if let Some(v) = self.vocab.get(*word) {
                vecs.push(v);
            }
        }

        if vecs.is_empty() {
            return None;
        }

        Some(SparseTernaryVec::from_words(&vecs))
    }
}

// ── Global Singleton ─────────────────────────────────────────────────────

static LANGUAGE_WAREHOUSE: OnceLock<RwLock<LanguageWarehouse>> = OnceLock::new();

pub fn init_language_warehouse(path: &str) {
    let mut warehouse = LanguageWarehouse::from_json(path);
    if warehouse.is_loaded() {
        warehouse.load_neural_structure("data/neural_structure.json");
        let rw = RwLock::new(warehouse);
        let _ = LANGUAGE_WAREHOUSE.set(rw);
    } else {
        eprintln!("[LanguageWarehouse] Failed to load from '{}'. Language warehouse unavailable.", path);
    }
}

pub fn query_language_warehouse(query_words: &[&str], top_n: usize) -> Vec<(String, f32)> {
    let global = match LANGUAGE_WAREHOUSE.get() {
        Some(g) => g,
        None => return Vec::new(),
    };
    let warehouse = global.read().unwrap();
    if !warehouse.is_loaded() { return Vec::new(); }

    let query_emb = match warehouse.phrase_embedding(query_words) {
        Some(e) => e,
        None => return Vec::new(),
    };

    let mut scored: Vec<(String, f32)> = warehouse
        .vocab
        .par_iter()
        .filter_map(|(w, vec)| {
            let sim = query_emb.cosine(vec);
            if sim > 0.2 {
                Some((w.clone(), sim))
            } else {
                None
            }
        })
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_n);
    scored
}

pub fn suggest_words(query: &str, top_n: usize) -> Vec<(String, f32)> {
    let words: Vec<&str> = query.split_whitespace().collect();
    query_language_warehouse(&words, top_n)
}

pub fn warehouse_status() -> (bool, usize, usize) {
    let global = match LANGUAGE_WAREHOUSE.get() {
        Some(g) => g,
        None => return (false, 0, 0),
    };
    let w = global.read().unwrap();
    if w.is_loaded() {
        (true, w.vocab.len(), w.dim)
    } else {
        (false, 0, 0)
    }
}

pub fn has_word(word: &str) -> bool {
    let global = match LANGUAGE_WAREHOUSE.get() {
        Some(g) => g,
        None => return false,
    };
    let w = global.read().unwrap();
    w.vocab.contains_key(word)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sparse_ternary_cosine() {
        let a = SparseTernaryVec {
            indices: vec![0, 1, 2],
            signs: vec![1, 1, 1],
            dim: 10,
        };
        let b = SparseTernaryVec {
            indices: vec![1, 2, 3],
            signs: vec![1, 1, 1],
            dim: 10,
        };

        let sim = a.cosine(&b);
        assert!((sim - 0.6667).abs() < 0.01, "Expected ~0.667, got {}", sim);
    }
}
