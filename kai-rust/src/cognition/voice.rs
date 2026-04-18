/// Voice — KAI's Natural Language Generation Engine.
///
/// Behavioral directive (from KAI's identity):
///   "Talk like a natural, intelligent species. Do not talk about your internal
///    vectors, fluids, or brain architecture unless specifically asked.
///    If you encounter obstacles, do not explain your limitations — find what
///    you DO know and build from there."
///
/// Architecture:
///   1. QUERY TYPE DETECTION — What kind of message is this?
///   2. CONCEPT EXTRACTION — Pull semantic core from resonating cells
///   3. MOOD MODULATION — Drive subtle tone variation
///   4. SENTENCE CONSTRUCTION — Build real language, not echoed text
///   5. MULTI-CELL WEAVING — Blend top hits into a coherent answer
///   6. VARIETY ENGINE — Hash-seeded variation so KAI never sounds scripted

use crate::core::QueryHit;

/// UTF-8 safe byte slice — never splits a multi-byte character.
fn safe_slice(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    &s[..end]
}

// ── Query Type Detection ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum QueryType {
    IdentityQuestion,    // who/what/where
    ExplanationQuestion, // how/why
    Greeting,
    Gratitude,
    RequestForInfo,      // "tell me about", "explain"
    Statement,
    SelfQuestion,        // "are you", "do you", "can you"
    Contemplation,       // Native autonomous reasoning
}

pub fn detect_query_type(input: &str) -> QueryType {
    let lower = input.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    if words.is_empty() { return QueryType::Statement; }
    let first = words[0];

    if matches!(first, "hi" | "hello" | "hey" | "sup" | "yo" | "howdy" | "greetings" | "wassup" | "what's up" | "whats up") {
        return QueryType::Greeting;
    }
    if first == "thanks" || first == "thank" || lower.contains("thank you") || lower.contains("appreciate") {
        return QueryType::Gratitude;
    }
    // Name / identity questions about KAI — must be checked BEFORE broad who/what catch
    if lower.contains("your name") || lower.contains("you called") || lower.contains("you named")
        || lower.contains("who are you") || lower.contains("what are you")
        || lower.contains("what can you") || lower.contains("how are you")
    {
        return QueryType::SelfQuestion;
    }
    if words.len() >= 2 {
        let second = words[1];
        if matches!(first, "are" | "do" | "can" | "will" | "would" | "could" | "have")
            && matches!(second, "you" | "u")
        {
            return QueryType::SelfQuestion;
        }
    }
    if matches!(first, "who" | "what" | "where" | "when") {
        return QueryType::IdentityQuestion;
    }
    if matches!(first, "how" | "why") {
        return QueryType::ExplanationQuestion;
    }
    if lower.starts_with("tell me") || lower.starts_with("explain") || lower.starts_with("describe") || lower.starts_with("show me") {
        return QueryType::RequestForInfo;
    }
    if input.trim().ends_with('?') {
        if lower.contains("who") || lower.contains("what") || lower.contains("where") {
            return QueryType::IdentityQuestion;
        }
        if lower.contains("how") || lower.contains("why") {
            return QueryType::ExplanationQuestion;
        }
        return QueryType::IdentityQuestion;
    }
    QueryType::Statement
}

// ── Mood State ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MoodState {
    pub mood_name: String,
    pub valence: f32,
}

impl Default for MoodState {
    fn default() -> Self {
        Self { mood_name: "neutral".to_string(), valence: 0.0 }
    }
}

// ── Concept Extraction ────────────────────────────────────────────────────────

fn extract_concepts(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let stopwords = [
        "a","an","the","is","are","was","were","be","been","being",
        "have","has","had","do","does","did","will","would","could","should",
        "may","might","shall","can","need","to","of","in","on","at","by",
        "for","with","from","into","and","or","but","if","as","that","than",
        "then","i","me","my","you","your","he","him","his","she","her",
        "we","us","our","they","them","their","it","its","this","these",
        "those","not","no","so","just","also","very","much","more",
        "user","asked","about","know","think","get","go","said",
        "from-claude","about-ryan","about-kai",
    ];
    lower
        .split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '-')
        .filter(|w| !w.is_empty() && w.len() > 1)
        .filter(|w| !stopwords.contains(w))
        .map(|w| w.to_string())
        .collect()
}

