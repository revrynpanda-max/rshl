//! KAI Oracle HTTP Server (Axum, port 3333)
//! Entry point for lattice operations and inter‑agent communication.
//! All blocking I/O is wrapped in spawn_blocking; external HTTP uses reqwest with timeouts.

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};
use tower_http::timeout::TimeoutLayer;

mod lattice;
mod memory;

pub use lattice::Lattice;
pub use memory::SynapticLayer;

/// Application state – global lattice and shared HTTP client.
#[derive(Clone)]
pub struct AppState {
    pub lattice: Arc<Mutex<Lattice>>,
    pub client: reqwest::Client,
}

impl AppState {
    pub fn new() -> Self {
        let lattice = Arc::new(Mutex::new(Lattice::new()));
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .expect("Failed to build reqwest client");
        Self { lattice, client }
    }
}

// ── Handlers ────────────────────────────────────────────────────────────────

/// POST /rshl – run the lattice (flocking + Hebbian update)
pub async fn run_lattice(
    State(state): State<AppState>,
    Json(params): Json<LatticeParams>,
) -> Json<LatticeResult> {
    let start = tokio::time::Instant::now();

    // Acquire lattice lock and run with a total timeout of 2 seconds.
    let mut guard = state.lattice.lock().await;
    let res = tokio::time::timeout(Duration::from_secs(2), async {
        guard.process(params.iterations).await;
        // Yield periodically during large steps
        tokio::task::yield_now().await;
        guard.stats()
    })
    .await;

    match res {
        Ok(stats) => Json(LatticeResult {
            elapsed: start.elapsed().as_secs_f64(),
            stats,
        }),
        Err(_) => {
            // Timeout – preserve partial state
            guard.emergency_save().ok();
            Json(LatticeResult {
                elapsed: start.elapsed().as_secs_f64(),
                stats: guard.stats(),
            })
        }
    }
}

/// POST /neural/query – bridge to external LLM (e.g., Groq, Gemini)
/// Uses reqwest with per‑request timeout.
pub async fn neural_query(
    State(state): State<AppState>,
    Json(query): Json<NeuralQuery>,
) -> Result<Json<NeuralResponse>, String> {
    let client = state.client.clone();
    let url = "https://api.groq.com/openai/v1/chat/completions";

    let body = serde_json::json!({
        "model": "mixtral-8x7b-32768",
        "messages": [{"role": "user", "content": query.prompt}]
    });

    let resp = timeout(Duration::from_secs(30), async {
        client
            .post(url)
            .json(&body)
            .header("Authorization", format!("Bearer {}", query.api_key))
            .send()
            .await
            .map_err(|e| format!("Request failed: {}", e))
    })
    .await
    .map_err(|_| "HTTP request timed out after 30 seconds".to_string())??;

    let text: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    Ok(Json(NeuralResponse {
        reply: text["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string(),
    }))
}

/// GET /health – simple liveness check
pub async fn health() -> &'static str {
    "KAI RSHL Server is alive – timeout guards active."
}

// ── Application entry (called from main.rs) ─────────────────────────────────

pub async fn run_server() {
    let state = AppState::new();

    let app = Router::new()
        .route("/health", get(health))
        .route("/rshl", post(run_lattice))
        .route("/neural/query", post(neural_query))
        .layer(TimeoutLayer::new(Duration::from_secs(35))) // Global guard
        .with_state(state);

    let addr = "0.0.0.0:3333";
    println!("Oracle server listening on {}", addr);
    axum::Server::bind(&addr.parse().unwrap())
        .serve(app.into_make_service())
        .await
        .unwrap();
}

// ── DTOs ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct LatticeParams {
    iterations: usize,
}

#[derive(Debug, Serialize)]
pub struct LatticeResult {
    elapsed: f64,
    stats: LatticeStats,
}

#[derive(Debug, Deserialize)]
pub struct NeuralQuery {
    pub prompt: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct NeuralResponse {
    pub reply: String,
}
