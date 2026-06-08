//! Corpus Trainer — Turn public interactions into lattice memory.
//!
//! Every message KAI sends (Discord, TUI, Oracle) is logged to
//! `data/training_corpus/corpus_*.jsonl`.  This module reads those
//! files and teaches the lattice the conversational patterns they
//! contain.
//!
//! Two modes:
//!   1. **Ingest** — bind every `(input, reply)` pair as a sequence
//!      so `predictive_query` can surface "when someone said X, KAI
//!      said Y".
//!   2. **Train Response MLP** — build a lightweight learned layer
//!      that maps `SparseVec(input)` → `SparseVec(reply)` with a
//!      single hidden sparse layer.  The weights are stored as JSON
//!      and loaded into `build_generative_state` to bias the tail
//!      positions of the decoder toward historically good replies.

use crate::core::{SparseVec, Universe};
use rand::{Rng, SeedableRng};
use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use std::path::Path;

// ═══════════════════════════════════════════════════════════════════════════════
//  1. Corpus Ingestion — bind (input, reply) sequences into the lattice
// ═══════════════════════════════════════════════════════════════════════════════

/// A single entry from the JSONL corpus.
#[derive(Debug, serde::Deserialize)]
struct CorpusEntry {
    timestamp: u64,
    input: String,
    reply: String,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    channel_id: String,
    #[serde(default)]
    state: Option<CorpusState>,
    #[serde(default)]
    hits: Vec<CorpusHit>,
}

#[derive(Debug, serde::Deserialize, Default)]
struct CorpusState {
    #[serde(default)]
    confidence: f32,
    #[serde(default)]
    conflict: f32,
    #[serde(default)]
    felt_valence: f32,
    #[serde(default)]
    mood: String,
}

#[derive(Debug, serde::Deserialize)]
struct CorpusHit {
    text: String,
    score: f32,
    #[serde(default)]
    source: String,
}

/// Read every `*.jsonl` file in `corpus_dir`, extract `(input,reply)`
/// pairs, and bind them into `universe` as sequences.
///
/// * `strength` — how strongly the sequence is stored (default 1.0).
///   Higher for high-quality exchanges, lower for noisy ones.
/// * `skip_short` — drop pairs where input or reply is shorter than
///   this many characters (default 8).
/// * `max_entries` — stop after this many entries (0 = unlimited).
///
/// Returns `(entries_read, sequences_bound)`.
pub fn ingest_corpus_dir(
    universe: &mut Universe,
    corpus_dir: &Path,
    strength: f32,
    skip_short: usize,
    max_entries: usize,
) -> std::io::Result<(usize, usize)> {
    let mut entries_read = 0usize;
    let mut sequences_bound = 0usize;
    let start_tick = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if !corpus_dir.exists() {
        return Ok((0, 0));
    }

    for entry in std::fs::read_dir(corpus_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        let content = std::fs::read_to_string(&path)?;
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let record: CorpusEntry = match serde_json::from_str(line) {
                Ok(r) => r,
                Err(_) => continue,
            };
            entries_read += 1;

            let input = record.input.trim();
            let reply = record.reply.trim();
            if input.len() < skip_short || reply.len() < skip_short {
                continue;
            }

            // Skip obvious meta / system / error messages
            if is_noisy(&input) || is_noisy(&reply) {
                continue;
            }

            // Bind the sequence: input → reply
            universe.bind_sequence(input, reply, start_tick + entries_read as u64);
            sequences_bound += 1;

            // Also store the reply as a standalone cell so it can be
            // retrieved independently (with source = corpus).
            universe.store_or_reinforce_with_vec(
                reply,
                "language",
                "corpus",
                strength,
                None,
                None,
                &record.user_id,
            );

            if max_entries > 0 && sequences_bound >= max_entries {
                return Ok((entries_read, sequences_bound));
            }
        }
    }

    Ok((entries_read, sequences_bound))
}

/// Heuristic noise filter — skip lines that are clearly not useful
/// training material (logs, errors, empty echoes, etc.).
fn is_noisy(text: &str) -> bool {
    let lower = text.to_lowercase();
    // System / meta prefixes
    let bad_prefixes = [
        "error:", "warning:", "[system", "[critical", "http:",
        "thread '<", "panicked at", "---", "===", "`cargo",
        "`kai", "`ollama", "oracle: could not",
    ];
    for p in &bad_prefixes {
        if lower.starts_with(p) {
            return true;
        }
    }
    // Pure punctuation / whitespace
    if text.chars().all(|c| c.is_whitespace() || c.is_ascii_punctuation()) {
        return true;
    }
    false
}

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Corpus Statistics — human-readable report
// ═══════════════════════════════════════════════════════════════════════════════