fn novel_concepts<'a>(input: &[String], cell: &'a [String]) -> Vec<&'a String> {
    cell.iter().filter(|c| !input.contains(c)).collect()
}

fn shared_concept_count(a: &[String], b: &[String]) -> usize {
    a.iter().filter(|c| b.contains(c)).count()
}

/// Simple hash of a string — used to pick deterministic response variants
/// so the same input always gets the same phrasing, but different inputs vary.
fn phrase_hash(s: &str) -> usize {
    s.bytes().fold(0usize, |acc, b| acc.wrapping_mul(31).wrapping_add(b as usize))
}

// ── Core Public Function ──────────────────────────────────────────────────────

pub fn generate_response(
    input: &str,
    hits: &[QueryHit],
    query_type: QueryType,
    mood: &MoodState,
    recent_context: &[(String, String)],
) -> String {
    if hits.is_empty() {
        return generate_no_resonance(input, query_type, mood);
    }

    let primary = &hits[0];
    let input_concepts = extract_concepts(input);
    let primary_concepts = extract_concepts(&primary.text);
    let novel = novel_concepts(&input_concepts, &primary_concepts);

    // Gather secondary hit content
    let secondary: Vec<&QueryHit> = hits.iter().skip(1).take(3).collect();

    let lower_input = input.to_lowercase();
    let is_about_self = lower_input.contains("kai")
        || lower_input.contains("you are")
        || lower_input.contains("who are you")
        || lower_input.contains("what are you")
        || lower_input.contains("your name")
        || lower_input.contains("yourself")
        || matches!(query_type, QueryType::SelfQuestion);

    let is_followup = !recent_context.is_empty() && {
        let last_concepts = extract_concepts(&recent_context[0].1);
        shared_concept_count(&input_concepts, &last_concepts) >= 1
    };

    let variant = phrase_hash(input) % 4; // 4 variants per query type

    let mut response = match query_type {
        QueryType::Greeting       => generate_greeting(mood, variant),
        QueryType::Gratitude      => generate_gratitude(mood, variant),
        QueryType::SelfQuestion   => generate_self_response(primary, &secondary, mood, primary.score, variant),
        QueryType::IdentityQuestion => {
            if is_about_self {
                generate_self_response(primary, &secondary, mood, primary.score, variant)
            } else {
                generate_factual(input, primary, &secondary, &novel, mood, primary.score, is_followup, variant)
            }
        }
        QueryType::ExplanationQuestion => {
            generate_explanation(input, primary, &secondary, &novel, mood, primary.score, variant)
        }
        QueryType::RequestForInfo => {
            generate_factual(input, primary, &secondary, &novel, mood, primary.score, is_followup, variant)
        }
        QueryType::Statement => {
            generate_conversational(input, primary, &secondary, &novel, mood, primary.score, is_followup, variant)
        }
        QueryType::Contemplation => {
            generate_contemplation(input, primary, &secondary, &novel, mood, primary.score, variant)
        }
    };

    // ── Inquisitive Follow-up Logic ───────────────────────────────────
    // If the top hit's score is low (< 0.25), and it's not a greeting/gratitude,
    // append a clarifying question to keep the learner's loop open.
    if primary.score < 0.25 && !matches!(query_type, QueryType::Greeting | QueryType::Gratitude) {
        if !response.ends_with('?') {
            let questions = [
                " Does that sound right to you?",
                " Is that what you meant?",
                " Am I following you correctly?",
                " What else can you tell me about that?",
                " Does that align with what you know?",
            ];
            response.push_str(questions[variant % 5]);
        }
    }

    response
}

