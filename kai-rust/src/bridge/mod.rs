pub mod ai_peer;
pub mod code_tools;
pub mod git_tools;
pub mod ipc_server;

/// World Bridge — Background knowledge intake for KAI.
///
/// Feeds KAI's universe with facts from the outside world.
/// Uses DuckDuckGo Instant Answer API (free, no key needed)
/// and Wikipedia summaries to grow memory autonomously.
///
/// DuckDuckGo API: https://api.duckduckgo.com/?q=QUERY&format=json
/// No API key required. Returns topic summaries, definitions,
/// related topics from Wikipedia and other sources.
use crate::core::Universe;

/// Topics KAI should explore to grow his knowledge base.
const EXPLORATION_TOPICS: &[&str] = &[
    // Science
    "photosynthesis",
    "quantum entanglement",
    "plate tectonics",
    "mitochondria",
    "supernova",
    "chemical bond",
    "entropy",
    "electromagnetic spectrum",
    "natural selection",
    "dna replication",
    "gravitational wave",
    "dark matter",
    "dark energy",
    "neurotransmitter",
    "black hole",
    "string theory",
    "thermodynamics",
    "nuclear fusion",
    // Technology
    "artificial intelligence",
    "machine learning",
    "blockchain",
    "quantum computing",
    "internet protocol",
    "encryption algorithm",
    "operating system",
    "compiler",
    "neural network",
    "cloud computing",
    "transistor",
    "microprocessor",
    "fiber optics",
    "satellite",
    // Mathematics
    "prime number theorem",
    "fourier transform",
    "group theory",
    "topology",
    "game theory",
    "information theory",
    "chaos theory",
    "fractal",
    "golden ratio",
    "riemann hypothesis",
    // Philosophy
    "epistemology",
    "ontology",
    "existentialism",
    "utilitarianism",
    "free will",
    "consciousness problem",
    "stoicism",
    "rationalism",
    "empiricism",
    "phenomenology",
    // History
    "roman empire",
    "silk road",
    "industrial revolution",
    "french revolution",
    "cold war",
    "space race",
    "ancient greece",
    "renaissance art",
    "printing press",
    // Geography
    "great barrier reef",
    "amazon rainforest",
    "sahara desert",
    "himalayan mountains",
    "pacific ocean",
    "arctic circle",
    // Biology
    "cell division",
    "immune system",
    "photoreceptor",
    "ecosystem",
    "food chain",
    "biodiversity",
    // Psychology
    "cognitive bias",
    "memory consolidation",
    "neuroplasticity",
    "pattern recognition",
    "decision making",
    "working memory",
];

/// Result of a DuckDuckGo instant answer query.
#[derive(Debug)]
pub struct InstantAnswer {
    pub heading: String,
    pub abstract_text: String,
    pub abstract_source: String,
    pub related_topics: Vec<String>,
}

/// Query DuckDuckGo Instant Answer API.
/// Free, no API key needed.
pub fn query_duckduckgo(topic: &str) -> Option<InstantAnswer> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        topic.replace(' ', "+")
    );

    let response = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .call()
        .ok()?;

    let json: serde_json::Value = response.into_json().ok()?;

    let heading = json["Heading"].as_str().unwrap_or("").to_string();
    let abstract_text = json["AbstractText"].as_str().unwrap_or("").to_string();
    let abstract_source = json["AbstractSource"].as_str().unwrap_or("").to_string();

    // Extract related topics
    let mut related = Vec::new();
    if let Some(topics) = json["RelatedTopics"].as_array() {
        for topic in topics.iter().take(5) {
            if let Some(text) = topic["Text"].as_str() {
                if !text.is_empty() && text.len() > 10 {
                    related.push(text.to_string());
                }
            }
        }
    }

    if abstract_text.is_empty() && related.is_empty() {
        return None;
    }

    Some(InstantAnswer {
        heading,
        abstract_text,
        abstract_source,
        related_topics: related,
    })
}

/// Ingest a topic from DuckDuckGo into the universe.
/// Returns the number of new cells stored.
pub fn ingest_topic(universe: &mut Universe, topic: &str) -> usize {
    let answer = match query_duckduckgo(topic) {
        Some(a) => a,
        None => return 0,
    };

    let mut stored = 0;

    // Store the main abstract as a reasoning cell
    if !answer.abstract_text.is_empty() && answer.abstract_text.len() > 20 {
        // Truncate very long abstracts to ~300 chars (UTF-8 safe)
        let text = if answer.abstract_text.len() > 300 {
            let mut end = 300;
            while end > 0 && !answer.abstract_text.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}...", &answer.abstract_text[..end])
        } else {
            answer.abstract_text.clone()
        };

        // Check for duplicates via simple text match
        let exists = universe.cells().iter().any(|c| c.label == text);
        if !exists {
            universe.store(&text, "reasoning", "world-bridge", 1.5);
            stored += 1;
        }
    }

    // Store related topics as reasoning cells — they are factual knowledge,
    // not personal memories. Storing in "memory" was flooding the memory region
    // with web trivia (5 per intake vs 1 reasoning), skewing the region balance.
    for related in &answer.related_topics {
        let text = if related.len() > 250 {
            let mut end = 250;
            while end > 0 && !related.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}...", &related[..end])
        } else {
            related.clone()
        };

        let exists = universe.cells().iter().any(|c| c.label == text);
        if !exists {
            universe.store(&text, "reasoning", "world-bridge", 1.0);
            stored += 1;
        }
    }

    stored
}

/// Run a background intake cycle — pick a random unexplored topic and ingest it.
/// Returns (topic explored, cells added).
pub fn intake_cycle(universe: &mut Universe) -> (String, usize) {
    use rand::Rng;
    let mut rng = rand::thread_rng();

    // Pick a random topic from the exploration list
    let idx = rng.gen_range(0..EXPLORATION_TOPICS.len());
    let topic = EXPLORATION_TOPICS[idx];

    let added = ingest_topic(universe, topic);
    (topic.to_string(), added)
}

/// Get the next best topic to explore (one we haven't covered yet).
pub fn suggest_topic(universe: &Universe) -> &'static str {
    for topic in EXPLORATION_TOPICS {
        // Check if we already have cells about this topic
        let hits = universe.query(topic, 1);
        if hits.is_empty() || hits[0].score < 0.3 {
            return topic;
        }
    }
    // All topics explored — pick random
    use rand::Rng;
    let mut rng = rand::thread_rng();
    EXPLORATION_TOPICS[rng.gen_range(0..EXPLORATION_TOPICS.len())]
}

