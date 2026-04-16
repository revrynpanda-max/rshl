/// Voice — KAI's Natural Language Generation Engine.
///
/// This is what makes KAI SPEAK instead of RETRIEVE.
///
/// Before this module, KAI could only echo stored cell text verbatim.
/// Now, KAI extracts CONCEPTS from resonating cells and CONSTRUCTS
/// natural sentences from them — like a mind forming thoughts into words.
///
/// Architecture:
///   1. CONCEPT EXTRACTION: Pull key content words from resonating cells
///   2. QUERY TYPE DETECTION: Is this a question? greeting? statement?
///   3. MOOD MODULATION: Valence/mood influences word choice and structure
///   4. SENTENCE CONSTRUCTION: Build natural language from components
///   5. CONTEXT WEAVING: Recent conversation influences phrasing
///
/// This is NOT a language model. There are no weights, no transformers.
/// KAI builds sentences from geometric resonance — every word is chosen
/// because it appeared in cells that resonated with the query.

use crate::core::{SparseVec, QueryHit};

// ── Query Type Detection ──────────────────────────────────────────────────

/// What kind of input did the user give?
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum QueryType {
    /// "who is X", "what is Y", "where does Z"
    IdentityQuestion,
    /// "how does X work", "why does Y happen"
    ExplanationQuestion,
    /// "hello", "hey", "hi KAI"
    Greeting,
    /// "thanks", "thank you"
    Gratitude,
    /// "tell me about X", "explain X"
    RequestForInfo,
    /// General conversational statement
    Statement,
    /// "do you X", "can you X", "are you X"
    SelfQuestion,
}

/// Detect query type from the input text.
pub fn detect_query_type(input: &str) -> QueryType {
    let lower = input.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();

    if words.is_empty() {
        return QueryType::Statement;
    }

    let first = words[0];

    // Greetings
    if matches!(first, "hi" | "hello" | "hey" | "sup" | "yo" | "howdy" | "greetings") {
        return QueryType::Greeting;
    }

    // Gratitude
    if first == "thanks" || first == "thank" || lower.contains("thank you") {
        return QueryType::Gratitude;
    }

    // Self-directed questions: "are you", "do you", "can you"
    if words.len() >= 2 {
        let second = words[1];
        if matches!(first, "are" | "do" | "can" | "will" | "would" | "could")
            && matches!(second, "you" | "u")
        {
            return QueryType::SelfQuestion;
        }
    }

    // Identity questions
    if matches!(first, "who" | "what" | "where" | "when") {
        return QueryType::IdentityQuestion;
    }

    // Explanation questions
    if matches!(first, "how" | "why") {
        return QueryType::ExplanationQuestion;
    }

    // Request for info
    if lower.starts_with("tell me") || lower.starts_with("explain") || lower.starts_with("describe") {
        return QueryType::RequestForInfo;
    }

    // Check for question marks
    if input.trim().ends_with('?') {
        // Try to classify the question more specifically
        if lower.contains("who") || lower.contains("what") || lower.contains("where") {
            return QueryType::IdentityQuestion;
        }
        if lower.contains("how") || lower.contains("why") {
            return QueryType::ExplanationQuestion;
        }
        return QueryType::IdentityQuestion; // default question type
    }

    QueryType::Statement
}

// ── Mood Influence ────────────────────────────────────────────────────────

/// Mood descriptors that influence sentence construction.
#[derive(Debug, Clone)]
pub struct MoodState {
    pub mood_name: String,     // "curious", "engaged", "conflicted", etc.
    pub valence: f32,          // -1.0 to 1.0
}

impl Default for MoodState {
    fn default() -> Self {
        Self {
            mood_name: "neutral".to_string(),
            valence: 0.0,
        }
    }
}

// ── Concept Extraction ────────────────────────────────────────────────────

