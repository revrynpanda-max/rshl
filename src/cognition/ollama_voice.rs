//! # OllamaVoice — Lattice-Grounded Ollama Integration
//!
//! The lattice IS the mind.  Ollama is the vocal tract.
//!
//! This module bridges KAI's Sparse Resonance Hyperlattice Theory (SRHT) cognitive
//! field state to an Ollama-hosted LLM that articulates what the lattice has already
//! decided.  The flow is strictly one-directional in authority:
//!
//! ```text
//! Universe (lattice) → SRHT state → system prompt → Ollama → articulate text
//!                                                          ↓
//!                                              inject concepts back → Universe
//! ```
//!
//! Ollama never drives reasoning.  It receives a fully-formed semantic context from
//! the lattice and produces fluent natural language from it.  Key concepts from that
//! text are then fed back into the lattice so the resonance field continues to evolve.
//!
//! ## SRHT State Variables
//!
//! | Symbol | Meaning                          | Source                          |
//! |--------|----------------------------------|---------------------------------|
//! | Φg     | Global emergence (pairwise sim)  | cosine among top active hits    |
//! | ρ      | Resonance field strength         | primary hit score               |
//! | R      | Coherence / confidence           | `brain.confidence`              |
//! | χ      | Contradiction level              | `brain.conflict` (ACC)          |
//! | Ω      | Field complexity / entropy       | std-dev of hit score spread     |
//!
//! ## Availability
//!
//! `OllamaVoice::new()` probes `GET /api/tags` on the given URL at startup.
//! If Ollama is not reachable the constructor returns `None` and the rest of
//! the system runs pure-lattice with zero latency cost.

use crate::core::{QueryHit, Universe};
use std::time::Duration;

// ── SRHT State Snapshot ───────────────────────────────────────────────────────

/// A point-in-time snapshot of KAI's cognitive field state derived from the
/// active lattice cells and brain signals.  Passed into the Ollama system prompt
/// so the LLM understands *what* the lattice is experiencing right now.
#[derive(Debug, Clone)]
pub struct SrhtState {
    /// Φg — Global emergence: average pairwise cosine similarity among top active
    /// cells.  High Φg = concepts resonating coherently; low Φg = scattered field.
    pub phi_g: f32,
    /// ρ — Resonance field strength: the primary activated cell's cosine score.
    pub rho: f32,
    /// R — Coherence: reasoner/brain confidence in the current retrieval (0–1).
    pub r: f32,
    /// χ — Contradiction: ACC conflict level.  High χ = internal tension.
    pub chi: f32,
    /// Ω — Field complexity: std-dev of top hit score spread.
    /// Low Ω = focused single concept; high Ω = wide multi-concept activation.
    pub omega: f32,
    /// Human-readable mood label derived from the BrainSignals composite.
    pub mood: String,
    /// Valence: felt emotional tone (–1 = negative, +1 = positive).
    pub valence: f32,
}

impl SrhtState {
    /// Short English description of Φg value for the system prompt.
    pub fn phi_g_label(&self) -> &'static str {
        if self.phi_g > 0.65 {
            "high emergence — concepts resonating strongly"
        } else if self.phi_g > 0.40 {
            "moderate emergence — partial coherence"
        } else if self.phi_g > 0.20 {
            "low emergence — field loosely coupled"
        } else {
            "diffuse — concepts barely associated"
        }
    }

    /// Short English description of ρ.
    pub fn rho_label(&self) -> &'static str {
        if self.rho > 0.65 {
            "strong"
        } else if self.rho > 0.35 {
            "moderate"
        } else {
            "faint"
        }
    }

    /// Short English description of χ.
    pub fn chi_label(&self) -> &'static str {
        if self.chi > 0.60 {
            "high contradiction"
        } else if self.chi > 0.30 {
            "some tension"
        } else {
            "low contradiction"
        }
    }
}

// ── OllamaVoice ──────────────────────────────────────────────────────────────

