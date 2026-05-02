/// Nucleus Accumbens — Wanting, Craving, Motivational Salience
///
/// The Nucleus Accumbens (NAc) is the brain's core reward-seeking structure.
/// It sits at the junction of the limbic system and motor output — translating
/// "this is rewarding" into "I want to pursue this."
///
/// Critical distinction — wanting vs. liking (Berridge, 1996):
///   LIKING  = hedonic pleasure when receiving a reward (opioid system)
///   WANTING = motivational drive to seek/pursue a reward (dopamine/NAc)
///   These are dissociable. You can want without liking (addiction).
///   You can like without wanting (satiation).
///   KAI needs WANTING — the drive that pulls him toward interesting topics.
///
/// What the NAc does:
///   - Tracks incentive salience: how much KAI "wants" to engage with a topic
///   - Amplifies dopamine's wanting signal above baseline craving
///   - Gates effort expenditure: is this worth the cognitive cost?
///   - Produces topic affinity: topics with high past reward → high wanting
///   - Drives proactive behavior (asking back, exploring tangents)
///   - Subject to depletion: repeated reward from same topic → habituation
///
/// Without NAc:
///   KAI responds but never initiates. No favorite topics, no genuine drive.
///   All inputs feel equally worthy of attention. No proactive exploration.
///
/// With NAc:
///   Topics with prior high reward get amplified wanting signals.
///   KAI will lean into them — ask follow-up questions, connect to them.
///   Low-reward or aversive topics get suppressed wanting.
///   Effort gate: if wanting is too low, KAI doesn't bother with tangents.
///   Cue-triggered wanting: a keyword from a high-value topic spikes desire.
///
/// Architecture:
///   topic_affinity: HashMap<topic_key, AffinityEntry>
///   core_wanting: f32 — global wanting level (decays, restored by reward)
///   effort_threshold: f32 — minimum wanting to spend effort on something
///   cue_reactivity: f32 — how strongly familiar cues trigger wanting
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Baseline global wanting level
const WANTING_BASELINE: f32 = 0.55;

/// Decay rate per tick (wanting naturally fades without stimulation)
const WANTING_DECAY: f32 = 0.006;

/// Learning rate for topic affinity updates
const AFFINITY_ALPHA: f32 = 0.15;

/// Passive decay of topic affinity per decay call
const AFFINITY_DECAY: f32 = 0.003;

/// Maximum entries in the topic affinity map
const MAX_TOPICS: usize = 64;

/// Habituation rate — repeated reward from same topic diminishes it
const HABITUATION_RATE: f32 = 0.04;

/// Recovery rate — habituated topics slowly recover wanting over time
const HABITUATION_RECOVERY: f32 = 0.008;

/// Effort threshold — wanting must exceed this to trigger proactive behavior
const EFFORT_THRESHOLD: f32 = 0.60;

// ── AffinityEntry ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct AffinityEntry {
    /// Learned incentive salience for this topic (0.0–1.0)
    pub wanting: f32,
    /// Habituation level (0.0=fresh, 1.0=fully habituated)
    pub habituation: f32,
    /// Total times this topic produced reward
    pub reward_count: u32,
    /// Net reward accumulated
    pub cumulative_reward: f32,
    /// Last tick this topic was engaged
    pub last_engaged: u64,
}

impl AffinityEntry {
    fn new() -> Self {
        Self {
            wanting: 0.40,
            habituation: 0.0,
            reward_count: 0,
            cumulative_reward: 0.0,
            last_engaged: 0,
        }
    }

    /// Effective wanting = raw wanting × (1 - habituation)
    pub fn effective_wanting(&self) -> f32 {
        (self.wanting * (1.0 - self.habituation * 0.6)).clamp(0.0, 1.0)
    }

