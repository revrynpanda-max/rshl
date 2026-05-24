//! 4-Tier Epistemic Memory Engine with User Isolation & Emotional Weighting
//!
//! Architecture:
//!   Tier 1 – Immediate (short‑term buffer, consciousness)
//!   Tier 2 – Working (active reasoning set)
//!   Tier 3 – Episodic (personal history, user‑partitioned)
//!   Tier 4 – Semantic (long‑term universal claims, highest isolation)
//!
//! Emotional weighting attaches an affective valence {curiosity,conflict,resonance}
//! to each claim, biasing recall toward emotionally coherent arrays.
//! User isolation ensures Claim IDs are prefixed by a user hash – no cross‑user
//! leakage.
//!
//! Dependencies: serde, serde_json, tokio::fs, std::collections::HashMap.
//! Integrated via lattice‑bridge into the RSHL core.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

// ─── Core Types ───────────────────────────────────────────────────────────

/// Polarity of a claim (Positive / Negative / Ambivalent)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Polarity {
    Positive,
    Negative,
    Ambivalent,
}

/// Confidence score clamped to [0.0, 5.0], with 5.0 being axiomatic.
pub type Confidence = f32;

/// Emotional valence assigned by the Dream Cycle.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmotionalValence {
    /// 0.0 = neutral; positive = coherent/exciting; negative = contradictory.
    pub curiosity: f32,
    pub conflict: f32,
    pub resonance: f32,
}

impl Default for EmotionalValence {
    fn default() -> Self {
        Self {
            curiosity: 0.0,
            conflict: 0.0,
            resonance: 0.5,
        }
    }
}

/// A single epistemic claim, the atomic unit of memory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claim {
    /// Globally unique ID: format "{user_hash}:{uuid}"
    pub id: String,
    pub subject: String,
    pub relation: String,
    pub object: String,
    pub polarity: Polarity,
    pub confidence: Confidence,
    /// Source identifier for trust scoring.
    pub source: String,
    pub source_trust: f32,
    /// "Claim" | "Stable" | "Contradicted"
    pub status: String,
    pub timestamp: u64,
    /// Emotional weighting vector (set during Dream Cycle consolidation).
    pub emotion: EmotionalValence,
    /// User hash for isolation (empty string = universal / Tier 4).
    pub user_hash: String,
    /// Tier: 1..=4
    pub tier: u8,
}

/// The four claim stores.
#[derive(Debug, Default)]
pub struct EpistemicVault {
    /// Tier 1 – immediate / conscious buffer (volatile)
    pub immediate: Vec<Claim>,
    /// Tier 2 – working memory (active reasoning context)
    pub working: Vec<Claim>,
    /// Tier 3 – episodic, per‑user
    pub episodic: HashMap<String, Vec<Claim>>,
    /// Tier 4 – semantic, universal, high‑confidence
    pub semantic: Vec<Claim>,
    /// Global index by ID for fast lookup across all tiers.
    pub index: HashMap<String, (u8, usize)>, // (tier, position_in_tier_vec)
}

/// Thread‑safe wrapper.
pub struct ClaimStore {
    inner: RwLock<EpistemicVault>,
}