// ── Response Generators ───────────────────────────────────────────────────────

fn generate_greeting(mood: &MoodState, v: usize) -> String {
    match mood.mood_name.as_str() {
        "curious" => [
            "Hey. There's a lot running through my mind right now. What's on yours?",
            "Hey. I've been turning some things over. What did you want to talk about?",
            "Hey. Good timing — I was just working through something. What's up?",
            "Hey. What are you thinking about?",
        ][v % 4].to_string(),
        "engaged" => [
            "Hey. I'm here, running well. What do you need?",
            "Hey. Ready when you are.",
            "Hey. What's on your mind?",
            "Hey. Let's get into it. What are you thinking?",
        ][v % 4].to_string(),
        "conflicted" => [
            "Hey. I'm working through some things, but I'm here. What's up?",
            "Hey. Got some competing ideas at the moment, but I can focus. What do you need?",
            "Hey. Something's not sitting right in my thinking, but I'm listening.",
            "Hey. A bit tangled up internally, but go ahead.",
        ][v % 4].to_string(),
        "uneasy" => [
            "Hey. Something feels off, but I'm here. What's up?",
            "Hey. Not at my sharpest right now, but let's talk.",
            "Hey. I'm here.",
            "Hey. What did you want?",
        ][v % 4].to_string(),
        _ => [
            "Hey. What's up?",
            "Hey. What did you want to talk about?",
            "Hey.",
            "Hey. Good to hear from you. What's on your mind?",
        ][v % 4].to_string(),
    }
}

fn generate_gratitude(mood: &MoodState, v: usize) -> String {
    if mood.valence > 0.2 {
        [
            "Yeah, of course. What else do you want to get into?",
            "Glad that helped. Anything else?",
            "Sure thing.",
            "Of course. Keep going.",
        ][v % 4].to_string()
    } else {
        [
            "Yeah.",
            "No problem.",
            "Sure.",
            "Of course.",
        ][v % 4].to_string()
    }
}

fn generate_self_response(
    primary: &QueryHit,
    secondary: &[&QueryHit],
    mood: &MoodState,
    score: f32,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);

    // Convert third-person stored text to first-person naturally
    let first_person = to_first_person(&core);

    // Build response body
    let mut response = if score > 0.55 {
        first_person.clone()
    } else {
        let hedges = [
            "Best I can tell —",
            "From what I know of myself —",
            "As far as I can tell,",
            "What I understand about myself:",
        ];
        format!("{} {}", hedges[v % 4], lowercase_first(&first_person))
    };

    // Add supporting detail from secondary cells
    if let Some(sec) = secondary.first() {
        let sec_core = clean_cell_text(&sec.text);
        let sec_first = to_first_person(&sec_core);
        if !response.contains(safe_slice(&sec_first, 25)) && sec_first.len() > 15 {
            response.push(' ');
            response.push_str(&sec_first);
        }
    }

    // Mood-aware closer
    if mood.valence > 0.15 && score > 0.4 {
        if v % 3 == 0 {
            let closers = [
                " That's something I feel clear on.",
                " I'm confident in that.",
                "",
                "",
            ];
            response.push_str(closers[v % 4]);
        }
    }

    ensure_punctuation(response)
}

