use crate::core::claim::Claim;
use crate::core::universe::Universe;

/// Memory Manager — Higher-level interface for the Universe.
pub struct MemoryManager {
    universe: Universe,
}

impl MemoryManager {
    pub fn new(universe: Universe) -> Self {
        Self { universe }
    }

    /// Add a structured claim to memory.
    pub fn add_claim(&mut self, claim: Claim) {
        self.universe.store_claim(claim, "general");
    }

    pub fn universe(&self) -> &Universe {
        &self.universe
    }

    pub fn universe_mut(&mut self) -> &mut Universe {
        &mut self.universe
    }
}

// KAI v6.0.0
