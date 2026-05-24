// KAI RSHL — Claudey Immune System
// Async-safe, timeout-hardened anomaly detection and lattice self-defense.
// Replaces synchronous ureq / crossbeam-channel operations with:
//   - reqwest (async HTTP)
//   - tokio::sync::mpsc / oneshot (async channels)
//   - tokio::task::spawn_blocking + timeout for compute-bound work (HNSW, roaring)

use std::sync::Arc;
use std::time::Duration;

use hnsw_rs::prelude::*;
use reqwest::Client;
use roaring::RoaringBitmap;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Mutex, oneshot};
use tokio::time::timeout;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Timeout configuration for all external and heavy internal operations.
/// Defaults to `CLAUDEY_TIMEOUT_SECS` env var, or 10 seconds.
#[derive(Debug, Clone, Copy)]
pub struct ClaudeyConfig {
    pub http_timeout_secs: u64,
    pub compute_timeout_secs: u64,
}

impl Default for ClaudeyConfig {
    fn default() -> Self {
        let timeout_s = std::env::var("CLAUDEY_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(10);
        Self {
            http_timeout_secs: timeout_s,
            compute_timeout_secs: timeout_s,
        }
    }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum ClaudeError {
    Timeout(String),
    Http(reqwest::Error),
    Internal(String),
}

impl std::fmt::Display for ClaudeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Timeout(msg) => write!(f, "Claudey timeout: {}", msg),
            Self::Http(e) => write!(f, "Claudey HTTP error: {}", e),
            Self::Internal(msg) => write!(f, "Claudey internal error: {}", msg),
        }
    }
}

impl std::error::Error for ClaudeError {}

impl From<reqwest::Error> for ClaudeError {
    fn from(e: reqwest::Error) -> Self {
        Self::Http(e)
    }
}

