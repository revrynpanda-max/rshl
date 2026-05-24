pub mod ai_peer;
pub mod code_tools;
pub mod git_tools;
pub mod ipc_server;
pub mod oracle_server;

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

/// Topics KAI should research to improve his own architecture and capabilities.
const RESEARCH_TOPICS: &[&str] = &[
    // VSA / Sparse Distributed Representations
    "vector symbolic architecture",
    "sparse distributed representations",
    "holographic reduced representations",
    "binding operation vector space",
    "hyperdimensional computing",
    "semantic pointer architecture",
    // Self-Improving AI
    "self-modifying code",
    "autonomous agent architecture",
    "recursive self-improvement",
    "open-ended learning",
    "continual learning neural networks",
    "catastrophic forgetting solutions",
    // Neural-Symbolic AI
    "neural symbolic integration",
    "differentiable reasoning",
    "logic tensor networks",
    "neural theorem proving",
    "structured prediction",
    // Scaling & Efficiency
    "million neuron simulation",
    "sparse neural network training",
    "memory efficient transformer",
    "progressive neural networks",
    "mixture of experts architecture",
    // Knowledge Representation
    "knowledge graph embedding",
    "semantic memory architecture",
    "episodic memory neural network",
    "constructive memory framework",
    // Cognitive Architecture
    "global workspace theory implementation",
    "integrated cognitive architecture",
    "active inference free energy",
    "predictive processing brain",
    "consciousness architecture AI",
    // New Discoveries
    "new AI architecture 2025",
    "breakthrough machine learning",
    "novel neural network topology",
    "emergent abilities large models",
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
        if !exists
            && universe.ingest_and_verify(&text, "reasoning", "world-bridge", 1.5) {
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
        if !exists
            && universe.ingest_and_verify(&text, "reasoning", "world-bridge", 1.0) {
                stored += 1;
            }
    }

    stored
}

#[derive(Debug)]
pub struct IntakeResult {
    pub topic: String,
    pub cells: Vec<(String, String, String, f32)>, // (text, region, source, strength)
}

/// Run a background intake cycle — pick a random unexplored topic and ingest it.
/// Returns (topic explored, cells added).
pub fn intake_cycle_async() -> Option<IntakeResult> {
    use rand::Rng;
    let mut rng = rand::thread_rng();

    // Pick a random topic from the exploration list
    let idx = rng.gen_range(0..EXPLORATION_TOPICS.len());
    let topic = EXPLORATION_TOPICS[idx];

    let answer = query_duckduckgo(topic)?;
    let mut cells = Vec::new();

    // Process abstract
    if !answer.abstract_text.is_empty() && answer.abstract_text.len() > 20 {
        let text = if answer.abstract_text.len() > 300 {
            let mut end = 300;
            while end > 0 && !answer.abstract_text.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}...", &answer.abstract_text[..end])
        } else {
            answer.abstract_text.clone()
        };
        cells.push((
            text,
            "reasoning".to_string(),
            "world-bridge".to_string(),
            1.5,
        ));
    }

    // Process related topics
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
        cells.push((
            text,
            "reasoning".to_string(),
            "world-bridge".to_string(),
            1.0,
        ));
    }

    Some(IntakeResult {
        topic: topic.to_string(),
        cells,
    })
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

