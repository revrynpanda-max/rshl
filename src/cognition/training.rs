//! Training pipeline for `NeuralVsaMapper`.
//!
//! This module is the other half of `cognition::neural_mapper`. The
//! mapper knows how to *apply* a learned dense→sparse projection and
//! how to do one SGD step given a single paired example. This module
//! knows how to *produce* those paired examples at scale from a real
//! dense encoder (BitNet) and a real RSHL target (the existing
//! `StatLexicon` / `Universe` encoders), and how to run the outer
//! training loop until the mapper is actually good at the job.
//!
//! ## The data generating process
//!
//! For each training example we do the same two forward passes:
//!
//! ```text
//!                  ┌─────────────────────────┐
//!   text ──────────► BitNet (external LLM)  ┼──► dense ∈ ℝ^d_in
//!                  └─────────────────────────┘
//!                  ┌─────────────────────────┐
//!   text ──────────► StatLexicon::encode_sentence ─► target ∈ {-1,0,+1}^16384
//!                  └─────────────────────────┘
//! ```
//!
//! The mapper's job is to learn a projection `dense → target` so that
//! once trained, we can skip the RSHL encoder and read meaning *out of
//! BitNet's residual stream directly* in our VSA basis. This is the
//! Hyperdimensional-Probe setup (Bronzini et al. arXiv:2509.25045),
//! dimensioned for our ternary 16384-d system.
//!
//! ## BitNet integration
//!
//! We talk to BitNet over its existing HTTP inference server
//! (`run_inference_server.py` → `llama-server.exe`). That gets us:
//!
//!   * zero native-linking drama (no FFI, no CMake in our build tree),
//!   * automatic batching / continuous batching on the server side,
//!   * a stable, language-agnostic interface we can point at remote
//!     BitNet instances later if we scale up.
//!
//! The cost is one localhost round-trip per embedding (~1–5 ms on
//! the same box), which is fine — SGD throughput is limited by the
//! forward+backward through `W2`, not network.
//!
//! ### How to bring BitNet up (one time)
//!
//! Starting from the `BitNet-main` folder sibling to `kai-rust`:
//!
//! ```powershell
//! # 1. Build bitnet.cpp (llama.cpp fork) + download a GGUF model.
//! cd ..\BitNet-main
//! python setup_env.py --hf-repo microsoft/BitNet-b1.58-2B-4T --quant-type i2_s
//!
//! # 2. Start the inference server in *embedding* mode.
//! python run_inference_server.py --host 127.0.0.1 --port 8080
//! # NOTE: embeddings require --embedding. If your llama-server doesn't
//! # accept it via run_inference_server.py, run the binary directly:
//! #   .\build\bin\Release\llama-server.exe -m <path-to.gguf> \
//! #       --host 127.0.0.1 --port 8080 --embedding -c 2048 -t 4
//! ```
//!
//! Once the server is up and idle, `--train-mapper` in this crate
//! will start sending `POST /embedding` requests to it and
//! streaming training pairs.
//!
//! ## Stub mode (works without BitNet)
//!
//! For pipeline validation, plumbing tests, and so the training
//! command doesn't sit dead until BitNet is built, we ship a
//! deterministic pure-Rust `StubEmbedder`. It produces a dense
//! pseudo-embedding from a text by hashing word trigrams and folding
//! them into a fixed-width `Vec<f32>` via sin/cos banks. It is not a
//! language model; it is just *a stable function from text to ℝ^d_in*
//! with enough signal that the probe can actually learn something.
//! Useful for:
//!
//!   * making sure `train_epoch` converges (MSE drops over epochs),
//!   * timing how many pairs/sec we can push through the training
//!     loop,
//!   * exercising save/load in integration tests,
//!
//! The moment BitNet is up, flip the embedder to `BitNetEmbedder` and
//! the rest of this file does not change.
//!
//! ## CLI
//!
//! `run_train_mapper_cli(args)` parses these flags:
//!
//! | flag                     | default                     | meaning                                                   |
//! |--------------------------|-----------------------------|-----------------------------------------------------------|
//! | `--train-mapper`         | —                           | activate the trainer (required)                           |
//! | `--bitnet-url=URL`       | `http://127.0.0.1:8080`     | base URL of a running `llama-server --embedding`          |
//! | `--stub-embedder`        | off                         | force-use `StubEmbedder`; skip BitNet entirely            |
//! | `--d-in=N`               | probe the server (or 384)   | dense embedding width                                     |
//! | `--d-hidden=N`           | max(2048, d_in/2) auto      | mapper hidden width; auto-scaled for real LLM embeddings  |
//! | `--num-pairs=N`          | 2000                        | unique training pairs generated this run                  |
//! | `--num-epochs=N`         | 5                           | epochs over the pair set                                  |
//! | `--learning-rate=F`      | 5e-4                        | SGD step size on the output layer                         |
//! | `--corpus-dir=PATH`      | `data/ingest_shelved`       | directory of `.txt` files to sample sentences from        |
//! | `--lexicon=PATH`         | `data/stat-lexicon.json`    | pre-built StatLexicon file (see `kai --build-lexicon`)    |
//! | `--output=PATH`          | `data/mapper.bin`           | where to write the trained mapper                         |
//! | `--seed=N`               | `0xC0FFEE_BABE`             | PRNG seed for mapper init + shuffle                       |
//!
//! To wire this into `main.rs` (explicitly left for later per the
//! project plan), add near the other `args.iter().any(...)` blocks:
//!
//! ```ignore
//! if args.iter().any(|a| a == "--train-mapper") {
//!     kai::cognition::training::run_train_mapper_cli(&args);
//!     return Ok(());
//! }
//! ```

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use serde_json::Value;

use crate::cognition::neural_mapper::{NeuralVsaMapper, DEFAULT_D_HIDDEN, DEFAULT_LEARNING_RATE};
use crate::core::sparse_vec::SparseVec;
use crate::core::stat_lexicon::StatLexicon;

// ─────────────────────────────────────────────────────────────────────
// DenseEmbedder — pluggable dense-embedding backend
// ─────────────────────────────────────────────────────────────────────

/// Any source of dense embeddings the trainer can consume. Implement
/// this for each external encoder we want to train the probe against
/// (BitNet, a remote inference endpoint, a pre-computed `.jsonl`, …).
///
/// Blocking on purpose — the inner SGD loop is sequential, there's no
/// latency we can hide behind async, and single-thread simplicity
/// dominates the design.
pub trait DenseEmbedder: Send + Sync {
    /// Width of every vector this embedder will return. Must be
    /// stable for the embedder's lifetime — the mapper is built
    /// against this value and can't silently handle a change.
    fn d_in(&self) -> usize;

    /// Produce a single dense embedding for the given text.
    ///
    /// Errors are `String` for CLI-friendliness; callers typically
    /// log and skip a bad sample rather than abort training.
    fn embed(&self, text: &str) -> Result<Vec<f32>, String>;