impl From<tokio::task::JoinError> for ClaudeError {
    fn from(e: tokio::task::JoinError) -> Self {
        Self::Internal(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Events for internal channel
// ---------------------------------------------------------------------------

enum ImmuneEvent {
    ScanRequest {
        data: Vec<f32>,
        response: oneshot::Sender<Result<ScanResult, ClaudeError>>,
    },
    // Additional events (health check, reset, training, etc.) can be added here.
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub anomalies: Vec<u64>,
    pub confidence: f32,
}

// ---------------------------------------------------------------------------
// Core struct
// ---------------------------------------------------------------------------

pub struct ClaudeyImmune {
    config: ClaudeyConfig,
    http_client: Client,
    // HNSW index for fast nearest‑neighbor anomaly lookup (shared with background task)
    hnsw_index: Arc<Mutex<HnswModel<f32, DistCosine>>>,
    // Roaring bitmaps for known‑good / known‑bad pattern sets
    known_good: Arc<Mutex<RoaringBitmap>>,
    known_bad: Arc<Mutex<RoaringBitmap>>,
    // Sender for internal event loop
    event_tx: mpsc::UnboundedSender<ImmuneEvent>,
}

impl ClaudeyImmune {
    /// Create a new Claudey immune instance and spawn the background event loop.
    pub fn new(config: ClaudeyConfig) -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel::<ImmuneEvent>();

        let inner = Self {
            config,
            http_client: Client::new(),
            hnsw_index: Arc::new(Mutex::new(HnswModel::new(16, 100, DistCosine::default()))),
            known_good: Arc::new(Mutex::new(RoaringBitmap::new())),
            known_bad: Arc::new(Mutex::new(RoaringBitmap::new())),
            event_tx,
        };

        // Spawn the background event loop
        let handle = inner.clone();
        tokio::spawn(async move {
            handle.run_event_loop(event_rx).await;
        });

        inner
    }

    /// Public entry: analyse a lattice snapshot or vector data for anomalies.
    /// This method is non‑blocking and returns a `Result` within the configured timeout.
    pub async fn analyze_anomaly(&self, data: Vec<f32>) -> Result<ScanResult, ClaudeError> {
        let (tx, rx) = oneshot::channel();
        self.event_tx
            .send(ImmuneEvent::ScanRequest { data, response: tx })
            .map_err(|e| ClaudeError::Internal(format!("event channel error: {}", e)))?;

        // Enforce timeout at the caller level.
        let timeout_dur = Duration::from_secs(self.config.compute_timeout_secs);
        match timeout(timeout_dur, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(e)) => Err(e),
            Err(_elapsed) => Err(ClaudeError::Timeout(format!(
                "analyze_anomaly exceeded {}s",
                self.config.compute_timeout_secs
            ))),
        }
    }

    // -----------------------------------------------------------------------
    // Background event loop – owns the mutable state for sequential processing
    // -----------------------------------------------------------------------

    async fn run_event_loop(self, mut rx: mpsc::UnboundedReceiver<ImmuneEvent>) {
        while let Some(event) = rx.recv().await {
            match event {
                ImmuneEvent::ScanRequest { data, response } => {
                    let result = self.process_scan(data).await;
                    // Ignore error if receiver dropped
                    let _ = response.send(result);
                }
            }
        }
    }

    async fn process_scan(&self, data: Vec<f32>) -> Result<ScanResult, ClaudeError> {
        // --- Example: call external verification API (async with timeout) ---
        let external_future = self.call_verification_api(&data);
        let external_timeout = Duration::from_secs(self.config.http_timeout_secs);
        let external_result = timeout(external_timeout, external_future)
            .await
            .map_err(|_| ClaudeError::Timeout("external verification API".into()))??;

        // --- Example: heavy HNSW search offloaded to blocking thread ---
        let index_arc = Arc::clone(&self.hnsw_index);
        let data_clone = data.clone();
        let compute_future = tokio::task::spawn_blocking(move || {
            let index = index_arc.blocking_lock();
            index.search(&data_clone, 10) // returns Vec<(f32, usize)>
        });
        let compute_timeout = Duration::from_secs(self.config.compute_timeout_secs);
        let neighbors = timeout(compute_timeout, compute_future)
            .await
            .map_err(|_| ClaudeError::Timeout("HNSW search".into()))??;

        // --- Example: combine with roaring bitmaps ---
        let known_bad = self.known_bad.lock().await;
        let anomaly_ids: Vec<u64> = neighbors
            .iter()
            .filter(|(dist, id)| *dist > 0.5 && known_bad.contains(*id as u32))
            .map(|(_, id)| *id as u64)
            .collect();

        Ok(ScanResult {
            anomalies: anomaly_ids,
            confidence: external_result.confidence,
        })
    }

    // -----------------------------------------------------------------------
    // Helper: async HTTP call with reqwest
    // -----------------------------------------------------------------------

    async fn call_verification_api(&self, data: &[f32]) -> Result<ExternalResponse, ClaudeError> {
        // Example endpoint; production URL would come from config.
        let url = format!("http://localhost:11434/api/verify"); // dummy
        let payload = serde_json::json!({ "vector": data });

        let response = self
            .http_client
            .post(&url)
            .json(&payload)
            .send()
            .await?
            .json::<ExternalResponse>()
            .await?;

        Ok(response)
    }
}

// ---------------------------------------------------------------------------
// Supporting types (adjust to actual API contract)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ExternalResponse {
    confidence: f32,
    // other fields as needed
}

// ---------------------------------------------------------------------------
// Safety: Clone for sharing across async tasks
// ---------------------------------------------------------------------------

impl Clone for ClaudeyImmune {
    fn clone(&self) -> Self {
        Self {
            config: self.config,
            http_client: Client::new(), // cheap clone – connection pool shared internally
            hnsw_index: Arc::clone(&self.hnsw_index),
            known_good: Arc::clone(&self.known_good),
            known_bad: Arc::clone(&self.known_bad),
            event_tx: self.event_tx.clone(),
        }
    }
}
