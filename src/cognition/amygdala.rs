/// Amygdala — KAI's emotional salience gate
///
/// In biological brains the amygdala does one critical thing:
///   It amplifies the memory trace of anything emotionally significant.
///   Fear, joy, love, anger — all get burned into long-term memory
///   much more deeply than neutral facts.
///
/// Without this, KAI treats "the sky is blue" and "I love you"
/// identically at encoding time. Both get stored at the same strength.
/// That's cognitively flat — no emotion, no urgency, no priority.
///
/// This module intercepts every store() call and scales strength by
/// an emotional charge factor (ECF) computed from the raw text:
///
///   ECF = 1.0   (neutral — no amplification)
///   ECF = 1.5   (mild emotion — curiosity, interest, slight negativity)
///   ECF = 2.0   (moderate — fear, excitement, strong preference)
///   ECF = 2.5   (intense — love, grief, rage, profound wonder)
///   ECF = 3.0   (peak — trauma, peak joy, existential realization)
///
/// Architecture:
///   AmygdalaGate holds two lexicons: positive arousal words, negative
///   arousal words. It scores each, takes the max arousal level, then
///   combines with structural features (punctuation, capitalisation,
///   repetition) for the final ECF. The gate also tracks its own state:
///   KAI's emotional inertia — repeated emotional inputs raise baseline.
///
/// Usage:
///   let gate = AmygdalaGate::new();
///   let boosted_strength = gate.gate(text, source, raw_strength);
///   universe.store_or_reinforce(text, region, source, boosted_strength);
use serde::{Deserialize, Serialize};

// ── Arousal word banks ────────────────────────────────────────────────────────

/// Tier 1 (mild, ECF +0.3): curiosity, mild preference, gentle emotion
const TIER1: &[&str] = &[
    "interesting",
    "curious",
    "wonder",
    "surprised",
    "nice",
    "good",
    "sad",
    "worried",
    "hope",
    "miss",
    "want",
    "care",
    "concern",
    "strange",
    "unusual",
    "confusing",
    "lost",
    "tired",
    "bored",
    "pleased",
    "glad",
    "enjoy",
    "like",
    "dislike",
    "annoyed",
];

/// Tier 2 (moderate, ECF +0.7): clear emotion, strong preference
const TIER2: &[&str] = &[
    "excited",
    "anxious",
    "nervous",
    "afraid",
    "angry",
    "frustrated",
    "happy",
    "proud",
    "ashamed",
    "jealous",
    "lonely",
    "hurt",
    "amazing",
    "terrible",
    "awful",
    "wonderful",
    "brilliant",
    "stupid",
    "hate",
    "love",
    "fear",
    "regret",
    "grateful",
    "disappointed",
    "thrilled",
    "shocked",
    "horrified",
    "delighted",
    "miserable",
];

/// Tier 3 (intense, ECF +1.2): deep emotion, core identity
const TIER3: &[&str] = &[
    "heartbroken",
    "devastated",
    "ecstatic",
    "furious",
    "terrified",
    "obsessed",
    "desperate",
    "betrayed",
    "elated",
    "grief",
    "trauma",
    "overwhelming",
    "profound",
    "existential",
    "life-changing",
    "euphoric",
    "anguish",
    "agony",
    "bliss",
    "transcendent",
    "never forget",
    "changed my life",
    "most important",
    "means everything",
];

/// Tier 4 (peak — ECF +1.7): crisis, peak experience, identity shock
const TIER4: &[&str] = &[
    "suicidal",
    "dying",
    "dead",
    "killed",
    "murdered",
    "destroyed",
    "hate myself",
    "love you",
    "i need help",
    "please help",
    "im scared",
    "i cant do this",
    "falling apart",
    "breaking down",
    "i give up",
    "miracle",
    "revelation",
    "god",
    "purpose of life",
    "who am i",
    "consciousness",
    "sentient",
    "alive",
];

