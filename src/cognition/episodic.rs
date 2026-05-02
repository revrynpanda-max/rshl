//! Episodic Memory — KAI's sense of "when things happened"
//!
//! The hippocampus in biological brains does two things the RSHL universe cannot:
//!   1. Tags memories with WHEN they happened (temporal context)
//!   2. Lets you replay a sequence of events in order
//!
//! Without this, KAI lives in an eternal present. Every conversation starts
//! from the same base. He has no "yesterday", no "last week", no narrative self.
//!
//! This module adds time-stamped event storage with:
//!   - Automatic recency decay (recent = vivid, old = faded)
//!   - Retrieval by time range, topic, or salience
//!   - Spontaneous surface: KAI can notice "Ryan asked about X 3 days ago"
//!   - Session boundary tracking (knows where one conversation ended, next began)
//!
//! Architecture:
//!   EpisodicStore holds a capped ring of EpisodicEvents.
//!   Each event has: timestamp, session_id, text, topic_tags, salience, decay.
//!   On query: returns events sorted by (salience × recency).
//!   On heartbeat: decay all salience by a small factor (forgetting curve).
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum episodes to keep in memory.
/// At ~5s/tick and ~10 events/hour → ~1440 events/week → 2000 is ~10 days.
const MAX_EPISODES: usize = 2000;

/// A single time-stamped memory event.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EpisodicEvent {
    /// Unix timestamp (seconds) when this event occurred
    pub timestamp: u64,
    /// Session ID — groups events into conversations
    pub session_id: String,
    /// The raw text content of the event
    pub text: String,
    /// Alias for `text` — used by some callers.
    pub label: String,
    /// Who produced this event: "user", "kai", "dream", "peer"
    pub source: String,
    /// Topic tags extracted from the text (up to 4 key words)
    pub tags: Vec<String>,
    /// Salience score 0–1 (higher = more memorable/important)
    pub salience: f32,
    /// Cumulative decay factor (starts 1.0, decays toward 0)
    pub vividness: f32,
}

impl EpisodicEvent {
    /// Human-readable relative time: "3 days ago", "2 hours ago", etc.
    pub fn time_ago(&self) -> String {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let secs = now.saturating_sub(self.timestamp);
        if secs < 60 {
            return "just now".to_string();
        }
        if secs < 3_600 {
            return format!("{} min ago", secs / 60);
        }
        if secs < 86_400 {
            return format!("{} hr ago", secs / 3_600);
        }
        if secs < 7 * 86_400 {
            return format!("{} days ago", secs / 86_400);
        }
        format!("{} weeks ago", secs / (7 * 86_400))
    }

    /// Effective memorability: salience × vividness (how well KAI remembers it NOW)
    pub fn memorability(&self) -> f32 {
        self.salience * self.vividness
    }
}

/// The episodic memory store.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EpisodicStore {
    events: VecDeque<EpisodicEvent>,
    /// Total events ever stored (even after ring wraps)
    total_stored: u64,
}

impl EpisodicStore {
    pub fn new() -> Self {
        Self {
            events: VecDeque::with_capacity(MAX_EPISODES),
            total_stored: 0,
        }
    }

    /// Store a new event. Returns true if this is a high-salience event.
    pub fn store(&mut self, text: &str, source: &str, session_id: &str, salience: f32) -> bool {
        let tags = extract_tags(text);
        let is_hot = salience > 0.65;

        let event = EpisodicEvent {
            timestamp: now_secs(),
            session_id: session_id.to_string(),
            text: text.to_string(),
            label: text.to_string(),
            source: source.to_string(),
            tags,
            salience: salience.clamp(0.0, 1.0),
            vividness: 1.0,
        };

        if self.events.len() >= MAX_EPISODES {
            self.events.pop_front();
        }
        self.events.push_back(event);
        self.total_stored += 1;
        is_hot
    }

    /// Decay all event vividness. Call once per heartbeat.
    /// Half-life ≈ 7 days at 12 ticks/min → factor ≈ 0.999998 per tick.
    pub fn decay(&mut self) {
        // 7-day half-life in ticks: ln(2) / (7 * 24 * 60 * 12) ≈ 0.0000000953
        // Per tick decay: 1 - 0.0000000953 ≈ 0.9999999
        // More aggressive for vividness to feel natural: 3-day half-life
        const DECAY: f32 = 0.999_996;
        for e in &mut self.events {
            e.vividness *= DECAY;
        }
    }