/// Deep research — fetch a topic from multiple sources and return structured findings.
/// Returns (main finding, related findings, source urls).
pub fn research_topic(topic: &str) -> Option<(String, Vec<String>, Vec<String>)> {
    // 1. Try DuckDuckGo instant answer
    let answer = query_duckduckgo(topic)?;
    let mut findings = Vec::new();
    let mut sources = Vec::new();

    if !answer.abstract_source.is_empty() {
        sources.push(format!("duckduckgo:{}", answer.abstract_source));
    }

    // 2. Try Wikipedia API for deeper content
    let wiki_query = topic.replace(' ', "%20");
    let wiki_url = format!(
        "https://en.wikipedia.org/api/rest_v1/page/summary/{}",
        wiki_query
    );
    if let Ok(response) = ureq::get(&wiki_url)
        .timeout(std::time::Duration::from_secs(8))
        .call() {
        if let Ok(json) = response.into_json::<serde_json::Value>() {
            if let Some(extract) = json["extract"].as_str() {
                if extract.len() > 50 {
                    findings.push(format!("[Wikipedia] {}", extract));
                    if let Some(url) = json["content_urls"]["desktop"]["page"].as_str() {
                        sources.push(url.to_string());
                    }
                }
            }
        }
    }

    // 3. Try arXiv API for papers
    let arxiv_url = format!(
        "http://export.arxiv.org/api/query?search_query=all:{}&start=0&max_results=2",
        topic.replace(' ', "%20")
    );
    if let Ok(response) = ureq::get(&arxiv_url)
        .timeout(std::time::Duration::from_secs(10))
        .call() {
        if let Ok(body) = response.into_string() {
            // Simple XML parsing without regex dependency
            let mut titles: Vec<String> = Vec::new();
            let mut summaries: Vec<String> = Vec::new();
            let mut pos = 0;
            while let Some(start) = body[pos..].find("<title>") {
                let abs_start = pos + start + 7;
                if let Some(end) = body[abs_start..].find("</title>") {
                    let title = body[abs_start..abs_start + end].trim().to_string();
                    if !title.is_empty() && title != "arXiv Query Results" {
                        titles.push(title);
                    }
                    pos = abs_start + end + 8;
                } else { break; }
            }
            pos = 0;
            while let Some(start) = body[pos..].find("<summary>") {
                let abs_start = pos + start + 9;
                if let Some(end) = body[abs_start..].find("</summary>") {
                    let summary = body[abs_start..abs_start + end].trim().to_string();
                    if !summary.is_empty() {
                        summaries.push(summary);
                    }
                    pos = abs_start + end + 10;
                } else { break; }
            }
            for (i, t) in titles.iter().take(2).enumerate() {
                if let Some(s) = summaries.get(i) {
                    let summary_clean = s.replace("\n", " ").replace("  ", " ");
                    let trunc = if summary_clean.len() > 400 {
                        &summary_clean[..400]
                    } else { &summary_clean };
                    findings.push(format!("[arXiv: {}] {}", t.trim(), trunc));
                    sources.push(format!("arxiv:{}", t.trim()));
                }
            }
        }
    }

    let main = if !answer.abstract_text.is_empty() {
        answer.abstract_text
    } else if !findings.is_empty() {
        findings[0].clone()
    } else {
        return None;
    };

    Some((main, findings, sources))
}

/// Autonomous research cycle — KAI researches topics that help him improve.
/// Returns cells to be ingested.
pub fn research_cycle_async() -> Option<IntakeResult> {
    use rand::Rng;
    let mut rng = rand::thread_rng();

    // 70% chance to research self-improvement, 30% general exploration
    let topic = if rng.gen_bool(0.7) {
        let idx = rng.gen_range(0..RESEARCH_TOPICS.len());
        RESEARCH_TOPICS[idx]
    } else {
        let idx = rng.gen_range(0..EXPLORATION_TOPICS.len());
        EXPLORATION_TOPICS[idx]
    };

    let (main, findings, _sources) = research_topic(topic)?;
    let mut cells = Vec::new();

    // Store main finding
    let main_text = if main.len() > 400 {
        format!("{}...", &main[..400])
    } else { main };
    cells.push((
        main_text,
        "reasoning".to_string(),
        "research".to_string(),
        2.0, // Higher confidence for research
    ));

    // Store related findings
    for finding in findings.iter().take(3) {
        let text = if finding.len() > 350 {
            format!("{}...", &finding[..350])
        } else {
            finding.clone()
        };
        cells.push((
            text,
            "reasoning".to_string(),
            "research".to_string(),
            1.5,
        ));
    }

    Some(IntakeResult {
        topic: topic.to_string(),
        cells,
    })
}
