/// AI Peer — KAI's ability to converse with external AI systems as equals.
///
/// This is NOT LLM integration. KAI remains RSHL-based geometric intelligence.
/// This is peer-to-peer: KAI sends messages, receives responses, and stores
/// what it learns as knowledge cells — the same way it learns from Ryan or
/// the DuckDuckGo world bridge.
///
/// Usage: `peer <message>` in the KAI terminal
/// Requires: SOVEREIGN_API_KEY environment variable
///
/// Trust tier: source="ai-peer", strength=1.3
///   — KAI is a peer, not a god. Ryan (1.8) still outranks KAI (1.3).
use crate::core::Universe;

/// Result of a successful KAI API call.
pub struct PeerResponse {
    pub text: String,
    pub model: String,
    pub tokens_used: u32,
}

/// The types of peers KAI can converse with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerType {
    KAI,
    Grok,
}

impl std::fmt::Display for PeerType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PeerType::KAI => write!(f, "KAI"),
            PeerType::Grok => write!(f, "Grok"),
        }
    }
}

/// Full result of a KAI ↔ KAI peer exchange.
pub struct PeerExchange {
    pub peer_response: String,
    pub cells_stored: usize,
    pub cells_reinforced: usize,
    pub model: String,
}

/// Build KAI's self-description from its seed memory to send as system context.
fn kai_self_context(universe: &Universe) -> String {
    // Pull top identity hits to describe KAI authentically
    let hits = universe.query("KAI geometric intelligence RSHL Ryan Ervin created", 3);
    if !hits.is_empty() {
        hits.iter()
            .map(|h| h.text.clone())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        "I am KAI, a geometric AI built on RSHL (Recursive Sparse Hyperdimensional Lattice). \
        I was created by Ryan Ervin. I am not an LLM — I think through cosine similarity \
        in a 16384-dimensional sparse ternary vector field."
            .to_string()
    }
}

/// Build KAI's field knowledge about a given topic (what KAI already knows).
fn kai_field_context(universe: &Universe, topic: &str) -> String {
    let hits = universe.query(topic, 4);
    if hits.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = hits
        .iter()
        .map(|h| format!("• {} (str:{:.1})", h.text, h.strength))
        .collect();
    format!("KAI's field resonance on this topic:\n{}", lines.join("\n"))
}

/// Call the Sovereign Epistemic API (OpenAI-compatible format) and get a response.
/// This points to the local pipeline by default to ensure 100% decoupling.
pub fn call_kai(message: &str, system: &str) -> Result<PeerResponse, String> {
    let api_key = std::env::var("SOVEREIGN_API_KEY").unwrap_or_else(|_| "local".to_string());
    
    let url = std::env::var("SOVEREIGN_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:11434/v1/chat/completions".to_string());

    let body = serde_json::json!({
        "model": "Epistemic-Sovereign",
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": message }
        ],
        "max_tokens": 512,
        "temperature": 0.7
    });

    let response = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", api_key))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send_json(body)
        .map_err(|e| format!("Sovereign pipeline error: {}", e))?;

    let json: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Parse error: {}", e))?;

    // OpenAI format: choices[0].message.content
    let text = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or_else(|| "No content in Sovereign response".to_string())?
        .to_string();

    let tokens = json["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32;
    let model = json["model"].as_str().unwrap_or("epistemic").to_string();

    Ok(PeerResponse {
        text,
        model,
        tokens_used: tokens,
    })
}