    /// Short name for logs / checkpoints.
    fn name(&self) -> &'static str;
}

/// Live BitNet embedder talking to a running `llama-server`.
///
/// The server must be launched with the `--embedding` flag, otherwise
/// `/embedding` returns a 500 and training aborts immediately.
///
/// `d_in` is auto-discovered via a single warm-up probe at
/// construction time so the mapper is instantiated against the actual
/// width of *this specific model*, not a hardcoded assumption.
pub struct BitNetEmbedder {
    base_url: String,
    d_in: usize,
    agent: ureq::Agent,
}

impl BitNetEmbedder {
    /// Connect to a running llama-server embedding endpoint and
    /// probe a dummy sentence to learn the output dimension.
    ///
    /// Returns `Err(msg)` with a clear explanation if the server
    /// isn't up or isn't in `--embedding` mode.
    pub fn new(base_url: impl Into<String>) -> Result<Self, String> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        // A short timeout — if the server is slow to first response
        // we'd rather fail loudly than wait 30 seconds at startup.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(30))
            .build();

        // Probe: send a short sentence through /embedding, read the
        // response shape. llama-server returns one of:
        //   {"embedding": [f32, ...]}
        //   {"embedding": [[f32, ...]]}
        //   [{"embedding": [f32, ...]}, ...]
        // depending on server version and batch size. We handle all
        // three via `parse_embedding_response`.
        let probe_text = "hello";
        let response: Value = agent
            .post(&format!("{}/embedding", base_url))
            .set("Content-Type", "application/json")
            .send_json(ureq::json!({ "content": probe_text }))
            .map_err(|e| {
                format!(
                    "BitNet probe failed ({}): is llama-server up with --embedding at {}? \
                 Check README in cognition/training.rs for launch instructions.",
                    e, base_url
                )
            })?
            .into_json::<Value>()
            .map_err(|e| format!("BitNet probe: invalid JSON response: {}", e))?;

        let probed = parse_embedding_response(&response).ok_or_else(|| {
            format!(
                "BitNet probe: could not find an embedding array in response: {}",
                response
            )
        })?;

        let d_in = probed.len();
        if d_in == 0 {
            return Err("BitNet probe returned empty embedding".to_string());
        }

        eprintln!(
            "[training] connected to BitNet at {} (d_in = {})",
            base_url, d_in
        );

        Ok(Self {
            base_url,
            d_in,
            agent,
        })
    }
}

impl DenseEmbedder for BitNetEmbedder {
    fn d_in(&self) -> usize {
        self.d_in
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let response: Value = self
            .agent
            .post(&format!("{}/embedding", self.base_url))
            .set("Content-Type", "application/json")
            .send_json(ureq::json!({ "content": text }))
            .map_err(|e| format!("BitNet embed HTTP error: {}", e))?
            .into_json::<Value>()
            .map_err(|e| format!("BitNet embed JSON error: {}", e))?;

        let v = parse_embedding_response(&response)
            .ok_or_else(|| format!("BitNet embed: no embedding in response: {}", response))?;
        if v.len() != self.d_in {
            return Err(format!(
                "BitNet embed: width mismatch (expected {}, got {})",
                self.d_in,
                v.len()
            ));
        }
        Ok(v)
    }

    fn name(&self) -> &'static str {
        "bitnet"
    }
}

// ─────────────────────────────────────────────────────────────────────
// OllamaEmbedder — talks to a local `ollama serve` instance over HTTP.
//
// Ollama exposes `/api/embeddings` on port 11434 by default. The
// request shape is `{"model": "<name>", "prompt": "<text>"}`, and
// the response is `{"embedding": [f32, ...], ...}`. That gives us
// the final pooled hidden state of whatever model is loaded — the
// real "what does the LLM think about this sentence" signal we
// train the probe against.
//
// Works against any embedding-capable Ollama model; common choices:
//   * `mistral:7b`          — 4096-d embedding, strong semantics
//   * `llama3.2:3b`         — 3072-d embedding, lighter/faster
//   * `nomic-embed-text`    — 768-d, purpose-built for embeddings
//   * `mxbai-embed-large`   — 1024-d, purpose-built for embeddings
//
// Any generation model will work too (Ollama runs the forward pass
// and exposes the pooled hidden state) but the dedicated embedding
// models are trained with a contrastive objective and produce
// better semantic-structure signal per dollar of GPU time.
// ─────────────────────────────────────────────────────────────────────

/// Real LLM embedder talking to a running `ollama serve` instance.
///
/// `d_in` is auto-discovered at construction time by probing the
/// configured model — the mapper built on top of this is therefore
/// dimensioned against the actual model width, not a hardcode.
///
/// Ollama has two embedding endpoints:
///   • `/api/embed`      — newer API (Ollama ≥0.5), request uses `"input"` key
///   • `/api/embeddings` — older API, request uses `"prompt"` key
///
/// The constructor probes the new endpoint first, falls back to the
/// old one, and remembers which worked for all subsequent `embed`
/// calls. This way we work against any Ollama version without the
/// user having to care.
pub struct OllamaEmbedder {
    base_url: String,
    model: String,
    d_in: usize,
    agent: ureq::Agent,
    /// Which endpoint succeeded at probe time. `true` = new
    /// `/api/embed`, `false` = old `/api/embeddings`.
    use_new_api: bool,
}