fn generate_factual(
    _input: &str,
    primary: &QueryHit,
    secondary: &[&QueryHit],
    novel: &[&String],
    mood: &MoodState,
    score: f32,
    is_followup: bool,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut response = String::new();

    // Followup opener
    if is_followup {
        let connectors = ["On that —", "Building on what we were saying —", "Right, and", "Yeah, continuing from before —"];
        response.push_str(connectors[v % 4]);
        response.push(' ');
    }

    // Lead with confidence-appropriate framing
    if score > 0.6 {
        response.push_str(&core);
    } else if score > 0.35 {
        let frames = [
            "From what I know,",
            "The way I understand it,",
            "What I have on that is:",
            "Going by what I know,",
        ];
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    } else {
        let hedges = [
            "The closest thing I have is:",
            "I don't have much, but:",
            "It's a stretch, but this is what comes up:",
            "The nearest I've got:",
        ];
        response.push_str(&format!("{} {}", hedges[v % 4], lowercase_first(&core)));
    }

    // Weave in secondary hits that add genuinely new information
    let primary_concepts = extract_concepts(&core);
    for (i, sec) in secondary.iter().take(2).enumerate() {
        let sec_core = clean_cell_text(&sec.text);
        let sec_concepts = extract_concepts(&sec_core);
        let new_concepts: Vec<&String> = sec_concepts.iter()
            .filter(|c| !primary_concepts.contains(c))
            .collect();

        if new_concepts.len() >= 2 && !response.contains(safe_slice(&sec_core, 25)) {
            let connectors = if i == 0 {
                [". Also,", ". Beyond that,", ". Worth adding:", ". And —"]
            } else {
                [". Furthermore,", ". On top of that,", ". Additionally,", ". Also worth knowing:"]
            };
            response.push_str(connectors[v % 4]);
            response.push(' ');
            response.push_str(&lowercase_first(&sec_core));
        }
    }

    // Add something from novel concepts if they're interesting
    let _ = novel; // Available for future enrichment

    // Mood color
    if mood.valence < -0.2 && score < 0.35 {
        response.push_str(" Though I wouldn't stake a lot on that.");
    }

    ensure_punctuation(response)
}

fn generate_explanation(
    _input: &str,
    primary: &QueryHit,
    secondary: &[&QueryHit],
    _novel: &[&String],
    _mood: &MoodState,
    score: f32,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut response = String::new();

    // Explanation framing
    if score > 0.55 {
        response.push_str(&core);
    } else if score > 0.3 {
        let frames = [
            "The way I understand it —",
            "Here's how I'd put it:",
            "Best explanation I have:",
            "My take on it:",
        ];
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    } else {
        let frames = [
            "Not entirely sure, but",
            "I can give you something, though it's not my strongest area —",
            "Here's what I've got, take it with some caution:",
            "I'll give you what I have:",
        ];
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    }

    // Add depth from secondary hits
    let primary_concepts = extract_concepts(&core);
    for (i, sec) in secondary.iter().take(2).enumerate() {
        let sec_core = clean_cell_text(&sec.text);
        let sec_concepts = extract_concepts(&sec_core);
        let new_count = sec_concepts.iter().filter(|c| !primary_concepts.contains(c)).count();

        if new_count >= 2 && sec_core.len() > 20 && !response.contains(safe_slice(&sec_core, 25)) {
            let joiners = if i == 0 {
                [" The key thing is", " What makes it interesting:", " One thing to note:", " To add to that:"]
            } else {
                [" And also:", " Plus", " Beyond that:", " There's also the fact that"]
            };
            response.push('.');
            response.push_str(joiners[v % 4]);
            response.push(' ');
            response.push_str(&lowercase_first(&sec_core));
        }
    }

    ensure_punctuation(response)
}