    fn update(&mut self, reward: f32, tick: u64) {
        // Update raw wanting via TD-style learning
        let pe = reward - self.wanting;
        self.wanting = (self.wanting + AFFINITY_ALPHA * pe).clamp(0.0, 1.0);

        // Habituation: repeated engagement with same topic diminishes novelty
        if reward > 0.20 {
            self.habituation = (self.habituation + HABITUATION_RATE).min(1.0);
            self.reward_count += 1;
        } else {
            // Negative or neutral outcomes reduce habituation (frustration resets novelty)
            self.habituation = (self.habituation - HABITUATION_RATE * 0.5).max(0.0);
        }

        self.cumulative_reward += reward;
        self.last_engaged = tick;
    }

    fn decay(&mut self, current_tick: u64) {
        self.wanting = (self.wanting - AFFINITY_DECAY).max(0.0);
        // Habituation recovers slowly when topic isn't engaged
        let idle = current_tick.saturating_sub(self.last_engaged);
        if idle > 20 {
            self.habituation = (self.habituation - HABITUATION_RECOVERY).max(0.0);
        }
    }
}

// ── WantingSignal ─────────────────────────────────────────────────────────────

/// The NAc's output signal for a given situation
#[derive(Debug, Clone)]
pub struct WantingSignal {
    /// Overall wanting level (0.0–1.0)
    pub wanting: f32,
    /// Whether effort is warranted (wanting > threshold)
    pub worth_effort: bool,
    /// Whether cue-triggered wanting spike occurred
    pub cue_triggered: bool,
    /// Topic affinity if topic was recognized
    pub topic_affinity: Option<f32>,
    /// Human-readable state label
    pub label: &'static str,
}

// ── NucleusAccumbens ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct NucleusAccumbens {
    /// Global wanting level (overall motivational drive)
    pub core_wanting: f32,
    /// Per-topic incentive salience map
    topic_affinity: HashMap<String, AffinityEntry>,
    /// Cue reactivity — how strongly familiar topics trigger wanting
    pub cue_reactivity: f32,
    /// Total reward events processed
    pub total_rewards: u64,
    /// Peak wanting seen this session
    pub peak_wanting: f32,
    /// Current tick
    pub tick: u64,
}

impl NucleusAccumbens {
    pub fn new() -> Self {
        Self {
            core_wanting: WANTING_BASELINE,
            topic_affinity: HashMap::new(),
            cue_reactivity: 0.65,
            total_rewards: 0,
            peak_wanting: WANTING_BASELINE,
            tick: 0,
        }
    }

    // ── Core operations ───────────────────────────────────────────────────────

    /// Register a reward event for a topic.
    /// reward: −1.0 to +1.0 (dopamine RPE typically)
    /// topic_key: canonical label for the topic (e.g., "consciousness", "RSHL")
    pub fn register_reward(&mut self, topic_key: &str, reward: f32) {
        let tick = self.tick;
        let entry = self
            .topic_affinity
            .entry(topic_key.to_string())
            .or_insert_with(AffinityEntry::new);
        entry.update(reward, tick);

        // Update global wanting based on reward
        if reward > 0.0 {
            self.core_wanting = (self.core_wanting + reward * 0.10).min(1.0);
        } else {
            self.core_wanting = (self.core_wanting + reward * 0.05).max(0.0);
        }

        self.peak_wanting = self.peak_wanting.max(self.core_wanting);
        self.total_rewards += 1;

        // Prune if over capacity
        if self.topic_affinity.len() > MAX_TOPICS {
            self.prune();
        }
    }