/// Summarise a corpus directory.
pub fn corpus_stats(corpus_dir: &Path) -> std::io::Result<CorpusReport> {
    let mut total_entries = 0usize;
    let mut total_input_len = 0usize;
    let mut total_reply_len = 0usize;
    let mut earliest_ts = u64::MAX;
    let mut latest_ts = 0u64;
    let mut files_read = 0usize;

    if !corpus_dir.exists() {
        return Ok(CorpusReport::default());
    }

    for entry in std::fs::read_dir(corpus_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        files_read += 1;
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let json: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            total_entries += 1;
            if let Some(ts) = json["timestamp"].as_u64() {
                earliest_ts = earliest_ts.min(ts);
                latest_ts = latest_ts.max(ts);
            }
            total_input_len += json["input"].as_str().map(|s| s.len()).unwrap_or(0);
            total_reply_len += json["reply"].as_str().map(|s| s.len()).unwrap_or(0);
        }
    }

    let avg_input = if total_entries > 0 { total_input_len / total_entries } else { 0 };
    let avg_reply = if total_entries > 0 { total_reply_len / total_entries } else { 0 };

    Ok(CorpusReport {
        files_read,
        total_entries,
        avg_input_len: avg_input,
        avg_reply_len: avg_reply,
        earliest_ts: if earliest_ts == u64::MAX { 0 } else { earliest_ts },
        latest_ts,
    })
}

#[derive(Debug, Default)]
pub struct CorpusReport {
    pub files_read: usize,
    pub total_entries: usize,
    pub avg_input_len: usize,
    pub avg_reply_len: usize,
    pub earliest_ts: u64,
    pub latest_ts: u64,
}

// ═══════════════════════════════════════════════════════════════════════════════
//  3. Learned Sparse Response MLP (experimental)
// ═══════════════════════════════════════════════════════════════════════════════
//
//  A single-hidden-layer network that learns:
//      hidden = relu(W_in · input_vec)     (sparse, top-k activation)
//      output = tanh(W_out · hidden)         (sparse ternary, density-clamped)
//
//  Trained by SGD on (input_vec, reply_vec) pairs from the corpus.
//  The output is added as a bias term inside `build_generative_state`
//  when a `ResponseMlp` is loaded.

use serde::{Deserialize, Serialize};

/// A learned sparse response layer.
///
/// Weights are stored as `Vec<SparseVec>` — each row is a sparse
/// vector.  This keeps the model small (~KBs) and compatible with
/// RSHL's ternary philosophy.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseMlp {
    /// Dimension of input / output vectors (must match `DIM`).
    pub dim: usize,
    /// Number of hidden units.
    pub hidden: usize,
    /// Input → hidden weights: one sparse vector per hidden unit.
    pub w_in: Vec<SparseVec>,
    /// Hidden → output weights: one sparse vector per output dimension
    /// (or, equivalently, `DIM` sparse vectors of length `hidden`).
    pub w_out: Vec<SparseVec>,
    /// Learning rate used during training.
    pub learning_rate: f32,
    /// Number of training steps.
    pub train_steps: usize,
    /// Average training cosine after last epoch.
    pub final_cosine: f32,
}

impl ResponseMlp {
    pub fn new(dim: usize, hidden: usize, seed: u64) -> Self {
        use rand::{Rng, SeedableRng};
        use rand::rngs::StdRng;
        let mut rng = StdRng::seed_from_u64(seed);
        let target_nnz = ((dim as f32) * 0.04) as usize; // 4% density

        let w_in: Vec<SparseVec> = (0..hidden)
            .map(|_| random_sparse_vec(dim, target_nnz, &mut rng))
            .collect();

        let w_out: Vec<SparseVec> = (0..dim)
            .map(|_| random_sparse_vec(hidden, target_nnz.max(1), &mut rng))
            .collect();

        Self {
            dim,
            hidden,
            w_in,
            w_out,
            learning_rate: 0.05,
            train_steps: 0,
            final_cosine: 0.0,
        }
    }

