//! Lattice Attention — KAI-native attention over the hyperdimensional lattice.
//!
//! This implements the transformer attention equation entirely in KAI's own
//! sparse vector math, without any LLM, neural network weights, or external model.
//!
//! ## The Math
//!
//! LLM attention:    Attention(Q,K,V) = softmax(QK^T / sqrt(d_k)) × V
//! KAI equivalent:   attended = softmax(cosine(q, cell_i)) × cell_i.vec
//!
//! The cosine similarity KAI already computes IS the Q·K attention score.
//! We just stopped throwing those scores away after picking #1.
//!
//! ## Multi-Hop Reasoning
//!
//! Analogous to stacking transformer layers:
//!   hop_0 = encode(input)
//!   hop_1 = lattice_attend(hop_0, universe)
//!   hop_2 = lattice_attend(hop_0 + hop_1, universe)   // residual
//!   hop_3 = lattice_attend(hop_0 + hop_1 + hop_2, universe)
//!
//! Each hop refines the concept state, the way each transformer layer
//! refines the hidden state. Residual connections prevent drift.
//!
//! ## Float Precision (f32)
//!
//! Softmax produces continuous weights in [0.0, 1.0].
//! `weighted_superpose` already accepts f32 weights on `SparseVec`.
//! The existing storage (i8 ternary) is preserved — f32 only lives
//! inside the attention computation itself, then gets ternarized back
//! into a `SparseVec` for the next hop.

use crate::core::{SparseVec, Universe};

/// Number of top-K cells to include in each attention pass.
/// More cells = richer attention but slower. 16 is the sweet spot.
pub const ATTENTION_TOP_K: usize = 16;

/// Temperature for softmax. Higher = more uniform weights (less peaked).
/// Lower = winner-takes-all (closer to argmax). 0.5 is a good default.
pub const ATTENTION_TEMPERATURE: f32 = 0.5;

/// Result of one attention pass: the attended vector and debug info.
pub struct AttendedState {
    /// The attended vector — weighted superposition of top-K cell vectors.
    pub vec: SparseVec,
    /// The labels of the cells that contributed most (for display).
    pub top_labels: Vec<String>,
    /// The attention weights for each top label (softmax output, f32).
    pub top_weights: Vec<f32>,
}

/// Compute softmax over a slice of f32 scores with temperature scaling.
/// Returns values in [0.0, 1.0] summing to 1.0.
pub fn softmax(scores: &[f32], temperature: f32) -> Vec<f32> {
    if scores.is_empty() {
        return vec![];
    }
    let t = temperature.max(0.01); // prevent division by zero
    // Scale by temperature first, then exponentiate.
    // Subtract max for numerical stability (standard trick).
    let scaled: Vec<f32> = scores.iter().map(|&s| s / t).collect();
    let max_val = scaled.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
    let exps: Vec<f32> = scaled.iter().map(|&s| (s - max_val).exp()).collect();
    let sum: f32 = exps.iter().sum();
    if sum == 0.0 {
        return vec![1.0 / scores.len() as f32; scores.len()];
    }
    exps.iter().map(|&e| e / sum).collect()
}

/// Single attention pass over the universe.
///
/// 1. Query the universe for top-K hits.
/// 2. Apply softmax over cosine scores → f32 attention weights.
/// 3. Weighted-superpose the cell vectors → attended SparseVec.
/// 4. Return the attended state with debug labels.
pub fn lattice_attend(query: &SparseVec, universe: &mut Universe) -> AttendedState {
    let hits = universe.query_vec(query, ATTENTION_TOP_K);

    if hits.is_empty() {
        return AttendedState {
            vec: query.clone(),
            top_labels: vec!["[empty lattice]".into()],
            top_weights: vec![1.0],
        };
    }

    // Extract cosine scores and cell vectors.
    let scores: Vec<f32> = hits.iter().map(|h| h.1).collect();
    let weights = softmax(&scores, ATTENTION_TEMPERATURE);

    // Build weighted superposition. `weighted_superpose` accepts &[(SparseVec, f32)].
    let pairs: Vec<(&SparseVec, f32)> = hits
        .iter()
        .zip(weights.iter())
        .map(|(h, &w)| (&h.0.claim.vec, w))
        .collect();

    // threshold_ratio = 0.0 → accept all dimensions (no consensus gate).
    // This gives the fullest possible attended vector.
    let attended_vec = SparseVec::weighted_superpose(&pairs, 0.0);

    let top_labels: Vec<String> = hits.iter().map(|h| {
        let words: Vec<&str> = h.0.claim.text.split_whitespace().take(4).collect();
        words.join(" ")
    }).collect();

    let top_weights: Vec<f32> = weights;

    AttendedState {
        vec: attended_vec,
        top_labels,
        top_weights,
    }
}

