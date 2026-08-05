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
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use candle_core::{Device, IndexOp, Tensor};
use candle_transformers::generation::LogitsProcessor;
use candle_transformers::models::quantized_llama::ModelWeights as LlamaDenseWeights;
use candle_transformers::models::quantized_qwen2::ModelWeights as Qwen2DenseWeights;

/// Architecture-dispatching wrapper for the Dense Expert GGUF model.
/// Supports both Llama-family and Qwen2-family quantized models.
pub enum DenseModelWeights {
    Llama(LlamaDenseWeights),
    Qwen2(Qwen2DenseWeights),
}

impl DenseModelWeights {
    pub fn forward(&mut self, x: &Tensor, index_pos: usize) -> candle_core::Result<Tensor> {
        match self {
            Self::Llama(m) => m.forward(x, index_pos),
            Self::Qwen2(m) => m.forward(x, index_pos),
        }
    }
}
use tokenizers::Tokenizer;

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

/// KAI's custom ternary transformer model (trained from scratch on KAI's data).
/// Loaded from `models/kai-native/weights.bin` + `config.json`.
pub struct KaiNativeModel {
    pub config: KaiNativeConfig,
    /// Packed weight data (ternary as i2 packed bytes, float32 for embeddings/norms)
    pub weight_data: Vec<(String, Vec<usize>, Vec<u8>, bool)>, // (name, shape, data, is_ternary)
    /// Embedding matrix (vocab_size x dim) as f32
    pub embed_weight: Vec<f32>,
    /// LM head: ternary packed
    pub head_weight: Vec<u8>,
    pub head_shape: Vec<usize>,
    /// Layer weights (each layer has attn + ffn projections)
    pub layers: Vec<KaiNativeLayer>,
    /// Final RMSNorm weight (dim,)
    pub final_norm: Vec<f32>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct KaiNativeConfig {
    pub hidden_size: usize,
    pub n_layers: usize,
    pub n_heads: usize,
    pub head_dim: usize,
    pub ffn_dim: usize,
    pub vocab_size: usize,
    pub max_seq_len: usize,
    pub architecture: String,
    pub weight_format: String,
}

pub struct KaiNativeLayer {
    pub attn_norm: Vec<f32>,
    pub q_weight: Vec<u8>,  pub q_shape: Vec<usize>,
    pub k_weight: Vec<u8>,  pub k_shape: Vec<usize>,
    pub v_weight: Vec<u8>,  pub v_shape: Vec<usize>,
    pub o_weight: Vec<u8>,  pub o_shape: Vec<usize>,
    pub ffn_norm: Vec<f32>,
    pub gate_weight: Vec<u8>,  pub gate_shape: Vec<usize>,
    pub up_weight: Vec<u8>,    pub up_shape: Vec<usize>,
    pub down_weight: Vec<u8>,  pub down_shape: Vec<usize>,
}

pub struct LanguageWarehouse {
    pub vocab: HashMap<String, SparseTernaryVec>,
    pub vocab_index: HashMap<String, EmbeddingMeta>, // NEW: Lazy index
    pub dim: usize,
    pub source_model: String,
    pub format: String,

    pub neural_structure: Option<NeuralStructure>,
    mmap_data: Option<Mmap>,

    // The native Transformer logic fused into the warehouse (BitNet ternary core)
    pub native_transformer: Option<(crate::cognition::bitnet_llama::Llama, crate::cognition::bitnet_llama::Config, Tokenizer, Device)>,

    // Dense Expert: fine-tuned 7B GGUF (kai-7b-q4_k_m.gguf) for hybrid MoE routing
    pub dense_expert: Option<Arc<Mutex<DenseModelWeights>>>,
    pub dense_tokenizer: Option<Tokenizer>,
    pub dense_device: Option<Device>,

    // KAI's custom ternary transformer (trained from scratch)
    pub kai_native: Option<KaiNativeModel>,
    pub kai_native_tokenizer: Option<Tokenizer>,
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
            dense_expert: None,
            dense_tokenizer: None,
            dense_device: None,
            kai_native: None,
            kai_native_tokenizer: None,
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

        // Layer metadata is in the JSON; mmap of neural_weights.bin is only useful
        // when we have per-token embedding offsets to read lazily. Empty token lists
        // used to still mmap ~1.4GB twice (relative + absolute path) and stall boot.
        let token_count = ns.embeddings.tokens.len();
        if ns.layers.is_empty() && token_count == 0 {
            println!("[LanguageWarehouse] Lattice index has 0 layers and 0 tokens — skip (no mmap).");
            return;
        }
        if token_count == 0 {
            println!(
                "[LanguageWarehouse] Lattice index has {} layer stubs but 0 token embeddings — skip weights mmap (~1.4GB saved).",
                ns.layers.len()
            );
            // Keep layer metadata only if something later wants polychora_route names.
            self.neural_structure = Some(ns);
            return;
        }

        let weights_path = "models/BitNet/neural_weights.bin";
        let weights_path_abs = "C:\\KAI\\models\\BitNet\\neural_weights.bin";
        let open_path = if std::path::Path::new(weights_path).exists() {
            weights_path
        } else {
            weights_path_abs
        };
        println!("[LanguageWarehouse] Mapping lattice weights from {} ({} tokens)...", open_path, token_count);

        let file = match File::open(open_path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[LanguageWarehouse] Could not open lattice weights for mmap: {}", e);
                return;
            }
        };