    /// Forward pass: input → hidden (top-k ReLU) → output (sparse ternary).
    /// Returns a sparse vector of the same dimension as input.
    pub fn forward(&self, input: &SparseVec) -> SparseVec {
        // 1. Compute hidden activations
        let mut hidden_acts: Vec<f32> = Vec::with_capacity(self.hidden);
        for w in &self.w_in {
            hidden_acts.push(input.cosine(w).max(0.0)); // ReLU
        }

        // 2. Top-k sparsification on hidden layer (keep strongest 25%)
        let k = (self.hidden as f32 * 0.25).ceil() as usize;
        let mut indexed: Vec<(usize, f32)> = hidden_acts.iter().enumerate().map(|(i, &v)| (i, v)).collect();
        indexed.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        for i in k..indexed.len() {
            hidden_acts[indexed[i].0] = 0.0;
        }

        // 3. Hidden → output
        // Each output dim i = sum_j hidden[j] * w_out[i][j]
        let mut out_dense: Vec<f32> = vec![0.0f32; self.dim];
        for (i, w) in self.w_out.iter().enumerate() {
            // w has indices into hidden layer
            for (idx, val) in w.iter() {
                if idx < self.hidden {
                    out_dense[i] += hidden_acts[idx] * (val as f32);
                }
            }
        }

        // 4. Density clamp to 4%
        let target_nnz = ((self.dim as f32) * 0.04).ceil() as usize;
        let mut indexed_out: Vec<(usize, f32)> = out_dense.iter().enumerate().map(|(i, &v)| (i, v)).collect();
        indexed_out.sort_by(|a, b| b.1.abs().partial_cmp(&a.1.abs()).unwrap_or(std::cmp::Ordering::Equal));

        let threshold = if target_nnz < indexed_out.len() {
            indexed_out[target_nnz].1.abs()
        } else {
            0.0
        };

        let mut indices: Vec<usize> = Vec::with_capacity(target_nnz);
        let mut values: Vec<i8> = Vec::with_capacity(target_nnz);
        for (i, v) in indexed_out.into_iter().take(target_nnz) {
            indices.push(i);
            values.push(if v >= 0.0 { 1 } else { -1 });
        }

        SparseVec::from_parts(indices, values)
    }

    /// Train one step on a single (input, target) pair.
    /// Returns the cosine between predicted and target (higher = better).
    pub fn train_step(&mut self, input: &SparseVec, target: &SparseVec) -> f32 {
        let pred = self.forward(input);
        let cos = pred.cosine(target);

        // Simple reward-based Hebbian update:
        // If prediction aligns with target, strengthen active paths.
        // If prediction opposes target, weaken active paths.
        let reward = (cos - 0.5).clamp(-1.0, 1.0); // -0.5..0.5 centered

        // Update w_in: for each hidden unit that fired, adjust its
        // input weights toward / away from the input pattern.
        for (h_idx, w) in self.w_in.iter_mut().enumerate() {
            let act = input.cosine(w).max(0.0);
            if act > 0.0 {
                // Hebbian: move w toward input with magnitude = reward * lr
                let delta = reward * self.learning_rate * act;
                *w = w.hebbian_update(input, delta);
            }
        }

        // Update w_out: for each output dim, move w_out[i] toward
        // the hidden activation pattern weighted by target[i].
        // We do this by converting target to a dense sign vector.
        let target_dense: Vec<i8> = (0..self.dim)
            .map(|i| if target.get(i) > 0 { 1 } else if target.get(i) < 0 { -1 } else { 0 })
            .collect();

        // Recompute hidden_acts (same as forward, but we need them here)
        let hidden_acts: Vec<f32> = self.w_in.iter().map(|w| input.cosine(w).max(0.0)).collect();

        for (i, w) in self.w_out.iter_mut().enumerate() {
            let t_sign = target_dense[i] as f32; // -1, 0, 1
            if t_sign != 0.0 {
                let delta = reward * self.learning_rate * t_sign;
                // Build a "hidden pattern" sparse vec from active hidden units
                let mut h_indices: Vec<usize> = Vec::new();
                let mut h_values: Vec<i8> = Vec::new();
                for (h_idx, &act) in hidden_acts.iter().enumerate() {
                    if act > 0.0 {
                        h_indices.push(h_idx);
                        h_values.push(if act >= 0.0 { 1 } else { -1 });
                    }
                }
                let hidden_pattern = SparseVec::from_parts(h_indices, h_values);
                *w = w.hebbian_update(&hidden_pattern, delta);
            }
        }

        self.train_steps += 1;
        cos
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(path, json)?;
        Ok(())
    }

    pub fn load(path: &Path) -> std::io::Result<Self> {
        let json = std::fs::read_to_string(path)?;
        let mlp: Self = serde_json::from_str(&json)?;
        Ok(mlp)
    }
}