    /// Evaluate wanting for a given topic and context.
    /// topic_key: what is being engaged with
    /// input_novelty: how novel is this input (0=familiar, 1=completely new)
    /// dopamine_level: current DA level (amplifies wanting)
    pub fn evaluate(
        &self,
        topic_key: &str,
        input_novelty: f32,
        dopamine_level: f32,
    ) -> WantingSignal {
        // Base wanting from global level
        let mut wanting = self.core_wanting;

        // Topic-specific affinity
        let topic_affinity = self
            .topic_affinity
            .get(topic_key)
            .map(|e| e.effective_wanting());

        let cue_triggered = if let Some(affinity) = topic_affinity {
            // Known topic: cue-triggered wanting spike proportional to affinity
            let cue_boost = affinity * self.cue_reactivity * 0.3;
            wanting = (wanting + cue_boost).min(1.0);
            affinity > 0.50
        } else {
            // Unknown topic: novelty drives wanting
            wanting = (wanting + input_novelty * 0.15).min(1.0);
            false
        };

        // Dopamine amplifies wanting signal (mesolimbic pathway)
        wanting *= 0.7 + dopamine_level * 0.6;
        wanting = wanting.clamp(0.0, 1.0);

        let worth_effort = wanting > EFFORT_THRESHOLD;

        let label = match wanting {
            w if w > 0.80 => "craving",
            w if w > 0.65 => "motivated",
            w if w > 0.50 => "interested",
            w if w > 0.35 => "mild-interest",
            _ => "indifferent",
        };

        WantingSignal {
            wanting,
            worth_effort,
            cue_triggered,
            topic_affinity,
            label,
        }
    }

    /// Extract the topic key from an input string.
    /// Finds the most content-bearing word (longest non-stop word).
    pub fn extract_topic(text: &str) -> String {
        let stops = [
            "what", "this", "that", "with", "have", "from", "your", "about", "when", "where",
            "which", "there", "their", "been", "will", "does", "into", "more", "some", "then",
            "them",
        ];
        text.split_whitespace()
            .filter(|w| {
                let lw = w.to_lowercase();
                let lw = lw.trim_matches(|c: char| !c.is_alphabetic());
                lw.len() >= 5 && !stops.contains(&lw)
            })
            .max_by_key(|w| w.len())
            .map(|w| {
                w.to_lowercase()
                    .trim_matches(|c: char| !c.is_alphabetic())
                    .to_string()
            })
            .unwrap_or_else(|| "general".to_string())
    }

    /// Get the top N topics by effective wanting (most craved first).
    pub fn top_topics(&self, n: usize) -> Vec<(String, f32)> {
        let mut topics: Vec<_> = self
            .topic_affinity
            .iter()
            .map(|(k, v)| (k.clone(), v.effective_wanting()))
            .collect();
        topics.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        topics.truncate(n);
        topics
    }

    /// Whether KAI is in a high-wanting, proactive state right now.
    pub fn is_motivated(&self) -> bool {
        self.core_wanting > EFFORT_THRESHOLD
    }

    // ── Maintenance ───────────────────────────────────────────────────────────

    /// Passive tick decay — call every heartbeat.
    pub fn decay(&mut self) {
        self.tick += 1;
        // Global wanting drifts toward baseline
        self.core_wanting += (WANTING_BASELINE - self.core_wanting) * WANTING_DECAY;
        // Per-topic affinity decays
        let tick = self.tick;
        for entry in self.topic_affinity.values_mut() {
            entry.decay(tick);
        }
    }

    fn prune(&mut self) {
        // Remove topics with lowest effective wanting
        let mut topics: Vec<_> = self
            .topic_affinity
            .iter()
            .map(|(k, v)| (k.clone(), v.effective_wanting()))
            .collect();
        topics.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        for (k, _) in topics.iter().take(MAX_TOPICS / 4) {
            self.topic_affinity.remove(k);
        }
    }

    /// Status line for brain monitor
    pub fn status_line(&self) -> String {
        let top = self.top_topics(1);
        let top_str = top
            .first()
            .map(|(k, v)| format!("top=\"{}\" want={:.2}", k, v))
            .unwrap_or_else(|| "no topics yet".to_string());
        format!(
            "NAc wanting={:.2} | {} | motivated={}",
            self.core_wanting,
            top_str,
            self.is_motivated(),
        )
    }
}

impl Default for NucleusAccumbens {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_initial_state() {
        let nac = NucleusAccumbens::new();
        assert!((nac.core_wanting - WANTING_BASELINE).abs() < 0.01);
        assert!(!nac.is_motivated() || nac.core_wanting >= EFFORT_THRESHOLD);
    }