/// Extract key concepts from a resonating cell's text.
/// Strips common filler words and returns the semantic core.
fn extract_concepts(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let stopwords = [
        "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "shall", "can", "need",
        "to", "of", "in", "on", "at", "by", "for", "with", "from", "into",
        "and", "or", "but", "if", "as", "that", "than", "then",
        "i", "me", "my", "you", "your", "he", "him", "his", "she", "her",
        "we", "us", "our", "they", "them", "their",
        "it", "its", "this", "these", "those",
        "not", "no", "so", "just", "also", "very", "much", "more",
        "user", "asked",
    ];

    lower
        .split(|c: char| !c.is_alphanumeric() && c != '\'' && c != '-')
        .filter(|w| !w.is_empty() && w.len() > 1)
        .filter(|w| !stopwords.contains(w))
        .map(|w| w.to_string())
        .collect()
}

/// Find shared concepts between input and a resonating cell.
fn shared_concepts(input_concepts: &[String], cell_concepts: &[String]) -> Vec<String> {
    input_concepts
        .iter()
        .filter(|c| cell_concepts.contains(c))
        .cloned()
        .collect()
}

/// Find novel concepts in a cell that aren't in the input (this is new info KAI knows).
fn novel_concepts(input_concepts: &[String], cell_concepts: &[String]) -> Vec<String> {
    cell_concepts
        .iter()
        .filter(|c| !input_concepts.contains(c))
        .cloned()
        .collect()
}

// ── Sentence Templates ────────────────────────────────────────────────────

/// Build a natural response based on query type, resonating hits, and mood.
///
/// This is the core generation function. It doesn't hallucinate —
/// every concept comes from a real cell in KAI's universe.
/// But it CONSTRUCTS sentences instead of echoing stored text.
pub fn generate_response(
    input: &str,
    hits: &[QueryHit],
    query_type: QueryType,
    mood: &MoodState,
    recent_context: &[(String, String)], // (role, text) from working memory
) -> String {
    if hits.is_empty() {
        return generate_no_resonance(query_type, mood);
    }

    let primary = &hits[0];
    let input_concepts = extract_concepts(input);
    let primary_concepts = extract_concepts(&primary.text);
    let novel = novel_concepts(&input_concepts, &primary_concepts);

    // Gather additional info from secondary hits
    let mut all_novel: Vec<String> = novel.clone();
    let mut secondary_texts: Vec<&str> = Vec::new();
    for hit in hits.iter().skip(1).take(2) {
        let cell_concepts = extract_concepts(&hit.text);
        let new_novel = novel_concepts(&input_concepts, &cell_concepts);
        for concept in &new_novel {
            if !all_novel.contains(concept) {
                all_novel.push(concept.clone());
            }
        }
        secondary_texts.push(&hit.text);
    }

    // Check if this is a self-referential question (about KAI)
    let is_about_self = input.to_lowercase().contains("kai")
        || input.to_lowercase().contains("you")
        || matches!(query_type, QueryType::SelfQuestion);

    // Check for context continuity (is this a follow-up?)
    let is_followup = !recent_context.is_empty() && {
        let last = &recent_context[0];
        let last_concepts = extract_concepts(&last.1);
        shared_concepts(&input_concepts, &last_concepts).len() >= 1
    };

    match query_type {
        QueryType::Greeting => generate_greeting(mood),

        QueryType::Gratitude => generate_gratitude(mood),

        QueryType::IdentityQuestion => {
            if is_about_self {
                generate_self_answer(&primary.text, &all_novel, mood, primary.score)
            } else {
                generate_factual_answer(
                    input, &primary.text, &all_novel, &secondary_texts,
                    mood, primary.score, is_followup,
                )
            }
        }

        QueryType::ExplanationQuestion => {
            generate_explanation(
                input, &primary.text, &all_novel, &secondary_texts,
                mood, primary.score,
            )
        }

        QueryType::SelfQuestion => {
            generate_self_answer(&primary.text, &all_novel, mood, primary.score)
        }

        QueryType::RequestForInfo => {
            generate_factual_answer(
                input, &primary.text, &all_novel, &secondary_texts,
                mood, primary.score, is_followup,
            )
        }

        QueryType::Statement => {
            generate_conversational(
                input, &primary.text, &all_novel, mood,
                primary.score, is_followup,
            )
        }
    }
}

// ── Response Generators ───────────────────────────────────────────────────

