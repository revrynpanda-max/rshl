pub mod heartbeat;

use super::core::{FieldState, SparseVec};
use serde::{Deserialize, Serialize};

/// Drive state — KAI's internal motivation system.
///
/// Ported from drive.js. Three systems:
///   1. EVOLVING GOAL VECTOR — composite of promoted beliefs with recency decay
///   2. VALENCE — pleasure/pain signal from field metrics
///   3. ADAPTIVE HEARTBEAT — tempo modulated by engagement level
///
/// Valence formula (from JS):
///   V_raw = (Φg × curiosityOrFamiliarity) - (χ_sustained × contradictionPain) + momentumBonus
///   where curiosityOrFamiliarity = novelty > 0.45 ? 1.6 : 1.0
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Drive {
    pub valence: f32,
    pub avg_phi_g: f32,
    pub avg_chi: f32,
    pub mood: Mood,
    pub goal_vector: Option<SparseVec>,
    pub goal_components: usize,
    pub valence_history: Vec<f32>,
    pub phi_g_history: Vec<f32>,
    pub chi_history: Vec<f32>,
    ticks_since_goal_update: u32,
}

// ── Configuration (matches JS drive.js CONFIG) ─────────────────────────
const CURIOSITY_BONUS: f32 = 1.6;
const FAMILIARITY_BONUS: f32 = 1.0;
const CONTRADICTION_PAIN: f32 = -1.2;
const VALENCE_SMOOTHING: f32 = 0.7;
const VALENCE_DECAY: f32 = 0.98;
const BASE_INTERVAL_MS: f32 = 5000.0;
const MIN_INTERVAL_MS: f32 = 2000.0;
const MAX_INTERVAL_MS: f32 = 12000.0;
const ENGAGEMENT_SCALE: f32 = 0.4;
const BOREDOM_SCALE: f32 = 0.3;

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
            phi_g_history: Vec::new(),
            chi_history: Vec::new(),
            ticks_since_goal_update: 0,
        }
    }
}

fn mean(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().sum::<f32>() / v.len() as f32
}

impl Drive {
    /// Update drive state from a new field measurement.
    /// Full JS drive.js valence formula.
    pub fn update(&mut self, field: &FieldState) {
        let phi_g = field.phi_g;
        let chi = field.chi;
        let q = field.q; // novelty = 1 - R
        let m = field.m_val; // momentum

        // Track chi over time for sustained-contradiction detection
        self.chi_history.push(chi);
        if self.chi_history.len() > 20 {
            self.chi_history.remove(0);
        }
        let sustained_chi = mean(&self.chi_history);

        // Track phi_g for boredom detection
        self.phi_g_history.push(phi_g);
        if self.phi_g_history.len() > 30 {
            self.phi_g_history.remove(0);
        }

        // EMA smoothing for averages
        let alpha = 0.3;
        self.avg_phi_g = self.avg_phi_g * (1.0 - alpha) + phi_g * alpha;
        self.avg_chi = self.avg_chi * (1.0 - alpha) + chi * alpha;

        // ── Valence computation (JS formula) ───────────────────────────
        // Curiosity vs familiarity reward
        let is_novel = q > 0.45;
        let reward_multiplier = if is_novel {
            CURIOSITY_BONUS
        } else {
            FAMILIARITY_BONUS
        };

        // Positive component: how good does this thought feel
        let positive = phi_g * reward_multiplier;

        // Momentum bonus: positive change feels good
        let momentum_bonus = if m > 0.0 { m * 0.5 } else { m * 0.3 };

        // Negative component: sustained contradiction is painful
        let negative = if sustained_chi > 0.25 {
            sustained_chi * CONTRADICTION_PAIN
        } else {
            0.0
        };

        // Raw valence for this tick
        let raw_valence = (positive + momentum_bonus + negative).clamp(-1.0, 1.0);

        // Smooth with EMA so valence changes gradually (mood, not reflex)
        self.valence = self.valence * VALENCE_SMOOTHING + raw_valence * (1.0 - VALENCE_SMOOTHING);

        // Slow decay toward neutral
        self.valence *= VALENCE_DECAY;
        self.valence = self.valence.clamp(-1.0, 1.0);

        // Record history
        self.valence_history.push(self.valence);
        if self.valence_history.len() > 50 {
            self.valence_history.remove(0);
        }

        // ── Mood classification (matches JS getMood) ───────────────────
        self.mood = if self.valence > 0.15 && self.avg_phi_g > 0.025 {
            Mood::Curious
        } else if self.valence > 0.08 {
            Mood::Engaged
        } else if self.valence < -0.15 && mean(&self.chi_history) > 0.3 {
            Mood::Conflicted
        } else if self.valence < -0.08 {
            Mood::Uneasy
        } else if self.avg_phi_g < 0.01 {
            Mood::Dormant
        } else {
            Mood::Neutral
        };

        self.ticks_since_goal_update += 1;
    }

    /// Valence-modulated memory reinforcement weight.
    /// Positive valence → stronger reinforcement. Negative → weaker.
    pub fn modulate_wm(&self, base_wm: f32) -> f32 {
        let multiplier = 1.0 + self.valence * 0.8; // [-1,+1] → [0.2, 1.8]
        (base_wm * multiplier).clamp(0.0, 1.0)
    }

    /// Valence-modulated replay priority.
    /// Negative valence → higher replay priority (drive to resolve confusion).
    pub fn modulate_pr(&self, base_pr: f32) -> f32 {
        let adjustment = if self.valence < 0.0 {
            self.valence.abs() * 0.3
        } else {
            -self.valence * 0.1
        };
        (base_pr + adjustment).clamp(0.0, 1.0)
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
    /// Matches JS computeAdaptiveInterval.
    pub fn adaptive_interval_ms(&self) -> u64 {
        let avg_phi_g = if !self.phi_g_history.is_empty() {
            mean(&self.phi_g_history)
        } else {
            0.03
        };

        // Engagement: how much above average is current Φg?
        let engagement = (self.avg_phi_g - avg_phi_g) / avg_phi_g.max(0.01);

        // Excitement: positive momentum amplifies
        let excitement = engagement; // simplified — momentum is already in valence

        // Confusion: sustained contradiction slows things down
        let confusion = if mean(&self.chi_history) > 0.3 {
            0.2
        } else {
            0.0
        };

        let mut modifier = -excitement * ENGAGEMENT_SCALE + confusion;

        // Boredom: very low Φg → stretch interval
        if avg_phi_g < 0.015 {
            modifier += BOREDOM_SCALE;
        }

        let interval = BASE_INTERVAL_MS * (1.0 + modifier);
        interval.clamp(MIN_INTERVAL_MS, MAX_INTERVAL_MS) as u64
    }
}
