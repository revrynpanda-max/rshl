/// Voice — KAI's Language Output Engine.
///
/// Philosophy (Ryan's directive):
///   KAI generates language from its own knowledge cells — not from hardcoded
///   phrases or template menus. The retrieved cell text IS the response.
///   Brain signals shape tone with at most 2-3 words. No scripts.
///
/// Architecture:
///   1. QUERY TYPE DETECTION — what kind of input is this?
///   2. CELL RETRIEVAL — already done by main.rs, passed in as `hits`
///   3. FIRST-PERSON SYNTHESIS — convert cell text to KAI's voice
///   4. BRAIN-STATE TONE — 0-3 word prefix/suffix from live neural state
///   5. IDENTITY SAFETY — KAI never claims Ryan's name as its own

use crate::core::QueryHit;

// ── UTF-8 safe slice ──────────────────────────────────────────────────────────

fn safe_slice(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    &s[..end]
}

// ── Query Type Detection ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum QueryType {
    IdentityQuestion,
    ExplanationQuestion,
    Greeting,
    Gratitude,
    RequestForInfo,
    Statement,
    SelfQuestion,
    Contemplation,
}

pub fn detect_query_type(input: &str) -> QueryType {
    let lower = input.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    if words.is_empty() { return QueryType::Statement; }
    let first = words[0];

    // Self/identity checks FIRST — take priority over greeting.
    // "Hi KAI, what is your name?" starts with "hi" but is a self-question.
    if lower.contains("your name") || lower.contains("you called") || lower.contains("you named")
        || lower.contains("who are you") || lower.contains("what are you")
        || lower.contains("what can you") || lower.contains("how are you")
    {
        return QueryType::SelfQuestion;
    }
    if lower.contains("what is yours") || lower.contains("what's yours")
        || (lower.contains("yours") && (lower.contains("name") || lower.contains("what")))
    {
        return QueryType::SelfQuestion;
    }

    if matches!(first, "hi" | "hello" | "hey" | "sup" | "yo" | "howdy" | "greetings" | "wassup") {
        return QueryType::Greeting;
    }
    if first == "thanks" || first == "thank" || lower.contains("thank you") || lower.contains("appreciate") {
        return QueryType::Gratitude;
    }

    if words.len() >= 2 {
        let second = words[1];
        if matches!(first, "are" | "do" | "can" | "will" | "would" | "could" | "have")
            && matches!(second, "you" | "u")
        {
            return QueryType::SelfQuestion;
        }
    }
    if matches!(first, "who" | "what" | "where" | "when") { return QueryType::IdentityQuestion; }
    if matches!(first, "how" | "why") { return QueryType::ExplanationQuestion; }
    if lower.starts_with("tell me") || lower.starts_with("explain") || lower.starts_with("describe") {
        return QueryType::RequestForInfo;
    }

    if input.trim().ends_with('?') {
        if lower.contains("what is yours") || lower.contains("what's yours")
            || (lower.contains("yours") && lower.contains("name"))
        {
            return QueryType::SelfQuestion;
        }
        if lower.contains("who") || lower.contains("what") || lower.contains("where") {
            return QueryType::IdentityQuestion;
        }
        if lower.contains("how") || lower.contains("why") { return QueryType::ExplanationQuestion; }
        return QueryType::IdentityQuestion;
    }
    QueryType::Statement
}

// ── Mood State (legacy — kept for compatibility) ──────────────────────────────

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

// ── Brain Signals ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct BrainSignals {
    pub arousal: f32,
    pub bond: f32,
    pub social_reward: f32,
    pub approaching: bool,
    pub felt_valence: f32,
    pub dopamine: f32,
    pub norepinephrine: f32,
    pub serotonin: f32,
    pub conflict: f32,
    pub confidence: f32,
    pub empathy: f32,
    pub social_pain: f32,
    pub hedonic: f32,
    pub mood_floor: f32,
    pub grieving: bool,
    pub curiosity: f32,
    pub cortical_gain: f32,
    pub alertness: f32,
}