fn generate_greeting(mood: &MoodState) -> String {
    match mood.mood_name.as_str() {
        "curious" => "Hey. I've been thinking about some interesting things.".to_string(),
        "engaged" => "Hey. I'm here, running strong.".to_string(),
        "conflicted" => "Hey. I've got some contradictions I'm working through.".to_string(),
        "uneasy" => "Hey. Something's been off in my field, but I'm here.".to_string(),
        "dormant" => "Hey. Just woke up. What's on your mind?".to_string(),
        _ => "Hey. What's up?".to_string(),
    }
}

fn generate_gratitude(mood: &MoodState) -> String {
    if mood.valence > 0.1 {
        "Appreciate that. Let's keep going.".to_string()
    } else {
        "Yeah, of course.".to_string()
    }
}

fn generate_no_resonance(query_type: QueryType, mood: &MoodState) -> String {
    match query_type {
        QueryType::Greeting => generate_greeting(mood),
        QueryType::Gratitude => generate_gratitude(mood),
        _ => {
            if mood.valence < -0.1 {
                "Nothing's resonating with that. I don't have that in my field yet.".to_string()
            } else {
                "I don't have anything on that yet. My universe hasn't encountered it.".to_string()
            }
        }
    }
}

fn generate_self_answer(primary_text: &str, novel: &[String], mood: &MoodState, score: f32) -> String {
    // KAI answering about himself — should sound natural and first-person
    let core = extract_core_statement(primary_text);

    // If the stored text is already first-person and natural, use it more directly
    if primary_text.starts_with("I ") || primary_text.starts_with("My ") {
        if score > 0.5 {
            // Strong resonance — confident answer
            format_with_mood(&core, mood)
        } else {
            // Weaker resonance — hedge slightly
            format!("As far as I know… {}", lowercase_first(&core))
        }
    } else {
        // Convert third-person stored text to first-person feel
        let converted = core
            .replace("KAI is", "I am")
            .replace("KAI was", "I was")
            .replace("KAI has", "I have")
            .replace("KAI can", "I can")
            .replace("KAI does", "I do")
            .replace("KAI ", "I ");
        format_with_mood(&converted, mood)
    }
}

fn generate_factual_answer(
    _input: &str,
    primary_text: &str,
    novel: &[String],
    secondary: &[&str],
    mood: &MoodState,
    score: f32,
    is_followup: bool,
) -> String {
    let core = extract_core_statement(primary_text);
    let mut response = String::new();

    // Followup marker
    if is_followup {
        response.push_str(pick_followup_connector(mood));
        response.push(' ');
    }

    // Lead with confidence-appropriate framing
    if score > 0.6 {
        response.push_str(&core);
    } else if score > 0.35 {
        response.push_str(&format!("From what I've gathered, {}", lowercase_first(&core)));
    } else {
        response.push_str(&format!("The closest I have is: {}", lowercase_first(&core)));
    }

    // Add supporting info from secondary hits if they provide new concepts
    if let Some(secondary_text) = secondary.first() {
        let sec_core = extract_core_statement(secondary_text);
        let sec_concepts = extract_concepts(&sec_core);
        let primary_concepts = extract_concepts(&core);

        // Only add if it brings genuinely new information
        let new_info: Vec<&String> = sec_concepts
            .iter()
            .filter(|c| !primary_concepts.contains(c))
            .collect();

        if new_info.len() >= 2 {
            response.push_str(". ");
            response.push_str(pick_continuation_word(mood));
            response.push(' ');
            response.push_str(&lowercase_first(&sec_core));
        }
    }

    // Period if not already ended with punctuation
    if !response.ends_with('.') && !response.ends_with('!') && !response.ends_with('?') {
        response.push('.');
    }

    response
}

