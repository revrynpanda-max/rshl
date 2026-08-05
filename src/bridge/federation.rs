use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use crate::core::Universe;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FederationNode {
    pub id: String,
    pub address: String,
    pub last_seen: u64,
    pub trust_score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedKnowledge {
    pub topic: String,
    pub content: String,
    pub signature: String,
    pub timestamp: u64,
}

pub struct FederationState {
    pub local_id: String,
    pub peers: HashMap<String, FederationNode>,
    pub port: u16,
}

impl FederationState {
    pub fn new(local_id: String, port: u16) -> Self {
        Self {
            local_id,
            peers: HashMap::new(),
            port,
        }
    }

    pub fn discover_peer(&mut self, peer: FederationNode) {
        self.peers.insert(peer.id.clone(), peer);
    }

    pub fn active_peers(&self) -> Vec<&FederationNode> {
        self.peers.values().collect()
    }
}

pub fn broadcast_knowledge(knowledge: SharedKnowledge, state: &FederationState) {
    // Stub: Serialize and broadcast to active_peers via UDP/TCP
    println!("[Federation] Broadcasting knowledge about '{}' to {} peers", knowledge.topic, state.peers.len());
}

pub fn receive_knowledge(universe: &mut Universe, knowledge: SharedKnowledge) -> bool {
    // Stub: Validate signature and ingest into local Universe
    println!("[Federation] Received knowledge: {}", knowledge.topic);
    
    // Check if we already have it
    let hits = universe.query(&knowledge.topic, 1);
    if hits.is_empty() || hits[0].score < 0.5 {
        // Ingest into the local universe memory lattice
        universe.ingest_and_verify(
            &knowledge.content,
            "federation",
            &format!("peer-{}", knowledge.signature),
            1.0
        );
        return true;
    }
    
    false
}