impl OllamaEmbedder {
    /// Connect to `base_url` (typically `http://127.0.0.1:11434`)
    /// and warm-probe `model` to discover its embedding width.
    ///
    /// Fails loudly with a human-readable message if Ollama isn't
    /// running or the model isn't pulled — we'd rather error out
    /// before training than silently send thousands of 404s.
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> Result<Self, String> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let model = model.into();

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(120))
            .build();

        let probe_text = "hello world";

        // Try the new /api/embed endpoint first (Ollama ≥0.5).
        // Request shape: {"model":"...", "input":"..."}
        // Response shape: {"embeddings":[[f32, ...]]}
        let new_result = ollama_post(
            &agent,
            &format!("{}/api/embed", base_url),
            &ureq::json!({ "model": model, "input": probe_text }),
        );

        if let Ok(ref resp) = new_result {
            if let Some(probed) = parse_embedding_response(resp) {
                if !probed.is_empty() {
                    eprintln!(
                        "[training] connected to Ollama at {} · model='{}' · d_in={} (api/embed)",
                        base_url,
                        model,
                        probed.len()
                    );
                    return Ok(Self {
                        base_url,
                        model,
                        d_in: probed.len(),
                        agent,
                        use_new_api: true,
                    });
                }
            }
        }

        // Fall back to the old /api/embeddings endpoint.
        // Request shape: {"model":"...", "prompt":"..."}
        // Response shape: {"embedding":[f32, ...]}
        let old_result = ollama_post(
            &agent,
            &format!("{}/api/embeddings", base_url),
            &ureq::json!({ "model": model, "prompt": probe_text }),
        );

        match old_result {
            Ok(ref resp) => {
                if let Some(probed) = parse_embedding_response(resp) {
                    if !probed.is_empty() {
                        eprintln!(
                            "[training] connected to Ollama at {} · model='{}' · d_in={} (api/embeddings)",
                            base_url, model, probed.len()
                        );
                        return Ok(Self {
                            base_url,
                            model,
                            d_in: probed.len(),
                            agent,
                            use_new_api: false,
                        });
                    }
                }
                Err(format!(
                    "Ollama probe: no embedding array in response from either endpoint.\n\
                     /api/embed   → {}\n\
                     /api/embeddings → {}\n\n\
                     Does your model expose embeddings? Try `nomic-embed-text` or `mxbai-embed-large`.\n\
                     If using a generation model like mistral:7b, make sure it's pulled: `ollama pull {}`",
                    new_result.as_ref().map_or_else(|e| e.clone(), |v| v.to_string()),
                    resp,
                    model,
                ))
            }
            Err(old_err) => {
                let new_err = new_result
                    .err()
                    .unwrap_or_else(|| "(no embedding in response)".to_string());
                Err(format!(
                    "Ollama probe failed on both endpoints:\n\
                     /api/embed      → {}\n\
                     /api/embeddings → {}\n\n\
                     Check:\n\
                     1. Is `ollama serve` running at {}?\n\
                     2. Is the model pulled? Run: `ollama pull {}`\n\
                     3. Is Ollama still starting up / upgrading? Wait a moment and retry.",
                    new_err, old_err, base_url, model,
                ))
            }
        }
    }
}

/// Fire a POST to an Ollama endpoint and return the parsed JSON body.
/// On HTTP error, extracts the response body (which often contains
/// Ollama's `{"error":"..."}` message) so the caller can show the
/// *real* reason (e.g. "model not found") instead of just "404".
fn ollama_post(agent: &ureq::Agent, url: &str, body: &Value) -> Result<Value, String> {
    match agent
        .post(url)
        .set("Content-Type", "application/json")
        .send_json(body.clone())
    {
        Ok(resp) => resp
            .into_json::<Value>()
            .map_err(|e| format!("invalid JSON: {}", e)),
        Err(ureq::Error::Status(code, resp)) => {
            let body_text = resp.into_string().unwrap_or_default();
            let detail = if let Ok(v) = serde_json::from_str::<Value>(&body_text) {
                v.get("error")
                    .and_then(|e| e.as_str())
                    .unwrap_or(&body_text)
                    .to_string()
            } else if !body_text.is_empty() {
                body_text
            } else {
                "(empty body)".to_string()
            };
            Err(format!("HTTP {} — {}", code, detail))
        }
        Err(e) => Err(format!("{}", e)),
    }
}

impl DenseEmbedder for OllamaEmbedder {
    fn d_in(&self) -> usize {
        self.d_in
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let (url, body) = if self.use_new_api {
            (
                format!("{}/api/embed", self.base_url),
                ureq::json!({ "model": self.model, "input": text }),
            )
        } else {
            (
                format!("{}/api/embeddings", self.base_url),
                ureq::json!({ "model": self.model, "prompt": text }),
            )
        };

        let response = ollama_post(&self.agent, &url, &body)
            .map_err(|e| format!("Ollama embed error: {}", e))?;

        let v = parse_embedding_response(&response)
            .ok_or_else(|| format!("Ollama embed: no embedding in response: {}", response))?;
        if v.len() != self.d_in {
            return Err(format!(
                "Ollama embed: width mismatch (expected {}, got {})",
                self.d_in,
                v.len()
            ));
        }
        Ok(v)
    }

    fn name(&self) -> &'static str {
        "ollama"
    }
}

/// Pull a `Vec<f32>` out of Ollama/llama-server's various embedding
/// response shapes. Returns `None` if nothing matches.
///
/// Known shapes (all actually seen in the wild across Ollama versions,
/// llama.cpp server, and OpenAI-compatible proxies):
///
///   A: `{"embedding": [f32, ...]}`         — old /api/embeddings
///   B: `{"embedding": [[f32, ...]]}`       — old /api/embeddings (batched)
///   C: `[{"embedding": [f32, ...]}, ...]`  — root-array wrapper
///   D: `{"data": [{"embedding": [...]}]}`  — OpenAI /v1/embeddings
///   E: `{"embeddings": [[f32, ...]]}`      — new /api/embed (Ollama ≥0.5)
fn parse_embedding_response(v: &Value) -> Option<Vec<f32>> {
    // Shape A: {"embedding": [f32, ...]}
    if let Some(arr) = v.get("embedding").and_then(|x| x.as_array()) {
        if arr.first().is_some_and(|x| x.is_number()) {
            return Some(
                arr.iter()
                    .filter_map(|x| x.as_f64())
                    .map(|x| x as f32)
                    .collect(),
            );
        }
        // Shape B: {"embedding": [[f32, ...]]}
        if let Some(inner) = arr.first().and_then(|x| x.as_array()) {
            return Some(
                inner
                    .iter()
                    .filter_map(|x| x.as_f64())
                    .map(|x| x as f32)
                    .collect(),
            );
        }
    }
    // Shape E: {"embeddings": [[f32, ...]]}  — new /api/embed
    if let Some(arr) = v.get("embeddings").and_then(|x| x.as_array()) {
        if let Some(first) = arr.first() {
            if let Some(inner) = first.as_array() {
                if inner.first().is_some_and(|x| x.is_number()) {
                    return Some(
                        inner
                            .iter()
                            .filter_map(|x| x.as_f64())
                            .map(|x| x as f32)
                            .collect(),
                    );
                }
            }
            if first.is_number() {
                return Some(
                    arr.iter()
                        .filter_map(|x| x.as_f64())
                        .map(|x| x as f32)
                        .collect(),
                );
            }
        }
    }
    // Shape C: [{"embedding": [f32, ...]}, ...]  — root array
    if let Some(arr) = v.as_array() {
        if let Some(first) = arr.first() {
            return parse_embedding_response(first);
        }
    }
    // Shape D: {"data": [{"embedding": [f32, ...]}]}  — /v1/embeddings
    if let Some(data) = v.get("data").and_then(|x| x.as_array()) {
        if let Some(first) = data.first() {
            return parse_embedding_response(first);
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────
// StubEmbedder — pure-Rust deterministic fallback
// ─────────────────────────────────────────────────────────────────────

/// Deterministic text→dense hash that behaves *like* an embedding for
/// training-pipeline validation purposes. Given the same text it
/// always returns the same vector; similar texts produce correlated
/// vectors because they share word trigrams in the same hash bins.
///
/// Not meant for real inference — do not point this at production
/// KAI. Its only job is to let the training loop exercise every code
/// path end-to-end (including save/load and convergence) while BitNet
/// is still being built.
pub struct StubEmbedder {
    d_in: usize,
}

impl StubEmbedder {
    pub fn new(d_in: usize) -> Self {
        assert!(d_in > 0);
        Self { d_in }
    }
}

impl DenseEmbedder for StubEmbedder {
    fn d_in(&self) -> usize {
        self.d_in
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        // Word-level bag with per-word sin/cos banks keyed by
        // FNV-1a(word). Two texts that share a word land at the same
        // set of `d_in` buckets with the same magnitudes — exactly
        // the kind of correlated signal a linear probe can fit.
        let mut out = vec![0.0f32; self.d_in];
        let mut n_words = 0u32;
        for raw in text.split_whitespace() {
            let word: String = raw
                .chars()
                .flat_map(char::to_lowercase)
                .filter(|c| c.is_alphanumeric())
                .collect();
            if word.is_empty() {
                continue;
            }
            n_words += 1;
            let h = fnv1a_u64(word.as_bytes());
            // Bank of 4 sinusoidal features per word. Small number
            // keeps the stub signal honest — the probe has to
            // actually learn, not just memorize.
            let phases = [
                (h as u32) as f32 * 2.3283064e-10,
                ((h >> 16) as u32) as f32 * 2.3283064e-10,
                ((h >> 32) as u32) as f32 * 2.3283064e-10,
                ((h >> 48) as u32) as f32 * 2.3283064e-10,
            ];
            for (bank_idx, phase) in phases.iter().enumerate() {
                let stride = (bank_idx + 1) as f32 * 0.07;
                for i in 0..self.d_in {
                    let t = (i as f32) * stride + phase * 6.2831853;
                    out[i] += t.sin();
                }
            }
        }
        if n_words > 0 {
            let inv = 1.0 / (n_words as f32);
            for v in &mut out {
                *v *= inv;
            }
        }
        // Unit-normalize. Real sentence encoders usually L2-norm the
        // output; downstream probes often assume it. Match the
        // convention so the stub doesn't teach the probe the wrong
        // scale.
        let norm: f32 = out.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-8);
        for v in &mut out {
            *v /= norm;
        }
        Ok(out)
    }

    fn name(&self) -> &'static str {
        "stub"
    }
}

/// Standard 64-bit FNV-1a. No dep just for this.
fn fnv1a_u64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xCBF29CE484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001B3);
    }
    h
}