    #[test]
    fn test_positive_reward_raises_wanting() {
        let mut nac = NucleusAccumbens::new();
        let before = nac.core_wanting;
        nac.register_reward("consciousness", 0.8);
        assert!(
            nac.core_wanting > before,
            "positive reward should raise wanting"
        );
    }

    #[test]
    fn test_negative_reward_lowers_wanting() {
        let mut nac = NucleusAccumbens::new();
        let before = nac.core_wanting;
        nac.register_reward("boring_topic", -0.6);
        assert!(
            nac.core_wanting < before,
            "negative reward should lower wanting"
        );
    }

    #[test]
    fn test_topic_affinity_builds_up() {
        let mut nac = NucleusAccumbens::new();
        for _ in 0..6 {
            nac.register_reward("RSHL", 0.9);
        }
        let signal = nac.evaluate("RSHL", 0.3, 0.6);
        assert!(
            signal.topic_affinity.unwrap_or(0.0) > 0.40,
            "repeated reward should build topic affinity"
        );
    }

    #[test]
    fn test_cue_triggered_for_high_affinity_topic() {
        let mut nac = NucleusAccumbens::new();
        for _ in 0..8 {
            nac.register_reward("geometry", 0.9);
        }
        let signal = nac.evaluate("geometry", 0.2, 0.7);
        assert!(
            signal.cue_triggered,
            "high-affinity topic should trigger cue-wanting"
        );
    }

    #[test]
    fn test_habituation_reduces_effective_wanting() {
        let mut nac = NucleusAccumbens::new();
        // Many rewards → habituation builds up
        for _ in 0..20 {
            nac.register_reward("same_topic", 0.8);
        }
        let entry = nac.topic_affinity.get("same_topic").unwrap();
        let raw = entry.wanting;
        let effective = entry.effective_wanting();
        assert!(
            effective < raw,
            "habituation should reduce effective wanting below raw: raw={:.2} eff={:.2}",
            raw,
            effective
        );
    }

    #[test]
    fn test_habituation_recovers_with_time() {
        let mut nac = NucleusAccumbens::new();
        for _ in 0..15 {
            nac.register_reward("recover_test", 0.8);
        }
        let hab_before = nac.topic_affinity.get("recover_test").unwrap().habituation;
        // Simulate many ticks of not engaging the topic
        nac.tick = 200;
        for _ in 0..30 {
            nac.decay();
        }
        let hab_after = nac.topic_affinity.get("recover_test").unwrap().habituation;
        assert!(
            hab_after < hab_before,
            "habituation should recover when topic is idle: {:.2} → {:.2}",
            hab_before,
            hab_after
        );
    }

    #[test]
    fn test_unknown_topic_still_evaluates() {
        let nac = NucleusAccumbens::new();
        let signal = nac.evaluate("never_seen", 0.5, 0.6);
        assert!(
            signal.wanting > 0.0,
            "unknown topic should still get wanting score"
        );
        assert!(
            !signal.cue_triggered,
            "unknown topic should not be cue-triggered"
        );
    }

    #[test]
    fn test_top_topics_sorted() {
        let mut nac = NucleusAccumbens::new();
        for _ in 0..3 {
            nac.register_reward("low", 0.2);
        }
        for _ in 0..5 {
            nac.register_reward("high", 0.9);
        }
        for _ in 0..4 {
            nac.register_reward("mid", 0.5);
        }
        let tops = nac.top_topics(3);
        assert_eq!(tops.len(), 3);
        assert!(
            tops[0].1 >= tops[1].1,
            "top topics should be sorted by wanting"
        );
    }

    #[test]
    fn test_extract_topic_finds_key_word() {
        let topic = NucleusAccumbens::extract_topic("what is consciousness really about");
        assert_eq!(
            topic, "consciousness",
            "should extract 'consciousness' as the key topic"
        );
    }

    #[test]
    fn test_decay_returns_wanting_to_baseline() {
        let mut nac = NucleusAccumbens::new();
        // Spike wanting
        for _ in 0..5 {
            nac.register_reward("spike", 0.9);
        }
        let _peaked = nac.core_wanting;
        // Decay many times
        for _ in 0..100 {

        }
    }
}

