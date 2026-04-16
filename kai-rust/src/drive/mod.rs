pub mod heartbeat;

use super::core::{FieldState, SparseVec};
use serde::{Deserialize, Serialize};

/// Drive state — KAI's internal motivation system.
/// Valence drives mood, mood drives heartbeat tempo.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Drive {
    pub valence: f32,
    pub avg_phi_g: f32,
    pub avg_chi: f32,
    pub mood: Mood,
    pub goal_vector: Option<SparseVec>,
    pub goal_components: usize,
    pub valence_history: Vec<f32>,
    ticks_since_goal_update: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Mood {
    Dormant,
    Neutral,
    Curious,
    Engaged,
    Uneasy,
    Conflicted,
}

impl std::fmt::Display for Mood {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Mood::Dormant => write!(f, "dormant"),
            Mood::Neutral => write!(f, "neutral"),
            Mood::Curious => write!(f, "curious"),
            Mood::Engaged => write!(f, "engaged"),
            Mood::Uneasy => write!(f, "uneasy"),
            Mood::Conflicted => write!(f, "conflicted"),
        }
    }
}

impl Mood {
    pub fn icon(&self) -> &str {
        match self {
            Mood::Dormant => "💤",
            Mood::Neutral => "·",
            Mood::Curious => "🔍",
            Mood::Engaged => "⚡",
            Mood::Uneasy => "😟",
            Mood::Conflicted => "⚔️",
        }
    }
}

impl Default for Drive {
    fn default() -> Self {
        Self {
            valence: 0.0,
            avg_phi_g: 0.0,
            avg_chi: 0.0,
            mood: Mood::Dormant,
            goal_vector: None,
            goal_components: 0,
            valence_history: Vec::new(),
            ticks_since_goal_update: 0,
        }
    }
}

impl Drive {
    /// Update drive state from a new field measurement.
    pub fn update(&mut self, field: &FieldState) {
        // EMA smoothing (α = 0.3)
        let alpha = 0.3;
        self.avg_phi_g = self.avg_phi_g * (1.0 - alpha) + field.phi_g * alpha;
        self.avg_chi = self.avg_chi * (1.0 - alpha) + field.pressure * alpha;

        // Compute raw valence: emergence is positive, contradiction is negative
        let raw_valence = (self.avg_phi_g * 2.0) - (self.avg_chi * 3.0) + (field.coherence * 0.5);
        self.valence = self.valence * 0.7 + raw_valence * 0.3;
        self.valence = self.valence.clamp(-1.0, 1.0);

        // Record history
        self.valence_history.push(self.valence);
        if self.valence_history.len() > 100 {
            self.valence_history.remove(0);
        }

        // Classify mood
        self.mood = if self.avg_phi_g < 0.01 && self.avg_chi < 0.01 {
            Mood::Dormant
        } else if self.valence > 0.15 && self.avg_phi_g > 0.03 {
            Mood::Engaged
        } else if self.valence > 0.05 {
            Mood::Curious
        } else if self.valence < -0.15 {
            Mood::Conflicted
        } else if self.valence < -0.05 {
            Mood::Uneasy
        } else {
            Mood::Neutral
        };

        self.ticks_since_goal_update += 1;
    }

    /// Feed a promoted belief into the evolving goal vector.
    pub fn feed_goal(&mut self, vec: &SparseVec) {
        self.goal_vector = Some(match &self.goal_vector {
            Some(existing) => SparseVec::bundle(&[existing, vec]),
            None => vec.clone(),
        });
        self.goal_components += 1;
        self.ticks_since_goal_update = 0;
    }

    /// Compute adaptive heartbeat interval in milliseconds.
    /// Fast when engaged/curious, slow when dormant.
    pub fn adaptive_interval_ms(&self) -> u64 {
        let base = 5000.0f32;
        let modifier = match self.mood {
            Mood::Engaged => -2500.0,
            Mood::Curious => -1500.0,
            Mood::Conflicted => -1000.0,
            Mood::Uneasy => -500.0,
            Mood::Neutral => 0.0,
            Mood::Dormant => 3000.0,
        };
        let valence_mod = self.valence.abs() * -1000.0;
        let ms = (base + modifier + valence_mod).clamp(2000.0, 12000.0);
        ms as u64
    }
}