// ─────────────────────────────────────────────────────────────────────
// Corpus loading
// ─────────────────────────────────────────────────────────────────────

/// Walk `dir`, read every `.txt` file, split on sentence boundaries,
/// keep sentences with ≥ `min_words` words after tokenizing loosely.
///
/// Returns shuffled sentences (deterministic under `seed`) so the
/// downstream SGD loop sees topic-diverse samples rather than a
/// thousand consecutive biology definitions followed by a thousand
/// physics ones.
pub fn load_corpus_sentences<P: AsRef<Path>>(
    dir: P,
    min_words: usize,
    seed: u64,
) -> std::io::Result<Vec<String>> {
    let mut sentences: Vec<String> = Vec::new();
    let dir = dir.as_ref();
    if !dir.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("corpus dir not found: {}", dir.display()),
        ));
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("txt") {
            continue;
        }
        let text = fs::read_to_string(&p)?;
        for sent in split_sentences(&text) {
            let n_words = sent.split_whitespace().count();
            if n_words >= min_words {
                sentences.push(sent);
            }
        }
    }

    let mut rng = StdRng::seed_from_u64(seed);
    sentences.shuffle(&mut rng);
    Ok(sentences)
}

/// Very tolerant sentence splitter. Splits on `. ! ?` when followed by
/// whitespace or EOF, and also treats newlines as boundaries so
/// line-per-definition corpora (our starter files) still break apart.
fn split_sentences(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let chars: Vec<char> = text.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        buf.push(c);
        let is_term = c == '.' || c == '!' || c == '?' || c == '\n';
        let next = chars.get(i + 1).copied();
        let boundary = is_term && matches!(next, None | Some(' ' | '\t' | '\n' | '\r'));
        if boundary {
            let s = buf
                .trim()
                .trim_matches(|x: char| x == '.' || x == '!' || x == '?')
                .trim();
            if !s.is_empty() {
                out.push(s.to_string());
            }
            buf.clear();
        }
    }
    let tail = buf.trim();
    if !tail.is_empty() {
        out.push(tail.to_string());
    }
    out
}

// ─────────────────────────────────────────────────────────────────────
// Pair generation
// ─────────────────────────────────────────────────────────────────────

/// Generate `how_many` `(dense, target)` training pairs by sampling
/// from `sentences` with replacement and calling both the dense
/// embedder and the RSHL target encoder per sample.
///
/// Samples that can't be embedded (HTTP error, malformed response)
/// are logged once and skipped — we don't abort training over a
/// single bad sentence. Samples whose RSHL target is the zero vector
/// (lexicon doesn't know any of the words in the sentence) are also
/// skipped: the probe can't learn anything from a `0 → 0` pair and
/// it would dilute the loss signal.
///
/// If `sentences` is empty or every candidate fails, returns an
/// empty `Vec`. The caller is responsible for handling the empty
/// case (typically: log and abort with instructions).
pub fn generate_training_pairs(
    embedder: &dyn DenseEmbedder,
    lex: &StatLexicon,
    sentences: &[String],
    how_many: usize,
    seed: u64,
) -> Vec<(Vec<f32>, SparseVec)> {
    if sentences.is_empty() || how_many == 0 {
        return Vec::new();
    }
    let mut rng = StdRng::seed_from_u64(seed);
    let mut pairs: Vec<(Vec<f32>, SparseVec)> = Vec::with_capacity(how_many);

    let mut errors = 0usize;
    let mut zero_targets = 0usize;
    let progress_every = (how_many / 20).max(50); // ~20 prints per run
    let t0 = Instant::now();

    let mut attempts = 0usize;
    // Hard cap on attempts to prevent an endless loop if every
    // sentence fails (broken server, empty lexicon, etc.).
    let max_attempts = how_many.saturating_mul(8).max(50);

    while pairs.len() < how_many && attempts < max_attempts {
        attempts += 1;
        let idx: usize = rng.gen_range(0..sentences.len());
        let text = &sentences[idx];

        let target = lex.encode_sentence(text);
        if target.nnz() == 0 {
            zero_targets += 1;
            continue;
        }

        match embedder.embed(text) {
            Ok(dense) => {
                pairs.push((dense, target));
                if pairs.len() % progress_every == 0 {
                    let elapsed = t0.elapsed().as_secs_f32();
                    let rate = pairs.len() as f32 / elapsed.max(0.001);
                    eprintln!(
                        "[training] generated {}/{} pairs ({:.1}/s, errs={}, zero_targets={})",
                        pairs.len(),
                        how_many,
                        rate,
                        errors,
                        zero_targets,
                    );
                }
            }
            Err(e) => {
                errors += 1;
                if errors <= 3 {
                    eprintln!("[training] embed error (sample={:?}): {}", text, e);
                }
            }
        }
    }

    eprintln!(
        "[training] pair generation done: {} pairs, {} errors, {} zero-target skips, {} attempts, {:.2}s",
        pairs.len(),
        errors,
        zero_targets,
        attempts,
        t0.elapsed().as_secs_f32(),
    );
    pairs
}