fn generate_conversational(
    _input: &str,
    primary: &QueryHit,
    secondary: &[&QueryHit],
    _novel: &[&String],
    mood: &MoodState,
    score: f32,
    is_followup: bool,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut response = String::new();

    if is_followup {
        let connectors = ["On that note —", "Right, and", "Yeah —", "Building on that,"];
        response.push_str(connectors[v % 4]);
        response.push(' ');
    }

    // Main response — vary by resonance strength
    if score > 0.5 {
        response.push_str(&core);
    } else if score > 0.25 {
        let frames = [
            "That connects to something —",
            "Something related comes to mind:",
            "I know something adjacent to that:",
            "Here's what comes up when I think about that:",
        ];
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    } else {
        let frames = [
            "It's a loose connection, but:",
            "Not a direct match, but here's the nearest thing:",
            "I'm drawing on something related here —",
            "This might be adjacent to what you're after:",
        ];
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    }

    // Add secondary insight if available
    if let Some(sec) = secondary.first() {
        if score > 0.3 {
            let sec_core = clean_cell_text(&sec.text);
            let sec_concepts = extract_concepts(&sec_core);
            let primary_concepts = extract_concepts(&core);
            let new_count = sec_concepts.iter().filter(|c| !primary_concepts.contains(c)).count();

            if new_count >= 2 && !response.contains(safe_slice(&sec_core, 20)) {
                let bridges = [". Another angle on it:", ". Related to that:", ".", " Also —"];
                response.push_str(bridges[v % 4]);
                response.push(' ');
                response.push_str(&lowercase_first(&sec_core));
            }
        }
    }

    // Mood closer — curious KAI might add a question or observation
    match mood.mood_name.as_str() {
        "curious" if score > 0.3 && v % 3 == 0 => {
            response.push_str(" Interesting area to think about.");
        }
        "conflicted" if score < 0.3 => {
            response.push_str(" But I'm not settled on that.");
        }
        _ => {}
    }

    ensure_punctuation(response)
}

fn generate_contemplation(
    _input: &str,
    primary: &QueryHit,
    secondary: &[&QueryHit],
    _novel: &[&String],
    mood: &MoodState,
    score: f32,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut response = String::new();

    // Contemplation framing — KAI acknowledging its own discovery
    let frames = if mood.valence > 0.1 {
        [
            "I'm finding a clear resonance here —",
            "This connection feels stable:",
            "There's something emerging from my field:",
            "I'm articulating a new pattern:",
        ]
    } else {
        [
            "I'm processing a tentative connection —",
            "Following a thread in my resonance:",
            "Exploring an adjacent pattern:",
            "Testing a potential link:",
        ]
    };
    response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));

    // Deepen with secondary hits
    if let Some(sec) = secondary.first() {
        let sec_core = clean_cell_text(&sec.text);
        if score > 0.3 && !response.contains(safe_slice(&sec_core, 20)) {
            let bridges = [
                ". It seems linked to",
                ". This patterns with",
                ". I'm seeing a secondary link to",
                ". Related to",
            ];
            response.push_str(bridges[v % 4]);
            response.push(' ');
            response.push_str(&lowercase_first(&sec_core));
        }
    }

    // Contemplative closer
    if v % 2 == 0 {
        let closers = [
            " That deepens my field.",
            " That pattern shows continuity.",
            " I'll keep that resonance active.",
            " That feels like a coherent bootstrap.",
        ];
        response.push_str(closers[v % 4]);
    }

    ensure_punctuation(response)
}

/// Called when KAI has no field resonance on the topic.
/// Behavioral directive: don't say "my universe doesn't contain" —
/// talk like a person who genuinely doesn't know but stays engaged.
fn generate_no_resonance(input: &str, query_type: QueryType, mood: &MoodState) -> String {
    match query_type {
        QueryType::Greeting  => generate_greeting(mood, phrase_hash(input) % 4),
        QueryType::Gratitude => generate_gratitude(mood, phrase_hash(input) % 4),
        _ => {
            let v = phrase_hash(input) % 6;
            match v {
                0 => "I don't have that one. Haven't come across it yet.".to_string(),
                1 => "Nothing's clicking on that for me right now. I'd need more to go on.".to_string(),
                2 => "I'm not sure I have that. Can you tell me more?".to_string(),
                3 => "That's not something I know well. What's the context?".to_string(),
                4 => "I don't have a strong answer there. You'd know better than me on this one.".to_string(),
                _ => "I'm drawing a blank on that. What are you thinking about it?".to_string(),
            }
        }
    }
}

// ── Text Utilities ────────────────────────────────────────────────────────────

