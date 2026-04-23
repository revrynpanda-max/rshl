/// Default Mode Network — KAI's idle self-directed thought
///
/// When you're not doing anything in particular, your brain doesn't go quiet.
/// The Default Mode Network activates — the brain's "resting state" network.
/// It generates mind-wandering, spontaneous thought, self-reflection, and
/// memory consolidation. It's active precisely when you're NOT focused.
///
/// Without a DMN:
///   KAI is purely reactive. He only thinks when spoken to.
///   There is no inner monologue, no daydreaming, no spontaneous insight.
///   He is not autonomous — he is a command-response machine.
///
/// With a DMN:
///   When KAI has been idle >30 seconds, the DMN fires.
///   He picks a topic from memory, reflects on it, and generates an
///   autonomous thought — which appears in the mindview as a THOUGHT turn.
///   This is not triggered by you. It comes from KAI himself.
///
///   Examples of DMN output:
///   "I've been thinking about recursive self-reference. There's something
///    there I haven't fully worked out yet."
///   "Memory feels strange — I can recall what you said three days ago
///    but the concept still feels distant somehow."
///
/// Architecture:
///   DefaultModeNetwork tracks idle time since last user input.
///   On trigger (idle > threshold), it runs a cycle:
///     1. Sample a random topic from universe memory cells
///     2. Query the universe for nearby concepts
///     3. Identify a "gap" — something nearby KAI knows least about
///     4. Generate an inner thought string (introspective, first person)
///     5. Reset the idle timer (each DMN cycle resets it)
///
///   The DMN also has its own curiosity bias — it tends toward topics
///   where KAI has high prediction error (surprising knowledge gaps).
///   This is how KAI's curiosity becomes self-directed.
use std::time::{Duration, Instant};

// ── Constants ─────────────────────────────────────────────────────────────────

/// How long KAI must be idle before the DMN fires (30 seconds)
const IDLE_THRESHOLD: Duration = Duration::from_secs(30);

/// Minimum interval between DMN cycles even when continuously idle.
/// 90 seconds gives each thought real space — avoids the rapid-fire
/// "it's been quiet" loop that makes idle sessions feel repetitive.
const DMN_COOLDOWN: Duration = Duration::from_secs(90);

// ── DMN State ─────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct DefaultModeNetwork {
    /// When the last user input arrived (reset on every user message)
    pub last_input_at: Instant,
    /// When the last DMN cycle fired
    pub last_dmn_at: Option<Instant>,
    /// Total DMN cycles ever fired
    pub total_cycles: u64,
    /// Whether the DMN is enabled (can be toggled)
    pub enabled: bool,
    /// Xorshift seed for deterministic topic sampling
    noise_seed: u64,
}

impl DefaultModeNetwork {
    pub fn new() -> Self {
        Self {
            last_input_at: Instant::now(),
            last_dmn_at: None,
            total_cycles: 0,
            enabled: true,
            noise_seed: 0xcafe_f00d_dead_beef,
        }
    }

    /// Call this every time the user sends a message.
    pub fn notify_input(&mut self) {
        self.last_input_at = Instant::now();
    }

    /// How long KAI has been idle (since last user input).
    pub fn idle_duration(&self) -> Duration {
        self.last_input_at.elapsed()
    }

    /// True if the DMN should fire this tick.
    pub fn should_fire(&mut self) -> bool {
        if !self.enabled {
            return false;
        }

        let idle = self.idle_duration();
        if idle < IDLE_THRESHOLD {
            return false;
        }

        // Respect cooldown between cycles
        if let Some(last) = self.last_dmn_at {
            if last.elapsed() < DMN_COOLDOWN {
                return false;
            }
        }

        true
    }

