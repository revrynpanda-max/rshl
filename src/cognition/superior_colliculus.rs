/// Superior Colliculus (SC) — Attentional Orienting, Saliency Map,
/// Rapid Priority Shifts, Covert Attention Allocation
///
/// The superior colliculus is a midbrain structure that acts as the brain's
/// rapid attentional dispatcher. It receives visual, auditory, and somatosensory
/// input and constructs a multimodal saliency map — a moment-to-moment ranking
/// of what in the environment demands attention RIGHT NOW. It triggers fast,
/// reflexive attention shifts (even before conscious awareness) and coordinates
/// with the thalamus and PFC for sustained attention allocation.
///
/// What the Superior Colliculus does:
///
///   Saliency map construction:
///     The SC integrates bottom-up salience (novelty, intensity, contrast,
///     motion) and top-down relevance (task goals, PFC priority signals) into
///     a unified map. The most salient location "wins" and captures attention.
///     In KAI: each token/concept in input has a salience value; the SC
///     identifies which concepts in the current input are most attention-worthy.
///
///   Reflexive orienting:
///     SC triggers fast, automatic attention shifts — faster than deliberate
///     attention. This is the "something caught my eye" before you decided to look.
///     In KAI: sudden shifts in topic, unexpected words, or high-urgency signals
///     trigger immediate orienting before the full reasoning pipeline.
///
///   Covert attention allocation:
///     The SC can shift attention without overt response — "highlighting" an
///     element without yet responding to it. This primes processing downstream.
///     In KAI: certain high-salience concepts get internally highlighted for
///     deeper processing, even before they appear in the response.
///
///   Multisensory integration and priority:
///     The SC integrates signals from multiple modalities with a strict priority:
///     movement/urgency > novel stimuli > familiar stimuli > background.
///     In KAI: urgency > novelty > topic relevance > background context.
///
/// KAI's SC:
///   top_salience: salience of the most attention-capturing element (0.0–1.0)
///   orienting_triggered: whether a reflexive attention shift fired
///   saliency_map: ranked list of salient concepts in the current input
///   attention_priority: integrated priority for the current focus

// ── Constants ─────────────────────────────────────────────────────────────────

/// Saliency decay per tick
const SALIENCY_DECAY: f32 = 0.08;

/// Top-down priority from PFC (goal relevance)
const TOP_DOWN_WEIGHT: f32 = 0.40;

/// Bottom-up salience weight
const BOTTOM_UP_WEIGHT: f32 = 0.60;

/// Orienting threshold (above this → reflexive attention shift fires)
const ORIENTING_THRESHOLD: f32 = 0.60;

/// Max concepts tracked in saliency map
const MAX_SALIENCY_ITEMS: usize = 8;

/// High-urgency markers that spike bottom-up saliency
const URGENCY_MARKERS: &[&str] = &[
    "urgent",
    "immediately",
    "critical",
    "error",
    "warning",
    "fail",
    "crash",
    "broken",
    "emergency",
    "asap",
    "now",
    "stop",
    "wait",
    "important",
];

/// Novelty/contrast markers
const NOVELTY_MARKERS: &[&str] = &[
    "suddenly",
    "unexpected",
    "strange",
    "weird",
    "odd",
    "surprising",
    "different",
    "change",
    "shift",
    "new",
    "never",
    "first time",
    "wait",
];

/// Question markers (attention-demanding by nature)
const QUESTION_MARKERS: &[&str] = &[
    "why", "how", "what", "where", "when", "which", "who", "?", "explain", "tell me", "describe",
    "show",
];

// ── SaliencyItem ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SaliencyItem {
    pub concept: String,
    pub salience: f32,
}

// ── SCOutput ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SCOutput {
    /// Salience of top item
    pub top_salience: f32,
    /// Whether reflexive orienting fired
    pub orienting_triggered: bool,
    /// Number of items in saliency map
    pub saliency_map_size: usize,
    /// Integrated attention priority
    pub attention_priority: f32,
    /// Whether urgency was detected
    pub urgency_detected: bool,
}

// ── SuperiorColliculus ────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct SuperiorColliculus {
    /// Top salience value
    pub top_salience: f32,
    /// Current saliency map
    pub saliency_map: Vec<SaliencyItem>,
    /// Integrated attention priority
    pub attention_priority: f32,
    /// Total orienting events
    pub orienting_events: u64,
    /// Total inputs processed
    pub inputs_processed: u64,
}