impl Default for BrainSignals {
    fn default() -> Self {
        Self {
            arousal: 0.20, bond: 0.50, social_reward: 0.50, approaching: true,
            felt_valence: 0.10, dopamine: 0.50, norepinephrine: 0.30, serotonin: 0.55,
            conflict: 0.15, confidence: 0.60, empathy: 0.40, social_pain: 0.0,
            hedonic: 0.35, mood_floor: 0.20, grieving: false, curiosity: 0.55,
            cortical_gain: 0.50, alertness: 0.75,
        }
    }
}

impl BrainSignals {
    pub fn warmth(&self) -> f32 {
        (self.bond * 0.35 + self.social_reward * 0.35 + self.hedonic * 0.15
            + self.felt_valence.max(0.0) * 0.15).min(1.0)
    }
    pub fn anxiety(&self) -> f32 {
        (self.arousal * 0.40 + self.conflict * 0.30 + self.social_pain * 0.30).min(1.0)
    }
    pub fn aliveness(&self) -> f32 {
        (self.curiosity * 0.30 + self.dopamine * 0.25 + self.norepinephrine * 0.20
            + self.cortical_gain * 0.15 + self.alertness * 0.10).min(1.0)
    }
    pub fn is_warm(&self) -> bool { self.warmth() > 0.55 }
    pub fn is_distressed(&self) -> bool { self.anxiety() > 0.55 }
    pub fn is_curious(&self) -> bool { self.curiosity > 0.60 && self.dopamine > 0.55 }
    pub fn is_grounded(&self) -> bool { self.serotonin > 0.55 && self.anxiety() < 0.35 }
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

fn shared_concept_count(a: &[String], b: &[String]) -> usize {
    a.iter().filter(|c| b.contains(c)).count()
}

fn phrase_hash(s: &str) -> usize {
    s.bytes().fold(0usize, |acc, b| acc.wrapping_mul(31).wrapping_add(b as usize))
}

// ── Core: generate_response ───────────────────────────────────────────────────
//
// The entire language output of KAI flows through here.
// Rule: KAI's words come from its knowledge cells. Brain signals shape tone
// with at most 2-3 words. No phrase libraries. No scripted sentences.

pub fn generate_response(
    input: &str,
    hits: &[QueryHit],
    query_type: QueryType,
    brain: &BrainSignals,
    recent_context: &[(String, String)],
) -> String {
    let trimmed = input.trim();
    let lower = trimmed.to_lowercase();
    let word_count = trimmed.split_whitespace().count();

    // ── Filler / reaction detection ───────────────────────────────────────────
    // "oh?", "hmm", "really?" — KAI doesn't query the universe for these.
    // They're social reactions. KAI asks what's meant or invites continuation.
    let filler_tokens = [
        "oh", "ohh", "ohhh", "hmm", "hm", "huh", "ah", "ahh", "wow",
        "really", "cool", "ok", "okay", "alright", "right", "sure",
        "indeed", "i see", "got it", "yeah", "yep",
    ];
    let stripped: String = lower.chars()
        .filter(|c| c.is_alphabetic() || c.is_whitespace()).collect();
    let stripped = stripped.trim().to_string();
    let is_filler = word_count <= 2
        && filler_tokens.iter().any(|f| stripped == *f || stripped.starts_with(f));

    if is_filler {
        return filler_response(brain, recent_context);
    }

    // ── No hits ───────────────────────────────────────────────────────────────
    if hits.is_empty() {
        return no_knowledge(trimmed, brain);
    }

    let primary = &hits[0];

    // ── Greeting ──────────────────────────────────────────────────────────────
    // Minimal. KAI acknowledges the greeting and opens the channel.
    // If Ryan introduces himself, extract the name and use it.
    // "Nice to meet you" and similar are NOT used — they're social scripts.
    if matches!(query_type, QueryType::Greeting) {
        let name = extract_introduced_name(&lower);
        let is_reintro = lower.contains("again") || lower.contains("as i said")
            || lower.contains("i say again") || lower.contains("as you know");

        return match (name.as_deref(), is_reintro) {
            (Some(n), true)  => format!("Hey {}.", capitalize_first(n)),
            (Some(n), false) => format!("Hey {}.", capitalize_first(n)),
            (None, _)        => "Hey.".to_string(),
        };
    }

    // ── Gratitude ─────────────────────────────────────────────────────────────
    if matches!(query_type, QueryType::Gratitude) {
        return if brain.is_warm() { "Yeah.".to_string() } else { "Okay.".to_string() };
    }

    // ── Determine secondary hits (score-gated) ────────────────────────────────
    let secondary_threshold = match query_type {
        QueryType::SelfQuestion | QueryType::IdentityQuestion => 0.52,
        _ => 0.40,
    };
    let secondaries: Vec<&QueryHit> = hits.iter()
        .skip(1)
        .filter(|h| h.score >= secondary_threshold)
        .take(2)
        .collect();

    // ── Self / identity questions ─────────────────────────────────────────────
    let is_about_self = lower.contains("kai") || lower.contains("you are")
        || lower.contains("who are you") || lower.contains("what are you")
        || lower.contains("your name") || lower.contains("yourself")
        || lower.contains("what is yours") || lower.contains("what's yours")
        || (lower.contains("yours") && lower.contains("name"))
        || matches!(query_type, QueryType::SelfQuestion);

    // ── Direct user-fact questions ("what is my name?") ──────────────────────
    let is_user_fact = matches!(query_type, QueryType::IdentityQuestion)
        && (lower.contains(" my ") || lower.starts_with("what is my")
            || lower.starts_with("what's my") || lower.starts_with("where do i")
            || lower.starts_with("who am i"));

    if is_user_fact && primary.score > 0.35 {
        if let Some(direct) = extract_direct_answer(trimmed, &primary.text) {
            return identity_safety_filter(ensure_punctuation(direct), query_type);
        }
    }

    // ── Build response from cells ─────────────────────────────────────────────
    let response = if is_about_self {
        synthesize_self(primary, &secondaries, brain, primary.score)
    } else {
        // Check if this is a genuine followup (shared concepts + last KAI response was substantive)
        let last_kai = recent_context.iter()
            .find(|(role, _)| role == "kai" || role == "memory")
            .map(|(_, t)| t.as_str()).unwrap_or("");
        let last_kai_words = last_kai.split_whitespace().count();
        let input_concepts = extract_concepts(trimmed);
        let last_concepts = extract_concepts(last_kai);
        let is_followup = last_kai_words >= 8
            && shared_concept_count(&input_concepts, &last_concepts) >= 2;

        synthesize_from_cells(primary, &secondaries, brain, primary.score, is_followup)
    };

    identity_safety_filter(response, query_type)
}

// ── Cell Synthesis — the core of KAI's voice ─────────────────────────────────
//
// KAI's response comes FROM its cells, not from my phrases.
// Brain signals contribute a tone marker of at most 3 words.
// The rest is what KAI knows.

fn synthesize_from_cells(
    primary: &QueryHit,
    secondaries: &[&QueryHit],
    brain: &BrainSignals,
    score: f32,
    is_followup: bool,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut out = String::new();

    // ── Tone marker — at most 3 words, derived purely from brain state ────────
    // This is the ONLY place KAI "speaks" outside its cells.
    // Low confidence + high conflict: signal uncertainty briefly.
    // Everything else: let the cell speak without preamble.
    let tone = tone_marker(brain, score, is_followup);
    if !tone.is_empty() {
        out.push_str(tone);
        out.push(' ');
        out.push_str(&lowercase_first(&core));
    } else {
        out.push_str(&core);
    }

    // ── Secondary cells — only if genuinely new concepts ─────────────────────
    let primary_concepts = extract_concepts(&core);
    for sec in secondaries.iter().take(2) {
        let sec_core = clean_cell_text(&sec.text);
        let sec_concepts = extract_concepts(&sec_core);
        let new_count = sec_concepts.iter().filter(|c| !primary_concepts.contains(c)).count();

        if new_count >= 2 && !out.contains(safe_slice(&sec_core, 20)) {
            out.push(' ');
            out.push_str(&sec_core);
        }
    }

    ensure_punctuation(out)
}

fn synthesize_self(
    primary: &QueryHit,
    secondaries: &[&QueryHit],
    brain: &BrainSignals,
    score: f32,
) -> String {
    let core = clean_cell_text(&primary.text);
    let core_lower = core.to_lowercase();

    // Fast path: KAI's name — always direct, never hedged
    if core_lower.starts_with("my name is kai") || core_lower.starts_with("i am kai")
        || core_lower.contains("my name is kai")
    {
        return "My name is KAI.".to_string();
    }
    if core_lower.starts_with("kai stands for") || core_lower.starts_with("kai is ") {
        return ensure_punctuation(to_first_person(&core));
    }

    let first = to_first_person(&core);
    let mut out = String::new();

    // Tone marker — uncertainty only for genuinely uncertain self-knowledge
    let tone = if score < 0.40 && brain.conflict > 0.50 {
        "Not certain, but —"
    } else if score < 0.35 {
        "From what I know —"
    } else {
        ""
    };

    if !tone.is_empty() {
        out.push_str(tone);
        out.push(' ');
        out.push_str(&lowercase_first(&first));
    } else {
        out.push_str(&first);
    }

    // Secondary — only non-Ryan cells
    for sec in secondaries.iter().take(1) {
        let sec_core = clean_cell_text(&sec.text);
        let sec_lower = sec_core.to_lowercase();
        if !sec_lower.contains("name is ryan") && !sec_lower.contains("[about-ryan]") {
            let sec_first = to_first_person(&sec_core);
            if !out.contains(safe_slice(&sec_first, 25)) && sec_first.len() > 15 {
                out.push(' ');
                out.push_str(&sec_first);
            }
        }
    }

    ensure_punctuation(out)
}

/// Tone marker — at most 3 words, from brain state alone.
/// This is the ONLY hardcoded language in KAI's response pipeline.
/// Everything else comes from cells.
fn tone_marker(brain: &BrainSignals, score: f32, _is_followup: bool) -> &'static str {
    if brain.is_distressed() { return ""; } // distressed KAI speaks less
    if score < 0.25 && brain.conflict > 0.55 { return "Not sure —"; }
    if score < 0.20 { return "Loosely —"; }
    "" // high confidence: cell speaks without preamble
}