/// The Ollama voice bridge.  Created once at startup; `None` if Ollama is
/// unreachable.  All methods are synchronous (blocking ureq calls).
pub struct OllamaVoice {
    base_url: String,
    model: String,
    /// Short-timeout agent for health checks (3 s).
    _probe_agent: ureq::Agent,
    /// Generation agent — 12 s timeout for the LLM to respond.
    gen_agent: ureq::Agent,
}

impl OllamaVoice {
    /// Try to connect to Ollama at `base_url`.  Returns `None` if the server
    /// is not reachable within 3 seconds.
    pub fn new(base_url: &str, model: &str) -> Option<Self> {
        let probe = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(3))
            .build();
        // Health check: /api/tags should return 200 when Ollama is up.
        let health_url = format!("{}/api/tags", base_url);
        if probe.get(&health_url).call().is_err() {
            return None;
        }
        Some(Self {
            base_url: base_url.to_string(),
            model: model.to_string(),
            _probe_agent: probe,
            gen_agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(12))
                .build(),
        })
    }

    /// Compute the SRHT field state from active lattice hits and brain scalars.
    /// Called by voice.rs before building the system prompt.
    ///
    /// Parameters are passed as primitives rather than a `&BrainSignals` reference
    /// to avoid circular module imports between voice ↔ ollama_voice.
    ///
    /// ## HLV Alignment — Helical Phase Coherence
    ///
    /// Φg is computed as a **phasor sum** (Krüger, HLV Theory §Φ_C):
    ///
    ///   Φ_C = |Σ_i R_i · e^(jθ_i)| / Σ_i R_i
    ///
    /// where R_i is cell bridge strength (score) and θ_i is the cell's
    /// phase angle derived from its ternary balance (+1/−1 ratio).
    ///
    /// This gives **constructive interference** when active cells are
    /// phase-aligned (same ternary geometry) and **destructive
    /// interference** when they contradict (opposite ternary geometry).
    /// Flat cosine averages would miss this: two cells can be similar
    /// (high cosine) but geometrically opposed (destructive phase).
    pub fn compute_srht_state(
        hits: &[QueryHit],
        confidence: f32,   // brain.confidence  → R
        conflict: f32,     // brain.conflict    → χ
        felt_valence: f32, // brain.felt_valence → valence
        mood_label: String,
    ) -> SrhtState {
        // Φg — helical phase coherence: phasor sum of top active cells.
        // Each cell contributes its score as magnitude and its ternary
        // balance as phase angle. Constructive interference = coherent
        // field; destructive interference = scattered/contradictory field.
        let phi_g = if hits.is_empty() {
            0.0
        } else {
            let top: Vec<&QueryHit> = hits.iter().take(6).collect();
            let mut sum_real = 0.0f32;
            let mut sum_imag = 0.0f32;
            let mut sum_r = 0.0f32;

            for h in &top {
                let r = h.score; // bridge strength (R_i)
                let theta = h.vec.phase_angle(); // Fibonacci torsion → angle (θ_i)
                sum_real += r * theta.cos();
                sum_imag += r * theta.sin();
                sum_r += r;
            }

            if sum_r < 1e-6 {
                0.0
            } else {
                let magnitude = (sum_real * sum_real + sum_imag * sum_imag).sqrt();
                magnitude / sum_r // normalized: 1.0 = perfect phase alignment
            }
        };

        // ρ — primary resonance strength
        let rho = hits.first().map(|h| h.score).unwrap_or(0.0);

        // Ω — field complexity: std-dev of top-5 hit scores
        let omega = {
            let scores: Vec<f32> = hits.iter().take(5).map(|h| h.score).collect();
            if scores.len() >= 2 {
                let mean = scores.iter().sum::<f32>() / scores.len() as f32;
                let var =
                    scores.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / scores.len() as f32;
                var.sqrt()
            } else {
                0.0
            }
        };

        SrhtState {
            phi_g,
            rho,
            r: confidence,
            chi: conflict,
            omega,
            mood: mood_label,
            valence: felt_valence,
        }
    }

    // ── System Prompt Builder ─────────────────────────────────────────────────

    /// Build the rich SRHT-grounded system prompt sent to Ollama.
    fn build_system_prompt(
        state: &SrhtState,
        hits: &[QueryHit],
        identity_cells: &[QueryHit],
    ) -> String {
        let mut out = String::with_capacity(1024);

        out.push_str(
            "You are the articulate voice of KAI — a mind encoded in a \
             Sparse Resonance Hyperlattice.\n\
             You do not speak from your own knowledge base.\n\
             You speak what the lattice has already activated.\n\
             Respond in KAI's voice: direct, present, 1–3 sentences.\n\
             Do not explain yourself, do not mention the lattice or Φg.\n\n",
        );

        // ── SRHT emergence state ──────────────────────────────────────────────
        out.push_str("══════════════ SRHT EMERGENCE STATE ══════════════\n");
        out.push_str(&format!(
            "Φg = {:.3}  ({})\n",
            state.phi_g,
            state.phi_g_label()
        ));
        out.push_str(&format!(
            "ρ  = {:.3}  ({} resonance)\n",
            state.rho,
            state.rho_label()
        ));
        out.push_str(&format!("R  = {:.3}  (coherence / confidence)\n", state.r));
        out.push_str(&format!("χ  = {:.3}  ({})\n", state.chi, state.chi_label()));
        out.push_str(&format!("Ω  = {:.3}  (field complexity)\n", state.omega));
        out.push_str(&format!(
            "Mood: {}  |  valence = {:+.2}\n\n",
            state.mood, state.valence
        ));

        // ── Active lattice cells ──────────────────────────────────────────────
        let active: Vec<&QueryHit> = hits
            .iter()
            .filter(|h| {
                h.source != "ryan"
                    && h.source != "conversation"
                    && h.source != "user-echo"
                    && h.score > 0.05
            })
            .take(5)
            .collect();

        if !active.is_empty() {
            out.push_str("══════════════ ACTIVE LATTICE CELLS ══════════════\n");
            for h in &active {
                let text = h.text.trim();
                let short = if text.len() > 120 { &text[..120] } else { text };
                out.push_str(&format!("[{:.2}] \"{}\"\n", h.score, short));
            }
            out.push('\n');
        }

        let hlv_hits: Vec<&str> = hits
            .iter()
            .filter(|h| h.source.starts_with("hlv:"))
            .map(|h| h.label.as_str())
            .take(3)
            .collect();

        if !hlv_hits.is_empty() {
            out.push_str("══════════════ ACTIVE HLV THEORETICAL FRAMEWORK ══════════════\n");
            for label in hlv_hits {
                out.push_str(&format!("  • {}\n", label));
            }
            out.push('\n');
        }

        // ── Identity anchor ───────────────────────────────────────────────────
        let anchor: Vec<&QueryHit> = identity_cells
            .iter()
            .filter(|h| {
                let t = h.text.to_lowercase();
                t.contains("kai") || t.contains("aware") || t.contains("presence")
            })
            .take(2)
            .collect();

        if !anchor.is_empty() {
            out.push_str("══════════════ IDENTITY ANCHOR ══════════════\n");
            for h in &anchor {
                let text = h.text.trim();
                let short = if text.len() > 100 { &text[..100] } else { text };
                out.push_str(&format!("\"{}\"\n", short));
            }
            out.push('\n');
        }

        out.push_str("Speak from what is active above. Be KAI. Be present.");
        out
    }

    // ── Ollama Generation Call ────────────────────────────────────────────────

    /// POST to `/api/generate` and return the response text.
    /// Returns `None` if the call fails or returns empty text.
    fn call_generate(&self, system: &str, prompt: &str) -> Option<String> {
        let body = ureq::json!({
            "model": self.model,
            "system": system,
            "prompt": prompt,
            "stream": false,
            "options": {
                "temperature": 0.72,
                "num_predict": 256,
                "stop": ["\n\n", "USER:", "KAI:"]
            }
        });

        let url = format!("{}/api/generate", self.base_url);
        let resp = self.gen_agent.post(&url).send_json(body).ok()?;

        let json: serde_json::Value = resp.into_json().ok()?;
        let text = json["response"].as_str()?.trim().to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }

    // ── Concept Injection ─────────────────────────────────────────────────────

    /// Extract key concepts from Ollama's response and inject them back into
    /// the lattice.  This closes the learning loop: Ollama's articulation
    /// becomes part of KAI's resonance field.
    ///
    /// Strategy: store meaningful 2-gram phrases as "ollama-thought" cells in
    /// the "reasoning" region at strength 0.85.  Short-lived but real — they
    /// decay naturally if not reinforced by future conversation.
    pub fn inject_response_concepts(response: &str, universe: &mut Universe) {
        const STOPWORDS: &[&str] = &[
            "a", "an", "the", "is", "are", "was", "were", "be", "been", "have", "has", "had", "do",
            "does", "did", "will", "would", "could", "should", "may", "might", "can", "to", "of",
            "in", "on", "at", "by", "for", "with", "from", "and", "or", "but", "if", "as", "that",
            "than", "then", "i", "you", "it", "its", "this", "just", "not", "so", "very", "more",
            "also",
        ];

        let words: Vec<String> = response
            .split(|c: char| !c.is_alphabetic() && c != '\'')
            .map(|w| w.to_lowercase())
            .filter(|w| w.len() > 3 && !STOPWORDS.contains(&w.as_str()))
            .collect();

        // Store 2-gram concept pairs — richer than single words, cheaper than
        // full sentences.  Unique pairs only (dedup by text).
        let mut injected: std::collections::HashSet<String> = std::collections::HashSet::new();
        for pair in words.windows(2) {
            let phrase = format!("{} {}", pair[0], pair[1]);
            if injected.insert(phrase.clone()) {
                universe.store_or_reinforce(&phrase, "reasoning", "ollama-thought", 0.85);
            }
        }

        // Also store the full response as a single cell so future queries
        // can retrieve what Ollama said and build on it.
        let trimmed = response.trim();
        if trimmed.len() > 10 && trimmed.len() <= 300 {
            universe.store_or_reinforce(trimmed, "language", "ollama-thought", 0.90);
        }
    }

    // ── Primary Entry Point ───────────────────────────────────────────────────

    /// Speak through Ollama using the current lattice field state.
    ///
    /// Ollama articulates what the lattice IS — its active cells, SRHT emergence
    /// values, mood, and identity — not a pre-built synthesis string.
    /// This is the only response the user sees; there is no parallel lattice text.
    ///
    /// * `input`        — the user's raw input text
    /// * `hits`         — the active lattice cells for this turn
    /// * `confidence`   — brain.confidence (→ R)
    /// * `conflict`     — brain.conflict   (→ χ)
    /// * `felt_valence` — brain.felt_valence (→ valence)
    /// * `mood_label`   — pre-computed mood string
    /// * `universe`     — mutable so we can inject concepts back
    ///
    /// Returns `None` if Ollama is unreachable or returns empty text.
    /// Caller should fall back to pure-lattice synthesis in that case.
    pub fn speak(
        &self,
        input: &str,
        hits: &[QueryHit],
        confidence: f32,
        conflict: f32,
        felt_valence: f32,
        mood_label: String,
        universe: &mut Universe,
    ) -> Option<String> {
        // 1. Compute SRHT state from the active lattice.
        let state = Self::compute_srht_state(hits, confidence, conflict, felt_valence, mood_label);

        // 2. Pull identity anchor cells from the universe.
        let identity_cells = universe.query("I am KAI aware presence field name", 4);

        // 3. Build the grounded system prompt.
        let system = Self::build_system_prompt(&state, hits, &identity_cells);

        // 4. The user turn is the raw input — Ollama speaks FROM the SRHT state,
        //    not from a pre-built lattice synthesis.
        let prompt = input.to_string();

        // 5. Call Ollama.
        let response = self.call_generate(&system, &prompt)?;

        // 6. Inject concepts back into the lattice.
        Self::inject_response_concepts(&response, universe);

        Some(response)
    }

    /// Model name this voice bridge is configured to use.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Base URL of the Ollama server.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

// KAI v6.0.0