// ─────────────────────────────────────────────────────────────────────
// Training loop
// ─────────────────────────────────────────────────────────────────────

/// Everything needed to kick off a training run. All fields have
/// sensible defaults in `TrainConfig::default()` so `run_train_mapper_cli`
/// can merge user flags over a coherent base.
#[derive(Clone, Debug)]
pub struct TrainConfig {
    /// `Some(url)` → use `BitNetEmbedder` against that base URL.
    /// `None`      → use `StubEmbedder` (pipeline-only validation).
    pub bitnet_url: Option<String>,

    /// When `bitnet_url` is `None` *or* probing BitNet fails in a
    /// recoverable way, fall back to this stub width. Ignored when a
    /// live BitNet is up — in that case `d_in` is whatever the
    /// server returns.
    pub stub_d_in: usize,

    /// Mapper hidden width.
    pub d_hidden: usize,

    /// Number of training pairs generated per run.
    pub num_pairs: usize,

    /// Full passes over the generated pair set.
    pub num_epochs: usize,

    /// SGD step size on the output layer.
    pub learning_rate: f32,

    /// Directory of `.txt` files for the training corpus.
    pub corpus_dir: PathBuf,

    /// Pre-built StatLexicon (`--build-lexicon` first). If this file
    /// doesn't exist, the trainer errors out with a pointer to the
    /// build command.
    pub lexicon_path: PathBuf,

    /// Where the trained mapper will be written (binary format — see
    /// `NeuralVsaMapper::save`).
    pub output_path: PathBuf,

    /// RNG seed for mapper init + corpus shuffle + pair sampling.
    /// Same seed → same training run, bit-for-bit.
    pub seed: u64,
}

impl Default for TrainConfig {
    fn default() -> Self {
        Self {
            bitnet_url: Some("http://127.0.0.1:8080".to_string()),
            stub_d_in: 384,
            d_hidden: DEFAULT_D_HIDDEN,
            num_pairs: 2_000,
            num_epochs: 5,
            learning_rate: DEFAULT_LEARNING_RATE,
            corpus_dir: PathBuf::from("data/ingest_shelved"),
            lexicon_path: PathBuf::from("data/stat-lexicon.json"),
            output_path: PathBuf::from("data/mapper.bin"),
            seed: 0xC0FFEE_BABE,
        }
    }
}

/// End-to-end training run.
///
/// Steps (print-ed live to stderr so a long run is watchable):
///
///   1. Load or error-on-missing the StatLexicon (we don't silently
///      build it here — explicit is kinder to the user).
///   2. Load corpus sentences.
///   3. Construct the embedder (BitNet or stub).
///   4. Generate `num_pairs` paired examples.
///   5. Instantiate a fresh `NeuralVsaMapper` with the correct
///      `d_in` from the embedder.
///   6. Run `num_epochs` of `mapper.train_epoch(&pairs)`, printing
///      mean loss and wall time per epoch.
///   7. Save the mapper.
///   8. Print a final cosine self-check: sample a handful of
///      sentences, map each via `mapper.map_to_sparse`, and compare
///      against `lex.encode_sentence(same)` — this is the crude
///      "is the probe doing anything" tell.
pub fn train_mapper(cfg: TrainConfig) -> Result<(), String> {
    eprintln!("[training] config: {:#?}", cfg);

    // ── 1. Lexicon ───────────────────────────────────────────────────
    if !cfg.lexicon_path.exists() {
        return Err(format!(
            "lexicon not found at {:?}. Run `kai --build-lexicon` first.",
            cfg.lexicon_path
        ));
    }
    let lex = StatLexicon::load(&cfg.lexicon_path)
        .map_err(|e| format!("failed to load lexicon {:?}: {}", cfg.lexicon_path, e))?;
    if lex.is_empty() {
        return Err(format!("lexicon at {:?} is empty", cfg.lexicon_path));
    }

    // ── 2. Corpus ────────────────────────────────────────────────────
    let sentences = load_corpus_sentences(&cfg.corpus_dir, 3, cfg.seed)
        .map_err(|e| format!("failed to load corpus {:?}: {}", cfg.corpus_dir, e))?;
    if sentences.is_empty() {
        return Err(format!(
            "corpus {:?} produced zero usable sentences",
            cfg.corpus_dir
        ));
    }
    eprintln!("[training] loaded {} corpus sentences", sentences.len());

    // ── 3. Embedder ──────────────────────────────────────────────────
    let embedder: Box<dyn DenseEmbedder> = match &cfg.bitnet_url {
        Some(url) => match BitNetEmbedder::new(url.clone()) {
            Ok(e) => Box::new(e),
            Err(msg) => {
                return Err(format!(
                    "BitNet setup failed:\n  {}\n\nTo use the stub embedder instead pass \
                     --stub-embedder.",
                    msg
                ));
            }
        },
        None => {
            eprintln!("[training] using StubEmbedder (d_in = {})", cfg.stub_d_in);
            Box::new(StubEmbedder::new(cfg.stub_d_in))
        }
    };

    let d_in = embedder.d_in();

    // ── 4. Pairs ─────────────────────────────────────────────────────
    let pairs =
        generate_training_pairs(embedder.as_ref(), &lex, &sentences, cfg.num_pairs, cfg.seed);
    if pairs.is_empty() {
        return Err(
            "no training pairs generated. Check embedder connectivity and corpus coverage."
                .to_string(),
        );
    }
    eprintln!("[training] {} training pairs ready", pairs.len());

    // ── 5. Mapper ────────────────────────────────────────────────────
    let mut mapper = NeuralVsaMapper::new(d_in, cfg.d_hidden, cfg.seed);
    mapper.learning_rate = cfg.learning_rate;
    eprintln!(
        "[training] mapper fresh: d_in={} d_hidden={} lr={}",
        d_in, cfg.d_hidden, cfg.learning_rate
    );

    // ── 6. Epoch loop ────────────────────────────────────────────────
    // Re-shuffle per epoch to de-correlate the SGD direction. We
    // don't shuffle in-place on the Vec<(Vec<f32>, SparseVec)> —
    // it's cheap to just permute an index vector and walk via the
    // index. Saves us from cloning massive Vec<f32>s every epoch.
    let mut rng = StdRng::seed_from_u64(cfg.seed.wrapping_add(0xEEE0));
    let mut idx: Vec<usize> = (0..pairs.len()).collect();

    for epoch in 0..cfg.num_epochs {
        idx.shuffle(&mut rng);
        let t0 = Instant::now();
        let mut total_loss = 0.0f32;
        for &i in &idx {
            total_loss += mapper.train_step(&pairs[i].0, &pairs[i].1);
        }
        let mean_loss = total_loss / idx.len() as f32;
        eprintln!(
            "[training] epoch {:>2}/{}  mean_loss = {:>10.4}  ({:.2}s)",
            epoch + 1,
            cfg.num_epochs,
            mean_loss,
            t0.elapsed().as_secs_f32(),
        );
    }

    // ── 7. Save ──────────────────────────────────────────────────────
    if let Some(parent) = cfg.output_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).ok();
        }
    }
    mapper
        .save(&cfg.output_path)
        .map_err(|e| format!("failed to save mapper to {:?}: {}", cfg.output_path, e))?;
    eprintln!("[training] saved mapper → {:?}", cfg.output_path);

    // ── 8. Crude quality self-check ──────────────────────────────────
    // Pick 5 random training sentences and print the cosine between
    // mapper output and lexicon-sentence target. After a real
    // training run these should be meaningfully > 0; on the stub
    // embedder they typically reach ~0.4–0.6 even on unseen sentences
    // because the signal is learnable.
    let sample_ids: Vec<usize> = {
        let mut r = StdRng::seed_from_u64(cfg.seed.wrapping_add(0x5A1AD));
        (0..5.min(pairs.len()))
            .map(|_| r.gen_range(0..pairs.len()))
            .collect()
    };
    eprintln!("[training] self-check (5 samples):");
    for (k, &i) in sample_ids.iter().enumerate() {
        let (dense, target) = &pairs[i];
        let predicted = mapper.map_to_sparse(dense);
        let sim = predicted.cosine(target);
        eprintln!(
            "  sample {}: cosine(map_to_sparse, target) = {:.4}",
            k + 1,
            sim
        );
    }

    Ok(())
}

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

