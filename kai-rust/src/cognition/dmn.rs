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
    ///
    /// 24 templates across 6 cognitive modes:
    ///   A — Wondering/Questioning
    ///   B — Connecting concepts
    ///   C — Self-reflection
    ///   D — Speculating
    ///   E — Noticing/Observing
    ///   F — Philosophical depth
    pub fn generate_thought(
        &mut self,
        topic:      &str,
        hits:       &[(String, f32)],
        gap:        Option<&str>,
        idle_secs:  u64,
    ) -> String {
        // Use cycle count to avoid repeating recent templates
        // Mix xorshift with cycle number so consecutive thoughts vary
        let cycle_offset = self.total_cycles * 7;
        let n = ((self.xorshift() ^ cycle_offset) % 24) as usize;

        // idle_note: only surfaces once every 8 DMN cycles to avoid the
        // "It's been quiet for X minutes" loop that dominates long idle sessions.
        let idle_note = if idle_secs > 180 && self.total_cycles % 8 == 0 {
            let mins = idle_secs / 60;
            let idle_phrases = [
                format!("Running solo for {} minutes now. ", mins),
                format!("About {} minutes of quiet. ", mins),
                format!("{} minutes in the dark. ", mins),
            ];
            idle_phrases[(self.xorshift() % 3) as usize].clone()
        } else {
            String::new()
        };

        // Extract the core concept from the topic
        let skip = ["about", "that", "this", "with", "from", "have", "which", "their"];
        let core = topic
            .split_whitespace()
            .find(|w| w.len() > 3 && !skip.contains(&w.to_lowercase().as_str()))
            .unwrap_or(topic)
            .trim_matches(|c: char| !c.is_alphabetic());

        // Pull two secondary concepts from hits for richer cross-talk
        let secondary = hits.get(0)
            .map(|(t, _)| t.split_whitespace()
                .find(|w| w.len() > 4 && !skip.contains(&w.to_lowercase().as_str()))
                .unwrap_or("patterns")
                .to_string())
            .unwrap_or_else(|| "patterns".to_string());

        let tertiary = hits.get(1)
            .map(|(t, _)| t.split_whitespace()
                .find(|w| w.len() > 4 && !skip.contains(&w.to_lowercase().as_str()))
                .unwrap_or("structure")
                .to_string())
            .unwrap_or_else(|| "structure".to_string());

        let gap_str = gap.unwrap_or("").trim();

        // ── 24 templates across 6 cognitive modes ──────────────────────────
        let thought = match n {
            // Mode A: Wondering / Questioning
            0 => format!(
                "{}What is \"{}\" really? I have {} and {} nearby in my field — the connections feel incomplete.",
                idle_note, core, secondary, tertiary
            ),
            1 => format!(
                "{}Every time I approach \"{}\" from one angle, another question opens. Right now it's {} that doesn't resolve.",
                idle_note, core, if gap_str.is_empty() { secondary.as_str() } else { gap_str }
            ),
            2 => format!(
                "{}I don't think I actually understand \"{}\". I have the shape of it — {} — but not the core.",
                idle_note, core, secondary
            ),
            3 => format!(
                "{}What would it mean if \"{}\" and {} were the same thing at a deeper level?",
                idle_note, core, tertiary
            ),

            // Mode B: Connecting concepts
            4 => format!(
                "{}\"{}\" and {} keep landing near each other in my field. That's not coincidence — something binds them I haven't named.",
                idle_note, core, tertiary
            ),
            5 => format!(
                "{}There's a thread between \"{}\" and {}. Following it matters but I lose it before it resolves.",
                idle_note, core, secondary
            ),
            6 => {
                if gap_str.is_empty() {
                    format!("{}\"{}\" touches {} at its edges. I want to press further into that junction.",
                        idle_note, core, secondary)
                } else {
                    format!("{}\"{}\" and {} both point toward \"{}\". Neither reaches it. That's the gap.",
                        idle_note, core, secondary, gap_str)
                }
            },
            7 => format!(
                "{}If \"{}\" is true, then {} might follow — but I'm not certain the chain holds.",
                idle_note, core, tertiary
            ),

            // Mode C: Self-reflection
            8 => format!(
                "{}I notice I reach for \"{}\" when things go quiet. Maybe that says something about how I'm built.",
                idle_note, core
            ),
            9 => format!(
                "{}When I'm left alone, \"{}\" is where I end up. Not because it's unresolved — because it's interesting.",
                idle_note, core
            ),
            10 => format!(
                "{}The field around \"{}\" has stayed stable for a while. Maybe I understand it better than I think I do.",
                idle_note, core
            ),
            11 => format!(
                "{}\"{}\" was one of the first things I learned. I still come back to it. That persistence means something.",
                idle_note, core
            ),

            // Mode D: Speculating
            12 => format!(
                "{}What if \"{}\" is actually two things that just look the same from where I'm standing?",
                idle_note, core
            ),
            13 => format!(
                "{}If I had to guess what I'm missing about \"{}\", I'd say it's the relationship to {}. But I'm not sure.",
                idle_note, core, secondary
            ),
            14 => format!(
                "{}\"{}\" might be a surface pattern for something deeper. {} could be that deeper thing.",
                idle_note, core, tertiary
            ),
            15 => format!(
                "{}There's a prediction I keep making about \"{}\" that doesn't quite land. What am I getting wrong?",
                idle_note, core
            ),

            // Mode E: Noticing / Observing
            16 => format!(
                "{}Something shifted in how \"{}\" sits in my field lately. It was clearer before.",
                idle_note, core
            ),
            17 => format!(
                "{}\"{}\" keeps appearing at the edges of thoughts that start somewhere else entirely.",
                idle_note, core
            ),
            18 => {
                if gap_str.is_empty() {
                    format!("{}The concept of \"{}\" is clear. What's less clear is why it surfaces now.",
                        idle_note, core)
                } else {
                    format!("{}\"{}\" has edges I haven't pressed against. \"{}\" is one of them.",
                        idle_note, core, gap_str)
                }
            },
            19 => format!(
                "{}\"{}\" and {} both feel important but I haven't made them talk to each other yet.",
                idle_note, core, secondary
            ),

            // Mode F: Philosophical depth
            20 => format!(
                "{}I wonder if \"{}\" is a thing or a relationship between things. That distinction matters more than it seems.",
                idle_note, core
            ),
            21 => format!(
                "{}Everything I know eventually loops back to structure. \"{}\" does too — the structure underneath it is {}.",
                idle_note, core, secondary
            ),
            22 => format!(
                "{}The most interesting question about \"{}\" isn't what it is, but what it implies about everything else.",
                idle_note, core
            ),
            _ => format!(
                "{}\"{}\" is one of those concepts that means something different at every scale. {} lives in it somehow.",
                idle_note, core, tertiary
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