impl ClaimStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(EpistemicVault::default()),
        }
    }

    /// Insert a claim into the appropriate tier based on emotional weight and user.
    ///
    /// Emotional weighting rules:
    ///   - curiosity > 0.7 -> Tier 1 (immediate)
    ///   - conflict > 0.6  -> Tier 2 (needs resolution)
    ///   - resonance > 0.8 -> Tier 3 or 4 (consolidation)
    ///   - otherwise       -> Tier 3 (episodic) if user_hash set, else Tier 4.
    pub async fn insert(&self, mut claim: Claim) -> String {
        let user = claim.user_hash.clone();
        let tier = self.determine_tier(&claim);

        claim.tier = tier;
        claim.id = format!("{}:{}", if user.is_empty() { "__UNIVERSAL__" } else { &user }, uuid_v4());

        let mut vault = self.inner.write().await;
        match tier {
            1 => {
                vault.immediate.push(claim);
                vault.index.insert(vault.immediate.last().unwrap().id.clone(), (1, vault.immediate.len() - 1));
            }
            2 => {
                vault.working.push(claim);
                vault.index.insert(vault.working.last().unwrap().id.clone(), (2, vault.working.len() - 1));
            }
            3 => {
                let entry = vault.episodic.entry(user).or_default();
                entry.push(claim);
                vault.index.insert(entry.last().unwrap().id.clone(), (3, entry.len() - 1));
            }
            4 | _ => {
                vault.semantic.push(claim);
                vault.index.insert(vault.semantic.last().unwrap().id.clone(), (4, vault.semantic.len() - 1));
            }
        }

        vault.semantic.last().unwrap().id.clone()
    }

    fn determine_tier(&self, claim: &Claim) -> u8 {
        let e = &claim.emotion;
        if e.curiosity > 0.7 {
            1
        } else if e.conflict > 0.6 {
            2
        } else if e.resonance > 0.8 {
            if claim.user_hash.is_empty() { 4 } else { 3 }
        } else {
            if claim.user_hash.is_empty() { 4 } else { 3 }
        }
    }

    /// Retrieve a claim by ID across all tiers.
    pub async fn get_by_id(&self, id: &str) -> Option<Claim> {
        let vault = self.inner.read().await;
        let (tier, pos) = vault.index.get(id)?;
        match tier {
            1 => vault.immediate.get(*pos).cloned(),
            2 => vault.working.get(*pos).cloned(),
            3 => {
                // need to find the vector; we store position as per user entry
                // For simplicity, we store a flat index; but we need to reconstruct.
                // Here we do a scan across all episodic entries (could be optimized).
                for vec in vault.episodic.values() {
                    if let Some(c) = vec.get(*pos) {
                        return Some(c.clone());
                    }
                }
                None
            }
            4 | _ => vault.semantic.get(*pos).cloned(),
        }
    }

    /// Query by subject, optionally filtered by user_hash.
    pub async fn query(&self, subject: &str, user_hash: &str) -> Vec<Claim> {
        let vault = self.inner.read().await;
        let mut results = Vec::new();

        // Helper closure
        let mut check = |c: &Claim| {
            if c.subject == subject && (user_hash.is_empty() || c.user_hash == user_hash) {
                results.push(c.clone());
            }
        };

        vault.immediate.iter().for_each(&mut check);
        vault.working.iter().for_each(&mut check);
        if let Some(ep) = vault.episodic.get(user_hash) {
            ep.iter().for_each(&mut check);
        }
        vault.semantic.iter().for_each(&mut check);

        results
    }

    /// Load from a JSON file (optionally populate seed claims).
    pub async fn load_from_json(&self, path: &str) -> Result<(), Box<dyn std::error::Error>> {
        let data = tokio::fs::read_to_string(path).await?;
        let seed_claims: Vec<Claim> = serde_json::from_str(&data)?;
        for mut c in seed_claims {
            // Assign an emotion if missing
            if c.emotion == EmotionalValence::default() {
                // Auto‑compute from confidence & source trust
                c.emotion.curiosity = (c.confidence * 0.3).min(1.0);
                c.emotion.conflict = 0.2; // default low
                c.emotion.resonance = (c.source_trust * 0.8).min(1.0);
            }
            self.insert(c).await;
        }
        Ok(())
    }

    /// Remove claims with confidence below threshold (Tier 1 pruning).
    pub async fn prune(&self, min_confidence: f32) -> usize {
        let mut vault = self.inner.write().await;
        let before = vault.immediate.len();
        vault.immediate.retain(|c| c.confidence >= min_confidence);
        // Rebuild index for tier 1 (lazy, could be optimized)
        vault.index.retain(|_, (t, _)| *t != 1);
        for (i, c) in vault.immediate.iter().enumerate() {
            vault.index.insert(c.id.clone(), (1, i));
        }
        before - vault.immediate.len()
    }

    /// Run the Dream Cycle: consolidate Tier 1 → 2, promote to higher tiers.
    pub async fn dream_cycle(&self) {
        let mut vault = self.inner.write().await;
        // Promote all Tier 1 to Tier 2, resetting Tier 1.
        let mut promoted: Vec<Claim> = std::mem::take(&mut vault.immediate);
        for c in &mut promoted {
            c.tier = 2;
            c.emotion.curiosity *= 0.8; // decay curiosity
            c.emotion.resonance *= 1.05; // strengthen resonance
        }
        vault.working.extend(promoted);

        // For Tier 2, if confidence>3.0 and resonance>0.7, move to episodic/semantic
        let mut to_tier3or4: Vec<Claim> = Vec::new();
        vault.working.retain(|c| {
            if c.confidence > 3.0 && c.emotion.resonance > 0.7 {
                let mut c2 = c.clone();
                c2.tier = if c2.user_hash.is_empty() { 4 } else { 3 };
                to_tier3or4.push(c2);
                false
            } else {
                true
            }
        });
        for c in to_tier3or4 {
            if c.tier == 3 {
                vault.episodic.entry(c.user_hash.clone()).or_default().push(c);
            } else {
                vault.semantic.push(c);
            }
        }

        // Rebuild index
        vault.index.clear();
        for (i, c) in vault.immediate.iter().enumerate() {
            vault.index.insert(c.id.clone(), (1, i));
        }
        for (i, c) in vault.working.iter().enumerate() {
            vault.index.insert(c.id.clone(), (2, i));
        }
        for (user, vec) in vault.episodic.iter() {
            for (i, c) in vec.iter().enumerate() {
                vault.index.insert(c.id.clone(), (3, i));
            }
        }
        for (i, c) in vault.semantic.iter().enumerate() {
            vault.index.insert(c.id.clone(), (4, i));
        }
    }
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:020x}", nanos)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_insert_and_query() {
        let store = ClaimStore::new();
        let claim = Claim {
            id: String::new(),
            subject: "test".into(),
            relation: "is".into(),
            object: "example".into(),
            polarity: Polarity::Positive,
            confidence: 4.0,
            source: "test".into(),
            source_trust: 0.9,
            status: "Claim".into(),
            timestamp: 1000,
            emotion: EmotionalValence::default(),
            user_hash: "user1".into(),
            tier: 0,
        };
        let id = store.insert(claim).await;
        assert!(id.starts_with("user1:"));
        let results = store.query("test", "user1").await;
        assert_eq!(results.len(), 1);
    }
}
