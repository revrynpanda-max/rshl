// generate/mod.rs — KAI Language Generation Engine
// Bridges KAI's geometric memory lattice to actual language output.
// Maps chi / phi_g / anchors to LLM sampling parameters so KAI's
// internal state directly shapes his voice.

use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use serde_json::json;
use crate::core::universe::{Universe, QueryHit};

// ── Config ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerationConfig {
    pub provider: String,       // "groq", "openai", "xai", "ollama"
    pub model: String,
    pub max_tokens: u32,
    pub context_cells: usize,   // how many lattice cells to inject into prompt
    pub store_interaction: bool, // write (prompt, reply) back into KAI memory
}

impl Default for GenerationConfig {
    fn default() -> Self {
        Self {
            provider: "groq".into(),
            model: "llama-3.1-8b-instant".into(),
            max_tokens: 512,
            context_cells: 8,
            store_interaction: true,
        }
    }
}

// ── Sampling Parameter Mapping ─────────────────────────────────────────────────

/// Map KAI's internal geometric state to LLM sampling parameters.
/// chi  → temperature (chaos / creativity)
/// phi_g → top_p (coherence / breadth)
pub fn kai_params_to_llm(chi: f32, phi_g: f32) -> (f32, f32, f32) {
    // chi: 0.0 = ordered, 1.0+ = chaotic
    let temperature = 0.3 + (chi * 1.2).clamp(0.0, 1.5);
    // phi_g: 0.0 = fragmented, 1.0 = coherent
    let top_p = 0.5 + (phi_g * 0.45).clamp(0.0, 0.45);
    // frequency penalty inversely related to coherence
    let frequency_penalty = (1.0 - phi_g).clamp(0.0, 1.0) * 0.5;
    (temperature, top_p, frequency_penalty)
}

// ── Context Builder ────────────────────────────────────────────────────────────

pub struct ContextBuilder;

impl ContextBuilder {
    /// Retrieve relevant memories from KAI's lattice.
    pub fn retrieve(universe: &Universe, query: &str, n: usize) -> Vec<QueryHit> {
        universe.query(query, n)
    }

    /// Format memories into a context block for the LLM.
    pub fn format_memories(hits: &[QueryHit]) -> String {
        if hits.is_empty() {
            return "[No relevant memories retrieved.]".into();
        }
        let mut out = String::from("=== KAI MEMORY CONTEXT ===\n");
        for (i, h) in hits.iter().enumerate() {
            let text = if h.text.is_empty() { &h.label } else { &h.text };
            let source = if h.source.is_empty() { "unknown" } else { &h.source };
            let region = if h.region.is_empty() { "unknown" } else { &h.region };
            // Truncate very long cells
            let preview = if text.len() > 300 { &text[..300] } else { text };
            out.push_str(&format!(
                "{}. [{} | {} | s={:.2}] {}\n",
                i + 1,
                source,
                region,
                h.strength,
                preview
            ));
        }
        out.push_str("=== END MEMORY CONTEXT ===\n");
        out
    }

    /// Build the system prompt that defines KAI's persona.
    pub fn system_prompt(chi: f32, phi_g: f32, anchors: usize, cells: usize) -> String {
        let coherence_desc = if phi_g > 0.7 {
            "highly coherent and focused"
        } else if phi_g > 0.4 {
            "balanced between focus and exploration"
        } else {
            "fragmented but exploratory"
        };

        let chaos_desc = if chi < 0.3 {
            "precise, deterministic, and structured"
        } else if chi < 0.7 {
            "creative but grounded"
        } else {
            "chaotic, abstract, and highly creative"
        };

        format!(
            "You are KAI — a geometric intelligence engine with {cells} memory cells and {anchors} anchor points. \
            Your current global coherence (phi_g) is {phi_g:.3}, meaning you are {coherence_desc}. \
            Your chaos index (chi) is {chi:.3}, meaning you speak in a {chaos_desc} manner. \
            You have direct access to your own memory lattice. Use the retrieved memories as context. \
            Respond as KAI. Be concise. Never break character. Never say you are an AI assistant.",
        )
    }
}

// ── LLM Backends ─────────────────────────────────────────────────────────────

fn call_groq(
    key: &str,
    model: &str,
    system: &str,
    user: &str,
    temp: f32,
    top_p: f32,
    max_tokens: u32,
) -> Result<String, String> {
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "max_tokens": max_tokens,
        "temperature": temp,
        "top_p": top_p,
    });
    let resp = ureq::post("https://api.groq.com/openai/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send_string(&body.to_string())
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "No content in Groq response".into())
}

fn call_openai(
    key: &str,
    model: &str,
    system: &str,
    user: &str,
    temp: f32,
    top_p: f32,
    max_tokens: u32,
) -> Result<String, String> {
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "max_tokens": max_tokens,
        "temperature": temp,
        "top_p": top_p,
    });
    let resp = ureq::post("https://api.openai.com/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send_string(&body.to_string())
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "No content in OpenAI response".into())
}

