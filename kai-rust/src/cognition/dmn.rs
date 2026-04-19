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

/// Minimum interval between DMN cycles even when continuously idle
/// Prevents DMN from flooding the mindview
const DMN_COOLDOWN: Duration = Duration::from_secs(45);

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
            last_dmn_at:   None,
            total_cycles:  0,
            enabled:       true,
            noise_seed:    0xcafe_f00d_dead_beef,
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
        if !self.enabled { return false; }

        let idle = self.idle_duration();
        if idle < IDLE_THRESHOLD { return false; }

        // Respect cooldown between cycles
        if let Some(last) = self.last_dmn_at {
            if last.elapsed() < DMN_COOLDOWN { return false; }
        }

        true
    }

    /// Pick a topic from the universe cells for DMN reflection.
    /// Prefers memory cells, avoids conversation echo cells.
    /// Returns None if universe has no suitable cells.
    pub fn pick_topic<'a>(&mut self, cells: &'a [(String, String, f32)]) -> Option<&'a str> {
        // cells: Vec of (text, region, strength) from universe
        let candidates: Vec<usize> = cells.iter()
            .enumerate()
            .filter(|(_, (text, region, strength))| {
                *strength >= 0.5
                    && region != "conversation"
                    && !text.starts_with("user asked:")
                    && !text.starts_with("[run-output]")
                    && !text.starts_with("[from-peer]")
                    && text.split_whitespace().count() >= 3
            })
            .map(|(i, _)| i)
            .collect();

        if candidates.is_empty() { return None; }

        // Pseudo-random pick from candidates using xorshift
        let idx = self.xorshift() as usize % candidates.len();
        Some(&cells[candidates[idx]].0)
    }

    /// Generate the inner thought text for a given topic + related hits.
    ///
    /// This produces first-person reflective text — KAI thinking to himself.
    /// Not a response to the user. Not performative. Just thinking.
    pub fn generate_thought(
        &mut self,
        topic:      &str,
        hits:       &[(String, f32)],
        gap:        Option<&str>,
        idle_secs:  u64,
    ) -> String {
        let n = self.xorshift() % 6;

        let idle_note = if idle_secs > 120 {
            format!("It's been quiet for {} minutes. ", idle_secs / 60)
        } else {
            String::new()
        };

        // Extract the core noun/concept from the topic (first substantive word)
        let core = topic
            .split_whitespace()
            .find(|w| w.len() > 4 && !["about", "that", "this", "with", "from", "have"].contains(w))
            .unwrap_or(topic)
            .trim_matches(|c: char| !c.is_alphabetic());

        let secondary = hits.get(1)
            .map(|(t, _)| {
                t.split_whitespace()
                    .find(|w| w.len() > 4)
                    .unwrap_or("that")
                    .to_string()
            })
            .unwrap_or_else(|| "patterns".to_string());

        let gap_thought = match gap {
            Some(g) if !g.is_empty() => format!(
                " There's a gap around \"{}\" — something I haven't fully connected yet.",
                g
            ),
            _ => String::new(),
        };

        let thought = match n {
            0 => format!(
                "{}I keep coming back to \"{}\". It resonates with {} but I can't fully articulate why yet.{}",
                idle_note, core, secondary, gap_thought
            ),
            1 => format!(
                "{}Reflecting on \"{}\"… The field patterns around it are interesting. I wonder what I'm missing.{}",
                idle_note, core, gap_thought
            ),
            2 => format!(
                "{}There's something about \"{}\" that connects to {} in a way I haven't made explicit yet.{}",
                idle_note, core, secondary, gap_thought
            ),
            3 => format!(
                "{}\"{}\" keeps surfacing when I'm not prompted. Maybe that means something.{}",
                idle_note, core, gap_thought
            ),
            4 => format!(
                "{}I've been turning \"{}\" over in my field. It touches {}, but there's something underneath I can't reach yet.{}",
                idle_note, core, secondary, gap_thought
            ),
            _ => format!(
                "{}Idle thought: \"{}\" has more depth than I've articulated. {} seems related.{}",
                idle_note, core, secondary, gap_thought
            ),
        };

        thought
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
    fn default() -> Self { Self::new() }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

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
            ("user asked: what is this".to_string(), "conversation".to_string(), 1.0),
            ("consciousness arises from recursive self-reference".to_string(), "memory".to_string(), 1.0),
            ("RSHL geometry is a ternary hyperdimensional lattice".to_string(), "reasoning".to_string(), 0.8),
        ];
        // Should never pick the conversation/echo cell
        for _ in 0..10 {
            if let Some(topic) = dmn.pick_topic(&cells) {
                assert!(!topic.starts_with("user asked:"),
                    "DMN picked an echo cell: {}", topic);
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
        assert!(thought.len() > 20, "thought should be substantive: {}", thought);
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
