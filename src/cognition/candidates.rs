/// Candidate Buffer — Dream candidate accumulation layer.
///
/// Biology analog: Pre-synaptic holding zone before long-term potentiation.
/// A pattern must recur repeatedly with stable field quality before it earns
/// promotion into durable memory.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum CandidateStatus {
    Candidate,
    Promoted,
    Rejected,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CandidateEntry {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub label: String,
    pub seen_count: u32,
    pub best_phi_g: f32,
    pub best_c: f32,
    pub best_confidence: f32,
    pub contradiction_history: Vec<f32>,
    pub phi_history: Vec<f32>,
    pub non_source_count: u32,
    pub status: CandidateStatus,
    pub first_seen: u64,
    pub last_seen: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CandidateBuffer {
    pub entries: HashMap<String, CandidateEntry>,
}

impl CandidateBuffer {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    pub fn count(&self) -> usize {
        self.entries.len()
    }

    /// Observe a dream result. Creates or updates a candidate.
    pub fn observe(
        &mut self,
        text: &str,
        phi_g: f32,
        c: f32,
        chi: f32,
        confidence: f32,
        is_non_source: bool,
    ) -> Option<&CandidateEntry> {
        let key = text.trim().to_lowercase();
        if key.is_empty() {
            return None;
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        if let Some(entry) = self.entries.get_mut(&key) {
            entry.seen_count += 1;
            entry.last_seen = now;
            if phi_g > entry.best_phi_g {
                entry.best_phi_g = phi_g;
            }
            if c > entry.best_c {
                entry.best_c = c;
            }
            if confidence > entry.best_confidence {
                entry.best_confidence = confidence;
            }
            if is_non_source {
                entry.non_source_count += 1;
            }

            entry.contradiction_history.push(chi);
            if entry.contradiction_history.len() > 20 {
                entry.contradiction_history.remove(0);
            }

            entry.phi_history.push(phi_g);
            if entry.phi_history.len() > 20 {
                entry.phi_history.remove(0);
            }
        } else {
            self.entries.insert(
                key.clone(),
                CandidateEntry {
                    key: key.clone(),
                    text: text.to_string(),
                    label: text.to_string(),
                    seen_count: 1,
                    best_phi_g: phi_g,
                    best_c: c,
                    best_confidence: confidence,
                    contradiction_history: vec![chi],
                    phi_history: vec![phi_g],
                    non_source_count: if is_non_source { 1 } else { 0 },
                    status: CandidateStatus::Candidate,
                    first_seen: now,
                    last_seen: now,
                },
            );
        }

        self.entries.get(&key)
    }

    /// Get all entries.
    pub fn get_all(&self) -> Vec<&CandidateEntry> {
        self.entries.values().collect()
    }

    /// Get active candidates meeting thresholds.
    pub fn get_candidates(&self, min_seen: u32, min_c: f32, min_phi: f32) -> Vec<&CandidateEntry> {
        self.entries
            .values()
            .filter(|e| {
                e.status == CandidateStatus::Candidate
                    && e.seen_count >= min_seen
                    && e.best_c >= min_c
                    && e.best_phi_g >= min_phi
            })
            .collect()
    }

    /// Mark as promoted.
    pub fn mark_promoted(&mut self, key: &str) {
        if let Some(e) = self.entries.get_mut(key) {
            e.status = CandidateStatus::Promoted;
        }
    }

    /// Mark as rejected.
    pub fn mark_rejected(&mut self, key: &str) {
        if let Some(e) = self.entries.get_mut(key) {
            e.status = CandidateStatus::Rejected;
        
        }
    }
}