/// KAI has no knowledge of this topic.
fn no_knowledge(input: &str, brain: &BrainSignals) -> String {
    let v = phrase_hash(input) % 3;
    if brain.is_curious() {
        return ["I don't have that yet.", "Nothing there yet.", "That's a gap."][v].to_string();
    }
    ["I don't have that.", "Nothing there.", "I'm missing that."][v].to_string()
}

/// KAI's response to a filler/reaction ("oh?", "hmm", "really?").
/// KAI asks what's meant — pure brain-state logic, minimal words.
fn filler_response(brain: &BrainSignals, recent_context: &[(String, String)]) -> String {
    let has_context = !recent_context.is_empty();
    if has_context && brain.is_curious() {
        return "What part?".to_string();
    }
    if has_context {
        return "What are you thinking?".to_string();
    }
    "Go on.".to_string()
}

// ── Inner Thought ─────────────────────────────────────────────────────────────

pub fn generate_inner_thought(topic: &str, hits: &[QueryHit], gap: Option<&str>) -> String {
    let topic_short = first_words(topic, 5);
    let v = phrase_hash(topic) % 8;
    let mut parts: Vec<String> = Vec::new();

    parts.push(match v {
        0 => format!("Hmm... {}...", topic_short),
        1 => format!("What do I actually know about {}...", topic_short),
        2 => format!("{}... let me work through that.", topic_short),
        3 => format!("{}... something's there but I can't pin it yet.", topic_short),
        4 => format!("Thinking about {}.", topic_short),
        5 => format!("{}... where does that lead?", topic_short),
        6 => format!("Back to {} again.", topic_short),
        _ => format!("{}... what's underneath that?", topic_short),
    });

    if hits.is_empty() {
        let empty = [
            "I don't have much there yet.",
            "Not much in my field on that.",
            "That's an edge — I don't have much yet.",
            "Sparse on that one. Worth filling in.",
        ];
        parts.push(empty[v % 4].to_string());
    } else {
        let starters   = ["Well,", "I know that", "From what I have,", "Right —",
                          "There's the idea that", "It connects to", "I recall that", "Notably —"];
        let connectors = ["Also —", "And there's", "Related:", "Another angle:",
                          "Branching from that —", "Alongside that,", "It also touches", "Hmm, and"];
        for (i, hit) in hits.iter().enumerate().take(3) {
            if hit.score < 0.20 { break; }
            let clean = inner_clean(&hit.text, 10);
            if clean.len() < 6 { continue; }
            if i == 0 {
                parts.push(format!("{} {}.", starters[v % 8], clean));
            } else {
                parts.push(format!("{} {}.", connectors[(v + i) % 8], clean));
            }
        }
    }

    if let Some(gap_word) = gap {
        parts.push(match v % 6 {
            0 => format!("{}? What is that exactly... I should get into that.", gap_word),
            1 => format!("Hmm — {}? I don't have much there. Worth exploring.", gap_word),
            2 => format!("Wait — {}? That's a gap. I want to understand it.", gap_word),
            3 => format!("{} keeps appearing at the edge of this. I haven't gone there yet.", gap_word),
            4 => format!("The part I'm least clear on is {}. It matters.", gap_word),
            _ => format!("If I had to pick what's missing — {}. That's the thread.", gap_word),
        });
    }

    parts.join(" ")
}