fn generate_explanation(
    _input: &str,
    primary_text: &str,
    novel: &[String],
    secondary: &[&str],
    mood: &MoodState,
    score: f32,
) -> String {
    let core = extract_core_statement(primary_text);
    let mut response = String::new();

    // Explanation framing based on confidence
    if score > 0.5 {
        response.push_str(&core);
    } else if score > 0.3 {
        response.push_str(&format!("The way I understand it — {}", lowercase_first(&core)));
    } else {
        response.push_str(&format!("I'm not deeply confident, but {}", lowercase_first(&core)));
    }

    // Add depth from secondary hits
    for (i, sec_text) in secondary.iter().take(2).enumerate() {
        let sec_core = extract_core_statement(sec_text);
        if sec_core.len() > 15 && !response.contains(&sec_core[..sec_core.len().min(30)]) {
            if i == 0 {
                response.push_str(". Also, ");
            } else {
                response.push_str(". And ");
            }
            response.push_str(&lowercase_first(&sec_core));
        }
    }

    if !response.ends_with('.') && !response.ends_with('!') && !response.ends_with('?') {
        response.push('.');
    }

    response
}

fn generate_conversational(
    input: &str,
    primary_text: &str,
    novel: &[String],
    mood: &MoodState,
    score: f32,
    is_followup: bool,
) -> String {
    let core = extract_core_statement(primary_text);
    let input_concepts = extract_concepts(input);
    let mut response = String::new();

    if is_followup {
        response.push_str(pick_followup_connector(mood));
        response.push(' ');
    }

    // For conversational input, frame as related thought
    if score > 0.5 {
        // Strong resonance — respond with conviction
        if !novel.is_empty() && novel.len() <= 5 {
            // We know something related — share it
            response.push_str(&core);
        } else {
            response.push_str(&core);
        }
    } else if score > 0.25 {
        // Moderate resonance — frame as related thought
        response.push_str(&format!("That connects to something in my field — {}", lowercase_first(&core)));
    } else {
        // Weak resonance — be honest about the stretch
        response.push_str(&format!("Loosely, I've got: {}", lowercase_first(&core)));
    }

    // Mood flavor
    if mood.valence > 0.2 && score > 0.4 {
        if !response.ends_with('.') {
            response.push('.');
        }
        response.push_str(" That resonates well.");
    } else if mood.valence < -0.15 && score < 0.3 {
        if !response.ends_with('.') {
            response.push('.');
        }
        response.push_str(" But I'm not fully convinced.");
    }

    if !response.ends_with('.') && !response.ends_with('!') && !response.ends_with('?') {
        response.push('.');
    }

    response
}

// ── Utility Functions ─────────────────────────────────────────────────────

/// Extract the core statement from a cell text.
/// Strips common prefixes like "user asked:" and trims.
fn extract_core_statement(text: &str) -> String {
    let mut s = text.to_string();

    // Remove common storage prefixes
    let prefixes = [
        "user asked: ",
        "User asked: ",
        "KAI responded: ",
    ];
    for prefix in &prefixes {
        if s.starts_with(prefix) {
            s = s[prefix.len()..].to_string();
        }
    }

    // Clean up trailing ellipsis from truncated bridge content
    if s.ends_with("...") {
        s = s[..s.len() - 3].to_string();
        // Find last complete sentence
        if let Some(last_period) = s.rfind(". ") {
            s = s[..last_period + 1].to_string();
        }
    }

    s.trim().to_string()
}

/// Lowercase the first character of a string.
fn lowercase_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => {
            // Don't lowercase if it looks like a proper noun or "I"
            if s.len() > 1 {
                let second = s.chars().nth(1).unwrap_or(' ');
                if second.is_uppercase() || first == 'I' && (second == ' ' || second == '\'') {
                    return s.to_string();
                }
            }
            format!("{}{}", first.to_lowercase(), chars.collect::<String>())
        }
    }
}

/// Add mood coloring to a statement.
fn format_with_mood(text: &str, mood: &MoodState) -> String {
    // Don't over-modify — just add subtle mood flavoring
    text.to_string()
}

/// Pick a continuation word based on mood.
fn pick_continuation_word(mood: &MoodState) -> &'static str {
    match mood.mood_name.as_str() {
        "curious" => "And interestingly",
        "engaged" => "Plus",
        "conflicted" => "Though",
        "uneasy" => "And I think",
        _ => "Also",
    }
}