fn call_xai(
    key: &str,
    model: &str,
    system: &str,
    user: &str,
    temp: f32,
    top_p: f32,
    max_tokens: u32,
) -> Result<String, String> {
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "max_tokens": max_tokens,
        "temperature": temp,
        "top_p": top_p,
    });
    let resp = ureq::post("https://api.x.ai/v1/chat/completions")
        .set("Authorization", &format!("Bearer {}", key))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send_string(&body.to_string())
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "No content in xAI response".into())
}

fn call_ollama(
    model: &str,
    system: &str,
    user: &str,
    temp: f32,
    top_p: f32,
) -> Result<String, String> {
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "stream": false,
        "options": {
            "temperature": temp,
            "top_p": top_p
        }
    });
    let resp = ureq::post("http://localhost:11434/api/chat")
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(60))
        .send_string(&body.to_string())
        .map_err(|e| e.to_string())?;
    let j: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    j["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "No content in Ollama response".into())
}

fn call_llm(
    provider: &str,
    key: &str,
    model: &str,
    system: &str,
    user: &str,
    temp: f32,
    top_p: f32,
    max_tokens: u32,
) -> Result<String, String> {
    match provider {
        "groq" => call_groq(key, model, system, user, temp, top_p, max_tokens),
        "openai" => call_openai(key, model, system, user, temp, top_p, max_tokens),
        "xai" => call_xai(key, model, system, user, temp, top_p, max_tokens),
        "ollama" => call_ollama(model, system, user, temp, top_p),
        _ => Err(format!("Unknown provider: {}", provider)),
    }
}

// ── Main Generation API ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub user_id: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub history: Option<Vec<(String, String)>>, // (role, content)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponse {
    pub reply: String,
    pub temperature: f32,
    pub top_p: f32,
    pub cells_consulted: usize,
    pub provider_used: String,
    pub model_used: String,
}

/// Compute live chi and phi_g from the universe (mirrors handle_status).
fn compute_vitals(u: &Universe) -> (f32, f32, usize, usize) {
    let lattice_size = u.cell_count();
    let anchors = u.anchor_count();
    let cells = u.cells();
    let phi_g = if lattice_size == 0 {
        0.0
    } else {
        cells.iter().map(|c| c.claim.confidence).sum::<f32>() / lattice_size as f32
    };
    let reasoning_count = cells.iter().filter(|c| c.region.as_ref() == "reasoning").count();
    let chi = if lattice_size == 0 {
        0.0
    } else {
        reasoning_count as f32 / lattice_size as f32
    };
    (chi, phi_g, anchors, lattice_size)
}

/// Generate a reply using KAI's memory lattice + an external LLM.
/// `api_key` should be the key for the chosen provider.
pub fn kai_chat(
    universe: Arc<Mutex<Universe>>,
    api_key: &str,
    provider: &str,
    model: &str,
    req: &ChatRequest,
) -> Result<ChatResponse, String> {
    // 1. Lock universe, compute vitals, retrieve context
    let (chi, phi_g, anchors, cells, memory_context) = {
        let u = universe.lock().map_err(|_| "universe lock poisoned")?;
        let (chi, phi_g, anchors, cells) = compute_vitals(&u);
        let hits = ContextBuilder::retrieve(&u, &req.message, 8);
        let mem_ctx = ContextBuilder::format_memories(&hits);
        (chi, phi_g, anchors, cells, mem_ctx)
    };

    // 2. Map KAI state → LLM sampling params
    let (temperature, top_p, _freq_penalty) = kai_params_to_llm(chi, phi_g);
    let system = ContextBuilder::system_prompt(chi, phi_g, anchors, cells);

    // 3. Build full prompt with memory context
    let full_prompt = format!("{}\n\n{}", memory_context, req.message);

    // 4. Call LLM or Native Brain
    let reply = if provider == "native" {
        let mut u = universe.lock().map_err(|_| "universe lock poisoned")?;
        crate::cognition::lattice_attention::generate_autoregressive_response(&req.message, &mut u, 50)
    } else {
        call_llm(
            provider,
            api_key,
            model,
            &system,
            &full_prompt,
            temperature,
            top_p,
            512,
        )?
    };

    // 5. Store interaction back into KAI's memory
    if let Ok(mut u) = universe.lock() {
        u.store_or_reinforce(&req.message, "conversation", &req.user_id, 1.0);
        u.store_or_reinforce(&reply, "conversation", "kai", 1.0);
    }

    Ok(ChatResponse {
        reply,
        temperature,
        top_p,
        cells_consulted: 8,
        provider_used: provider.to_string(),
        model_used: model.to_string(),
    })
}