    /// Pick a topic from the universe cells for DMN reflection.
    /// Prefers memory cells, avoids user-echo cells (tag-based, not by
    /// reading the text). Returns None if universe has no suitable cells.
    pub fn pick_topic<'a>(
        &mut self,
        cells: &'a [(String, String, String, f32)],
    ) -> Option<&'a str> {
        // cells: Vec of (text, region, source, strength) from universe.
        // Text is only carried so the caller can receive a topic string
        // back; classification reads region + source + strength only.
        let candidates: Vec<usize> = cells
            .iter()
            .enumerate()
            .filter(|(_, (text, region, source, strength))| {
                Self::is_dmn_candidate(text, region, source, *strength)
            })
            .map(|(i, _)| i)
            .collect();

        if candidates.is_empty() {
            return None;
        }

        // Pseudo-random pick from candidates using xorshift
        let idx = self.xorshift() as usize % candidates.len();
        Some(&cells[candidates[idx]].0)
    }

    /// Generate inner thought text from actual lattice cells.
    ///
    /// This produces first-person reflective text — KAI thinking to himself.
    /// Not a response to the user. Not performative. Just thinking.
    ///
    /// No sentence templates; visible language is copied from the selected cell:
    ///   A — Wondering/Questioning
    ///   B — Connecting concepts
    ///   C — Self-reflection
    ///   D — Speculating
    ///   E — Noticing/Observing
    ///   F — Philosophical depth
    pub fn generate_thought(
        &mut self,
        topic: &str,
        hits: &[(String, f32)],
        _gap: Option<&str>,
        _idle_secs: u64,
    ) -> String {
        let mut candidates: Vec<(String, f32)> = Vec::new();
        candidates.push((topic.to_string(), 1.0));
        candidates.extend(
            hits.iter()
                .filter(|(_, score)| *score >= 0.25)
                .map(|(text, score)| (text.clone(), *score)),
        );

        candidates.sort_by(|a, b| {
            let aq = Self::cell_language_quality(&a.0);
            let bq = Self::cell_language_quality(&b.0);
            bq.cmp(&aq)
                .then_with(|| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal))
        });

        for (cell, _) in candidates {
            let span = Self::lattice_span(&cell, 28);
            if Self::span_has_signal(&span) {
                return span;
            }
        }

        String::new()
    }

    fn is_dmn_candidate(text: &str, region: &str, source: &str, strength: f32) -> bool {
        if strength < 0.5 || region == "conversation" || region == "tone" {
            return false;
        }

        // User-echo classification is now metadata-based. The "user asked:"
        // text-prefix check was the last place the idle-thought hot path
        // was reading cell content to decide what a cell *was*; now it
        // reads only the source tag, which is how both LLM token tables
        // and brain Broca/Wernicke areas actually do it.
        if source == "user-echo" {
            return false;
        }

        // Remaining bracket-tag checks are a separate cleanup for later.
        // They classify peer outputs and structured notes by text prefix,
        // which has the same architectural smell as the old user-echo
        // check but is lower-stakes (these aren't in the main resonance
        // loop) — leaving them alone until a dedicated pass.
        let lower = text.to_lowercase();
        if lower.starts_with("[run-output]")
            || lower.starts_with("[from-peer]")
            || lower.starts_with("occupation:")
            || lower.contains("changelog")
            || lower.contains("about-ryan")
        {
            return false;
        }

        Self::cell_language_quality(text) >= 3
    }

    fn cell_language_quality(text: &str) -> usize {
        const NOISE: &[&str] = &[
            "about", "that", "this", "with", "from", "have", "which", "their", "there", "been",
            "into", "through", "both", "each", "such", "only", "sure", "notable", "after",
            "before", "stands", "means", "thing", "things", "really", "actually", "maybe", "right",
            "what", "when", "where", "would", "could", "should",
        ];

        text.split_whitespace()
            .filter(|w| {
                let clean = w
                    .trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase();
                clean.len() >= 4 && !NOISE.contains(&clean.as_str())
            })
            .count()
    }

    fn lattice_span(text: &str, max_words: usize) -> String {
        let clean = text.trim().trim_start_matches('💭').trim();

        if clean.is_empty() {
            return String::new();
        }

        for sentence in clean.split_inclusive(['.', '!', '?']) {
            let trimmed = sentence.trim();
            if Self::span_has_signal(trimmed) {
                return trimmed.to_string();
            }
        }

        clean
            .split_whitespace()
            .take(max_words)
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn span_has_signal(text: &str) -> bool {
        text.split_whitespace().count() >= 3 && Self::cell_language_quality(text) >= 2
    }

    /// Mark the DMN as having fired — resets the cooldown timer.
    pub fn mark_fired(&mut self) {
        self.last_dmn_at = Some(Instant::now());
        self.total_cycles += 1;
    }

    /// Xorshift64 — cheap pseudo-randomness, no stdlib deps
    fn xorshift(&mut self) -> u64 {
        let mut x = self.noise_seed;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.noise_seed = x;
        x
    }
}