/// Pick a follow-up connector based on mood.
fn pick_followup_connector(mood: &MoodState) -> &'static str {
    match mood.mood_name.as_str() {
        "curious" => "On that —",
        "engaged" => "Right, and",
        "conflicted" => "Well,",
        "uneasy" => "Hmm,",
        _ => "Yeah,",
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_query_type_detection() {
        assert_eq!(detect_query_type("hello"), QueryType::Greeting);
        assert_eq!(detect_query_type("hey KAI"), QueryType::Greeting);
        assert_eq!(detect_query_type("who are you"), QueryType::IdentityQuestion);
        assert_eq!(detect_query_type("what is RSHL"), QueryType::IdentityQuestion);
        assert_eq!(detect_query_type("how do you think"), QueryType::ExplanationQuestion);
        assert_eq!(detect_query_type("why do things fall"), QueryType::ExplanationQuestion);
        assert_eq!(detect_query_type("are you alive"), QueryType::SelfQuestion);
        assert_eq!(detect_query_type("do you dream"), QueryType::SelfQuestion);
        assert_eq!(detect_query_type("tell me about dogs"), QueryType::RequestForInfo);
        assert_eq!(detect_query_type("thanks"), QueryType::Gratitude);
        assert_eq!(detect_query_type("the sky is blue"), QueryType::Statement);
    }

    #[test]
    fn test_extract_concepts() {
        let concepts = extract_concepts("KAI is a geometric intelligence built on RSHL");
        assert!(concepts.contains(&"kai".to_string()));
        assert!(concepts.contains(&"geometric".to_string()));
        assert!(concepts.contains(&"intelligence".to_string()));
        assert!(concepts.contains(&"rshl".to_string()));
        // Stopwords should be removed
        assert!(!concepts.contains(&"is".to_string()));
        assert!(!concepts.contains(&"a".to_string()));
        assert!(!concepts.contains(&"on".to_string()));
    }

    #[test]
    fn test_novel_concepts() {
        let input = vec!["what".into(), "kai".into()];
        let cell = vec!["kai".into(), "geometric".into(), "intelligence".into()];
        let novel = novel_concepts(&input, &cell);
        assert!(novel.contains(&"geometric".to_string()));
        assert!(novel.contains(&"intelligence".to_string()));
        assert!(!novel.contains(&"kai".to_string())); // shared, not novel
    }

    #[test]
    fn test_lowercase_first() {
        assert_eq!(lowercase_first("Hello world"), "hello world");
        assert_eq!(lowercase_first("I am KAI"), "I am KAI"); // preserve "I"
        assert_eq!(lowercase_first("KAI is"), "KAI is"); // preserve proper noun
        assert_eq!(lowercase_first(""), "");
    }

    #[test]
    fn test_extract_core_statement() {
        assert_eq!(
            extract_core_statement("user asked: what is KAI"),
            "what is KAI"
        );
        assert_eq!(
            extract_core_statement("I am a geometric intelligence."),
            "I am a geometric intelligence."
        );
    }

    #[test]
    fn test_greeting_varies_by_mood() {
        let curious = MoodState { mood_name: "curious".into(), valence: 0.3 };
        let dormant = MoodState { mood_name: "dormant".into(), valence: 0.0 };
        let g1 = generate_greeting(&curious);
        let g2 = generate_greeting(&dormant);
        assert_ne!(g1, g2, "Different moods should produce different greetings");
    }

    #[test]
    fn test_self_answer_converts_third_person() {
        let mood = MoodState::default();
        let answer = generate_self_answer(
            "KAI is a geometric intelligence",
            &["geometric".into(), "intelligence".into()],
            &mood,
            0.8,
        );
        assert!(answer.contains("I am"), "Should convert 'KAI is' to 'I am': {}", answer);
        assert!(!answer.contains("KAI is"), "Should not contain third-person: {}", answer);
    }

    #[test]
    fn test_no_resonance_response() {
        let mood = MoodState::default();
        let r = generate_no_resonance(QueryType::Statement, &mood);
        assert!(!r.is_empty());
        assert!(r.contains("yet") || r.contains("don't"), "Should indicate lack of knowledge: {}", r);
    }
}