/// Multi-hop reasoning: N sequential attention passes with residual connections.
///
/// Each hop feeds its output back as input for the next hop, conditioned on
/// the original query (residual). This is the KAI equivalent of stacking
/// N transformer layers.
///
/// Returns the final attended vector and per-hop debug labels.
pub fn multi_hop_attend(
    input: &SparseVec,
    universe: &mut Universe,
    hops: usize,
) -> (SparseVec, Vec<Vec<String>>) {
    let hops = hops.max(1).min(6); // clamp 1..6
    let mut current = input.clone();
    let mut hop_labels: Vec<Vec<String>> = Vec::with_capacity(hops);

    for _ in 0..hops {
        let state = lattice_attend(&current, universe);

        hop_labels.push(state.top_labels);

        // Residual connection: blend attended output with original query.
        // Weight original query at 0.4, attended at 0.6.
        // This prevents the hop chain from drifting away from the question.
        let pairs: Vec<(&SparseVec, f32)> = vec![
            (input, 0.4),
            (&state.vec, 0.6),
        ];
        current = SparseVec::weighted_superpose(&pairs, 0.0);
    }

    (current, hop_labels)
}

/// Format multi-hop labels as a human-readable chain for display in responses.
pub fn format_hop_chain(hop_labels: &[Vec<String>]) -> String {
    hop_labels
        .iter()
        .enumerate()
        .map(|(i, labels)| {
            let top3: Vec<&str> = labels.iter().take(3).map(|s| s.as_str()).collect();
            format!("hop{} [{}]", i + 1, top3.join(" | "))
        })
        .collect::<Vec<_>>()
        .join("  ->  ")
}

/// Generate a response using multi-hop lattice attention.
///
/// This is the main entry point replacing the single-pass decoder in oracle_server.rs.
/// Returns a formatted string ready for display.
pub fn generate_attentive_response(
    query: &str,
    universe: &mut Universe,
    hops: usize,
) -> String {
    let query_vec = SparseVec::encode(query);

    let (final_vec, hop_labels) = multi_hop_attend(&query_vec, universe, hops);

    // Final retrieval: use the attended state to find the best matching cell.
    let final_hits = universe.query_vec(&final_vec, 8);

    // Build the output from the top hit's text, informed by all hops.
    let response_text = if let Some(best) = final_hits.first() {
        // Take the first sentence or first 12 words from the best hit.
        let sentence: String = best.0.claim.text
            .split(|c| c == '.' || c == '!' || c == '?')
            .next()
            .unwrap_or(&best.0.claim.text)
            .split_whitespace()
            .take(20)
            .collect::<Vec<_>>()
            .join(" ");
        sentence
    } else {
        "Lattice quiet — no resonance found.".to_string()
    };

    // Format: show the reasoning chain + the response
    let chain = format_hop_chain(&hop_labels);
    format!("[LATTICE ATTEND | hops={}]\n  chain: {}\n  -> {}", hops, chain, response_text)
}

/// A native Ternary Matrix that supports "Dense Multiplication without Multiplying"
/// by doing pure addition and subtraction of decimals.
pub struct TernaryMatrix {
    pub rows: usize,
    pub cols: usize,
    pub weights_latent: Vec<f32>, // Latent high-precision weights for training
    pub weights_quantized: Vec<i8>, // Quantized -1, 0, 1 for inference
}

impl TernaryMatrix {
    pub fn new_random(rows: usize, cols: usize, seed: u64) -> Self {
        use rand::{Rng, SeedableRng};
        use rand::rngs::StdRng;
        let mut rng = StdRng::seed_from_u64(seed);
        let mut weights_latent = vec![0f32; rows * cols];
        for i in 0..weights_latent.len() {
            let r: f32 = rng.gen();
            weights_latent[i] = (r * 0.2) - 0.1;
        }
        let mut tm = Self { rows, cols, weights_latent, weights_quantized: vec![0i8; rows * cols] };
        tm.quantize();
        tm
    }

    pub fn update(&mut self, grads: &[f32], learning_rate: f32) {
        assert_eq!(self.weights_latent.len(), grads.len());
        for i in 0..self.weights_latent.len() {
            self.weights_latent[i] -= learning_rate * grads[i];
        }
        self.quantize();
    }

    pub fn quantize(&mut self) {
        let mut sum_abs = 0.0f32;
        for &w in &self.weights_latent {
            sum_abs += w.abs();
        }
        let mean_abs = sum_abs / (self.weights_latent.len() as f32).max(1.0);
        let epsilon = 1e-5;
        let scale = 1.0 / (mean_abs + epsilon);
        
        for i in 0..self.weights_latent.len() {
            let scaled = self.weights_latent[i] * scale;
            self.weights_quantized[i] = scaled.round().clamp(-1.0, 1.0) as i8;
        }
    }

    /// Dense multiplication without times operator!
    /// Y = X * W  (X: 1 x rows, W: rows x cols, Y: 1 x cols)
    pub fn forward_multiplier_less(&self, x: &[f32]) -> Vec<f32> {
        assert_eq!(x.len(), self.rows);
        let mut y = vec![0.0f32; self.cols];
        
        for (i, &val_x) in x.iter().enumerate() {
            if val_x.abs() < 1e-6 { continue; } // FAST PATH
            let row_offset = i * self.cols;
            for j in 0..self.cols {
                let w = self.weights_quantized[row_offset + j];
                if w == 1 {
                    y[j] += val_x;
                } else if w == -1 {
                    y[j] -= val_x;
                }
            }
        }
        y
    }

    pub fn save_weights(&self, writer: &mut impl std::io::Write) -> std::io::Result<()> {
        let rows = self.rows as u64;
        let cols = self.cols as u64;
        writer.write_all(&rows.to_le_bytes())?;
        writer.write_all(&cols.to_le_bytes())?;
        for &w in &self.weights_latent {
            writer.write_all(&w.to_le_bytes())?;
        }
        Ok(())
    }