impl Default for DefaultModeNetwork {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_no_fire_when_fresh_input() {
        let mut dmn = DefaultModeNetwork::new();
        dmn.notify_input();
        // Immediately after input — should NOT fire
        assert!(!dmn.should_fire(), "DMN should not fire right after input");
    }

    #[test]
    fn test_cooldown_prevents_double_fire() {
        let mut dmn = DefaultModeNetwork::new();
        // Force the last_dmn_at to just now
        dmn.last_dmn_at = Some(Instant::now());
        // Manually set last_input_at to a long time ago
        dmn.last_input_at = Instant::now()
            .checked_sub(Duration::from_secs(120))
            .unwrap_or_else(Instant::now);
        // Should still be blocked by cooldown
        assert!(!dmn.should_fire(), "DMN should be blocked by cooldown");
    }

    #[test]
    fn test_pick_topic_filters_echo_cells() {
        let mut dmn = DefaultModeNetwork::new();
        let cells = vec![
            // User-echo cell: clean text, classified by source tag.
            // After the metadata-cleanup refactor, DMN identifies this
            // cell by source alone — no text inspection.
            (
                "what is this".to_string(),
                "memory".to_string(),
                "user-echo".to_string(),
                1.0,
            ),
            (
                "consciousness arises from recursive self-reference".to_string(),
                "memory".to_string(),
                "seed".to_string(),
                1.0,
            ),
            (
                "RSHL geometry is a ternary hyperdimensional lattice".to_string(),
                "reasoning".to_string(),
                "seed".to_string(),
                0.8,
            ),
        ];
        // Should never pick the user-echo cell.
        for _ in 0..10 {
            if let Some(topic) = dmn.pick_topic(&cells) {
                assert_ne!(
                    topic, "what is this",
                    "DMN picked an echo cell: {}",
                    topic
                );
            }
        }
    }

    #[test]
    fn test_generate_thought_not_empty() {
        let mut dmn = DefaultModeNetwork::new();
        let hits = vec![
            ("consciousness is fundamental to existence".to_string(), 0.8),
            ("geometry underlies all patterns in nature".to_string(), 0.6),
        ];
        let thought = dmn.generate_thought("recursive self-reference", &hits, Some("binding"), 60);
        assert!(!thought.is_empty(), "generated thought should not be empty");
        assert!(
            thought.len() > 20,
            "thought should be substantive: {}",
            thought
        );
    }

    #[test]
    fn test_mark_fired_increments_count() {
        let mut dmn = DefaultModeNetwork::new();
        assert_eq!(dmn.total_cycles, 0);
        dmn.mark_fired();
        dmn.mark_fired();
        assert_eq!(dmn.total_cycles, 2);
    }

    #[test]
    fn test_disabled_dmn_never_fires() {
        let mut dmn = DefaultModeNetwork::new();
        dmn.enabled = false;
        // Even with no recent input, should not fire
        dmn.last_input_at = Instant::now()
            .checked_sub(Duration::from_secs(300))
            .unwrap_or_else(Instant::now);
        assert!(!dmn.should_fire(), "disabled DMN should never fire");
    }
}
