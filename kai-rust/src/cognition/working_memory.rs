/// Working Memory — KAI's short-term context buffer.
///
/// This is the RSHL equivalent of an LLM's context window.
/// Stores the last N conversation turns as temporary high-strength
/// vectors that get injected into queries alongside the universe.
///
/// Working memory decays over time — recent turns have high weight,
/// older turns fade. This gives KAI conversational context without
/// polluting the long-term universe.

use crate::core::SparseVec;
use std::time::Instant;

const MAX_TURNS: usize = 12;
const DECAY_TICKS: u64 = 80; // turns fully decay after ~80 ticks

/// A single working memory entry.
#[derive(Clone)]
pub struct MemorySlot {
    pub text: String,
    pub vec: SparseVec,
    pub role: String,  // "user" or "kai"
    pub created_tick: u64,
    pub strength: f32,
}

/// The working memory buffer — short-term conversational context.
pub struct WorkingMemory {
    slots: Vec<MemorySlot>,
}

impl WorkingMemory {
    pub fn new() -> Self {
        Self {
            slots: Vec::with_capacity(MAX_TURNS),
        }
    }

    /// Add a new turn to working memory.
    pub fn push(&mut self, text: &str, role: &str, tick: u64) {
        let vec = SparseVec::encode(text);
        self.slots.push(MemorySlot {
            text: text.to_string(),
            vec,
            role: role.to_string(),
            created_tick: tick,
            strength: 1.0,
        });

        // Evict oldest if over capacity
        if self.slots.len() > MAX_TURNS {
            self.slots.remove(0);
        }
    }

    /// Decay working memory based on current tick.
    /// Returns number of entries that fully decayed (removed).
    pub fn decay(&mut self, current_tick: u64) -> usize {
        let before = self.slots.len();
        self.slots.retain(|slot| {
            let age = current_tick.saturating_sub(slot.created_tick);
            age < DECAY_TICKS
        });

        // Update strengths based on age
        for slot in &mut self.slots {
            let age = current_tick.saturating_sub(slot.created_tick);
            let decay_factor = 1.0 - (age as f32 / DECAY_TICKS as f32);
            slot.strength = decay_factor.max(0.1);
        }

        before - self.slots.len()
    }

    /// Get all active memory slots for query injection.
    /// Returns references to slot vectors with their current strength.
    pub fn active_slots(&self) -> Vec<(&SparseVec, f32)> {
        self.slots
            .iter()
            .map(|s| (&s.vec, s.strength))
            .collect()
    }

    /// Get recent context as text (for compose output).
    pub fn recent_context(&self, n: usize) -> Vec<(String, String)> {
        self.slots
            .iter()
            .rev()
            .take(n)
            .map(|s| (s.role.clone(), s.text.clone()))
            .collect()
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }
}

impl Default for WorkingMemory {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_and_len() {
        let mut wm = WorkingMemory::new();
        wm.push("hello world", "user", 1);
        wm.push("hi there", "kai", 2);
        assert_eq!(wm.len(), 2);
    }

    #[test]
    fn test_capacity_eviction() {
        let mut wm = WorkingMemory::new();
        for i in 0..20 {
            wm.push(&format!("turn {}", i), "user", i as u64);
        }
        assert_eq!(wm.len(), MAX_TURNS);
    }

    #[test]
    fn test_decay() {
        let mut wm = WorkingMemory::new();
        wm.push("old turn", "user", 0);
        wm.push("new turn", "user", 90);
        let removed = wm.decay(100);
        assert_eq!(removed, 1); // old turn decayed
        assert_eq!(wm.len(), 1); // new turn remains
    }
}