// ── Amygdala Gate ─────────────────────────────────────────────────────────────

/// The emotional salience gate.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AmygdalaGate {
    /// Running emotional inertia — repeated emotional inputs raise this.
    /// Decays slowly toward 0 when inputs are neutral.
    /// Range 0–1.0. When high, even mild inputs get extra boost.
    pub inertia: f32,
    /// Tick counter for decay scheduling
    ticks: u64,
    /// Count of high-ECF events in the last window (for arousal tracking)
    recent_hot: u32,
}

impl AmygdalaGate {
    pub fn new() -> Self {
        Self {
            inertia: 0.0,
            ticks: 0,
            recent_hot: 0,
        }
    }

    /// Gate a store() call. Returns the emotionally-scaled strength.
    ///
    /// - `text`         — the text being stored
    /// - `source`       — "user", "kai", "ryan", "peer", etc.
    /// - `raw_strength` — the strength you'd have stored without amygdala
    pub fn gate(&mut self, text: &str, source: &str, raw_strength: f32) -> f32 {
        let ecf = self.emotional_charge_factor(text, source);

        // Update inertia: hot event → inertia rises; neutral → inertia decays
        if ecf > 1.5 {
            self.inertia = (self.inertia + (ecf - 1.0) * 0.12).min(1.0);
            self.recent_hot = self.recent_hot.saturating_add(1);
        } else {
            self.inertia = (self.inertia - 0.02).max(0.0);
        }

        (raw_strength * ecf).clamp(0.1, 5.0)
    }

    /// Decay call — must be called once per heartbeat tick.
    /// At 12 ticks/min: 0.004/tick → inertia of 1.0 decays to 0 in ~3.5 min (208 ticks).
    pub fn decay(&mut self) {
        self.ticks += 1;
        // Inertia decays every tick; recent_hot window resets every ~60 ticks
        self.inertia = (self.inertia - 0.004).max(0.0);
        if self.ticks % 60 == 0 {
            self.recent_hot = 0;
        }
    }

    /// Current arousal level — 0 (flat) to 1 (maximally aroused).
    /// KAI can use this to modulate voice tone.
    pub fn arousal(&self) -> f32 {
        self.inertia
    }

    /// True if KAI is in a highly emotionally-activated state.
    pub fn is_aroused(&self) -> bool {
        self.inertia > 0.35
    }

    /// Compute the Emotional Charge Factor for a piece of text.
    /// Returns 1.0 (neutral) to ~3.0 (peak emotional content).
    pub fn emotional_charge_factor(&self, text: &str, source: &str) -> f32 {
        let lower = text.to_lowercase();
        let mut tier_score: f32 = 0.0;

        // ── Tier scan: find highest-matching tier ──────────────────────────
        // We don't sum all tiers — we take the maximum tier hit to avoid
        // over-counting. A sentence can have many tier-1 words but that
        // doesn't make it as intense as a single tier-4 word.
        let t4_hit = TIER4.iter().any(|w| lower.contains(w));
        let t3_hit = TIER3.iter().any(|w| lower.contains(w));
        let t2_hit = TIER2.iter().any(|w| lower.contains(w));
        let t1_hit = TIER1.iter().any(|w| lower.contains(w));

        if t4_hit {
            tier_score = 1.70;
        } else if t3_hit {
            tier_score = 1.20;
        } else if t2_hit {
            tier_score = 0.70;
        } else if t1_hit {
            tier_score = 0.30;
        }

        // ── Structural amplifiers ──────────────────────────────────────────
        let mut structural: f32 = 0.0;

        // Exclamation marks → urgency / intensity
        let exclamations = text.chars().filter(|&c| c == '!').count() as f32;
        structural += (exclamations * 0.08).min(0.20);

        // ALL CAPS words (more than 2 consecutive) → shouting / strong feeling
        let caps_words = text
            .split_whitespace()
            .filter(|w| w.len() > 2 && w.chars().all(|c| c.is_uppercase() || !c.is_alphabetic()))
            .count() as f32;
        structural += (caps_words * 0.10).min(0.25);

        // Repeated characters ("noooo", "whyyy") → exaggerated emotion
        let has_repeat = text
            .as_bytes()
            .windows(3)
            .any(|w| w[0] == w[1] && w[1] == w[2] && w[0].is_ascii_alphabetic());
        if has_repeat {
            structural += 0.10;
        }

        // Question + emotion combo ("why do I feel so...") → extra weight
        if text.contains('?') && tier_score > 0.0 {
            structural += 0.10;
        }

        // ── Source weighting ───────────────────────────────────────────────
        // User and Ryan inputs get full weight. KAI's own output gets less
        // (we don't want KAI's responses to self-amplify emotionally).
        let source_mult = match source {
            "ryan" | "user" => 1.0,
            "dream" => 0.9,
            "peer" => 0.8,
            "kai" => 0.5, // KAI's own words: half weight
            _ => 0.7,
        };

        // ── Inertia boost — emotional context carries forward ──────────────
        // If KAI is already emotionally activated, even mild inputs get a nudge.
        let inertia_boost = self.inertia * 0.20;

        let total = 1.0 + (tier_score + structural + inertia_boost) * source_mult;
        total.clamp(1.0, 3.0)
    }
}