fn random_sparse_vec(dim: usize, nnz: usize, rng: &mut impl Rng) -> SparseVec {
    use rand::seq::SliceRandom;
    let mut indices: Vec<usize> = (0..dim).collect();
    indices.shuffle(rng);
    indices.truncate(nnz);
    indices.sort_unstable();
    let values: Vec<i8> = indices.iter().map(|_| if rng.gen_bool(0.5) { 1 } else { -1 }).collect();
    SparseVec::from_parts(indices, values)
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CLI helpers
// ═══════════════════════════════════════════════════════════════════════════════

/// Run `kai --ingest-corpus [--dir=PATH] [--strength=N] [--max=N]`
pub fn run_ingest_corpus_cli(args: &[String]) {
    let dir = args
        .iter()
        .find_map(|a| a.strip_prefix("--dir="))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("data/training_corpus"));
    let strength = args
        .iter()
        .find_map(|a| a.strip_prefix("--strength="))
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(1.0);
    let max_entries = args
        .iter()
        .find_map(|a| a.strip_prefix("--max="))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);

    println!("═══════════════════════════════════════════════════════════════════");
    println!("  KAI — Corpus Ingestion");
    println!("═══════════════════════════════════════════════════════════════════");
    println!("  dir      : {:?}", dir);
    println!("  strength : {}", strength);
    println!("  max      : {}", if max_entries == 0 { "unlimited".to_string() } else { max_entries.to_string() });
    println!();

    let mut universe = Universe::new();
    // Load existing mind if available (try nested Snapshot format first, then direct Universe)
    let mind_path = std::path::PathBuf::from("data/kai-mind.json");
    if mind_path.exists() {
        match std::fs::read_to_string(&mind_path) {
            Ok(json) => {
                // Try nested Snapshot format (persistence::save writes this)
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&json) {
                    if let Some(u) = val.get("universe") {
                        if let Ok(u) = serde_json::from_value::<Universe>(u.clone()) {
                            universe = u;
                            println!("[ingest] loaded existing mind: {} cells", universe.cell_count());
                        }
                    }
                }
            }
            Err(e) => println!("[ingest] warning: could not load mind: {}", e),
        }
    }

    match ingest_corpus_dir(&mut universe, &dir, strength, 8, max_entries) {
        Ok((read, bound)) => {
            println!("[ingest] entries read      : {}", read);
            println!("[ingest] sequences bound   : {}", bound);
            println!("[ingest] total cells now   : {}", universe.cell_count());

            // Save back — serialize universe directly (no need for full persistence)
            match serde_json::to_string(&universe) {
                Ok(json) => {
                    if let Err(e) = std::fs::write(&mind_path, json) {
                        eprintln!("[ingest] ERROR saving mind: {}", e);
                        std::process::exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("[ingest] ERROR serializing mind: {}", e);
                    std::process::exit(1);
                }
            }
            println!("[ingest] mind saved to {:?}", mind_path);
        }
        Err(e) => {
            eprintln!("[ingest] ERROR: {}", e);
            std::process::exit(1);
        }
    }
}