    pub fn load_weights(reader: &mut impl std::io::Read) -> std::io::Result<Self> {
        let mut buf8 = [0u8; 8];
        reader.read_exact(&mut buf8)?;
        let rows = u64::from_le_bytes(buf8) as usize;
        reader.read_exact(&mut buf8)?;
        let cols = u64::from_le_bytes(buf8) as usize;
        let mut weights_latent = vec![0.0f32; rows * cols];
        let mut buf4 = [0u8; 4];
        for i in 0..weights_latent.len() {
            reader.read_exact(&mut buf4)?;
            weights_latent[i] = f32::from_le_bytes(buf4);
        }
        let mut tm = Self { rows, cols, weights_latent, weights_quantized: vec![0i8; rows * cols] };
        tm.quantize();
        Ok(tm)
    }
}

pub struct TernaryMlp {
    pub dim: usize,
    pub hidden: usize,
    pub w_in: TernaryMatrix,
    pub w_out: TernaryMatrix,
}

impl TernaryMlp {
    pub fn new(dim: usize, hidden: usize, seed: u64) -> Self {
        let w_in = TernaryMatrix::new_random(dim, hidden, seed);
        let w_out = TernaryMatrix::new_random(hidden, dim, seed + 1);
        Self { dim, hidden, w_in, w_out }
    }

    pub fn save_weights(&self, path: &str) -> std::io::Result<()> {
        let file = std::fs::File::create(path)?;
        let mut writer = std::io::BufWriter::new(file);
        self.w_in.save_weights(&mut writer)?;
        self.w_out.save_weights(&mut writer)?;
        Ok(())
    }

    pub fn load_weights(path: &str) -> std::io::Result<Self> {
        let file = std::fs::File::open(path)?;
        let mut reader = std::io::BufReader::new(file);
        let w_in = TernaryMatrix::load_weights(&mut reader)?;
        let w_out = TernaryMatrix::load_weights(&mut reader)?;
        Ok(Self {
            dim: w_in.rows,
            hidden: w_in.cols,
            w_in,
            w_out,
        })
    }

    pub fn forward(&mut self, input: &SparseVec) -> SparseVec {
        self.w_in.quantize();
        self.w_out.quantize();
        // 1. Convert sparse input to dense decimals
        let mut x_dense = vec![0.0f32; self.dim];
        for (idx, val) in input.iter() {
            x_dense[idx] = val as f32;
        }

        // 2. Hidden layer (multiplier-less!)
        let mut hidden_acts = self.w_in.forward_multiplier_less(&x_dense);

        // ReLU
        for v in hidden_acts.iter_mut() {
            if *v < 0.0 {
                *v = 0.0;
            }
        }

        // 3. Output layer (multiplier-less!)
        let out_dense = self.w_out.forward_multiplier_less(&hidden_acts);

        // 4. Convert back to SparseVec (top-4%)
        let target_nnz = ((self.dim as f32) * 0.04).ceil() as usize;
        let mut indexed: Vec<(usize, f32)> = out_dense.into_iter().enumerate().collect();
        indexed.sort_by(|a, b| b.1.abs().partial_cmp(&a.1.abs()).unwrap_or(std::cmp::Ordering::Equal));
        
        let mut data = vec![0i8; self.dim];
        for (i, v) in indexed.into_iter().take(target_nnz) {
            data[i] = if v >= 0.0 { 1 } else { -1 };
        }
        SparseVec::from_raw(data)
    }

    pub fn train_step(&mut self, input: &SparseVec, target: &SparseVec, lr: f32) -> f32 {
        self.w_in.quantize();
        self.w_out.quantize();

        let mut x = vec![0.0f32; self.dim];
        for (idx, val) in input.iter() {
            x[idx] = val as f32;
        }

        let h_pre = self.w_in.forward_multiplier_less(&x);
        let mut h = h_pre.clone();
        
        // Layer Normalize h_pre and h
        let h_scale = 1.0 / (self.hidden as f32);
        for k in 0..self.hidden {
            h[k] = if h_pre[k] > 0.0 { h_pre[k] * h_scale } else { 0.0 };
        }

        let y = self.w_out.forward_multiplier_less(&h);

        let mut t = vec![0.0f32; self.dim];
        for (idx, val) in target.iter() {
            t[idx] = val as f32;
        }

        let mut dy = vec![0.0f32; self.dim];
        let mut loss = 0.0;
        
        for i in 0..self.dim {
            let error = y[i] - t[i];
            loss += error * error;
            dy[i] = error.clamp(-0.1, 0.1);
        }
        
        let t_nnz = t.iter().filter(|&&v| v != 0.0).count();
        let y_nnz = y.iter().filter(|&&v| v != 0.0).count();
        if t_nnz == 0 {
            println!("DEBUG: t is completely zero!");
        }
        if loss.is_nan() {
            println!("DEBUG: loss is NaN!");
        }
        
        let scale = 1.0 / self.dim as f32;
        loss *= scale * 0.5;

        use rayon::prelude::*;

        let mut dh = vec![0.0f32; self.hidden];

        dh.par_iter_mut().zip(self.w_out.weights_latent.par_chunks_mut(self.dim)).enumerate().for_each(|(k, (dh_k, row))| {
            let h_val = h[k];
            let row_offset = k * self.dim;
            let mut local_dh = 0.0;
            
            if h_val.abs() > 1e-6 {
                for i in 0..self.dim {
                    let dy_i = dy[i];
                    let mut w = row[i] - lr * (dy_i * h_val);
                    w = w.clamp(-1.0, 1.0);
                    row[i] = w;
                    let w_q = self.w_out.weights_quantized[row_offset + i] as f32;
                    local_dh += dy_i * w_q;
                }
            } else {
                for i in 0..self.dim {
                    let w_q = self.w_out.weights_quantized[row_offset + i] as f32;
                    local_dh += dy[i] * w_q;
                }
            }
            *dh_k = local_dh;
        });

        let mut dh_pre = vec![0.0f32; self.hidden];
        let h_scale = 1.0 / (self.hidden as f32);
        for k in 0..self.hidden {
            dh_pre[k] = if h_pre[k] > 0.0 { dh[k] * h_scale } else { 0.0 };
        }

        self.w_in.weights_latent.par_chunks_mut(self.hidden).enumerate().for_each(|(m, row)| {
            let x_val = x[m];
            if x_val.abs() >= 1e-6 {
                for k in 0..self.hidden {
                    let mut w = row[k] - lr * (dh_pre[k] * x_val);
                    w = w.clamp(-1.0, 1.0);
                    row[k] = w;
                }
            }
        });

        loss
    }
}