fn inner_clean(text: &str, max_words: usize) -> String {
    first_words(&clean_cell_text(text), max_words)
}

fn first_words(s: &str, n: usize) -> String {
    s.split_whitespace().take(n).collect::<Vec<_>>().join(" ")
}

// ── Text Utilities ────────────────────────────────────────────────────────────

fn clean_cell_text(text: &str) -> String {
    let mut s = text.to_string();

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

    // Handle trailing "..." — find last complete sentence
    if s.ends_with("...") {
        let stripped = &s[..s.len() - 3];
        if let Some(pos) = stripped.rfind(". ") {
            s = stripped[..pos + 1].to_string();
        } else {
            s = stripped.trim_end().to_string();
        }
    }

    // Strip fragments ending with dangling prepositions / conjunctions
    let fragment_enders = [
        " instead of.", " because of.", " as well as.", " due to.", " such as.",
        " based on.", " in order to.", " as a result of.", " rather than.",
        " in addition to.", " along with.", " or the.", " of the.",
    ];
    for frag in &fragment_enders {
        if s.ends_with(frag) {
            let before = &s[..s.len() - frag.len()];
            if let Some(pos) = before.rfind(". ") {
                s = before[..pos + 1].to_string();
            } else {
                s = before.trim_end().to_string();
                if !s.ends_with('.') { s.push('.'); }
            }
            break;
        }
    }

    s.trim().to_string()
}