/// Run `kai --train-response-mlp [--dir=PATH] [--hidden=N] [--epochs=N] [--output=PATH]`
pub fn run_train_response_mlp_cli(args: &[String]) {
    let dir = args
        .iter()
        .find_map(|a| a.strip_prefix("--dir="))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("data/training_corpus"));
    let hidden = args
        .iter()
        .find_map(|a| a.strip_prefix("--hidden="))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(64);
    let epochs = args
        .iter()
        .find_map(|a| a.strip_prefix("--epochs="))
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(10);
    let output = args
        .iter()
        .find_map(|a| a.strip_prefix("--output="))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("data/response_mlp.json"));
    let seed = args
        .iter()
        .find_map(|a| a.strip_prefix("--seed="))
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0xC0FFEE_BABE);

    println!("═══════════════════════════════════════════════════════════════════");
    println!("  KAI — Response MLP Training");
    println!("═══════════════════════════════════════════════════════════════════");
    println!("  corpus : {:?}", dir);
    println!("  hidden : {}", hidden);
    println!("  epochs : {}", epochs);
    println!("  output : {:?}", output);
    println!();

    // Collect (input_vec, reply_vec) pairs from corpus
    let mut pairs: Vec<(SparseVec, SparseVec)> = Vec::new();
    let mut entries_read = 0usize;

    if !dir.exists() {
        eprintln!("[train-mlp] corpus dir not found: {:?}", dir);
        std::process::exit(1);
    }

    let entries: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(_) => Vec::new(),
    };
    for entry in entries {
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
            entries_read += 1;
            let input = json["input"].as_str().unwrap_or("").trim();
            let reply = json["reply"].as_str().unwrap_or("").trim();
            if input.len() < 8 || reply.len() < 8 { continue; }
            if is_noisy(input) || is_noisy(reply) { continue; }

            let iv = SparseVec::encode(input);
            let rv = SparseVec::encode(reply);
            if iv.nnz() > 0 && rv.nnz() > 0 {
                pairs.push((iv, rv));
            }
        }
    }

    if pairs.is_empty() {
        eprintln!("[train-mlp] no usable pairs found in corpus");
        std::process::exit(1);
    }

    println!("[train-mlp] entries read : {}", entries_read);
    println!("[train-mlp] usable pairs : {}", pairs.len());

    let dim = crate::core::sparse_vec::DIM;

    // Adaptive Hardware Detection
    let python_check = std::process::Command::new("python")
        .arg("-c")
        .arg("import sys; sys.exit(0)")
        .status();
        
    let mut use_gpu = false;
    
    if let Ok(status) = python_check {
        if status.success() {
            let torch_check = std::process::Command::new("python")
                .arg("-c")
                .arg("import torch")
                .status();
                
            if torch_check.is_err() || !torch_check.unwrap().success() {
                println!("[train-mlp] PyTorch not found. Attempting to install...");
                let _ = std::process::Command::new("python")
                    .args(&["-m", "pip", "install", "torch", "numpy"])
                    .status();
            }
            
            let torch_check2 = std::process::Command::new("python")
                .arg("-c")
                .arg("import torch")
                .status();
                
            if let Ok(ts) = torch_check2 {
                if ts.success() {
                    use_gpu = true;
                }
            }
        }
    }

    if use_gpu {
        println!("[train-mlp] Hardware detected: GPU (PyTorch)");
        let batch_path = std::path::PathBuf::from("data/mlp_batch.json");
        
        let batch_data = serde_json::json!({
            "dim": dim,
            "hidden": hidden,
            "pairs": pairs.iter().map(|(i, t)| {
                serde_json::json!({
                    "input": i,
                    "target": t
                })
            }).collect::<Vec<_>>()
        });
        
        println!("[train-mlp] Exporting {} pairs to batch file...", pairs.len());
        if let Err(e) = std::fs::write(&batch_path, serde_json::to_string(&batch_data).unwrap()) {
            eprintln!("[train-mlp] Failed to write batch file: {}", e);
            use_gpu = false;
        } else {
            let mut cmd = std::process::Command::new("python");
            cmd.arg("scripts/train_mlp_gpu.py")
               .arg("--data").arg(&batch_path)
               .arg("--out").arg(&output)
               .arg("--hidden").arg(hidden.to_string())
               .arg("--epochs").arg(epochs.to_string());
               
            println!("[train-mlp] Spawning PyTorch script...");
            let mut child = cmd.spawn().expect("Failed to start python");
            let status = child.wait().expect("Failed to wait on python");
            
            if status.success() {
                println!("[train-mlp] GPU training complete. Output saved to {:?}", output);
                let _ = std::fs::remove_file(&batch_path);
                return;
            } else {
                eprintln!("[train-mlp] GPU script failed. Falling back to pure Rust CPU loop...");
            }
        }
    }

    println!("[train-mlp] Hardware: Pure Rust CPU Fallback");
    let mut mlp = ResponseMlp::new(dim, hidden, seed);
    mlp.learning_rate = 0.05;

    use rand::{SeedableRng};
    use rand::rngs::StdRng;
    let mut rng = StdRng::seed_from_u64(seed);

    let mut idx: Vec<usize> = (0..pairs.len()).collect();

    for epoch in 0..epochs {
        idx.shuffle(&mut rng);
        let mut total_cos = 0.0f32;
        for &i in &idx {
            let (input, target) = &pairs[i];
            total_cos += mlp.train_step(input, target);
        }
        let mean_cos = total_cos / idx.len() as f32;
        println!("[train-mlp] epoch {:2} | mean cosine = {:.4}", epoch + 1, mean_cos);
    }

    mlp.final_cosine = pairs.iter().map(|(i, t)| mlp.forward(i).cosine(t)).sum::<f32>() / pairs.len() as f32;
    println!("[train-mlp] final cosine = {:.4}", mlp.final_cosine);

    match mlp.save(&output) {
        Ok(_) => println!("[train-mlp] saved to {:?}", output),
        Err(e) => {
            eprintln!("[train-mlp] save failed: {}", e);
            std::process::exit(1);
        }
    }
}
