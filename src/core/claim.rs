use crate::core::SparseVec;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claim {
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_source")]
    pub source: Arc<str>,
    /// List of evidence labels or unique identifiers supporting this claim.
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    #[serde(default)]
    pub last_verified: u64,
    #[serde(default)]
    pub created_at: u64,
    /// List of contradictory claim labels or identifiers.
    #[serde(default)]
    pub contradictions: Vec<String>,
    /// The semantic vector for this claim.
    #[serde(default)]
    pub vec: SparseVec,
    /// Biological vitality (telomere-like budget). Starts at 1.0.
    #[serde(default = "default_vitality")]
    pub vitality: f32,
    /// Hierarchy layer (0: Quantum, 1: Syncytium, 2: Cellular, 3: Organ, 4: Body).
    #[serde(default)]
    pub layer: u8,
    /// User identifier for cellularization (isolation).
    #[serde(default)]
    pub user_id: Arc<str>,
    /// Discord channel ID where this belief originated.
    #[serde(default)]
    pub channel_id: Arc<str>,
    /// Discord message ID for exact retrieval.
    #[serde(default)]
    pub message_id: Arc<str>,
    /// Discord guild ID.
    #[serde(default)]
    pub guild_id: Arc<str>,
    /// Extracted keywords for fast overlap lookup.
    #[serde(default)]
    pub keywords: Vec<String>,
}

pub const LAYER_QUANTUM: u8 = 0;
pub const LAYER_SYNCYTIUM: u8 = 1;
pub const LAYER_CELLULAR: u8 = 2;
pub const LAYER_ORGAN: u8 = 3;
pub const LAYER_BODY: u8 = 4;

fn default_vitality() -> f32 {
    1.0
}

fn default_source() -> Arc<str> {
    Arc::from("unknown")
}

fn default_confidence() -> f32 {
    1.0
}

impl Claim {
    pub fn new(text: &str, source: &str, confidence: f32, vec: SparseVec) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        Self {
            text: text.to_string(),
            source: Arc::from(source),
            evidence: Vec::new(),
            confidence,
            last_verified: now,
            created_at: now,
            contradictions: Vec::new(),
            vec,
            vitality: 1.0,
            layer: LAYER_SYNCYTIUM,
            user_id: Arc::from(""),
            channel_id: Arc::from(""),
            message_id: Arc::from(""),
            guild_id: Arc::from(""),
            keywords: Vec::new(),
        }
    }
}
