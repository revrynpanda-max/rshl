// KAI RSHL — Claudey Immune System
// Async-safe, timeout-hardened anomaly detection and lattice self-defense.
// Replaces synchronous ureq / crossbeam-channel operations with
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
    hnsw_index: Arc<Mutex<Hnsw<f32, DistCosine>>>,
    known_good: Arc<Mutex<RoaringBitmap>>,
    known_bad: Arc<Mutex<RoaringBitmap>>,
    event_tx: mpsc::UnboundedSender<ImmuneEvent>,
}

impl Clone for ClaudeyImmune {
    fn clone(&self) -> Self {
        Self {
            config: self.config,
            http_client: self.http_client.clone(),
            hnsw_index: Arc::clone(&self.hnsw_index),
            known_good: Arc::clone(&self.known_good),
            known_bad: Arc::clone(&self.known_bad),
            event_tx: self.event_tx.clone(),
        }
    }
}

impl ClaudeyImmune {
    /// Create a new Claudey immune instance and spawn the background event loop.
    pub fn new(config: ClaudeyConfig) -> Self {
        let (event_tx, event_rx) = mpsc::unbounded_channel::<ImmuneEvent>();
        let inner = Self {
            config,
            http_client: Client::new(),
            hnsw_index: Arc::new(Mutex::new(Hnsw::new(16, 100, 16, 200, DistCosine))),
            known_good: Arc::new(Mutex::new(RoaringBitmap::new())),
            known_bad: Arc::new(Mutex::new(RoaringBitmap::new())),
            event_tx,
        };

        let handle = inner.clone();
        tokio::spawn(async move {
            handle.run_event_loop(event_rx).await;
        });

        inner
    }

    /// Public entry: analyse a lattice snapshot or vector data for anomalies.
    /// This method is non-blocking and returns a `Result` within the configured timeout.
    pub async fn analyze_anomaly(&self, data: Vec<f32>) -> Result<ScanResult, ClaudeError> {
        let (tx, rx) = oneshot::channel();
        self.event_tx
            .send(ImmuneEvent::ScanRequest { data, response: tx })
            .map_err(|e| ClaudeError::Internal(format!("event channel error: {}", e)))?;

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
                    let _ = response.send(result);
                }
            }
        }
    }

    async fn process_scan(&self, data: Vec<f32>) -> Result<ScanResult, ClaudeError> {
        let compute_timeout = Duration::from_secs(self.config.compute_timeout_secs);
        
        let hnsw_clone = Arc::clone(&self.hnsw_index);
        let known_good_clone = Arc::clone(&self.known_good);
        let known_bad_clone = Arc::clone(&self.known_bad);
        let data_clone = data.clone();

        let scan_task = tokio::task::spawn_blocking(move || {
            let hnsw = hnsw_clone.blocking_lock();
            let known_good = known_good_clone.blocking_lock();
            let known_bad = known_bad_clone.blocking_lock();

            let neighbors = hnsw.search(&data_clone, 10, 50);
            let mut anomalies = Vec::new();
            let mut confidence_sum = 0.0f32;

            for (idx, dist) in neighbors {
                let uid = idx as u64;
                if known_bad.contains(uid as u32) {
                    anomalies.push(uid);
                    confidence_sum += 1.0 - dist;
                } else if !known_good.contains(uid as u32) && dist > 0.7 {
                    anomalies.push(uid);
                    confidence_sum += (dist - 0.7) * 2.0;
                }
            }

            let confidence = if anomalies.is_empty() {
                0.0
            } else {
                (confidence_sum / anomalies.len() as f32).min(1.0)
            };

            ScanResult { anomalies, confidence }
        });

        match timeout(compute_timeout, scan_task).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(e)) => Err(ClaudeError::Internal(format!("spawn_blocking join error: {}", e))),
            Err(_) => Err(ClaudeError::Timeout(format!(
                "HNSW scan exceeded {}s",
                self.config.compute_timeout_secs
            ))),
        }
    }
}
