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
use serde_json::Value;
use std::io::{BufRead, BufReader};
use candle_core::IndexOp;

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

    pub fn project_to_sublattice(&self, max_dim: u16) -> SparseTernaryVec {
        let mut indices = Vec::new();
        let mut signs = Vec::new();
        for (idx, sign) in self.indices.iter().zip(self.signs.iter()) {
            if *idx < max_dim {
                indices.push(*idx);
                signs.push(*sign);
            }
        }
        SparseTernaryVec {
            indices,
            signs,
            dim: max_dim as usize,
        }
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
pub struct EmbeddingsContainer {
    pub count: usize,
    pub tokens: Vec<EmbeddingMeta>,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct NeuralStructure {
    pub layers: Vec<LayerMeta>,
    pub embeddings: EmbeddingsContainer,
}

pub struct LanguageWarehouse {
    pub vocab: HashMap<String, SparseTernaryVec>,
    pub vocab_index: HashMap<String, EmbeddingMeta>, // NEW: Lazy index
    pub dim: usize,
    pub source_model: String,
    pub format: String,
    
    pub neural_structure: Option<NeuralStructure>,
    mmap_data: Option<Mmap>,

    // The native Transformer logic fused into the warehouse
    pub native_transformer: Option<(crate::cognition::bitnet_llama::Llama, crate::cognition::bitnet_llama::Config, tokenizers::Tokenizer, candle_core::Device)>,
}

impl LanguageWarehouse {
    pub fn empty() -> Self {
        Self {
            vocab: HashMap::new(),
            vocab_index: HashMap::new(),
            dim: 16384,
            source_model: "none".to_string(),
            format: "sparse_ternary".to_string(),
            neural_structure: None,
            mmap_data: None,
            native_transformer: None,
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
        
        // SMARTER NOT HARDER: Populate only the vocab_index, not the full vocab.
        // This drops RAM usage massively by relying on zero-copy mmap reads.
        self.vocab.clear();
        self.vocab_index.clear();
        for emb in &ns.embeddings.tokens {
            self.vocab_index.insert(emb.token.clone(), emb.clone());
        }
        println!("[LanguageWarehouse] Indexed {} sparse embeddings into Vocab Space (Lazy loaded via mmap).", self.vocab_index.len());

        self.neural_structure = Some(ns);
        self.mmap_data = Some(mmap);
    }
    

    pub fn get_lazy(&self, word: &str) -> Option<SparseTernaryVec> {
        if let Some(v) = self.vocab.get(word) {
            return Some(v.clone());
        }
        
        let meta = self.vocab_index.get(word)?;
        let mmap = self.mmap_data.as_ref()?;
        
        let start = meta.offset;
        let end = start + meta.size;
        if end > mmap.len() { return None; }
        
        let slice = &mmap[start..end];
        if slice.len() >= 4 {
            let mut count_bytes = [0u8; 4];
            count_bytes.copy_from_slice(&slice[0..4]);
            let count = u32::from_le_bytes(count_bytes) as usize;
            
            if count == meta.nonzero && slice.len() >= 4 + count * 4 + count {
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
                    signs.push(slice[sign_offset + i] as i8);
                }
                
                return Some(SparseTernaryVec {
                    indices,
                    signs,
                    dim: self.dim, // Use actual dimension
                });
            }
        }
        None
    }

    pub fn cosine_mmap(&self, target: &SparseTernaryVec, meta: &EmbeddingMeta) -> f32 {
        let mmap = match self.mmap_data.as_ref() {
            Some(m) => m,
            None => return 0.0,
        };
        let start = meta.offset;
        let end = start + meta.size;
        if end > mmap.len() { return 0.0; }
        let slice = &mmap[start..end];
        if slice.len() < 4 { return 0.0; }
        
        let count = meta.nonzero;
        if slice.len() < 4 + count * 4 + count { return 0.0; }
        
        let mut dot = 0i32;
        let mut i = 0usize;
        let mut j = 0usize;
        
        let t_indices = &target.indices;
        let t_signs = &target.signs;
        
        let idx_base = 4;
        let sign_base = 4 + count * 4;
        
        while i < count && j < t_indices.len() {
            let mut b = [0u8; 4];
            b.copy_from_slice(&slice[idx_base + i*4 .. idx_base + i*4 + 4]);
            let a_idx = u32::from_le_bytes(b) as u16;
            let b_idx = t_indices[j];
            
            if a_idx == b_idx {
                let a_sign = slice[sign_base + i] as i8 as i32;
                let b_sign = t_signs[j] as i32;
                dot += a_sign * b_sign;
                i += 1;
                j += 1;
            } else if a_idx < b_idx {
                i += 1;
            } else {
                j += 1;
            }
        }
        
        let mag_a = (count as f32).sqrt();
        let mag_b = (t_indices.len() as f32).sqrt();
        
        if mag_a == 0.0 || mag_b == 0.0 {
            return 0.0;
        }
        
        dot as f32 / (mag_a * mag_b)
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

    // forward_pass_polychora: EXCLUDED FROM BUILD (dead — zero callers anywhere
    // in the crate; verified by grep). It was the ONLY consumer of the
    // `polychora` module, which is now mod-excluded in cognition/mod.rs. Its body
    // was a self-described placeholder ("simulate structural resonance"). Kept
    // here commented for reversibility; re-enable alongside `pub mod polychora;`.
    /*
    pub fn forward_pass_polychora(&self, input: &SparseTernaryVec) -> SparseTernaryVec {
        if self.neural_structure.is_none() {
            return input.clone();
        }
        let q = crate::cognition::polychora::project_to_4d(input);
        let vertices = crate::cognition::polychora::get_600_cell_vertices();
        let vertex_id = crate::cognition::polychora::snap_to_600_cell(&q, vertices);
        let mut out_indices = input.indices.clone();
        let out_signs = input.signs.clone();
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
    */

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

        Self { vocab, vocab_index: HashMap::new(), dim, source_model, format, neural_structure: None, mmap_data: None, native_transformer: None }
    }

    pub fn native_decode(&self, prompt_str: &str, max_tokens: usize) -> Option<String> {
        let (llama, config, tokenizer, device) = self.native_transformer.as_ref()?;
        
        let encoding = tokenizer.encode(prompt_str, true).ok()?;
        let mut prompt_ids = encoding.get_ids().to_vec();
        
        if prompt_ids.first() != Some(&config.bos_token_id) {
            prompt_ids.insert(0, config.bos_token_id);
        }
        
        let mut cache = crate::cognition::bitnet_llama::Cache::new(true, candle_core::DType::F32, config, device).ok()?;
        let mut generated_ids = Vec::new();
        let mut pos = 0;
        
        let dict = crate::core::pos_dict::get_dictionary();
        
        for _ in 0..max_tokens {
            let input_tensor = candle_core::Tensor::new(prompt_ids.as_slice(), device).ok()?.unsqueeze(0).ok()?;
            let logits = llama.forward(&input_tensor, pos, &mut cache).ok()?;
            
            // bitnet_llama forward() already slices to the last sequence token, 
            // so logits is of shape (batch_size, vocab_size).
            let last_logits = logits.i((0, ..)).ok()?;
            let mut logits_vec = last_logits.to_vec1::<f32>().ok()?;
            
            // --- SRHT Born-Modulated Emergence Scoring & Logit Biasing ---
            let prompt_words: Vec<String> = prompt_str
                .split_whitespace()
                .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
                .filter(|s| !s.is_empty())
                .collect();
            let prompt_words_ref: Vec<&str> = prompt_words.iter().map(|s| s.as_str()).collect();
            
            let mut indexed_logits: Vec<(usize, f32)> = logits_vec.iter().enumerate().map(|(i, &v)| (i, v)).collect();
            indexed_logits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            
            for &(token_id, _) in indexed_logits.iter().take(15) {
                let mut temp_ids = generated_ids.clone();
                temp_ids.push(token_id as u32);
                if let Ok(tentative_text) = tokenizer.decode(&temp_ids, false) {
                    let tentative_words: Vec<String> = tentative_text
                        .split_whitespace()
                        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
                        .filter(|s| !s.is_empty())
                        .collect();
                    let tentative_words_ref: Vec<&str> = tentative_words.iter().map(|s| s.as_str()).collect();
                    
                    let parsed = crate::cognition::algebra::parse_equation(&tentative_text, Some(dict));
                    
                    let rho = ((generated_ids.len() + 1) as f32 / max_tokens as f32).min(1.0).max(0.1);
                    
                    let mut g = 0.8;
                    if !prompt_words_ref.is_empty() && !tentative_words_ref.is_empty() {
                        if let Some(prompt_emb) = self.phrase_embedding(&prompt_words_ref) {
                            if let Some(tentative_emb) = self.phrase_embedding(&tentative_words_ref) {
                                // Dynamic Sublattice Projection: project 16K down to 4096
                                let prompt_emb_4096 = prompt_emb.project_to_sublattice(4096);
                                let tentative_emb_4096 = tentative_emb.project_to_sublattice(4096);
                                let sim = tentative_emb_4096.cosine(&prompt_emb_4096);
                                g = 0.5 + (sim.max(0.0) * 0.5);
                            }
                        }
                    }
                    
                    let mut r_coeff = 0.5;
                    let mut chi = 0.1;
                    
                    if parsed.intent_sum == "Unknown formulation" {
                        if tentative_words.len() >= 4 {
                            chi = 0.3;
                            r_coeff = 0.4;
                        } else {
                            chi = 0.1;
                            r_coeff = 0.5;
                        }
                    } else {
                        r_coeff = 0.8;
                        chi = 0.1;
                    }
                    
                    let mut syntax_error = false;
                    for win in parsed.nodes.windows(2) {
                        if (win[0].symbol() == "F" && win[1].symbol() == "F") 
                            || (win[0].symbol() == "A" && win[1].symbol() == "A" && win[0].text() == win[1].text())
                        {
                            syntax_error = true;
                            break;
                        }
                    }
                    
                    // Word repetition check
                    if tentative_words.len() >= 2 {
                        let len = tentative_words.len();
                        if tentative_words[len - 1].to_lowercase() == tentative_words[len - 2].to_lowercase() {
                            let w = tentative_words[len - 1].to_lowercase();
                            if !["the", "and", "a", "of", "to", "in", "is", "that"].contains(&w.as_str()) {
                                syntax_error = true;
                            }
                        }
                    }
                    
                    // Loop detection
                    let mut repetitions = 0;
                    if tentative_words.len() >= 6 {
                        let last_word = tentative_words.last().unwrap().to_lowercase();
                        for w in tentative_words.iter().rev().skip(1).take(5) {
                            if w.to_lowercase() == last_word {
                                repetitions += 1;
                            }
                        }
                    }
                    if repetitions > 1 {
                        syntax_error = true;
                    }
                    
                    if syntax_error {
                        chi = 0.95;
                        r_coeff = 0.1;
                    }
                    
                    let s = 1.0 / (2.0 - r_coeff);
                    let phi_g = rho * (r_coeff * r_coeff) * s * (1.0 - chi) * g;
                    let c_readiness = phi_g * (1.0 - chi) * 0.8;
                    
                    // Born rule phase modulation: P = C * cos^4(chi * pi/2)
                    let phase_term = ((chi * std::f32::consts::PI / 2.0).cos()).powf(4.0).max(1e-10);
                    let bias = phase_term.ln() + (c_readiness * 6.0);
                    
                    if token_id < logits_vec.len() {
                        logits_vec[token_id] += bias;
                    }
                }
            }
            
            let next_token = crate::cognition::language_warehouse::sample(&mut logits_vec, &generated_ids, 1.15, 0.7, 0.9);
            if next_token == config.eos_token_id {
                break;
            }
            
            generated_ids.push(next_token);
            pos += prompt_ids.len();
            prompt_ids.clear();
            prompt_ids.push(next_token);
            
            if let Ok(current_text) = tokenizer.decode(&generated_ids, false) {
                let trimmed = current_text.trim_start();
                if !trimmed.is_empty() && (trimmed.contains('\n') || trimmed.contains("Human:") || trimmed.contains("KAI:")) {
                    break;
                }
            }
        }
        
        let mut decoded = tokenizer.decode(&generated_ids, false).ok()?;
        if let Some(idx) = decoded.find("\n") {
            decoded.truncate(idx);
        }
        if let Some(idx) = decoded.find("Human:") {
            decoded.truncate(idx);
        }
        if let Some(idx) = decoded.find("KAI:") {
            decoded.truncate(idx);
        }
        Some(decoded.trim().to_string())
    }

    pub fn is_loaded(&self) -> bool {
        // The native BitNet brain counts as "loaded" too. Without this, whenever
        // the (now-retired) sparse-vocab path is empty, init_language_warehouse
        // discarded the ENTIRE warehouse — including the native brain that had just
        // mounted successfully — so BitNet contributed nothing at runtime. The brain
        // alone now keeps the warehouse alive.
        !self.vocab.is_empty() || !self.vocab_index.is_empty() || self.native_transformer.is_some()
    }

    pub fn get(&self, word: &str) -> Option<&SparseTernaryVec> {
        self.vocab.get(word)
    }

    pub fn word_similarity(&self, word_a: &str, word_b: &str) -> f32 {
        let Some(a) = self.get_lazy(word_a) else { return 0.0 };
        let Some(b) = self.get_lazy(word_b) else { return 0.0 };
        a.cosine(&b)
    }

    pub fn nearest_neighbors(&self, word: &str, n: usize) -> Vec<(String, f32)> {
        let Some(target) = self.get_lazy(word) else {
            return Vec::new();
        };

        let mut scored: Vec<(String, f32)> = if self.vocab_index.is_empty() {
            self.vocab.par_iter()
                .filter(|(w, _)| w.as_str() != word)
                .map(|(w, vec)| (w.clone(), target.cosine(vec)))
                .filter(|(_, sim)| *sim > 0.1)
                .collect()
        } else {
            self.vocab_index.par_iter()
                .filter(|(w, _)| w.as_str() != word)
                .map(|(w, meta)| (w.clone(), self.cosine_mmap(&target, meta)))
                .filter(|(_, sim)| *sim > 0.1)
                .collect()
        };

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);
        scored
    }

    pub fn phrase_embedding(&self, words: &[&str]) -> Option<SparseTernaryVec> {
        let mut owned_vecs = Vec::new();
        for word in words {
            if let Some(v) = self.get_lazy(*word) {
                owned_vecs.push(v);
            }
        }

        if owned_vecs.is_empty() {
            return None;
        }
        
        let refs: Vec<&SparseTernaryVec> = owned_vecs.iter().collect();
        Some(SparseTernaryVec::from_words(&refs))
    }
}

// ── Global Singleton ─────────────────────────────────────────────────────

static LANGUAGE_WAREHOUSE: OnceLock<RwLock<LanguageWarehouse>> = OnceLock::new();

pub fn init_language_warehouse(path: &str) {
    // SPARSE-VOCAB WAREHOUSE RETIRED (2026-06). The old neural_weights.bin (WIAK)
    // path is orphaned: its on-disk index (neural_structure.json) is a GGUF tensor
    // dump, NOT the {layers, embeddings} that load_neural_structure deserializes
    // into — so it ALWAYS failed to parse and produced an empty vocab, and no
    // current code reads the WIAK format anyway. The live BitNet integration is the
    // NATIVE BRAIN mounted just below. We skip the dead load entirely (no silent
    // error, no wasted work). To revive sparse-vocab embeddings later, build a fresh
    // extractor + a matching per-token index + a loader (see
    // tools/diagnose_bitnet_ingest.py for the format gap).
    let _ = path; // retained for call-site compatibility
    let mut warehouse = LanguageWarehouse::empty();

    // ── STAGE 1: LATTICE VOCAB FROM BITNET (extracted sparse-ternary embeddings) ──
    // The new extractor (extract_bitnet_to_lattice.py) projects each BitNet token
    // embedding into KAI's 16384-dim sparse-ternary space and writes a MATCHING
    // index (data/neural_structure.json -> {layers, embeddings.count, tokens[]})
    // plus the per-token vectors in models/BitNet/neural_weights.bin. When those
    // files are present, load_neural_structure() now parses cleanly and populates
    // vocab_index (lazy mmap reads). This is KAI using its OWN brain: the lattice,
    // not the live transformer and not Ollama. It is ADDITIVE and gated only on the
    // files existing — if they're absent, load_neural_structure() degrades quietly
    // (prints a note, leaves the warehouse empty) and we fall through unchanged.
    // This runs REGARDLESS of KAI_NATIVE_BRAIN: the transformer stays OFF; the
    // lattice vocab is the point.
    {
        // Prefer the canonical extractor output location, fall back to legacy.
        let structure_candidates = [
            "data/neural_structure.json",
            "C:\\KAI\\data\\neural_structure.json",
            "models/BitNet/neural_structure.json",
        ];
        let mut loaded_vocab = false;
        for cand in structure_candidates {
            if std::path::Path::new(cand).exists() {
                warehouse.load_neural_structure(cand);
                if !warehouse.vocab_index.is_empty() || !warehouse.vocab.is_empty() {
                    println!("[LanguageWarehouse] Lattice vocab loaded from '{}' ({} tokens) — KAI is using its own brain (transformer stays OFF).", cand, warehouse.vocab_index.len().max(warehouse.vocab.len()));
                    loaded_vocab = true;
                    break;
                }
            }
        }
        if !loaded_vocab {
            println!("[LanguageWarehouse] No lattice vocab found (run extract_bitnet_to_lattice.py to populate data/neural_structure.json + models/BitNet/neural_weights.bin). Continuing without it.");
        }
    }

    // ── NATIVE BITNET BRAIN — RAM-gated, default OFF ────────────────────────────
    // Mounting this DEQUANTIZES the 2B ternary weights to f32 (~8GB) and clones the
    // token-embedding matrix twice (~2.6GB) — roughly ~10GB resident — EVEN THOUGH
    // generation currently routes through Ollama, so the model sits loaded but
    // unused. That ~10GB is the bulk of the engine's RAM on a small cell count.
    // So we DON'T load it by default. Set KAI_NATIVE_BRAIN=1 to mount it once the
    // native generator is actually the live path. (The real long-term fix is to
    // keep the weights PACKED and do a true BitLinear ternary matmul instead of
    // dequantizing to f32 — that's the endgame; until then, don't pay 10GB for a
    // dead load.)
    let want_native_brain = std::env::var("KAI_NATIVE_BRAIN")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !want_native_brain {
        println!("[LanguageWarehouse] Native BitNet brain SKIPPED (KAI_NATIVE_BRAIN!=1) — reclaims ~10GB RAM. Set KAI_NATIVE_BRAIN=1 to load the native brain.");
        // The transformer is off, but the LATTICE VOCAB may have loaded above.
        // Publish the warehouse so the lattice embeddings are usable at runtime
        // instead of being discarded (which is what left the engine with nothing).
        if warehouse.is_loaded() {
            println!("[LanguageWarehouse] Publishing lattice warehouse (vocab present, transformer OFF).");
            let _ = LANGUAGE_WAREHOUSE.set(RwLock::new(warehouse));
        } else {
            println!("[LanguageWarehouse] No lattice vocab and transformer OFF — language warehouse unavailable (generation runs via Ollama).");
        }
        return;
    }

    // Attempt to mount native BitNet brain as part of the pure lattice
    use crate::cognition::bitnet_llama::{Llama, Config};
    use crate::cognition::bitnet_brain::BitNetBrain;
    use tokenizers::Tokenizer;

    println!("[LanguageWarehouse] Booting native transformer logic (KAI_NATIVE_BRAIN=1)...");
    let config = Config::bitnet_2b_4t();
    // DEVICE SELECTION (Stage 1 of heterogeneous compute): put the BitNet LLM on
    // the GPU when one is actually usable, otherwise fall back to CPU. The LLM was
    // previously pinned to CPU — this is the single biggest CPU-load offload.
    // SAFE BY DEFAULT: `cuda_if_available` returns the CPU device unless candle is
    // built with its `cuda` feature AND a GPU is present, so the normal build is
    // unchanged. To actually use the GPU: install the CUDA toolkit and build with
    // `--features llm-cuda` (see Cargo.toml).
    let device = candle_core::Device::cuda_if_available(0).unwrap_or(candle_core::Device::Cpu);
    println!("[LanguageWarehouse] BitNet brain device: {:?}", device);
    if let Ok(brain) = BitNetBrain::mount("models/BitNet/Native") {
        if let Ok(llama) = Llama::from_brain(&brain, &config, &device) {
            if let Ok(tokenizer) = Tokenizer::from_file("models/BitNet/tokenizer.json") {
                println!("[LanguageWarehouse] Native transformer fused successfully.");
                warehouse.native_transformer = Some((llama, config, tokenizer, device));
            }
        }
    }

    if warehouse.is_loaded() {
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

    let mut scored: Vec<(String, f32)> = if warehouse.vocab_index.is_empty() {
        warehouse.vocab.par_iter().filter_map(|(w, vec)| {
            let sim = query_emb.cosine(vec);
            if sim > 0.2 { Some((w.clone(), sim)) } else { None }
        }).collect()
    } else {
        warehouse.vocab_index.par_iter().filter_map(|(w, meta)| {
            let sim = warehouse.cosine_mmap(&query_emb, meta);
            if sim > 0.2 { Some((w.clone(), sim)) } else { None }
        }).collect()
    };

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
        let size = if w.vocab_index.is_empty() { w.vocab.len() } else { w.vocab_index.len() };
        (true, size, w.dim)
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
    w.vocab.contains_key(word) || w.vocab_index.contains_key(word)
}

pub fn has_native_transformer() -> bool {
    let global = match LANGUAGE_WAREHOUSE.get() {
        Some(g) => g,
        None => return false,
    };
    let w = global.read().unwrap();
    w.native_transformer.is_some()
}

// RUNTIME PROOF the native BitNet brain is actually CONTRIBUTING, not just mounted.
// This counter was effectively stuck at 0 before, because the warehouse (and the
// brain with it) got discarded by the old is_loaded() check, so has_native_transformer()
// returned false and the generate/voice paths never called the brain.
pub static NATIVE_DECODE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn native_decode_count() -> u64 {
    NATIVE_DECODE_COUNT.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn global_native_decode(prompt_str: &str, max_tokens: usize) -> Option<String> {
    let global = LANGUAGE_WAREHOUSE.get()?;
    let w = global.read().unwrap();
    let out = w.native_decode(prompt_str, max_tokens);
    if let Some(ref s) = out {
        let n = NATIVE_DECODE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        // Watch the engine console: a RISING count means the BitNet brain is being
        // used to generate. Stays at 0 ⇒ it's still not contributing.
        println!("[BitNetBrain] native_decode #{} — generated {} chars from a {}-char prompt.",
                 n, s.len(), prompt_str.len());
    }
    out
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

pub fn sample(
    logits_vec: &mut [f32],
    recent_tokens: &[u32],
    repeat_penalty: f32,
    temperature: f32,
    top_p: f32,
) -> u32 {
    if repeat_penalty != 1.0 {
        for &tok in recent_tokens {
            let idx = tok as usize;
            if idx < logits_vec.len() {
                let val = logits_vec[idx];
                if val > 0.0 { logits_vec[idx] = val / repeat_penalty; } 
                else { logits_vec[idx] = val * repeat_penalty; }
            }
        }
    }
    if temperature <= 0.0 {
        let mut best_id = 0;
        let mut best_val = f32::NEG_INFINITY;
        for (i, &val) in logits_vec.iter().enumerate() {
            if val > best_val { best_val = val; best_id = i; }
        }
        return best_id as u32;
    }
    if temperature != 1.0 {
        for val in logits_vec.iter_mut() { *val /= temperature; }
    }
    let mut max_val = f32::NEG_INFINITY;
    for &val in logits_vec.iter() {
        if val > max_val { max_val = val; }
    }
    let mut probs: Vec<(usize, f32)> = Vec::with_capacity(logits_vec.len());
    let mut sum_exp = 0.0;
    for (i, &val) in logits_vec.iter().enumerate() {
        let p = (val - max_val).exp();
        probs.push((i, p));
        sum_exp += p;
    }
    for (_, p) in probs.iter_mut() { *p /= sum_exp; }
    probs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    if top_p < 1.0 {
        let mut cumulative_prob = 0.0;
        let mut cutoff_idx = probs.len();
        for (idx, &(_, p)) in probs.iter().enumerate() {
            cumulative_prob += p;
            if cumulative_prob >= top_p { cutoff_idx = idx + 1; break; }
        }
        probs.truncate(cutoff_idx);
        let mut new_sum = 0.0;
        for &(_, p) in probs.iter() { new_sum += p; }
        for (_, p) in probs.iter_mut() { *p /= new_sum; }
    }
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let r: f32 = rng.gen();
    let mut cum = 0.0;
    for &(id, p) in probs.iter() {
        cum += p;
        if r <= cum { return id as u32; }
    }
    probs[0].0 as u32
}
