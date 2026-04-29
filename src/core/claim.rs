use crate::core::SparseVec;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claim {
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_source")]
    pub source: String,
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
}

fn default_source() -> String {
    "unknown".to_string()
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
            source: source.to_string(),
            evidence: Vec::new(),
            confidence,
            last_verified: now,
            created_at: now,
            contradictions: Vec::new(),
            vec,
        }
    }
}