/// `KAI_AR_VOCAB_CLEAN` — vocabulary hygiene for the autoregressive generator.
///
/// **Default ON.** This is a bug fix, not an experiment: the AR vocabulary used to
/// be the raw whitespace tokens of the top-1000 lattice cells, trimmed only at the
/// edges. That let markup/code/math fragments (`1e9`, `c_3`, `ATX`, `WSS`, `CSS`,
/// `g(x`, `s=1`, `1-3`) into the word pool and kept `For` and `for` as two separate
/// entries — which is exactly what the observed word-salad replies were made of.
///
/// Set `KAI_AR_VOCAB_CLEAN=0` (or `false`/`off`) to restore the old behaviour
/// exactly: raw `trim_matches(!is_alphanumeric)` tokens, case preserved.
pub fn ar_vocab_clean_enabled() -> bool {
    std::env::var("KAI_AR_VOCAB_CLEAN")
        .map(|v| {
            let v = v.trim();
            v != "0" && !v.eq_ignore_ascii_case("false") && !v.eq_ignore_ascii_case("off")
        })
        .unwrap_or(true)
}

/// Longest token we will accept as a "word". Anything past this is a run-on
/// artefact of stripped markup, not something KAI should ever say.
const AR_VOCAB_MAX_LEN: usize = 32;

/// Characters allowed *inside* a word in addition to letters.
fn is_word_connector(c: char) -> bool {
    c == '-' || c == '\'' || c == '\u{2019}'
}

/// Is `token` a plausible English word that KAI could say out loud?
///
/// Operates on an already edge-trimmed token. Rejects, in order:
/// * empty / single-character tokens (`?`, `g`, `1`)
/// * anything containing a digit (`1e9`, `s=1`, `1-3`, `c_3`, `H2O`)
/// * anything containing a symbol (`g(x`, `c_3`, `s=1`, `foo::bar`)
/// * tokens with no ASCII vowel (`WSS`, `CSS`, `nth`) — an unpronounceable code
///   (`y` counts as a vowel, so `sky` and `why` survive)
/// * ALL-CAPS initialisms of 2+ letters (`LLM`, `ATX`, `CSS`, `WSS`)
/// * absurdly long run-ons
///
/// Hyphenated and apostrophised words survive (`ninety-three`, `don't`), and so
/// do ordinary capitalised words (`For` → accepted, later folded to `for`).
pub fn is_plausible_word(token: &str) -> bool {
    let mut chars = 0usize;
    let mut letters = 0usize;
    let mut upper_letters = 0usize;
    let mut has_ascii_vowel = false;
    let mut prev_was_connector = false;

    for c in token.chars() {
        chars += 1;
        if chars > AR_VOCAB_MAX_LEN {
            return false;
        }
        if c.is_numeric() {
            return false; // digits are never part of a spoken word
        }
        if c.is_alphabetic() {
            letters += 1;
            prev_was_connector = false;
            if c.is_uppercase() {
                upper_letters += 1;
            }
            if matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y' | 'A' | 'E' | 'I' | 'O' | 'U' | 'Y') {
                has_ascii_vowel = true;
            }
        } else if is_word_connector(c) {
            if prev_was_connector {
                return false; // `well--known`, `it''s` — stripped markup, not a word
            }
            prev_was_connector = true;
        } else {
            return false; // punctuation / symbol / whitespace inside the token
        }
    }

    // Single characters and pure-punctuation tokens carry no meaning here.
    // (`I` and `a` are supplied by the hard-coded conversational list below.)
    if chars < 2 || letters < 2 {
        return false;
    }
    // Connectors may not lead or trail (`-foo`, `foo-`).
    let first = token.chars().next().unwrap_or(' ');
    let last = token.chars().last().unwrap_or(' ');
    if is_word_connector(first) || is_word_connector(last) {
        return false;
    }
    if !has_ascii_vowel {
        return false;
    }
    // ALL-CAPS with 2+ letters is an initialism/acronym, not a word.
    if upper_letters == letters {
        return false;
    }
    true
}