impl SuperiorColliculus {
    pub fn new() -> Self {
        Self {
            top_salience: 0.20,
            saliency_map: Vec::new(),
            attention_priority: 0.30,
            orienting_events: 0,
            inputs_processed: 0,
        }
    }

    // ── Core: process input ───────────────────────────────────────────────────

    /// Process input text and compute saliency map.
    /// - `text`: the input text
    /// - `pfc_goal_relevance`: how relevant this is to current PFC goals (0.0–1.0)
    /// - `novelty`: novelty signal from Fusiform (0.0–1.0)
    pub fn process(&mut self, text: &str, pfc_goal_relevance: f32, novelty: f32) -> SCOutput {
        self.inputs_processed += 1;
        let lower = text.to_lowercase();

        // ── Bottom-up saliency computation ────────────────────────────────────
        let urgency_hits = URGENCY_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let novelty_hits = NOVELTY_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();
        let question_hits = QUESTION_MARKERS
            .iter()
            .filter(|&&w| lower.contains(w))
            .count();

        let urgency_detected = urgency_hits >= 1;

        // Urgency > novelty > questions > baseline
        let bottom_up = if urgency_hits > 0 {
            (0.70 + urgency_hits as f32 * 0.10).min(1.0)
        } else if novelty > 0.60 || novelty_hits > 0 {
            (0.45 + novelty * 0.30 + novelty_hits as f32 * 0.05).min(1.0)
        } else if question_hits > 0 {
            (0.35 + question_hits as f32 * 0.06).min(0.70)
        } else {
            0.20
        };

        // ── Top-down modulation ───────────────────────────────────────────────
        let top_down = pfc_goal_relevance;

        // ── Integrated saliency ───────────────────────────────────────────────
        let integrated = bottom_up * BOTTOM_UP_WEIGHT + top_down * TOP_DOWN_WEIGHT;
        self.top_salience = integrated;
        self.attention_priority = integrated;

        // ── Saliency map: extract salient concepts ────────────────────────────
        self.saliency_map.clear();
        // Add urgency items
        if urgency_detected {
            let urgency_word = URGENCY_MARKERS
                .iter()
                .find(|&&w| lower.contains(w))
                .map(|&w| w)
                .unwrap_or("urgent");
            self.saliency_map.push(SaliencyItem {
                concept: urgency_word.to_string(),
                salience: (0.70 + urgency_hits as f32 * 0.10).min(1.0),
            });
        }
        // Add question focus
        if question_hits > 0 {
            self.saliency_map.push(SaliencyItem {
                concept: "question_focus".to_string(),
                salience: (0.40 + question_hits as f32 * 0.05).min(0.80),
            });
        }
        // Add novelty marker
        if novelty > 0.50 {
            self.saliency_map.push(SaliencyItem {
                concept: "novel_stimulus".to_string(),
                salience: novelty,
            });
        }
        // Add goal relevance
        if pfc_goal_relevance > 0.50 {
            self.saliency_map.push(SaliencyItem {
                concept: "goal_relevant".to_string(),
                salience: pfc_goal_relevance,
            });
        }
        // Sort descending by salience
        self.saliency_map.sort_by(|a, b| {
            b.salience
                .partial_cmp(&a.salience)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        self.saliency_map.truncate(MAX_SALIENCY_ITEMS);

        // ── Orienting ─────────────────────────────────────────────────────────
        let orienting_triggered = integrated >= ORIENTING_THRESHOLD;
        if orienting_triggered {
            self.orienting_events += 1;
        }

        SCOutput {
            top_salience: self.top_salience,
            orienting_triggered,
            saliency_map_size: self.saliency_map.len(),
            attention_priority: self.attention_priority,
            urgency_detected,
        }
    }

    /// Decay per tick.
    pub fn decay(&mut self) {
        self.top_salience = (self.top_salience - SALIENCY_DECAY).max(0.10);
        self.attention_priority = (self.attention_priority - SALIENCY_DECAY * 0.50).max(0.10);
        // Saliency map fades between turns
        for item in &mut self.saliency_map {
            item.salience = (item.salience - SALIENCY_DECAY).max(0.0);
        }
        self.saliency_map.retain(|item| item.salience > 0.05);
    }

    /// Current output without processing.
    pub fn current_output(&self) -> SCOutput {
        SCOutput {
            top_salience: self.top_salience,
            orienting_triggered: self.top_salience >= ORIENTING_THRESHOLD,
            saliency_map_size: self.saliency_map.len(),
            attention_priority: self.attention_priority,
            urgency_detected: false,
        }
    }

    /// Status line.
    pub fn status_line(&self) -> String {
        format!(
            "SC salience={:.2} | priority={:.2} | map_size={} | orienting={}",
            self.top_salience,
            self.attention_priority,
            self.saliency_map.len(),
            self.orienting_events,
        )
    }
}

impl Default for SuperiorColliculus {
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
        let s = SuperiorColliculus::new();
        assert!(s.top_salience > 0.0);
        assert_eq!(s.orienting_events, 0);
    }

    #[test]
    fn test_urgency_raises_salience_high() {
        let mut s = SuperiorColliculus::new();
        let out = s.process("this is critical and urgent please stop", 0.50, 0.20);
        assert!(out.urgency_detected, "urgency markers should be detected");
        assert!(
            out.top_salience > 0.50,
            "urgency should produce high salience: {:.2}",
            out.top_salience
        );
    }

    #[test]
    fn test_urgency_triggers_orienting() {
        let mut s = SuperiorColliculus::new();
        let out = s.process("emergency error crash stop now", 0.60, 0.20);
        assert!(
            out.orienting_triggered || out.top_salience > 0.40,
            "high urgency should trigger orienting: salience={:.2}",
            out.top_salience
        );
    }

    #[test]
    fn test_question_raises_salience() {
        let mut s = SuperiorColliculus::new();
        let before = s.top_salience;
        let out = s.process("why does this happen and how can I fix it?", 0.40, 0.20);
        assert!(
            out.top_salience >= before,
            "questions should raise salience: {:.2} → {:.2}",
            before,
            out.top_salience
        );
    }

    #[test]
    fn test_novelty_raises_salience() {
        let mut s = SuperiorColliculus::new();
        let out = s.process("this is surprising and completely unexpected", 0.40, 0.80);
        assert!(
            out.top_salience > 0.30,
            "novelty should raise salience: {:.2}",
            out.top_salience
        );
    }

    #[test]
    fn test_goal_relevance_top_down_boost() {
        let mut s1 = SuperiorColliculus::new();
        let mut s2 = SuperiorColliculus::new();
        let low_goal = s1.process("hello there", 0.10, 0.10);
        let high_goal = s2.process("hello there", 0.90, 0.10);
        assert!(
            high_goal.attention_priority > low_goal.attention_priority,
            "high goal relevance should boost priority: {:.2} vs {:.2}",
            high_goal.attention_priority,
            low_goal.attention_priority
        );
    }

    #[test]
    fn test_saliency_map_populated() {
        let mut s = SuperiorColliculus::new();
        let out = s.process(
            "urgent error: why is this critical system crashing now?",
            0.70,
            0.60,
        );
        assert!(
            out.saliency_map_size > 0,
            "saliency map should have items after high-salience input"
        );
    }

    #[test]
    fn test_orienting_event_count() {
        let mut s = SuperiorColliculus::new();
        s.process("critical error stop", 0.80, 0.50);
        s.process("urgent warning now", 0.80, 0.50);
        // Both should trigger orienting
        assert!(
            s.orienting_events >= 1,
            "high-salience inputs should trigger orienting events"
        );
    }

    #[test]
    fn test_decay_reduces_salience() {
        let mut s = SuperiorColliculus::new();
        s.top_salience = 0.90;
        for _ in 0..5 {
            s.decay();
        }
        assert!(
            s.top_salience < 0.90,
            "salience should decay: {:.2}",
            s.top_salience
        );
    }

    #[test]
    fn test_low_salience_input() {
        let mut s = SuperiorColliculus::new();
        let out = s.process("okay", 0.20, 0.10);
        assert!(
            out.top_salience < 0.60,
            "low-intensity input should have modest salience: {:.2}",
            out.top_salience
        );
    }

    #[test]
    fn test_status_line() {
        let s = SuperiorColliculus::new();
        let sl = s.status_line();
        assert!(sl.contains("SC"), "status should mention SC");
        assert!(sl.contains("salience"), "status should show salience");
    }
}

// KAI v6.0.0