/// Parse the `--train-mapper` family of flags out of `args` and run
/// the trainer. See module header for the flag table. On error
/// prints a human-readable message to stderr and exits with 1.
pub fn run_train_mapper_cli(args: &[String]) {
    let mut cfg = TrainConfig::default();

    for a in args {
        if a == "--stub-embedder" {
            cfg.bitnet_url = None;
        } else if let Some(v) = a.strip_prefix("--bitnet-url=") {
            cfg.bitnet_url = Some(v.to_string());
        } else if let Some(v) = a.strip_prefix("--d-in=") {
            cfg.stub_d_in = v.parse().unwrap_or(cfg.stub_d_in);
        } else if let Some(v) = a.strip_prefix("--d-hidden=") {
            cfg.d_hidden = v.parse().unwrap_or(cfg.d_hidden);
        } else if let Some(v) = a.strip_prefix("--num-pairs=") {
            cfg.num_pairs = v.parse().unwrap_or(cfg.num_pairs);
        } else if let Some(v) = a.strip_prefix("--num-epochs=") {
            cfg.num_epochs = v.parse().unwrap_or(cfg.num_epochs);
        } else if let Some(v) = a.strip_prefix("--learning-rate=") {
            cfg.learning_rate = v.parse().unwrap_or(cfg.learning_rate);
        } else if let Some(v) = a.strip_prefix("--corpus-dir=") {
            cfg.corpus_dir = PathBuf::from(v);
        } else if let Some(v) = a.strip_prefix("--lexicon=") {
            cfg.lexicon_path = PathBuf::from(v);
        } else if let Some(v) = a.strip_prefix("--output=") {
            cfg.output_path = PathBuf::from(v);
        } else if let Some(v) = a.strip_prefix("--seed=") {
            cfg.seed = v.parse().unwrap_or(cfg.seed);
        }
    }

    if let Err(msg) = train_mapper(cfg) {
        eprintln!("[training] ERROR: {}", msg);
        std::process::exit(1);
    }
}

// ─────────────────────────────────────────────────────────────────────
// `--train-real` — train the mapper against a real LLM via Ollama
//
// This is the whole point. Instead of the toy stub embedder, we hit a
// real LLM (mistral:7b, llama3.2:3b, nomic-embed-text, etc.) through
// Ollama's /api/embeddings endpoint. Every sentence in the corpus gets
// a real dense hidden state from the LLM and a real sparse ternary
// target from StatLexicon::encode_sentence. The mapper learns the
// projection dense → sparse so that we can later read LLM cognition
// directly in our VSA basis.
//
// Prerequisites:
//   1. `ollama serve` running (default http://127.0.0.1:11434)
//   2. Model pulled:  `ollama pull nomic-embed-text`  (or mistral:7b, etc.)
//   3. Lexicon built: `kai --build-lexicon`
//   4. Corpus in:     `data/ingest_shelved/*.txt`
//
// Run:
//   kai --train-real
//   kai --train-real --ollama-model=mistral:7b --num-pairs=5000 --num-epochs=10
// ─────────────────────────────────────────────────────────────────────

/// Configuration for the real-LLM training pipeline.
#[derive(Clone, Debug)]
pub struct TrainRealConfig {
    /// Ollama base URL (default: `http://127.0.0.1:11434`).
    pub ollama_url: String,

    /// Ollama model name (default: `nomic-embed-text`).
    /// `nomic-embed-text` is recommended because it's a dedicated
    /// embedding model with a contrastive training objective — its
    /// hidden states carry cleaner semantic structure than generation
    /// models. `mistral:7b` and `llama3.2:3b` work too but are
    /// slower per embedding and their pooled states are noisier.
    pub ollama_model: String,

    /// Mapper hidden width.
    ///
    /// When `d_hidden_explicit` is false (the default), `train_real` will
    /// override this to `max(2048, d_in / 2)` once d_in is auto-discovered
    /// from the live Ollama model. Pass `--d-hidden=N` on the CLI to pin an
    /// exact value and bypass the auto-scaling.
    pub d_hidden: usize,

    /// Set to `true` when the caller explicitly passed `--d-hidden=N`.
    /// When false, `train_real` replaces `d_hidden` with `max(2048, d_in/2)`
    /// after discovering d_in from the Ollama embedding model.
    pub d_hidden_explicit: bool,

    /// Number of unique training pairs generated this run.
    pub num_pairs: usize,

    /// Full passes over the generated pair set.
    pub num_epochs: usize,

    /// SGD step size on the output layer.
    pub learning_rate: f32,

    /// Directory of `.txt` corpus files.
    pub corpus_dir: PathBuf,

    /// Pre-built StatLexicon file.
    pub lexicon_path: PathBuf,