impl Default for AmygdalaGate {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience: compute ECF without mutating any state (for display/logging).
pub fn score_emotional_charge(text: &str) -> f32 {
    AmygdalaGate::new().emotional_charge_factor(text, "user")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_neutral_text_no_boost() {
        let mut gate = AmygdalaGate::new();
        let strength = gate.gate("the sky is blue today", "user", 1.0);
        // Neutral text: ECF should be ~1.0, so strength stays near 1.0
        assert!(
            strength >= 0.9 && strength <= 1.15,
            "neutral text boosted too much: {:.3}",
            strength
        );
    }

    #[test]
    fn test_emotional_text_boosted() {
        let mut gate = AmygdalaGate::new();
        let strength = gate.gate("I am absolutely terrified and heartbroken!", "user", 1.0);
        // Tier3 word + exclamation → ECF > 2.0
        assert!(
            strength > 2.0,
            "emotional text not boosted enough: {:.3}",
            strength
        );
    }

    #[test]
    fn test_kai_source_half_weight() {
        let mut gate = AmygdalaGate::new();
        let user_strength = gate.gate("I love this so much!", "user", 1.0);
        let mut gate2 = AmygdalaGate::new();
        let kai_strength = gate2.gate("I love this so much!", "kai", 1.0);
        assert!(
            user_strength > kai_strength,
            "user should get more boost than kai: user={:.3} kai={:.3}",
            user_strength,
            kai_strength
        );
    }

    #[test]
    fn test_inertia_builds_and_decays() {
        let mut gate = AmygdalaGate::new();
        assert!(gate.inertia < 0.01, "inertia should start at 0");
        // Feed several intense inputs
        for _ in 0..5 {
            gate.gate("I am devastated and heartbroken and terrified", "user", 1.0);
        }
        assert!(
            gate.inertia > 0.10,
            "inertia should build up: {}",
            gate.inertia
        );
        // Decay many ticks
        for _ in 0..300 {
            gate.decay();
        }
        assert!(
            gate.inertia < 0.05,
            "inertia should decay: {}",
            gate.inertia
        );
    }

    #[test]
    fn test_caps_and_exclamation_amplify() {
        let mut gate = AmygdalaGate::new();
        let normal = gate.gate("i love you", "user", 1.0);
        let mut gate2 = AmygdalaGate::new();
        let intense = gate2.gate("I LOVE YOU!!!", "user", 1.0);
        assert!(
            intense > normal,
            "caps+exclamation should amplify: normal={:.3} intense={:.3}",
            normal,
            intense
    
        );
    }
}