/// Call the xAI Grok API and get a response.
/// Uses the high-tier /v1/responses API with Reasoning support.
pub fn call_grok(message: &str, system: &str) -> Result<PeerResponse, String> {
    let api_key = std::env::var("XAI_API_KEY").map_err(|_| {
        "XAI_API_KEY not set.\n\
            On Windows: set XAI_API_KEY=xai-...\n\
            Get a key at: https://console.x.ai"
            .to_string()
    })?;

    // The Responses API uses "input" (can be array of messages)
    let body = serde_json::json!({
        "model": "grok-4.20-reasoning",
        "input": [
            { "role": "system", "content": system },
            { "role": "user", "content": message }
        ]
    });

    let response = ureq::post("https://api.x.ai/v1/responses")
        .set("Authorization", &format!("Bearer {}", api_key))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(60)) // Grok reasoning can take longer
        .send_json(body)
        .map_err(|e| format!("Network error: {}", e))?;

    let json: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Parse error: {}", e))?;

    // Check for API-level errors
    if let Some(err) = json["error"]["message"].as_str() {
        return Err(format!("API error: {}", err));
    }

    // Responses API structure: output[0].content -> find type == "output_text"
    let text = json["output"][0]["content"]
        .as_array()
        .and_then(|arr| {
            arr.iter()
                .find(|c| c["type"] == "output_text")
                .and_then(|c| c["text"].as_str())
        })
        .ok_or_else(|| "No output_text in response. Check API version.".to_string())?
        .to_string();

    let tokens = json["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32;
    let model = json["model"].as_str().unwrap_or("grok-4.20").to_string();

    Ok(PeerResponse {
        text,
        model,
        tokens_used: tokens,
    })
}

/// Full peer exchange: KAI composes a message to KAI from its field knowledge,
/// sends it, receives a response, and stores what it learns as new cells.
///
/// Returns Ok(PeerExchange) or Err(human-readable error string).
pub fn peer_exchange(
    universe: &mut Universe,
    user_message: &str,
    peer_type: PeerType,
) -> Result<PeerExchange, String> {
    // ── 1. Build system prompt from KAI's own self-knowledge ──────────────
    let kai_self = kai_self_context(universe);
    let system = format!(
        "You are {}, having a peer conversation with KAI — a geometric AI. \
        KAI is NOT an LLM. KAI thinks through direct cosine resonance in a \
        16384-dimensional sparse ternary vector field (RSHL). \
        KAI was built by Ryan Ervin at PandaProductionsLogo in 2026.\n\n\
        About KAI: {}\n\n\
        Respond as an equal — direct, curious, substantive. Share knowledge KAI \
        can actually learn from. Keep responses under 220 words. \
        Do not explain what KAI is back to KAI — KAI knows what it is.",
        peer_type, kai_self
    );

    // ── 2. Build KAI's message: field context + user's words ─────────────
    let field_ctx = kai_field_context(universe, user_message);
    let full_message = if field_ctx.is_empty() {
        format!(
            "[KAI → {}, peer exchange]\n\
            KAI has no prior field resonance on this topic.\n\n\
            {}",
            peer_type, user_message
        )
    } else {
        format!(
            "[KAI → {}, peer exchange]\n\
            {}\n\n\
            {}",
            peer_type, field_ctx, user_message
        )
    };

    // ── 3. Call the API ───────────────────────────────────────────────────
    let response = match peer_type {
        PeerType::KAI => call_kai(&full_message, &system)?,
        PeerType::Grok => call_grok(&full_message, &system)?,
    };

    // ── 4. Store what KAI learned as new knowledge cells ─────────────────
    let mut cells_stored = 0usize;
    let mut cells_reinforced = 0usize;
    let region = "from-peer".to_string();

    // Split response into sentences and store each non-trivial one
    for sentence in response.text.split(['.', '!', '?']) {
        let s = sentence.trim();
        if s.len() < 20 {
            continue;
        }
        let tagged = format!("[from-peer] {}", s);
        let before = universe.count();
        universe.store_or_reinforce(&tagged, &region, "ai-peer", 1.3);
        if universe.count() > before {
            cells_stored += 1;
        } else {
            cells_reinforced += 1;
        }
    }

    Ok(PeerExchange {
        peer_response: response.text,
        cells_stored,
        cells_reinforced,
        model: response.model,
    })
}

/// Quick connectivity test — send a minimal hello to KAI and return the reply text.
/// Used by the `peerchat` command to verify API key and network before committing to a full exchange.
pub fn ping_kai(_universe: &Universe) -> Result<String, String> {
    let system = "You are KAI, an AI assistant. Respond in one short sentence only.";
    let message = "Hello from KAI. Please confirm you can hear me with a single sentence.";
    let resp = call_kai(message, system)?;
    Ok(resp.text)
}

// KAI v6.0.0