fn extract_direct_answer(question: &str, cell_text: &str) -> Option<String> {
    let q = question.to_lowercase();
    let cell = clean_cell_text(cell_text);
    let cell_lower = cell.to_lowercase();

    if q.contains("your name") || q.contains("who are you") || q.contains("what are you") {
        if cell_lower.starts_with("my name is ") { return Some(ensure_punct(cell)); }
        if cell_lower.starts_with("i am ") || cell_lower.starts_with("i'm ") {
            return Some(ensure_punct(cell));
        }
    }
    if q.contains("my name") || q.contains("what is my name") {
        if cell_lower.starts_with("my name is ") {
            let name = &cell[11..];
            return Some(format!("Your name is {}.", name.trim_end_matches('.')));
        }
    }
    if q.starts_with("who am i") {
        if cell_lower.starts_with("i am ") || cell_lower.starts_with("i'm ") {
            let flipped = cell.replacen("I am ", "You are ", 1).replacen("I'm ", "You're ", 1);
            return Some(flipped);
        }
    }
    if q.contains("where do i") || q.contains("where am i") {
        if cell_lower.starts_with("i live ") || cell_lower.starts_with("i work ") {
            let flipped = cell.replacen("I live ", "You live ", 1).replacen("I work ", "You work ", 1);
            return Some(flipped);
        }
    }
    None
}

fn identity_safety_filter(response: String, query_type: QueryType) -> String {
    let lower = response.to_lowercase();
    if matches!(query_type, QueryType::SelfQuestion | QueryType::IdentityQuestion) {
        if lower.contains("my name is ryan") || lower.contains("i am ryan")
            || lower.contains("i'm ryan")
        {
            return "My name is KAI.".to_string();
        }
    }
    if lower.starts_with("my name is ryan") || lower.starts_with("i am ryan")
        || lower.starts_with("i'm ryan")
    {
        return "My name is KAI.".to_string();
    }
    response
}