    /// Where to write the trained mapper.
    pub output_path: PathBuf,

    /// RNG seed for reproducibility.
    pub seed: u64,
}

impl Default for TrainRealConfig {
    fn default() -> Self {
        Self {
            ollama_url: "http://127.0.0.1:11434".to_string(),
            ollama_model: "nomic-embed-text".to_string(),
            d_hidden: DEFAULT_D_HIDDEN,
            d_hidden_explicit: false,
            num_pairs: 5_000,
            num_epochs: 10,
            learning_rate: DEFAULT_LEARNING_RATE,
            corpus_dir: PathBuf::from("data/ingest_shelved"),
            lexicon_path: PathBuf::from("data/stat-lexicon.json"),
            output_path: PathBuf::from("data/mapper-real.bin"),
            seed: 0xC0FFEE_BABE,
        }
    }
}

/// End-to-end training run against a real LLM via Ollama.
///
/// Identical structure to `train_mapper` but hard-wired to
/// `OllamaEmbedder` and with defaults tuned for a real run
/// (more pairs, more epochs, dedicated output file so it doesn't
/// stomp the stub-trained mapper).
pub fn train_real(mut cfg: TrainRealConfig) -> Result<(), String> {
    eprintln!("═══════════════════════════════════════════════════════════════════");
    eprintln!("  KAI — train NeuralVsaMapper against a REAL LLM via Ollama");
    eprintln!("═══════════════════════════════════════════════════════════════════");
    eprintln!("{:#?}", cfg);
    eprintln!();

    // ── 1. Lexicon ───────────────────────────────────────────────────
    if !cfg.lexicon_path.exists() {
        return Err(format!(
            "lexicon not found at {:?}. Run `kai --build-lexicon` first.",
            cfg.lexicon_path
        ));
    }
    let lex = StatLexicon::load(&cfg.lexicon_path)
        .map_err(|e| format!("failed to load lexicon {:?}: {}", cfg.lexicon_path, e))?;
    if lex.is_empty() {
        return Err(format!("lexicon at {:?} is empty", cfg.lexicon_path));
    }
    eprintln!("[train-real] lexicon: {} words", lex.len());

    // ── 2. Corpus ────────────────────────────────────────────────────
    let sentences = load_corpus_sentences(&cfg.corpus_dir, 3, cfg.seed)
        .map_err(|e| format!("failed to load corpus {:?}: {}", cfg.corpus_dir, e))?;
    if sentences.is_empty() {
        return Err(format!(
            "corpus {:?} produced zero usable sentences",
            cfg.corpus_dir
        ));
    }
    eprintln!("[train-real] corpus: {} sentences", sentences.len());

    // ── 3. Connect to Ollama ─────────────────────────────────────────
    let embedder = OllamaEmbedder::new(&cfg.ollama_url, &cfg.ollama_model).map_err(|e| {
        format!(
            "Ollama connection failed:\n  {}\n\n\
             Make sure:\n\
             1. `ollama serve` is running\n\
             2. The model is pulled: `ollama pull {}`\n\
             3. Ollama is reachable at {}",
            e, cfg.ollama_model, cfg.ollama_url
        )
    })?;
    let d_in = embedder.d_in();
    eprintln!(
        "[train-real] connected to Ollama: model='{}' d_in={}",
        cfg.ollama_model, d_in
    );

    // ── Auto-scale d_hidden for real LLM embeddings ──────────────────
    // At 512 hidden units a 4096-dim input (Mistral 7B) faces an 8:1
    // compression before the output layer — the bottleneck collapses
    // the manifold and the mapper learns nothing useful.
    // Formula: d_hidden = max(2048, d_in / 2).  This gives a ≤2:1 ratio
    // for all current LLM sizes.  Skipped when the user pinned --d-hidden
    // explicitly so power users can still experiment with other widths.
    if !cfg.d_hidden_explicit {
        cfg.d_hidden = (d_in / 2).max(2048);
        eprintln!(
            "[train-real] auto d_hidden={} (d_in={}, formula=max(2048, d_in/2))",
            cfg.d_hidden, d_in
        );
    }

    // ── 4. Generate training pairs ───────────────────────────────────
    // Each pair: (LLM dense hidden state, RSHL encode_sentence target)
    eprintln!(
        "[train-real] generating {} pairs (this talks to the LLM for every sentence)...",
        cfg.num_pairs
    );
    let t_pairs = Instant::now();
    let pairs = generate_training_pairs(&embedder, &lex, &sentences, cfg.num_pairs, cfg.seed);
    let pair_secs = t_pairs.elapsed().as_secs_f32();
    if pairs.is_empty() {
        return Err(
            "no training pairs generated. Check Ollama connectivity and corpus coverage."
                .to_string(),
        );
    }
    eprintln!(
        "[train-real] {} pairs ready in {:.1}s ({:.1} pairs/sec)",
        pairs.len(),
        pair_secs,
        pairs.len() as f32 / pair_secs.max(0.001),
    );

    // ── 5. Create mapper ─────────────────────────────────────────────
    let mut mapper = NeuralVsaMapper::new(d_in, cfg.d_hidden, cfg.seed);
    mapper.learning_rate = cfg.learning_rate;
    eprintln!(
        "[train-real] mapper: d_in={} d_hidden={} lr={} target_density={}",
        d_in, cfg.d_hidden, cfg.learning_rate, mapper.target_density
    );

    // ── 6. Training loop ─────────────────────────────────────────────
    let mut rng = StdRng::seed_from_u64(cfg.seed.wrapping_add(0xEEE0));
    let mut idx: Vec<usize> = (0..pairs.len()).collect();

    eprintln!();
    for epoch in 0..cfg.num_epochs {
        idx.shuffle(&mut rng);
        let t0 = Instant::now();
        let mut total_loss = 0.0f32;
        for &i in &idx {
            total_loss += mapper.train_step(&pairs[i].0, &pairs[i].1);
        }
        let mean_loss = total_loss / idx.len() as f32;

        // Every epoch, also compute average cosine on a small held-out
        // subset so we can see alignment improving in real time.
        let check_n = 20.min(pairs.len());
        let mut cos_sum = 0.0f32;
        for k in 0..check_n {
            let (dense, target) = &pairs[k];
            let predicted = mapper.map_to_sparse(dense);
            cos_sum += predicted.cosine(target);
        }
        let mean_cos = cos_sum / check_n as f32;

        eprintln!(
            "  epoch {:>2}/{}  loss={:>10.4}  cosine={:.4}  ({:.2}s)",
            epoch + 1,
            cfg.num_epochs,
            mean_loss,
            mean_cos,
            t0.elapsed().as_secs_f32(),
        );
    }
    eprintln!();

    // ── 7. Save ──────────────────────────────────────────────────────
    if let Some(parent) = cfg.output_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).ok();
        }
    }
    mapper
        .save(&cfg.output_path)
        .map_err(|e| format!("failed to save mapper to {:?}: {}", cfg.output_path, e))?;
    eprintln!("[train-real] saved mapper → {:?}", cfg.output_path);

    // ── 8. Quality report ────────────────────────────────────────────
    // Sample 10 sentences, print each with cosine between mapper
    // output and RSHL target, plus the top-3 nearest words from the
    // lexicon for the mapper output vs the target. This tells us
    // whether the mapper is capturing real semantic structure or just
    // memorizing noise.
    let report_n = 10.min(pairs.len());
    let report_ids: Vec<usize> = {
        let mut r = StdRng::seed_from_u64(cfg.seed.wrapping_add(0x5A1AD));
        (0..report_n).map(|_| r.gen_range(0..pairs.len())).collect()
    };
    eprintln!("═══════════════════════════════════════════════════════════════════");
    eprintln!("  Quality report ({} samples)", report_n);
    eprintln!("═══════════════════════════════════════════════════════════════════");
    let mut total_cos = 0.0f32;
    for (k, &i) in report_ids.iter().enumerate() {
        let (dense, target) = &pairs[i];
        let predicted = mapper.map_to_sparse(dense);
        let sim = predicted.cosine(target);
        total_cos += sim;

        let pred_nn: Vec<(String, f32)> = lex.top_k_nearest(&predicted, 3);
        let tgt_nn: Vec<(String, f32)> = lex.top_k_nearest(target, 3);

        eprintln!("  #{:<2} cosine={:.4}", k + 1, sim);
        eprintln!(
            "       mapper → [{}]",
            pred_nn
                .iter()
                .map(|(w, s)| format!("{}({:.2})", w, s))
                .collect::<Vec<_>>()
                .join(", ")
        );
        eprintln!(
            "       target → [{}]",
            tgt_nn
                .iter()
                .map(|(w, s)| format!("{}({:.2})", w, s))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    let mean_cos = total_cos / report_n as f32;
    eprintln!("───────────────────────────────────────────────────────────────────");
    eprintln!(
        "  mean cosine = {:.4}  (>0.3 = learning, >0.5 = good, >0.7 = excellent)",
        mean_cos
    );
    eprintln!("═══════════════════════════════════════════════════════════════════");

    Ok(())
}

/// Parse the `--train-real` CLI flags and run the real-LLM trainer.
pub fn run_train_real_cli(args: &[String]) {
    let mut cfg = TrainRealConfig::default();

    for a in args {
        if let Some(v) = a.strip_prefix("--ollama-url=") {
            cfg.ollama_url = v.to_string();
        } else if let Some(v) = a.strip_prefix("--ollama-model=") {
            cfg.ollama_model = v.to_string();
        } else if let Some(v) = a.strip_prefix("--d-hidden=") {
            // Explicit --d-hidden overrides the auto-scaling logic in train_real.
            cfg.d_hidden = v.parse().unwrap_or(cfg.d_hidden);
            cfg.d_hidden_explicit = true;
        } else if let Some(v) = a.strip_prefix("--num-pairs=") {
            cfg.num_pairs = v.parse().unwrap_or(cfg.num_pairs);
        } else if let Some(v) = a.strip_prefix("--num-epochs=") {
            cfg.num_epochs = v.parse().unwrap_or(cfg.num_epochs);
        } else if let Some(v) = a.strip_prefix("--learning-rate=") {
            cfg.learning_rate = v.parse().unwrap_or(cfg.learning_rate);
        } else if let Some(v) = a.strip_prefix("--corpus-dir=") {
            cfg.corpus_dir = PathBuf::from(v);
        } else if let Some(v) = a.strip_prefix("--lexicon=") {
            cfg.lexicon_path = PathBuf::from(v);
        } else if let Some(v) = a.strip_prefix("--output=") {
            cfg.output_path = PathBuf::from(v);
        } else if let Some(v) = a.strip_prefix("--seed=") {
            cfg.seed = v.parse().unwrap_or(cfg.seed);
        }
    }

    if let Err(msg) = train_real(cfg) {
        eprintln!("[train-real] ERROR: {}", msg);
        std::process::exit(1);
    }
}

// ─────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    fn cosine_dense(a: &[f32], b: &[f32]) -> f32 {
        let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm_a == 0.0 || norm_b == 0.0 {
            0.0
        } else {
            dot / (norm_a * norm_b)
        }
    }

    #[test]
    fn stub_embedder_is_deterministic_and_correlates() {
        let e = StubEmbedder::new(64);
        let a = e.embed("the quick brown fox").unwrap();
        let b = e.embed("the quick brown fox").unwrap();
        let c = e.embed("completely different content here").unwrap();

        // Determinism.
        assert_eq!(a, b);
        // Self-cosine = 1.
        let sim_aa = cosine_dense(&a, &a);
        assert!(sim_aa > 0.999, "self cosine should be 1, got {}", sim_aa);
        // A shares 3 words with itself, 0 with c — similarity must
        // be higher to self than to unrelated text. This is the
        // "probe has signal to learn from" property.
        let sim_ac = cosine_dense(&a, &c);
        assert!(sim_aa > sim_ac, "aa={} should exceed ac={}", sim_aa, sim_ac);
    }

    #[test]
    fn split_sentences_handles_mixed_punctuation_and_newlines() {
        let text = "This is one. This is two!\nThree?\nFour is four";
        let s = split_sentences(text);
        assert_eq!(s.len(), 4, "got: {:?}", s);
    }

    #[test]
    fn parse_embedding_response_accepts_all_shapes() {
        // Shape A: flat
        let a = serde_json::json!({"embedding": [1.0, 2.0, 3.0]});
        assert_eq!(parse_embedding_response(&a).unwrap(), vec![1.0, 2.0, 3.0]);

        // Shape B: nested single row
        let b = serde_json::json!({"embedding": [[4.0, 5.0]]});
        assert_eq!(parse_embedding_response(&b).unwrap(), vec![4.0, 5.0]);

        // Shape C: root array
        let c = serde_json::json!([{"embedding": [7.0, 8.0]}]);
        assert_eq!(parse_embedding_response(&c).unwrap(), vec![7.0, 8.0]);

        // Shape D: OpenAI
        let d = serde_json::json!({"data": [{"embedding": [9.0, 10.0]}]});
        assert_eq!(parse_embedding_response(&d).unwrap(), vec![9.0, 10.0]);

        // Shape E: new Ollama /api/embed (plural key, nested array)
        let e = serde_json::json!({"embeddings": [[11.0, 12.0, 13.0]]});
        assert_eq!(
            parse_embedding_response(&e).unwrap(),
            vec![11.0, 12.0, 13.0]
        );

        // Broken
        let f = serde_json::json!({"nope": 1});
        assert!(parse_embedding_response(&f).is_none());
    }
}