        let mmap = match unsafe { Mmap::map(&file) } {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[LanguageWarehouse] Failed to memory-map lattice weights: {}", e);
                return;
            }
        };

        println!(
            "[LanguageWarehouse] Lattice weights mapped ({:.1} MB, {} layer records).",
            mmap.len() as f64 / 1024.0 / 1024.0,
            ns.layers.len()
        );

        // SMARTER NOT HARDER: Populate only the vocab_index, not the full vocab.
        // This drops RAM usage massively by relying on zero-copy mmap reads.
        self.vocab.clear();
        self.vocab_index.clear();
        for emb in &ns.embeddings.tokens {
            self.vocab_index.insert(emb.token.clone(), emb.clone());
        }
        println!(
            "[LanguageWarehouse] Indexed {} sparse embeddings (lazy mmap).",
            self.vocab_index.len()
        );

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

    /// Project a SparseVec through the 600-cell and return (vertex_id, coherence).
    /// vertex_id: which of 120 structural vertices this concept snaps to.
    /// coherence: Born-rule probability of the snap (0..1) — higher = more
    /// structurally definite concept, lower = ambiguous/conflicted.
    pub fn polychora_route(&self, vec: &crate::core::SparseVec) -> (usize, f32) {
        use crate::cognition::polychora;
        // Convert SparseVec (core) → SparseTernaryVec (warehouse) for projection
        let stv = SparseTernaryVec {
            indices: vec.nz.clone(),
            signs: vec.vals.clone(),
            dim: crate::core::sparse_vec::DIM,
        };
        let q = polychora::project_to_4d(&stv);
        let vertices = polychora::get_600_cell_vertices();
        // Use quantum snap with chi=0 for clean routing (no contradiction damping)
        let vertex_id = polychora::snap_to_600_cell(&q, vertices);
        // Born probability = |<q|v>|^2 — measures how cleanly the concept fits
        let amplitude = q.dot(&vertices[vertex_id]);
        let coherence = amplitude * amplitude;
        (vertex_id, coherence)
    }

    /// Score structural coherence between two vectors via 600-cell geometry.
    /// Returns 0..1 — 1.0 = same vertex (structurally aligned), 0.0 = orthogonal.
    /// Used to bias retrieval toward structurally coherent responses.
    pub fn polychora_coherence(&self, a: &crate::core::SparseVec, b: &crate::core::SparseVec) -> f32 {
        let (va, _) = self.polychora_route(a);
        let (vb, _) = self.polychora_route(b);
        if va == vb { return 1.0; }
        // Geodesic similarity on the 600-cell: dot product of the two vertices
        let vertices = crate::cognition::polychora::get_600_cell_vertices();
        let dot = vertices[va].dot(&vertices[vb]);
        // Map from [-1,1] to [0,1]
        (dot + 1.0) * 0.5
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

        Self {
            vocab, vocab_index: HashMap::new(), dim, source_model, format,
            neural_structure: None, mmap_data: None, native_transformer: None,
            dense_expert: None, dense_tokenizer: None, dense_device: None,
            kai_native: None, kai_native_tokenizer: None,
        }
    }

    /// Dense Expert generation — fine-tuned `kai-7b-q4_k_m.gguf` via candle quantized_llama.
    /// Real forward + sample loop (not scaffold). Returns None only on hard failure.
    pub fn dense_decode(&self, prompt_str: &str, max_tokens: usize) -> Option<String> {
        let expert = self.dense_expert.as_ref()?;
        let tokenizer = self.dense_tokenizer.as_ref().or_else(|| {
            self.native_transformer.as_ref().map(|(_, _, tok, _)| tok)
        })?;
        let device = self.dense_device.as_ref().or_else(|| {
            self.native_transformer.as_ref().map(|(_, _, _, dev)| dev)
        })?;

        let mut model = expert.lock().ok()?;
        let encoding = tokenizer.encode(prompt_str, true).ok()?;
        let mut tokens = encoding.get_ids().to_vec();
        if tokens.is_empty() {
            eprintln!("[Dense Expert] empty encode for prompt ({} chars)", prompt_str.len());
            return None;
        }

        let temp = std::env::var("KAI_DENSE_TEMP")
            .ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.7);
        let top_p = std::env::var("KAI_DENSE_TOP_P")
            .ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.9);
        let mut logits_processor = LogitsProcessor::new(42, Some(temp), Some(top_p));

        let mut generated: Vec<u32> = Vec::new();
        let mut index_pos: usize = 0;
        let max_tok = max_tokens.max(1).min(256);

        for step in 0..max_tok {
            let input = Tensor::new(tokens.as_slice(), device).ok()?.unsqueeze(0).ok()?;
            let logits = match model.forward(&input, index_pos) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[Dense Expert] forward error at step {}: {}", step, e);
                    break;
                }
            };
            let logits = logits.squeeze(0).ok()?;
            let logits = if logits.rank() == 2 {
                let last = logits.dim(0).ok()?.saturating_sub(1);
                logits.get(last).ok()?
            } else {
                logits
            };

            let next = match logits_processor.sample(&logits) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[Dense Expert] sample error: {}", e);
                    break;
                }
            };

            // EOS ids: Llama-family (2, 128001, 128008, 128009) + Qwen2 (151643, 151645)
            if next == 2 || next == 128001 || next == 128008 || next == 128009
                || next == 151643 || next == 151645 {
                break;
            }

            generated.push(next);
            index_pos = index_pos.saturating_add(tokens.len());
            tokens = vec![next];

            // Stop after a completed sentence newline once we have content
            if step >= 8 && (next == 13 || next == 198 || next == 271) {
                break;
            }
        }

        if generated.is_empty() {
            return None;
        }

        let mut decoded = tokenizer.decode(&generated, true).unwrap_or_default();
        for stop in ["\nHuman:", "\nUser:", "\nKAI:", "\nAssistant:", "\n###", "<|eot_id|>", "<|im_end|>"] {
            if let Some(idx) = decoded.find(stop) {
                decoded.truncate(idx);
            }
        }
        // First paragraph only — avoid runaway continuation
        if let Some(idx) = decoded.find("\n\n") {
            decoded.truncate(idx);
        }
        let out = decoded.trim().to_string();
        if out.is_empty() { None } else { Some(out) }
    }

    /// PHASE 4: VRAM Optimization — unload Dense Expert when idle.
    pub fn unload_dense_expert(&mut self) {
        if self.dense_expert.is_some() {
            println!("[LanguageWarehouse] Offloading Dense Expert model to free VRAM/RAM...");
            self.dense_expert = None;
            self.dense_tokenizer = None;
            self.dense_device = None;
        }
    }

    /// Load KAI's custom ternary transformer from models/kai-native/.
    pub fn load_kai_native(&mut self, model_dir: &str) {
        let config_path = format!("{}/config.json", model_dir);
        let weights_path = format!("{}/weights.bin", model_dir);

        if !std::path::Path::new(&weights_path).exists() {
            println!("[LanguageWarehouse] KAI native model: not found at {} — using fallback", weights_path);
            return;
        }

        let config: KaiNativeConfig = match std::fs::read_to_string(&config_path) {
            Ok(s) => match serde_json::from_str(&s) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[LanguageWarehouse] KAI native config parse error: {}", e);
                    return;
                }
            },
            Err(e) => {
                eprintln!("[LanguageWarehouse] KAI native config not found: {}", e);
                return;
            }
        };

        println!("[LanguageWarehouse] KAI native model: LOADING — {}x{}, {} layers, {} heads, vocab {}",
            config.hidden_size, config.ffn_dim, config.n_layers, config.n_heads, config.vocab_size);

        let weight_bytes = match std::fs::read(&weights_path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[LanguageWarehouse] KAI native weights read error: {}", e);
                return;
            }
        };

        // Parse the weights.bin format: repeated (name_len, name, shape_len, shapes, data_len, data)
        let mut offset = 0;
        let mut weight_map: Vec<(String, Vec<usize>, Vec<u8>, bool)> = Vec::new();

        while offset + 4 <= weight_bytes.len() {
            // name_len (u32 LE)
            let name_len = u32::from_le_bytes(weight_bytes[offset..offset+4].try_into().unwrap()) as usize;
            offset += 4;
            if offset + name_len > weight_bytes.len() { break; }
            let name = String::from_utf8_lossy(&weight_bytes[offset..offset+name_len]).to_string();
            offset += name_len;

            // shape_len (u32 LE)
            if offset + 4 > weight_bytes.len() { break; }
            let shape_len = u32::from_le_bytes(weight_bytes[offset..offset+4].try_into().unwrap()) as usize;
            offset += 4;
            let mut shape = Vec::with_capacity(shape_len);
            for _ in 0..shape_len {
                if offset + 4 > weight_bytes.len() { break; }
                shape.push(u32::from_le_bytes(weight_bytes[offset..offset+4].try_into().unwrap()) as usize);
                offset += 4;
            }

            // data_len (u32 LE)
            if offset + 4 > weight_bytes.len() { break; }
            let data_len = u32::from_le_bytes(weight_bytes[offset..offset+4].try_into().unwrap()) as usize;
            offset += 4;
            if offset + data_len > weight_bytes.len() { break; }
            let data = weight_bytes[offset..offset+data_len].to_vec();
            offset += data_len;

            // Detect ternary vs float by checking if data size matches float32 expectation
            let total_elems: usize = shape.iter().product();
            let is_ternary = data.len() != total_elems * 4; // float32 = 4 bytes/elem
            weight_map.push((name, shape, data, is_ternary));
        }

        let size_mb = weight_bytes.len() as f64 / 1024.0 / 1024.0;
        println!("[LanguageWarehouse] KAI native model: LOADED — {:.1} MB, {} tensors",
            size_mb, weight_map.len());

        // Try loading the BPE tokenizer alongside (for decode)
        let tok_candidates = [
            format!("{}/tokenizer.json", model_dir),
            "models/qwen2-tokenizer.json".to_string(),
            "models/BitNet/tokenizer.json".to_string(),
        ];
        let mut loaded_tok = false;
        for tok_path in &tok_candidates {
            if std::path::Path::new(tok_path).exists() {
                match Tokenizer::from_file(tok_path) {
                    Ok(tok) => {
                        println!("[LanguageWarehouse] KAI native tokenizer: {} loaded", tok_path);
                        self.kai_native_tokenizer = Some(tok);
                        loaded_tok = true;
                        break;
                    }
                    Err(e) => {
                        eprintln!("[LanguageWarehouse] KAI native tokenizer {} failed: {}", tok_path, e);
                    }
                }
            }
        }
        if !loaded_tok {
            println!("[LanguageWarehouse] KAI native tokenizer: none found (decode will use char-level fallback)");
        }

        let model = structure_kai_native_model(config, weight_map);
        println!(
            "[LanguageWarehouse] KAI native structured: embed={} floats, {} layers, head_shape={:?}, final_norm={}",
            model.embed_weight.len(),
            model.layers.len(),
            model.head_shape,
            model.final_norm.len()
        );
        self.kai_native = Some(model);
    }

    pub fn has_kai_native(&self) -> bool {
        self.kai_native.is_some()
    }

    /// Generate text with KAI's custom ternary transformer (weights from RunPod train).
    pub fn kai_native_decode(&self, prompt_str: &str, max_tokens: usize) -> Option<String> {
        let model = self.kai_native.as_ref()?;
        if model.embed_weight.is_empty() || model.layers.is_empty() || model.head_weight.is_empty() {
            eprintln!("[KaiNative] model incomplete (embed/layers/head missing) — cannot decode");
            return None;
        }
        let dim = model.config.hidden_size;
        let n_heads = model.config.n_heads;
        let head_dim = model.config.head_dim;
        let max_seq = model.config.max_seq_len.min(512);
        let vocab = model.config.vocab_size;

        // Tokenize
        let mut ids: Vec<u32> = if let Some(tok) = self.kai_native_tokenizer.as_ref() {
            let enc = tok.encode(prompt_str, true).ok()?;
            enc.get_ids()
                .iter()
                .map(|&id| if (id as usize) < vocab { id } else { 1 })
                .collect()
        } else {
            // crude char fallback
            let mut v = vec![2u32]; // bos-ish
            for b in prompt_str.bytes().take(max_seq.saturating_sub(2)) {
                v.push((b as u32) % (vocab as u32).max(1));
            }
            v
        };
        if ids.is_empty() {
            ids.push(2);
        }
        if ids.len() > max_seq {
            ids = ids[ids.len() - max_seq..].to_vec();
        }

        let (cos, sin) = precompute_rope_f32(head_dim, max_seq);
        let mut generated: Vec<u32> = Vec::new();

        for _ in 0..max_tokens {
            let ctx = if ids.len() > max_seq {
                &ids[ids.len() - max_seq..]
            } else {
                &ids[..]
            };
            let t_len = ctx.len();
            // Embed: (T, dim)
            let mut x = vec![0.0f32; t_len * dim];
            for (t, &tid) in ctx.iter().enumerate() {
                let row = (tid as usize).min(vocab.saturating_sub(1));
                let src = &model.embed_weight[row * dim..(row + 1) * dim];
                x[t * dim..(t + 1) * dim].copy_from_slice(src);
            }

            for layer in &model.layers {
                x = kai_native_layer_forward(layer, &x, t_len, dim, n_heads, head_dim, &cos, &sin)?;
            }

            // Final RMSNorm on last token
            let mut h = x[(t_len - 1) * dim..t_len * dim].to_vec();
            rmsnorm_inplace(&mut h, &model.final_norm);

            // LM head: ternary matvec → vocab logits
            let (hout, hin) = if model.head_shape.len() == 2 {
                (model.head_shape[0], model.head_shape[1])
            } else {
                (vocab, dim)
            };
            let logits = crate::cognition::ternary_math::kai_ternary_matvec(
                &model.head_weight,
                &h,
                hout,
                hin,
            )
            .ok()?;

            // temperature sample
            let next = sample_logits(&logits, 0.8);
            if next == 3 || next as usize >= vocab {
                // eos-ish or OOB
                if next == 3 {
                    break;
                }
            }
            ids.push(next);
            generated.push(next);
            if generated.len() >= max_tokens {
                break;
            }
        }

        if generated.is_empty() {
            return None;
        }
        if let Some(tok) = self.kai_native_tokenizer.as_ref() {
            tok.decode(&generated, true).ok()
        } else {
            Some(generated.iter().map(|i| format!("[{}]", i)).collect::<Vec<_>>().join(" "))
        }
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
        // BitNet ternary OR dense expert OR vocab OR kai-native keeps the warehouse alive.
        !self.vocab.is_empty()
            || !self.vocab_index.is_empty()
            || self.native_transformer.is_some()
            || self.dense_expert.is_some()
            || self.kai_native.is_some()
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

/// Print a load-stage line immediately (no wait for full line-buffer flush).
fn boot_progress(stage: u8, total: u8, msg: &str) {
    use std::io::Write;
    let line = format!("[Load {stage}/{total}] {msg}\n");
    let _ = std::io::stdout().write_all(line.as_bytes());
    let _ = std::io::stdout().flush();
}

fn boot_note(msg: &str) {
    use std::io::Write;
    let line = format!("[Load] {msg}\n");
    let _ = std::io::stdout().write_all(line.as_bytes());
    let _ = std::io::stdout().flush();
}

fn env_flag_true(name: &str) -> bool {
    std::env::var(name)
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true") || v.eq_ignore_ascii_case("on"))
        .unwrap_or(false)
}

fn env_flag_false(name: &str) -> bool {
    std::env::var(name)
        .map(|v| v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
        .unwrap_or(false)
}

/// Load language models + optional lattice vocab into the process-global warehouse.
///
/// Order (fast path first):
///   1) KAI native ternary weights (~100MB) — primary trained model
///   2) Lattice vocab index (optional; skipped if empty/broken)
///   3) BitNet 2B decoder (optional, ~10GB dequant) — OFF in RSHL-native unless forced
///   4) Dense 7B expert GGUF (optional)
///
/// Unlike a single GGUF LLM, KAI is an engine: mind/lattice + zero or more language
/// backends. That is why startup feels like a "boot" — it is assembling a stack.
pub fn init_language_warehouse(path: &str) {
    let _ = path; // retained for call-site compatibility
    let t0 = std::time::Instant::now();
    let total_stages: u8 = 4;
    let mut warehouse = LanguageWarehouse::empty();

    // RSHL-native generation mode: lattice / kai-native speak; external LLM scaffolding off.
    let rshl_native = crate::cognition::voice::NATIVE_ONLY
        .load(std::sync::atomic::Ordering::Relaxed);

    boot_note(&format!(
        "Language stack starting{}…",
        if rshl_native { " (RSHL-native: BitNet off unless KAI_FORCE_BITNET=1)" } else { "" }
    ));

    // ── STAGE 1: KAI NATIVE TERNARY (primary — load first, ~100MB) ─────────────
    // Owner's trained model. Small enough to feel like a normal LLM weight load.
    {
        let stage_t = std::time::Instant::now();
        boot_progress(1, total_stages, "KAI native ternary model…");
        let kai_native_dir = std::env::var("KAI_NATIVE_MODEL_DIR")
            .unwrap_or_else(|_| "models/kai-native".to_string());
        let want_kai_native = !env_flag_false("KAI_NATIVE_MODEL");
        if want_kai_native {
            warehouse.load_kai_native(&kai_native_dir);
        } else {
            boot_note("KAI native SKIPPED (KAI_NATIVE_MODEL=0).");
        }
        boot_progress(
            1,
            total_stages,
            &format!(
                "KAI native {} ({:.1}s)",
                if warehouse.kai_native.is_some() { "ready" } else { "not loaded" },
                stage_t.elapsed().as_secs_f32()
            ),
        );
    }

    // ── STAGE 2: LATTICE VOCAB (optional sparse embeddings) ────────────────────
    // Dedupe relative vs absolute path so we never mmap the same dead index twice.
    {
        let stage_t = std::time::Instant::now();
        boot_progress(2, total_stages, "Lattice vocab (optional)…");
        let structure_candidates = [
            "data/neural_structure.json",
            "C:\\KAI\\data\\neural_structure.json",
            "models/BitNet/neural_structure.json",
        ];
        let mut seen: std::collections::HashSet<std::path::PathBuf> =
            std::collections::HashSet::new();
        let mut loaded_vocab = false;
        for cand in structure_candidates {
            let p = std::path::Path::new(cand);
            if !p.exists() {
                continue;
            }
            let key = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
            if !seen.insert(key) {
                continue; // same file via two path spellings
            }
            warehouse.load_neural_structure(cand);
            if !warehouse.vocab_index.is_empty() || !warehouse.vocab.is_empty() {
                boot_note(&format!(
                    "Lattice vocab OK from '{}' ({} tokens).",
                    cand,
                    warehouse.vocab_index.len().max(warehouse.vocab.len())
                ));
                loaded_vocab = true;
                break;
            }
        }
        if !loaded_vocab {
            boot_note(
                "Lattice vocab empty/absent — OK; continuing (run extract_bitnet_to_lattice.py later if needed).",
            );
        }
        boot_progress(
            2,
            total_stages,
            &format!("Lattice done ({:.1}s)", stage_t.elapsed().as_secs_f32()),
        );
    }

    // ── STAGE 3: BITNET 2B DECODER (optional, expensive) ───────────────────────
    // Dequantizes ternary → f32 (~8–10GB). Under RSHL-native mode this is almost
    // never the live voice — skip unless the operator forces it.
    let env_wants_bitnet = env_flag_true("KAI_NATIVE_BRAIN");
    let force_bitnet = env_flag_true("KAI_FORCE_BITNET");
    let want_native_brain = if rshl_native {
        force_bitnet // RSHL-native: BitNet only if forced
    } else {
        env_wants_bitnet
    };

    let device = candle_core::Device::cuda_if_available(0).unwrap_or(candle_core::Device::Cpu);

    if !want_native_brain {
        let stage_t = std::time::Instant::now();
        if rshl_native && env_wants_bitnet && !force_bitnet {
            boot_progress(
                3,
                total_stages,
                "BitNet SKIPPED (RSHL-native) — saves ~10GB RAM / minutes of dequant. Set KAI_FORCE_BITNET=1 to load.",
            );
        } else {
            boot_progress(
                3,
                total_stages,
                "BitNet SKIPPED (KAI_NATIVE_BRAIN!=1) — optional scaffolding, not the RSHL lattice.",
            );
        }
        let _ = stage_t;
    } else {
        use crate::cognition::bitnet_brain::BitNetBrain;
        use crate::cognition::bitnet_llama::{Config, Llama};

        let stage_t = std::time::Instant::now();
        boot_progress(
            3,
            total_stages,
            "BitNet ternary decoder (this step can take minutes / ~10GB RAM)…",
        );
        let config = if std::path::Path::new("models/BitNet/Native/config.json").exists() {
            boot_note("BitNet config: models/BitNet/Native/config.json");
            Config::from_json("models/BitNet/Native/config.json")
        } else {
            Config::bitnet_2b_4t()
        };
        boot_note(&format!(
            "BitNet shape {}x{}, {} layers, {} heads on {:?}",
            config.hidden_size,
            config.intermediate_size,
            config.num_hidden_layers,
            config.num_attention_heads,
            device
        ));
        match BitNetBrain::mount("models/BitNet/Native") {
            Ok(brain) => match Llama::from_brain(&brain, &config, &device) {
                Ok(llama) => match Tokenizer::from_file("models/BitNet/tokenizer.json") {
                    Ok(tokenizer) => {
                        warehouse.native_transformer =
                            Some((llama, config, tokenizer, device.clone()));
                        boot_progress(
                            3,
                            total_stages,
                            &format!(
                                "BitNet ready ({:.1}s)",
                                stage_t.elapsed().as_secs_f32()
                            ),
                        );
                    }
                    Err(e) => eprintln!("[LanguageWarehouse] BitNet tokenizer load failed: {}", e),
                },
                Err(e) => eprintln!("[LanguageWarehouse] BitNet Llama::from_brain failed: {:?}", e),
            },
            Err(e) => eprintln!("[LanguageWarehouse] BitNetBrain::mount failed: {}", e),
        }
    }

    // ── STAGE 4: DENSE 7B EXPERT (optional GGUF) ───────────────────────────────
    {
        let stage_t = std::time::Instant::now();
        // In RSHL-native mode default dense OFF unless explicitly enabled.
        let want_dense = if rshl_native {
            env_flag_true("KAI_DENSE_EXPERT")
        } else {
            !env_flag_false("KAI_DENSE_EXPERT")
        };
        let dense_path = std::env::var("KAI_DENSE_GGUF")
            .unwrap_or_else(|_| "models/kai-7b-q4_k_m.gguf".to_string());

        if !want_dense {
            boot_progress(
                4,
                total_stages,
                if rshl_native {
                    "Dense 7B SKIPPED (RSHL-native; set KAI_DENSE_EXPERT=1 to load)."
                } else {
                    "Dense 7B SKIPPED (KAI_DENSE_EXPERT=0)."
                },
            );
        } else if !std::path::Path::new(&dense_path).exists() {
            boot_progress(
                4,
                total_stages,
                &format!("Dense 7B missing at '{}' — skip.", dense_path),
            );
        } else {
            boot_progress(
                4,
                total_stages,
                &format!("Dense expert GGUF ({})…", dense_path),
            );
            match std::fs::File::open(&dense_path) {
                Ok(mut file) => match candle_core::quantized::gguf_file::Content::read(&mut file) {
                    Ok(content) => {
                        let arch: String = content
                            .metadata
                            .get("general.architecture")
                            .and_then(|v| match v {
                                candle_core::quantized::gguf_file::Value::String(s) => {
                                    Some(s.clone())
                                }
                                _ => None,
                            })
                            .unwrap_or_else(|| "llama".to_string());
                        boot_note(&format!("Dense GGUF architecture: {}", arch));
                        let load_result = if arch.as_str() == "qwen2" {
                            Qwen2DenseWeights::from_gguf(content, &mut file, &device)
                                .map(DenseModelWeights::Qwen2)
                        } else {
                            LlamaDenseWeights::from_gguf(content, &mut file, &device)
                                .map(DenseModelWeights::Llama)
                        };
                        match load_result {
                            Ok(weights) => {
                                let tok = if arch.as_str() == "qwen2" {
                                    Tokenizer::from_file("models/qwen2-tokenizer.json")
                                        .or_else(|_| {
                                            Tokenizer::from_file("models/tokenizer.json")
                                        })
                                        .or_else(|_| {
                                            Tokenizer::from_file("models/BitNet/tokenizer.json")
                                        })
                                } else {
                                    Tokenizer::from_file("models/BitNet/tokenizer.json").or_else(
                                        |_| Tokenizer::from_file("models/tokenizer.json"),
                                    )
                                };
                                match tok {
                                    Ok(tokenizer) => {
                                        warehouse.dense_expert =
                                            Some(Arc::new(Mutex::new(weights)));
                                        warehouse.dense_tokenizer = Some(tokenizer);
                                        warehouse.dense_device = Some(device.clone());
                                        boot_progress(
                                            4,
                                            total_stages,
                                            &format!(
                                                "Dense 7B ready ({:.1}s)",
                                                stage_t.elapsed().as_secs_f32()
                                            ),
                                        );
                                    }
                                    Err(e) => {
                                        eprintln!(
                                            "[LanguageWarehouse] Dense weights OK but tokenizer failed: {} — dense decode disabled.",
                                            e
                                        );
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[LanguageWarehouse] Dense Expert from_gguf failed: {}", e)
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[LanguageWarehouse] Dense Expert GGUF parse failed: {}", e)
                    }
                },
                Err(e) => eprintln!("[LanguageWarehouse] Dense Expert open failed: {}", e),
            }
        }
    }

    // Summary (same fields as before for scripts that grep HYBRID STATUS)
    println!(
        "[LanguageWarehouse] READY in {:.1}s — KAI native: {} | BitNet: {} | Dense 7B: {} | lattice tokens: {}",
        t0.elapsed().as_secs_f32(),
        if warehouse.kai_native.is_some() {
            "MOUNTED"
        } else {
            "OFF"
        },
        if warehouse.native_transformer.is_some() {
            "MOUNTED"
        } else {
            "OFF"
        },
        if warehouse.dense_expert.is_some() {
            "MOUNTED"
        } else {
            "OFF"
        },
        if warehouse.vocab_index.is_empty() {
            warehouse.vocab.len()
        } else {
            warehouse.vocab_index.len()
        }
    );
    // Keep legacy grep string for dashboards
    println!(
        "[LanguageWarehouse] HYBRID STATUS — KAI native: {} | BitNet ternary: {} | Dense 7B expert: {} | lattice vocab entries: {}",
        if warehouse.kai_native.is_some() { "MOUNTED" } else { "OFF" },
        if warehouse.native_transformer.is_some() { "MOUNTED" } else { "OFF" },
        if warehouse.dense_expert.is_some() { "MOUNTED" } else { "OFF" },
        if warehouse.vocab_index.is_empty() { warehouse.vocab.len() } else { warehouse.vocab_index.len() }
    );

    if warehouse.is_loaded() {
        let _ = LANGUAGE_WAREHOUSE.set(RwLock::new(warehouse));
    } else {
        eprintln!(
            "[LanguageWarehouse] No language backend loaded (path arg was '{}'). Generation may fall back elsewhere.",
            path
        );
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

pub fn has_kai_native() -> bool {
    let global = match LANGUAGE_WAREHOUSE.get() {
        Some(g) => g,
        None => return false,
    };
    let w = global.read().unwrap();
    w.kai_native.is_some()
}

pub fn has_dense_expert() -> bool {
    let global = match LANGUAGE_WAREHOUSE.get() {
        Some(g) => g,
        None => return false,
    };
    let w = global.read().unwrap();
    w.dense_expert.is_some()
}

// RUNTIME PROOF the native BitNet brain is actually CONTRIBUTING, not just mounted.
pub static NATIVE_DECODE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn native_decode_count() -> u64 {
    NATIVE_DECODE_COUNT.load(std::sync::atomic::Ordering::Relaxed)
}

pub static DENSE_DECODE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn dense_decode_count() -> u64 {
    DENSE_DECODE_COUNT.load(std::sync::atomic::Ordering::Relaxed)
}

/// Honest hybrid triple-brain status for /api/status (RSHL is always the lattice on universe).
pub fn hybrid_brain_status() -> serde_json::Value {
    let (wh_ok, vocab_n, dim) = warehouse_status();
    let flag = |name: &str, default_on: bool| -> bool {
        std::env::var(name)
            .map(|v| {
                if default_on {
                    !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off"))
                } else {
                    v == "1" || v.eq_ignore_ascii_case("true")
                }
            })
            .unwrap_or(default_on)
    };
    serde_json::json!({
        "rshl_lattice": "live_via_universe",
        "language_warehouse_loaded": wh_ok,
        "vocab_entries": vocab_n,
        "vocab_dim": dim,
        "kai_native_model_mounted": has_kai_native(),
        "bitnet_ternary_mounted": has_native_transformer(),
        "dense_expert_mounted": has_dense_expert(),
        "dense_gguf": std::env::var("KAI_DENSE_GGUF").unwrap_or_else(|_| "models/kai-7b-q4_k_m.gguf".into()),
        "native_decode_count": native_decode_count(),
        "dense_decode_count": dense_decode_count(),
        "hybrid_fully_wired": has_native_transformer() && has_dense_expert(),
        "flags": {
            "KAI_NATIVE_MODEL": flag("KAI_NATIVE_MODEL", true),
            "KAI_NATIVE_BRAIN": flag("KAI_NATIVE_BRAIN", false),
            "KAI_LLM_VOICE": flag("KAI_LLM_VOICE", false),
            "KAI_DENSE_EXPERT": flag("KAI_DENSE_EXPERT", true),
            "KAI_HYBRID_CONTEXT": flag("KAI_HYBRID_CONTEXT", true),
        }
    })
}

pub static KAI_NATIVE_DECODE_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn kai_native_decode_count() -> u64 {
    KAI_NATIVE_DECODE_COUNT.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn global_native_decode(prompt_str: &str, max_tokens: usize) -> Option<String> {
    let global = LANGUAGE_WAREHOUSE.get()?;
    let w = global.read().unwrap();

    // KAI's own trained model gets first shot — it's purpose-built for KAI's voice
    if w.kai_native.is_some() {
        println!("[Hybrid Router] Routing → KAI native ternary model (trained from scratch)...");
        if let Some(out) = w.kai_native_decode(prompt_str, max_tokens) {
            let n = KAI_NATIVE_DECODE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            println!(
                "[KaiNative] decode #{} — {} chars from {}-char prompt.",
                n,
                out.len(),
                prompt_str.len()
            );
            return Some(out);
        }
        println!("[Hybrid Router] KAI native decode returned None — falling through.");
    }

    // SEMANTIC ROUTER — Dense Expert (fine-tuned 7B) for coding / complex / long context
    let lower = prompt_str.to_lowercase();
    let requires_dense = lower.contains("write code")
        || lower.contains("script")
        || lower.contains("function")
        || lower.contains("```")
        || lower.contains("implement")
        || lower.contains("refactor")
        || prompt_str.len() > 1000;

    // Prefer dense when required; if dense is mounted and ternary is not, use dense always
    let try_dense_first = (requires_dense && w.dense_expert.is_some())
        || (w.dense_expert.is_some() && w.native_transformer.is_none());

    if try_dense_first {
        println!("[Hybrid Router] Routing → Dense Expert (fine-tuned kai-7b)...");
        if let Some(out) = w.dense_decode(prompt_str, max_tokens) {
            let n = DENSE_DECODE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            println!(
                "[DenseExpert] dense_decode #{} — {} chars from {}-char prompt.",
                n,
                out.len(),
                prompt_str.len()
            );
            return Some(out);
        }
        println!("[Hybrid Router] Dense Expert returned empty — falling back to Ternary Core.");
    }

    if w.native_transformer.is_some() {
        println!("[Hybrid Router] Routing → Ternary Core (BitNet)...");
        let out = w.native_decode(prompt_str, max_tokens);
        if let Some(ref s) = out {
            let n = NATIVE_DECODE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            println!(
                "[BitNetBrain] native_decode #{} — {} chars from {}-char prompt.",
                n,
                s.len(),
                prompt_str.len()
            );
        }
        return out;
    }

    // Last resort: dense even for general chat if ternary missing
    if w.dense_expert.is_some() {
        println!("[Hybrid Router] Ternary OFF — Dense Expert general path...");
        if let Some(out) = w.dense_decode(prompt_str, max_tokens) {
            let n = DENSE_DECODE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            println!("[DenseExpert] dense_decode #{} (general) — {} chars.", n, out.len());
            return Some(out);
        }
    }

    None
}

// ── KAI native ternary transformer helpers (RunPod export format) ─────────────

fn structure_kai_native_model(
    config: KaiNativeConfig,
    weight_map: Vec<(String, Vec<usize>, Vec<u8>, bool)>,
) -> KaiNativeModel {
    let mut by_name: HashMap<String, (Vec<usize>, Vec<u8>, bool)> = HashMap::new();
    for (name, shape, data, is_t) in weight_map.iter() {
        by_name.insert(name.clone(), (shape.clone(), data.clone(), *is_t));
    }

    let get_f32 = |name: &str| -> Vec<f32> {
        if let Some((shape, data, is_t)) = by_name.get(name) {
            if *is_t {
                let n: usize = shape.iter().product();
                return crate::cognition::ternary_math::unpack_kai_i2(data, n);
            }
            let mut v = vec![0.0f32; data.len() / 4];
            for (i, chunk) in data.chunks_exact(4).enumerate() {
                v[i] = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            }
            return v;
        }
        Vec::new()
    };
    let get_tern = |name: &str| -> (Vec<u8>, Vec<usize>) {
        if let Some((shape, data, _)) = by_name.get(name) {
            return (data.clone(), shape.clone());
        }
        (Vec::new(), Vec::new())
    };

    let embed_weight = get_f32("embed.weight");
    let final_norm = get_f32("norm.weight");
    let (head_weight, head_shape) = get_tern("head.weight");

    let mut layers = Vec::new();
    for i in 0..config.n_layers {
        let p = format!("layers.{}", i);
        let (q_weight, q_shape) = get_tern(&format!("{}.attn.q_proj.weight", p));
        let (k_weight, k_shape) = get_tern(&format!("{}.attn.k_proj.weight", p));
        let (v_weight, v_shape) = get_tern(&format!("{}.attn.v_proj.weight", p));
        let (o_weight, o_shape) = get_tern(&format!("{}.attn.o_proj.weight", p));
        let (gate_weight, gate_shape) = get_tern(&format!("{}.ffn.gate.weight", p));
        let (up_weight, up_shape) = get_tern(&format!("{}.ffn.up.weight", p));
        let (down_weight, down_shape) = get_tern(&format!("{}.ffn.down.weight", p));
        layers.push(KaiNativeLayer {
            attn_norm: get_f32(&format!("{}.attn.norm.weight", p)),
            q_weight,
            q_shape,
            k_weight,
            k_shape,
            v_weight,
            v_shape,
            o_weight,
            o_shape,
            ffn_norm: get_f32(&format!("{}.ffn.norm.weight", p)),
            gate_weight,
            gate_shape,
            up_weight,
            up_shape,
            down_weight,
            down_shape,
        });
    }

    KaiNativeModel {
        config,
        weight_data: weight_map,
        embed_weight,
        head_weight,
        head_shape,
        layers,
        final_norm,
    }
}

fn precompute_rope_f32(head_dim: usize, max_seq: usize) -> (Vec<f32>, Vec<f32>) {
    // cos/sin: (max_seq, head_dim/2) row-major flattened to (max_seq * half)
    let half = head_dim / 2;
    let mut cos = vec![0.0f32; max_seq * half];
    let mut sin = vec![0.0f32; max_seq * half];
    for t in 0..max_seq {
        for i in 0..half {
            let freq = 1.0 / 10000f32.powf((2.0 * i as f32) / head_dim as f32);
            let angle = t as f32 * freq;
            cos[t * half + i] = angle.cos();
            sin[t * half + i] = angle.sin();
        }
    }
    (cos, sin)
}

fn rmsnorm_inplace(x: &mut [f32], weight: &[f32]) {
    let n = x.len();
    let mut mean_sq = 0.0f32;
    for &v in x.iter() {
        mean_sq += v * v;
    }
    mean_sq /= n as f32;
    let inv = 1.0 / (mean_sq + 1e-5).sqrt();
    for i in 0..n {
        let w = if i < weight.len() { weight[i] } else { 1.0 };
        x[i] = x[i] * inv * w;
    }
}

fn apply_rope_inplace(q_or_k: &mut [f32], t: usize, n_heads: usize, head_dim: usize, cos: &[f32], sin: &[f32]) {
    // q_or_k is one token: n_heads * head_dim
    let half = head_dim / 2;
    for h in 0..n_heads {
        let base = h * head_dim;
        for i in 0..half {
            let c = cos[t * half + i];
            let s = sin[t * half + i];
            let x1 = q_or_k[base + i];
            let x2 = q_or_k[base + half + i];
            q_or_k[base + i] = x1 * c - x2 * s;
            q_or_k[base + half + i] = x2 * c + x1 * s;
        }
    }
}

fn kai_native_layer_forward(
    layer: &KaiNativeLayer,
    x: &[f32],
    t_len: usize,
    dim: usize,
    n_heads: usize,
    head_dim: usize,
    cos: &[f32],
    sin: &[f32],
) -> Option<Vec<f32>> {
    // x: (T, dim) row-major
    let mut out = x.to_vec();

    // --- Attention ---
    let q_rows = layer.q_shape.get(0).copied().unwrap_or(n_heads * head_dim);
    let q_cols = layer.q_shape.get(1).copied().unwrap_or(dim);
    let mut q_all = vec![0.0f32; t_len * q_rows];
    let mut k_all = vec![0.0f32; t_len * q_rows];
    let mut v_all = vec![0.0f32; t_len * q_rows];

    for t in 0..t_len {
        let mut h = x[t * dim..(t + 1) * dim].to_vec();
        rmsnorm_inplace(&mut h, &layer.attn_norm);
        let q = crate::cognition::ternary_math::kai_ternary_matvec(&layer.q_weight, &h, q_rows, q_cols).ok()?;
        let k = crate::cognition::ternary_math::kai_ternary_matvec(&layer.k_weight, &h, q_rows, q_cols).ok()?;
        let v = crate::cognition::ternary_math::kai_ternary_matvec(&layer.v_weight, &h, q_rows, q_cols).ok()?;
        let mut q = q;
        let mut k = k;
        apply_rope_inplace(&mut q, t, n_heads, head_dim, cos, sin);
        apply_rope_inplace(&mut k, t, n_heads, head_dim, cos, sin);
        q_all[t * q_rows..(t + 1) * q_rows].copy_from_slice(&q);
        k_all[t * q_rows..(t + 1) * q_rows].copy_from_slice(&k);
        v_all[t * q_rows..(t + 1) * q_rows].copy_from_slice(&v);
    }

    // Causal attention per head
    let scale = 1.0 / (head_dim as f32).sqrt();
    let mut attn_out = vec![0.0f32; t_len * q_rows];
    for h in 0..n_heads {
        for t in 0..t_len {
            let mut scores = vec![0.0f32; t + 1];
            let q_base = t * q_rows + h * head_dim;
            for s in 0..=t {
                let k_base = s * q_rows + h * head_dim;
                let mut dot = 0.0f32;
                for d in 0..head_dim {
                    dot += q_all[q_base + d] * k_all[k_base + d];
                }
                scores[s] = dot * scale;
            }
            // softmax
            let max_s = scores.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
            let mut sum = 0.0f32;
            for s in scores.iter_mut() {
                *s = (*s - max_s).exp();
                sum += *s;
            }
            for s in scores.iter_mut() {
                *s /= sum.max(1e-8);
            }
            let out_base = t * q_rows + h * head_dim;
            for d in 0..head_dim {
                let mut acc = 0.0f32;
                for s in 0..=t {
                    acc += scores[s] * v_all[s * q_rows + h * head_dim + d];
                }
                attn_out[out_base + d] = acc;
            }
        }
    }

    let o_rows = layer.o_shape.get(0).copied().unwrap_or(dim);
    let o_cols = layer.o_shape.get(1).copied().unwrap_or(q_rows);
    for t in 0..t_len {
        let slice = &attn_out[t * q_rows..(t + 1) * q_rows];
        let proj = crate::cognition::ternary_math::kai_ternary_matvec(&layer.o_weight, slice, o_rows, o_cols).ok()?;
        for d in 0..dim.min(proj.len()) {
            out[t * dim + d] += proj[d];
        }
    }

    // --- FFN SwiGLU ---
    let g_rows = layer.gate_shape.get(0).copied().unwrap_or(layer.gate_shape.first().copied().unwrap_or(dim * 4));
    let g_cols = layer.gate_shape.get(1).copied().unwrap_or(dim);
    let d_rows = layer.down_shape.get(0).copied().unwrap_or(dim);
    let d_cols = layer.down_shape.get(1).copied().unwrap_or(g_rows);

    for t in 0..t_len {
        let mut h = out[t * dim..(t + 1) * dim].to_vec();
        rmsnorm_inplace(&mut h, &layer.ffn_norm);
        let gate = crate::cognition::ternary_math::kai_ternary_matvec(&layer.gate_weight, &h, g_rows, g_cols).ok()?;
        let up = crate::cognition::ternary_math::kai_ternary_matvec(&layer.up_weight, &h, g_rows, g_cols).ok()?;
        let mut hidden = vec![0.0f32; g_rows];
        for i in 0..g_rows {
            // silu(gate) * up
            let g = gate[i];
            let silu = g / (1.0 + (-g).exp());
            hidden[i] = silu * up[i];
        }
        let down = crate::cognition::ternary_math::kai_ternary_matvec(&layer.down_weight, &hidden, d_rows, d_cols).ok()?;
        for d in 0..dim.min(down.len()) {
            out[t * dim + d] += down[d];
        }
    }

    Some(out)
}

fn sample_logits(logits: &[f32], temperature: f32) -> u32 {
    if logits.is_empty() {
        return 0;
    }
    let temp = temperature.max(1e-4);
    let max_l = logits.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let mut probs: Vec<f32> = logits.iter().map(|l| ((l - max_l) / temp).exp()).collect();
    let sum: f32 = probs.iter().sum();
    if sum > 0.0 {
        for p in probs.iter_mut() {
            *p /= sum;
        }
    }
    // deterministic-ish sample from hash of probs (no RNG global) — use weighted
    let mut r = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        max_l.to_bits().hash(&mut h);
        logits.len().hash(&mut h);
        (h.finish() % 10_000) as f32 / 10_000.0
    };
    for (i, &p) in probs.iter().enumerate() {
        r -= p;
        if r <= 0.0 {
            return i as u32;
        }
    }
    (logits.len() - 1) as u32
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