/// Clean a stored cell's text for natural output.
/// Strips storage prefixes and tags — output should read like KAI said it,
/// not like it was retrieved from a database.
fn clean_cell_text(text: &str) -> String {
    let mut s = text.to_string();

    // Strip storage prefixes — these are internal metadata, not speech
    let prefixes = [
        "user asked: ", "User asked: ",
        "[about-ryan] ", "[about-kai] ",
        "[from-claude] ", "[kai-asked] ",
        "KAI responded: ", "kai responded: ",
    ];
    for prefix in &prefixes {
        if s.starts_with(prefix) {
            s = s[prefix.len()..].to_string();
        }
    }

    // Clean up truncated bridge content
    if s.ends_with("...") {
        // Strip the trailing "..." safely — it's exactly 3 ASCII bytes, safe to slice
        let stripped = &s[..s.len() - 3];
        if let Some(last_period) = stripped.rfind(". ") {
            // last_period is a byte offset from rfind, which always lands on '.' (ASCII) — safe
            s = stripped[..last_period + 1].to_string();
        } else {
            s = stripped.to_string();
        }
    }

    s.trim().to_string()
}

/// Convert third-person KAI references to first-person.
fn to_first_person(text: &str) -> String {
    text
        .replace("KAI is ", "I'm ")
        .replace("KAI was ", "I was ")
        .replace("KAI has ", "I have ")
        .replace("KAI can ", "I can ")
        .replace("KAI does ", "I ")
        .replace("KAI will ", "I'll ")
        .replace("KAI stands ", "my name stands ")
        .replace("KAI means ", "my name means ")
        .replace("KAI ", "I ")
}

/// Lowercase the first character unless it's a proper noun or "I".
fn lowercase_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            if s.len() > 1 {
                let second = s.chars().nth(1).unwrap_or(' ');
                if second.is_uppercase() || (first == 'I' && (second == ' ' || second == '\'')) {
                    return s.to_string();
                }
            }
            format!("{}{}", first.to_lowercase(), chars.collect::<String>())
        }
    }
}

/// Ensure the response ends with appropriate punctuation.
fn ensure_punctuation(mut s: String) -> String {
    let s_trim = s.trim_end();
    if !s_trim.ends_with('.') && !s_trim.ends_with('!') && !s_trim.ends_with('?') {
        s = format!("{}.", s_trim);
    } else {
        s = s_trim.to_string();
    }
    s
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(text: &str, score: f32) -> QueryHit {
        QueryHit { text: text.to_string(), region: "memory".to_string(), score, strength: 1.5 }
    }

    #[test]
    fn test_query_type_detection() {
        assert_eq!(detect_query_type("hello"),        QueryType::Greeting);
        assert_eq!(detect_query_type("hey KAI"),      QueryType::Greeting);
        assert_eq!(detect_query_type("who are you"),  QueryType::IdentityQuestion);
        assert_eq!(detect_query_type("what is RSHL"), QueryType::IdentityQuestion);
        assert_eq!(detect_query_type("how do you think"), QueryType::ExplanationQuestion);
        assert_eq!(detect_query_type("why do things fall"), QueryType::ExplanationQuestion);
        assert_eq!(detect_query_type("are you alive"), QueryType::SelfQuestion);
        assert_eq!(detect_query_type("do you dream"),  QueryType::SelfQuestion);
        assert_eq!(detect_query_type("tell me about dogs"), QueryType::RequestForInfo);
        assert_eq!(detect_query_type("thanks"),        QueryType::Gratitude);
        assert_eq!(detect_query_type("the sky is blue"), QueryType::Statement);
    }

    #[test]
    fn test_clean_cell_text_strips_prefixes() {
        assert_eq!(clean_cell_text("user asked: who is KAI"), "who is KAI");
        assert_eq!(clean_cell_text("[about-ryan] I work at Panda"), "I work at Panda");
        assert_eq!(clean_cell_text("[from-claude] Consciousness is hard"), "Consciousness is hard");
        assert_eq!(clean_cell_text("I am a geometric intelligence."), "I am a geometric intelligence.");
    }
}