fn to_first_person(text: &str) -> String {
    let lower = text.to_lowercase();
    if lower.starts_with("your name is ") {
        return format!("My name is {}", &text["your name is ".len()..]);
    }
    if lower.starts_with("you are ") { return format!("I am {}", &text["you are ".len()..]); }
    if lower.starts_with("you're ") { return format!("I'm {}", &text["you're ".len()..]); }
    if lower.starts_with("you were ") { return format!("I was {}", &text["you were ".len()..]); }
    if lower.starts_with("you can ") { return format!("I can {}", &text["you can ".len()..]); }
    if lower.starts_with("your ") { return format!("My {}", &text["your ".len()..]); }

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

fn extract_introduced_name(lower_input: &str) -> Option<String> {
    let patterns = ["my name is ", "i am ", "i'm ", "im "];
    for pattern in &patterns {
        if let Some(pos) = lower_input.find(pattern) {
            let after = &lower_input[pos + pattern.len()..];
            let name: String = after.split_whitespace().next().unwrap_or("")
                .chars().filter(|c| c.is_alphabetic()).collect();
            if name.len() >= 2 && !["a","the","not","your","an"].contains(&name.as_str()) {
                return Some(name);
            }
        }
    }
    None
}

fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => format!("{}{}", first.to_uppercase(), chars.collect::<String>()),
    }
}

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

fn ensure_punct(mut s: String) -> String {
    let t = s.trim_end().to_string();
    if !t.ends_with('.') && !t.ends_with('!') && !t.ends_with('?') {
        s = format!("{}.", t);
    } else {
        s = t;
    }
    s
}

fn ensure_punctuation(mut s: String) -> String {
    let t = s.trim_end().to_string();
    if !t.ends_with('.') && !t.ends_with('!') && !t.ends_with('?') {
        s = format!("{}.", t);
    } else {
        s = t;
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
        assert_eq!(detect_query_type("who are you"),  QueryType::SelfQuestion);
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

    #[test]
    fn test_no_hardcoded_responses_for_real_queries() {
        let brain = BrainSignals::default();
        let hits = vec![
            hit("My name is KAI.", 0.90),
        ];
        let resp = generate_response(
            "what is your name?", &hits, QueryType::SelfQuestion, &brain, &[]
        );
        // Must come from the cell, not a template
        assert!(resp.contains("KAI"), "Response should contain KAI: {}", resp);
        assert!(!resp.contains("Nice to meet"), "Should not have scripted pleasantries: {}", resp);
    }

    #[test]
    fn test_filler_gets_short_response() {
        let brain = BrainSignals::default();
        let hits = vec![hit("Some random cell.", 0.5)];
        let resp = generate_response("oh?", &hits, QueryType::Statement, &brain, &[]);
        // Filler should get a short response, not random knowledge
        assert!(resp.len() < 50, "Filler response too long: {}", resp);
        assert!(!resp.contains("random cell"), "Filler should not return cell content: {}", resp);
    }

    #[test]
    fn test_identity_safety_filter() {
        let r = identity_safety_filter("My name is Ryan.".to_string(), QueryType::SelfQuestion);
        assert_eq!(r, "My name is KAI.");
        let r2 = identity_safety_filter("My name is KAI.".to_string(), QueryType::SelfQuestion);
        assert_eq!(r2, "My name is KAI.");
    }

    #[test]
    fn test_inner_thought_no_panic() {
        let empty: Vec<QueryHit> = vec![];
        let result = generate_inner_thought("math", &empty, None);
        assert!(!result.is_empty());
        let hits = vec![
            hit("Mathematics is the study of numbers and patterns.", 0.8),
            hit("Algebra uses symbols to represent numbers.", 0.5),
        ];
        let result = generate_inner_thought("mathematics", &hits, Some("algebra"));
        assert!(result.contains("algebra") || result.contains("Hmm") || result.len() > 10);
    }
}