/// Turn one raw whitespace token from lattice text into a vocabulary entry.
///
/// Returns `None` when the token is not a usable word. On success the entry is
/// **lower-cased**, so `For`/`for` and `Why`/`why` collapse into a single vocab
/// slot instead of competing as two.
pub fn normalize_vocab_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim_matches(|c: char| !c.is_alphanumeric());
    if !is_plausible_word(trimmed) {
        return None;
    }
    Some(trimmed.to_lowercase())
}

/// Generate a response word-by-word using autoregressive lattice attention.
/// At each step, it builds a context vector from the generated sequence,
/// attends over the lattice to get an attention-weighted context, and then
/// finds the single closest word from a dynamically built local vocabulary to append.
pub fn generate_autoregressive_response(
    query: &str,
    universe: &mut Universe,
    max_tokens: usize,
) -> String {

    // 1. Build a local vocabulary by querying the lattice for the top 1000 hits related to the query.
    // This avoids scanning the entire 400k+ cell universe while ensuring the vocabulary
    // is highly relevant to the context.
    let q_init = SparseVec::encode(query);
    let local_hits = universe.query_vec(&q_init, 1000);
    
    let mut vocab_map = std::collections::HashSet::new();

    // VOCAB HYGIENE (KAI_AR_VOCAB_CLEAN, default ON): the raw lattice text is
    // Wikipedia/code/markup soup. Without this filter, tokens like `1e9`, `c_3`,
    // `ATX`, `WSS`, `CSS`, `g(x`, `s=1` and `1-3` enter the word pool and get
    // emitted verbatim — the observed word salad. Set the flag to 0 to restore
    // the old raw behaviour exactly.
    let vocab_clean = ar_vocab_clean_enabled();

    // Add words from local hits (Wikipedia context)
    for hit in local_hits {
        for word in hit.0.claim.text.split_whitespace() {
            if vocab_clean {
                if let Some(clean_word) = normalize_vocab_token(word) {
                    vocab_map.insert(clean_word);
                }
            } else {
                let clean_word = word.trim_matches(|c: char| !c.is_alphanumeric());
                if !clean_word.is_empty() {
                    vocab_map.insert(clean_word.to_string());
                }
            }
        }
    }

    // Add common conversational words to the vocabulary!
    let common_words = vec![
        "I", "you", "he", "she", "it", "we", "they", "am", "is", "are", "was", "were", 
        "be", "been", "being", "have", "has", "had", "do", "does", "did", "a", "an", "the", 
        "and", "but", "if", "or", "because", "as", "until", "while", "of", "at", "by", "for", 
        "with", "about", "against", "between", "into", "through", "during", "before", 
        "after", "above", "below", "to", "from", "up", "down", "in", "out", "on", "off", 
        "over", "under", "again", "further", "then", "once", "here", "there", "when", 
        "where", "why", "how", "all", "any", "both", "each", "few", "more", "most", "other", 
        "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", 
        "very", "can", "will", "just", "don", "should", "now", "Kai", "hello", "hi", "hey", 
        "yes", "no", "yeah", "nope", "okay", "ok", "good", "bad", "well", "think", "know",
        "want", "like", "love", "hate", "see", "hear", "feel", "make", "take", "get", "go",
        "come", "say", "tell", "ask", "help", "need", "use", "find", "give", "work", "play",
        "time", "day", "night", "morning", "evening", "today", "tomorrow", "yesterday",
        "something", "anything", "nothing", "everything", "someone", "anyone", "everyone",
        "system", "protocol", "data", "processing", "learning", "model", "network", "matrix",
        "lattice", "vector", "symbolic", "architecture", "cognitive", "engine", "memory",
        "Antigravity", "Ryan", "creator", "human", "AI", "artificial", "intelligence"
    ];
    for w in common_words {
        // The hard-coded list is authoritative for its own capitalisation
        // ("I", "Kai", "Ryan", "AI"): drop any lower-cased lattice twin so the
        // proper noun does not compete with itself.
        if vocab_clean {
            let lower = w.to_lowercase();
            if lower != w {
                vocab_map.remove(&lower);
            }
        }
        vocab_map.insert(w.to_string());
    }

    // Convert string tokens into augmented SparseVecs
    let vocab: Vec<(String, SparseVec)> = vocab_map
        .into_iter()
        .map(|w| {
            let bundle = crate::cognition::semantic_dict::lookup_word(&w);
            let augmented = if bundle.pos == "unknown" {
                w.clone()
            } else {
                format!("{} pos:{} syn:{} def:{}", w, bundle.pos, bundle.synonyms.join(","), bundle.definition)
            };
            let v = SparseVec::encode(&augmented);
            (w, v)
        })
        .collect();

    if vocab.is_empty() {
        return "[Autoregressive] Error: Local vocabulary is empty. No contextual resonance found.".to_string();
    }

    // We instantiate the TernaryMlp from trained weights
    let mut mlp = match TernaryMlp::load_weights("C:\\KAI/data/ternary_mlp.bin") {
        Ok(m) => m,
        Err(_) => {
            println!("Warning: No trained TernaryMLP found. Using random weights.");
            TernaryMlp::new(crate::core::sparse_vec::DIM, 128, 42)
        }
    };

    // Compute the overarching semantic topic ONCE, rather than 150 times (which requires 472K linear scans!)
    let query_context = SparseVec::encode(query);
    let (topic_vec, _) = multi_hop_attend(&query_context, universe, 2);

    // 2. Autoregressive generation loop with Self-Reflection
    for attempt in 0..3 {
        let mut current_text = query.to_string();
        let mut generated_words = Vec::new();

        for _ in 0..max_tokens {
            // Encode the current sequence grammar with semantic augmentation
            let augmented_text: String = current_text
                .split_whitespace()
                .map(|w| {
                    let bundle = crate::cognition::semantic_dict::lookup_word(w);
                    if bundle.pos == "unknown" {
                        w.to_string()
                    } else {
                        format!("{} pos:{} syn:{}", w, bundle.pos, bundle.synonyms.join(","))
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let grammar_vec = SparseVec::encode(&augmented_text);

            // Superpose topic with current grammar
            let pairs: Vec<(&SparseVec, f32)> = vec![
                (&topic_vec, 0.7),
                (&grammar_vec, 0.3),
            ];
            let attended_vec = SparseVec::weighted_superpose(&pairs, 0.0);

            // Shift the semantic state to grammar prediction using the Ternary MLP!
            let prediction_vec = mlp.forward(&attended_vec);

            // Find the word in the local vocabulary that is closest to the PREDICTION state
            let mut best_word = "";
            let mut best_score = f32::NEG_INFINITY;

            for (word, vec) in &vocab {
                let mut score = prediction_vec.cosine(vec);
                
                // Add a little deterministic noise based on attempt number to escape local minima if rejected
                if attempt > 0 {
                    let noise = ((word.len() * (attempt + 1)) % 10) as f32 * 0.05;
                    score += noise;
                }
                
                // Repetition penalty
                let rep_count = generated_words.iter().filter(|&w| w == word).count();
                score -= (rep_count as f32) * 2.5;
                
                if score > best_score {
                    best_score = score;
                    best_word = word;
                }
            }

            // Break if we didn't find a good word
            if best_word.is_empty() {
                break;
            }

            // Append to our growing sequence
            generated_words.push(best_word.to_string());
            current_text.push(' ');
            current_text.push_str(best_word);
        }

        // WORD-CALCULUS (flag-gated, off by default): the lattice path emits only
        // space-joined words with NO punctuation. When enabled, render the word list
        // into structured sentences (operators + capitalization) so KAI speaks in
        // real sentences instead of a run-on. Unchanged when the flag is off.
        let final_text = if crate::cognition::word_calculus::enabled() {
            crate::cognition::word_calculus::render(&generated_words)
        } else {
            generated_words.join(" ")
        };
        let thought_vec = SparseVec::encode(&final_text);
        let reflection_score = topic_vec.cosine(&thought_vec);
        
        if reflection_score > 0.15 || attempt == 2 {
            println!("[SELF-REFLECTION] Thought accepted (Attempt {}, Score: {:.4})", attempt + 1, reflection_score);
            return final_text;
        } else {
            println!("[SELF-REFLECTION] Rejecting off-topic thought (Score: {:.4}). Retrying...", reflection_score);
        }
    }
    "".to_string()
}

pub fn run_train_ternary_mlp_cli(args: &[String]) {
    let dir = args
        .iter()
        .find_map(|a| a.strip_prefix("--dir="))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("data/training_corpus"));
    let hidden = args
        .iter()
        .find_map(|a| a.strip_prefix("--hidden="))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(2048);
    let epochs = args
        .iter()
        .find_map(|a| a.strip_prefix("--epochs="))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1);
    
    println!("═══════════════════════════════════════════════════════════════════");
    println!("  KAI — Ternary MLP Training (QAT)");
    println!("═══════════════════════════════════════════════════════════════════");
    
    let mut mlp = TernaryMlp::load_weights("data/ternary_mlp.bin")
        .unwrap_or_else(|_| {
            println!("No existing weights found, initializing fresh MLP...");
            TernaryMlp::new(crate::core::sparse_vec::DIM, hidden, 42)
        });
    let lr = 0.01;

    println!("Loading KAI Universe for multi-hop attention contexts...");
    let mut universe = if let Some(loaded) = crate::persistence::load_compact(".") {
        loaded.0
    } else {
        println!("Warning: Could not load universe, continuing with empty.");
        crate::core::Universe::new()
    };

    let entries: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => Vec::new(),
    };

    for epoch in 1..=epochs {
        println!("Epoch {}/{}", epoch, epochs);
        let mut epoch_loss = 0.0;
        let mut steps = 0;
        
        for entry in &entries {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            for line in content.lines() {
                if line.trim().is_empty() { continue; }
                let json: serde_json::Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let input_text = json["input"].as_str().unwrap_or("").trim();
                let reply_text = json["reply"].as_str().unwrap_or("").trim();
                
                if input_text.is_empty() || reply_text.is_empty() { continue; }
                if rand::random::<f32>() > 0.02 { continue; } // 50x speedup by keeping 2% of the corpus per epoch
                
                let last_user_text = input_text.to_string();
                
                // If it's kai responding, train on next word prediction!
                let words: Vec<&str> = reply_text.split_whitespace().take(20).collect();
                if words.is_empty() { continue; }
                
                // Compute topic vector ONCE per reply
                let topic_vec = crate::core::SparseVec::encode(&last_user_text);
                
                let mut current_grammar = String::new();
                
                for i in 0..words.len() {
                    let target_word = words[i];
                    
                    let augmented_text: String = current_grammar
                        .split_whitespace()
                        .map(|w| {
                            let bundle = crate::cognition::semantic_dict::lookup_word(w);
                            if bundle.pos == "unknown" {
                                w.to_string()
                            } else {
                                format!("{} pos:{} syn:{}", w, bundle.pos, bundle.synonyms.join(","))
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    let grammar_vec = crate::core::SparseVec::encode(&augmented_text);
                    let pairs: Vec<(&crate::core::SparseVec, f32)> = vec![
                        (&topic_vec, 0.7),
                        (&grammar_vec, 0.3),
                    ];
                    let attended_vec = crate::core::SparseVec::weighted_superpose(&pairs, 0.0);
                    
                    let target_bundle = crate::cognition::semantic_dict::lookup_word(target_word);
                    let augmented_target = if target_bundle.pos == "unknown" {
                        target_word.to_string()
                    } else {
                        format!("{} pos:{} syn:{} def:{}", target_word, target_bundle.pos, target_bundle.synonyms.join(","), target_bundle.definition)
                    };
                    let target_vec = crate::core::SparseVec::encode(&augmented_target);
                    
                    let loss = mlp.train_step(&attended_vec, &target_vec, lr);
                    epoch_loss += loss;
                    steps += 1;
                    
                    if steps % 100 == 0 {
                        println!("  step {} | loss: {:.4}", steps, epoch_loss / steps as f32);
                        mlp.w_in.quantize();
                        mlp.w_out.quantize();
                    }
                    if steps % 500 == 0 {
                        let weights_path = "data/ternary_mlp.bin";
                        mlp.save_weights(weights_path).expect("Failed to save weights");
                        println!("Saved partial weights at step {} to {}", steps, weights_path);
                    }
                    
                    current_grammar.push(' ');
                    current_grammar.push_str(target_word);
                }
            }
        }
        println!("Epoch {} complete. Avg Loss: {:.4}", epoch, epoch_loss / (steps as f32).max(1.0));
        
        let weights_path = "data/ternary_mlp.bin";
        mlp.save_weights(weights_path).expect("Failed to save weights");
        println!("Saved weights for epoch {} to {}", epoch, weights_path);
    }
    
    println!("Training complete.");
}

pub fn online_train_step(universe: &crate::core::Universe, sample_size: usize) -> f32 {
    let weights_path = "data/ternary_mlp.bin";
    let mut mlp = TernaryMlp::load_weights(weights_path)
        .unwrap_or_else(|_| TernaryMlp::new(crate::core::sparse_vec::DIM, 2048, 42));
    let lr = 0.005; // Slightly lower learning rate for continuous online learning
    
    let cells = universe.cells();
    if cells.is_empty() { return 0.0; }
    
    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();
    
    let sampled: Vec<_> = cells.choose_multiple(&mut rng, sample_size).collect();
    let mut total_loss = 0.0;
    let mut steps = 0;
    
    for cell in sampled {
        let text = &cell.claim.text;
        // Truncate to first 50 words to prevent O(N^2) explosion on large cells
        let words: Vec<&str> = text.split_whitespace().take(50).collect();
        if words.len() < 3 { continue; }
        
        let topic_vec = &cell.claim.vec;
        let mut current_grammar = String::new();
        
        for i in 0..words.len() {
            let target_word = words[i];
            
            let augmented_text: String = current_grammar
                .split_whitespace()
                .map(|w| {
                    let bundle = crate::cognition::semantic_dict::lookup_word(w);
                    if bundle.pos == "unknown" {
                        w.to_string()
                    } else {
                        format!("{} pos:{} syn:{}", w, bundle.pos, bundle.synonyms.join(","))
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");
            let grammar_vec = crate::core::SparseVec::encode(&augmented_text);
            let pairs: Vec<(&crate::core::SparseVec, f32)> = vec![
                (topic_vec, 0.7),
                (&grammar_vec, 0.3),
            ];
            let attended_vec = crate::core::SparseVec::weighted_superpose(&pairs, 0.0);
            
            let target_bundle = crate::cognition::semantic_dict::lookup_word(target_word);
            let augmented_target = if target_bundle.pos == "unknown" {
                target_word.to_string()
            } else {
                format!("{} pos:{} syn:{} def:{}", target_word, target_bundle.pos, target_bundle.synonyms.join(","), target_bundle.definition)
            };
            let target_vec = crate::core::SparseVec::encode(&augmented_target);
            
            let loss = mlp.train_step(&attended_vec, &target_vec, lr);
            total_loss += loss;
            steps += 1;
            
            current_grammar.push(' ');
            current_grammar.push_str(target_word);
        }
    }
    
    if steps > 0 {
        mlp.w_in.quantize();
        mlp.w_out.quantize();
        let _ = mlp.save_weights(weights_path);
        total_loss / steps as f32
    } else {
        0.0
    }
}

#[cfg(test)]
mod ar_vocab_tests {
    use super::{is_plausible_word, normalize_vocab_token};

    /// The REAL reply KAI produced while retrieval was working correctly
    /// (correct cell ranked #0, score 2.392, 17.3ms). Every junk token in it is
    /// explained by the un-filtered vocabulary this module now cleans.
    const OBSERVED_SALAD: &str =
        "LLM far pub 1e9 c_3 For for app s=1 ATX ice WSS sky why Why way ? 1-3 g(x phi Who who had yes CSS";

    /// Exactly the tokens from the salad that must never reach the word pool.
    const JUNK: &[&str] = &["1e9", "c_3", "ATX", "WSS", "CSS", "g(x", "s=1", "1-3", "LLM", "?"];

    /// Ordinary words — real, invented, and hyphenated — that must survive.
    const KEEP: &[&str] = &["constant", "flimbertwig", "ninety-three", "gravity"];

    #[test]
    fn rejects_observed_junk_tokens() {
        for &tok in JUNK {
            assert!(
                normalize_vocab_token(tok).is_none(),
                "junk token {:?} leaked into the AR vocabulary",
                tok
            );
        }
    }

    #[test]
    fn keeps_ordinary_words() {
        for &tok in KEEP {
            assert_eq!(
                normalize_vocab_token(tok).as_deref(),
                Some(tok),
                "ordinary word {:?} was wrongly rejected",
                tok
            );
        }
    }

    #[test]
    fn keeps_words_with_trailing_punctuation() {
        // Edge trimming is preserved from the original implementation.
        assert_eq!(normalize_vocab_token("gravity,").as_deref(), Some("gravity"));
        assert_eq!(normalize_vocab_token("(constant)").as_deref(), Some("constant"));
        assert_eq!(normalize_vocab_token("\"why?\"").as_deref(), Some("why"));
    }

    #[test]
    fn normalizes_case_into_one_entry() {
        // `For`/`for` and `Why`/`why` and `Who`/`who` were duplicate vocab slots.
        for (a, b) in [("For", "for"), ("Why", "why"), ("Who", "who")] {
            assert_eq!(
                normalize_vocab_token(a),
                normalize_vocab_token(b),
                "{:?} and {:?} should collapse to one vocabulary entry",
                a,
                b
            );
        }
        assert_eq!(normalize_vocab_token("For").as_deref(), Some("for"));
    }

    #[test]
    fn rejects_single_chars_and_pure_punctuation() {
        for tok in ["g", "x", "1", "?", "-", "--", "...", "", "   ", "!!!"] {
            assert!(
                normalize_vocab_token(tok).is_none(),
                "token {:?} should be rejected",
                tok
            );
        }
    }

    #[test]
    fn rejects_mixed_alphanumeric_and_symbols() {
        for tok in [
            "H2O", "v1", "x2y", "f(x)", "a_b", "foo::bar", "e=mc2", "3.14", "0x1F",
            "well--known", "it''s",
        ] {
            assert!(
                normalize_vocab_token(tok).is_none(),
                "token {:?} should be rejected as code/math, not a word",
                tok
            );
        }
    }

    #[test]
    fn rejects_vowelless_and_all_caps_initialisms() {
        // NB: `y` counts as a vowel — `sky` and `why` are real words and must survive,
        // so a lowercase pseudo-word like `xyz` is intentionally NOT caught here.
        for tok in ["WSS", "CSS", "LLM", "HTML", "nth", "IEEE"] {
            assert!(!is_plausible_word(tok), "{:?} is an initialism, not a word", tok);
        }
        // ...but a normally capitalised word is fine.
        assert!(is_plausible_word("Gravity"));
        assert!(is_plausible_word("Wikipedia"));
    }

    /// Feed the entire observed salad line through the filter and assert that
    /// what comes out is a clean, de-duplicated, lower-case word list.
    #[test]
    fn dirty_vocabulary_end_to_end() {
        let mut kept: Vec<String> = Vec::new();
        for raw in OBSERVED_SALAD.split_whitespace() {
            if let Some(w) = normalize_vocab_token(raw) {
                if !kept.contains(&w) {
                    kept.push(w);
                }
            }
        }

        // Nothing junky survived.
        for &j in JUNK {
            assert!(
                !kept.iter().any(|w| w == j || w == &j.to_lowercase()),
                "junk {:?} survived; kept = {:?}",
                j,
                kept
            );
        }
        // Everything left is a real word, lower-case, and unique.
        for w in &kept {
            assert_eq!(w, &w.to_lowercase(), "vocab entry {:?} was not lower-cased", w);
            assert!(
                w.chars().all(|c| c.is_alphabetic() || c == '-' || c == '\''),
                "vocab entry {:?} still contains non-word characters",
                w
            );
        }
        assert_eq!(
            kept,
            vec!["far", "pub", "for", "app", "ice", "sky", "why", "way", "phi", "who", "had", "yes"],
            "unexpected surviving vocabulary"
        );
    }

    #[test]
    fn legacy_path_is_byte_for_byte_unchanged() {
        // What the OFF path (`KAI_AR_VOCAB_CLEAN=0`) still does, verbatim.
        let legacy = |w: &str| {
            let c = w.trim_matches(|c: char| !c.is_alphanumeric());
            if c.is_empty() { None } else { Some(c.to_string()) }
        };
        assert_eq!(legacy("1e9").as_deref(), Some("1e9"));
        assert_eq!(legacy("g(x").as_deref(), Some("g(x"));
        assert_eq!(legacy("For").as_deref(), Some("For"));
        assert_eq!(legacy("?"), None);
    }
}