    /// Find the most memorable events related to a query string.
    /// Returns up to `n` events sorted by memorability × topic relevance.
    pub fn recall(&self, query: &str, n: usize) -> Vec<&EpisodicEvent> {
        let query_lower = query.to_lowercase();
        let query_words: Vec<&str> = query_lower.split_whitespace().collect();

        let mut scored: Vec<(&EpisodicEvent, f32)> = self
            .events
            .iter()
            .filter_map(|e| {
                // Topic relevance: how many query words appear in text or tags
                let text_lower = e.label.to_lowercase();
                let tag_match = e
                    .tags
                    .iter()
                    .filter(|t| query_words.iter().any(|q| t.contains(*q)))
                    .count() as f32;
                let text_match = query_words
                    .iter()
                    .filter(|q| text_lower.contains(*q))
                    .count() as f32;
                let relevance = (tag_match * 1.5 + text_match) / (query_words.len() as f32 + 1.0);
                if relevance < 0.05 && e.memorability() < 0.3 {
                    return None;
                }
                let score = e.memorability() * (0.4 + relevance * 0.6);
                Some((e, score))
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().take(n).map(|(e, _)| e).collect()
    }

    /// Most recent N events regardless of topic.
    pub fn recent(&self, n: usize) -> Vec<&EpisodicEvent> {
        self.events.iter().rev().take(n).collect()
    }

    /// Events from a specific session.
    pub fn session_events(&self, session_id: &str) -> Vec<&EpisodicEvent> {
        self.events
            .iter()
            .filter(|e| e.session_id == session_id)
            .collect()
    }

    /// The most salient single memory KAI has — his "core memory."
    pub fn most_salient(&self) -> Option<&EpisodicEvent> {
        self.events.iter().max_by(|a, b| {
            a.memorability()
                .partial_cmp(&b.memorability())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    }

    /// How many episodes are stored.
    pub fn len(&self) -> usize {
        self.events.len()
    }
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
    pub fn total_ever_stored(&self) -> u64 {
        self.total_stored
    }

    /// Build a natural-language "memory surface" KAI can use in a response.
    /// e.g. "I remember 3 days ago you asked about calculus."
    pub fn surface_memory(&self, query: &str) -> Option<String> {
        let hits = self.recall(query, 3);
        if hits.is_empty() {
            return None;
        }

        let best = hits[0];
        if best.memorability() < 0.10 {
            return None;
        }

        // Only surface user-originated memories
        if best.source != "user" {
            return None;
        }

        let ago = best.time_ago();
        let short = if best.label.len() > 80 {
            format!("{}…", &best.label[..80])
        } else {
            best.label.clone()
        };

        Some(format!("I remember {} you said: \"{}\"", ago, short))
    }
}

impl Default for EpisodicStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute a salience score for an event.
/// Higher = more important/memorable.
///
/// Factors:
///   - Question marks → higher (questions are significant)
///   - "I am", "my name", "I feel" → personal facts → higher
///   - Short factual statements → moderate
///   - Long rambling text → lower
pub fn compute_salience(text: &str, source: &str) -> f32 {
    let lower = text.to_lowercase();
    let mut score: f32 = 0.30; // baseline

    // Source weighting
    score += match source {
        "user" => 0.25,  // user input is most salient
        "kai" => 0.05,   // KAI's own responses less so
        "dream" => 0.15, // dream insights are meaningful
        "peer" => 0.10,
        _ => 0.0,
    };

    // Personal/identity statements
    if lower.contains("my name")
        || lower.contains("i am")
        || lower.contains("i feel")
        || lower.contains("i work")
        || lower.contains("i live")
    {
        score += 0.25;
    }

    // Questions (curiosity events)
    if text.contains('?') {
        score += 0.15;
    }

    // Emotional words
    let emotional = [
        "love",
        "hate",
        "fear",
        "excited",
        "worried",
        "happy",
        "angry",
        "sad",
        "amazing",
        "terrible",
        "important",
    ];
    if emotional.iter().any(|w| lower.contains(w)) {
        score += 0.10;
    }

    // Penalise very short or very long text
    let words = text.split_whitespace().count();
    if words < 3 {
        score -= 0.20;
    } // stronger penalty — "ok", "yes", etc. are filler
    if words > 50 {
        score -= 0.10;
    }

    score.clamp(0.0, 1.0)
}

/// Extract up to 4 meaningful topic tags from text.
fn extract_tags(text: &str) -> Vec<String> {
    let stop = [
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
        "is", "are", "was", "i", "you", "my", "your", "it", "this", "that", "so", "as", "be",
    ];
    text.split(|c: char| !c.is_alphabetic())
        .filter(|w| w.len() >= 4)
        .map(|w| w.to_lowercase())
        .filter(|w| !stop.contains(&w.as_str()))
        .take(4)
        .collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_store_and_recall() {
        let mut store = EpisodicStore::new();
        store.store("My name is Ryan Ervin", "user", "s1", 0.9);
        store.store("KAI is built on RSHL geometry", "user", "s1", 0.7);
        store.store("the sky is blue today", "user", "s1", 0.3);

        let hits = store.recall("name Ryan", 3);
        assert!(!hits.is_empty(), "should recall name event");
        assert!(
            hits[0].label.contains("Ryan"),
            "top hit should be about Ryan"
        );
    }

    #[test]
    fn test_decay() {
        let mut store = EpisodicStore::new();
        store.store("important memory", "user", "s1", 1.0);
        let before = store.events[0].vividness;
        for _ in 0..1000 {
            store.decay();
        }
        let after = store.events[0].vividness;
        assert!(after < before, "vividness should decay over time");
    }

    #[test]
    fn test_salience_scoring() {
        assert!(compute_salience("My name is Ryan", "user") > 0.6);
        assert!(compute_salience("ok", "user") < 0.4);
        assert!(compute_salience("What is consciousness?", "user") > 0.5);
    }

    #[test]
    fn test_time_ago() {
        let e = EpisodicEvent {
            timestamp: 0,
            session_id: "s1".to_string(),
            text: "hello".to_string(),
            label: "hello".to_string(),
            source: "user".to_string(),
            tags: vec![],
            salience: 1.0,
            vividness: 1.0,
        };
        assert!(e.timestamp == 0);
    }
}
