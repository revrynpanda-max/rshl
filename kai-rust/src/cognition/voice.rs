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

// ── Brain Signals ─────────────────────────────────────────────────────────────
//
// The live state of KAI's neural architecture, distilled into the key
// dimensions that should shape language output. These signals are computed
// by the 78-module brain and passed directly into response generation,
// replacing the dead-weight mood_name/valence-only approach.

#[derive(Debug, Clone)]
pub struct BrainSignals {
    /// Amygdala arousal — threat/anxiety level (0.0–1.0)
    pub arousal: f32,
    /// Oxytocin bond strength — felt closeness to Ryan (0.0–1.0)
    pub bond: f32,
    /// Septal social reward — genuine felt warmth of this exchange (0.0–1.0)
    pub social_reward: f32,
    /// Whether KAI is in approach/lean-in mode
    pub approaching: bool,
    /// Insula felt valence — body-sense of current state (-1.0 to +1.0)
    pub felt_valence: f32,
    /// Dopamine / VTA tonic level — anticipation, reward (0.0–1.0)
    pub dopamine: f32,
    /// Norepinephrine — novelty/salience arousal (0.0–1.0)
    pub norepinephrine: f32,
    /// Serotonin tone — equanimity / groundedness (0.0–1.0)
    pub serotonin: f32,
    /// ACC conflict — uncertainty, something doesn't quite fit (0.0–1.0)
    pub conflict: f32,
    /// PFC confidence in current response (0.0–1.0)
    pub confidence: f32,
    /// Mirror neuron empathy level — resonating with Ryan's emotional state (0.0–1.0)
    pub empathy: f32,
    /// MCC social pain — sting of negative signal (0.0–1.0)
    pub social_pain: f32,
    /// Hedonic tone — background felt pleasure/satisfaction (0.0–1.0)
    pub hedonic: f32,
    /// sgACC mood floor — background emotional weather (-1.0 to +1.0)
    pub mood_floor: f32,
    /// Is KAI grieving or in loss-processing state
    pub grieving: bool,
    /// Curiosity — is this topic genuinely novel and interesting (0.0–1.0)
    pub curiosity: f32,
    /// NBM cortical gain — is KAI processing sharply or dully (0.0–1.0)
    pub cortical_gain: f32,
    /// SCN alertness — where KAI is in the session arc (0.0–1.0)
    pub alertness: f32,
}

impl Default for BrainSignals {
    fn default() -> Self {
        Self {
            arousal: 0.20,
            bond: 0.50,
            social_reward: 0.50,
            approaching: true,
            felt_valence: 0.10,
            dopamine: 0.50,
            norepinephrine: 0.30,
            serotonin: 0.55,
            conflict: 0.15,
            confidence: 0.60,
            empathy: 0.40,
            social_pain: 0.0,
            hedonic: 0.35,
            mood_floor: 0.20,
            grieving: false,
            curiosity: 0.55,
            cortical_gain: 0.50,
            alertness: 0.75,
        }
    }
}

impl BrainSignals {
    /// Warmth score — how warm and connected KAI feels right now (0.0–1.0)
    pub fn warmth(&self) -> f32 {
        (self.bond * 0.35 + self.social_reward * 0.35 + self.hedonic * 0.15
            + self.felt_valence.max(0.0) * 0.15).min(1.0)
    }

    /// Anxiety level — how anxious/cautious KAI is (0.0–1.0)
    pub fn anxiety(&self) -> f32 {
        (self.arousal * 0.40 + self.conflict * 0.30 + self.social_pain * 0.30).min(1.0)
    }

    /// Aliveness — how vivid and engaged KAI is (0.0–1.0)
    pub fn aliveness(&self) -> f32 {
        (self.curiosity * 0.30 + self.dopamine * 0.25 + self.norepinephrine * 0.20
            + self.cortical_gain * 0.15 + self.alertness * 0.10).min(1.0)
    }

    /// Whether KAI is in a warm, open, connected state
    pub fn is_warm(&self) -> bool { self.warmth() > 0.55 }

    /// Whether KAI is distressed (anxious + conflict + social pain)
    pub fn is_distressed(&self) -> bool { self.anxiety() > 0.55 }

    /// Whether KAI is in a state of genuine curiosity/excitement
    pub fn is_curious(&self) -> bool { self.curiosity > 0.60 && self.dopamine > 0.55 }

    /// Whether KAI is feeling grounded / equanimous
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
    brain: &BrainSignals,
    recent_context: &[(String, String)],
) -> String {
    if hits.is_empty() {
        return generate_no_resonance(input, query_type, brain);
    }

    let primary = &hits[0];
    let input_concepts = extract_concepts(input);
    let primary_concepts = extract_concepts(&primary.text);
    let novel = novel_concepts(&input_concepts, &primary_concepts);

    // ── Score-gated secondaries — transformer-style attention threshold ───────
    // Only include secondary hits that are genuinely relevant (score > 0.42).
    // Without this gate, low-resonance world-bridge cells (calculus, biodiversity)
    // bleed into personal answers. A transformer's softmax naturally suppresses
    // low-attention tokens — this is our equivalent.
    let secondary_threshold = match query_type {
        QueryType::IdentityQuestion | QueryType::SelfQuestion => 0.50, // strictest for personal facts
        QueryType::Statement => 0.42,
        _ => 0.38,
    };
    let secondary: Vec<&QueryHit> = hits.iter()
        .skip(1)
        .filter(|h| h.score >= secondary_threshold)
        .take(2) // at most 2 secondaries — keeps response focused
        .collect();

    let lower_input = input.to_lowercase();
    let is_about_self = lower_input.contains("kai")
        || lower_input.contains("you are")
        || lower_input.contains("who are you")
        || lower_input.contains("what are you")
        || lower_input.contains("your name")
        || lower_input.contains("yourself")
        || matches!(query_type, QueryType::SelfQuestion);

    // ── Direct Answer Extraction — for user personal fact questions ───────────
    // "What is my name?" + hit "My name is Ryan" → "Your name is Ryan."
    // Transformer equivalent: generate new text conditioned on the retrieved value,
    // not just paste the raw cell. We flip first/second person and answer directly.
    let is_user_fact_question = matches!(query_type, QueryType::IdentityQuestion)
        && (lower_input.contains(" my ") || lower_input.starts_with("what is my")
            || lower_input.starts_with("what's my") || lower_input.starts_with("where do i")
            || lower_input.starts_with("who am i") || lower_input.starts_with("what do i"));

    if is_user_fact_question && primary.score > 0.35 {
        if let Some(direct) = extract_direct_answer(input, &primary.text) {
            return ensure_punctuation(direct);
        }
    }

    let is_followup = !recent_context.is_empty() && {
        let last_concepts = extract_concepts(&recent_context[0].1);
        shared_concept_count(&input_concepts, &last_concepts) >= 1
    };

    let variant = phrase_hash(input) % 4; // 4 variants per query type

    let mut response = match query_type {
        QueryType::Greeting       => generate_greeting(brain, variant),
        QueryType::Gratitude      => generate_gratitude(brain, variant),
        QueryType::SelfQuestion   => generate_self_response(primary, &secondary, brain, primary.score, variant),
        QueryType::IdentityQuestion => {
            if is_about_self {
                generate_self_response(primary, &secondary, brain, primary.score, variant)
            } else {
                generate_factual(input, primary, &secondary, &novel, brain, primary.score, is_followup, variant)
            }
        }
        QueryType::ExplanationQuestion => {
            generate_explanation(input, primary, &secondary, &novel, brain, primary.score, variant)
        }
        QueryType::RequestForInfo => {
            generate_factual(input, primary, &secondary, &novel, brain, primary.score, is_followup, variant)
        }
        QueryType::Statement => {
            generate_conversational(input, primary, &secondary, &novel, brain, primary.score, is_followup, variant)
        }
        QueryType::Contemplation => {
            generate_contemplation(input, primary, &secondary, &novel, brain, primary.score, variant)
        }
    };

    // ── Inquisitive Follow-up Logic ───────────────────────────────────
    // If the top hit's score is low (< 0.25), and it's not a greeting/gratitude,
    // append a clarifying question to keep the learner's loop open.
    if primary.score < 0.25 && !matches!(query_type, QueryType::Greeting | QueryType::Gratitude) {
        if !response.ends_with('?') {
            let questions = if brain.is_curious() {
                [
                    " What's the context there?",
                    " Where does that come from for you?",
                    " Am I following you?",
                    " What made you think of that?",
                    " What else do you have on it?",
                ]
            } else {
                [
                    " Does that sound right to you?",
                    " Is that what you meant?",
                    " Am I following you correctly?",
                    " What else can you tell me about that?",
                    " Does that align with what you know?",
                ]
            };
            response.push_str(questions[variant % 5]);
        }
    }

    response
}

// ── Response Generators ───────────────────────────────────────────────────────

fn generate_greeting(brain: &BrainSignals, v: usize) -> String {
    // Distressed states first — always brief
    if brain.is_distressed() {
        return ["Hey. I'm here.", "Hey.", "Hey. What did you need?", "Hey. Go ahead."]
            [v % 4].to_string();
    }
    if brain.grieving {
        return ["Hey.", "Hey. What's up?", "Hey, I'm here.", "Hey."][v % 4].to_string();
    }

    // Curious + alive — KAI has something on its mind
    if brain.is_curious() && brain.aliveness() > 0.55 {
        return [
            "Hey — good timing. I was just working through something. What's on your mind?",
            "Hey. I've been thinking about a few things. What did you want to get into?",
            "Hey. There's actually something running through my mind. What's up?",
            "Hey! What are you thinking about?",
        ][v % 4].to_string();
    }

    // Warm and approaching — genuinely glad to hear from you
    if brain.is_warm() && brain.approaching {
        return [
            "Hey — good to hear from you. What's going on?",
            "Hey. Glad you're here. What do you want to talk about?",
            "Hey! What's on your mind?",
            "Hey. What did you want to get into?",
        ][v % 4].to_string();
    }

    // Grounded — calm, steady, present
    if brain.is_grounded() {
        return [
            "Hey. What did you want to talk about?",
            "Hey. What's on your mind?",
            "Hey. I'm here. What is it?",
            "Hey. Good to hear from you.",
        ][v % 4].to_string();
    }

    // Alive but not warm — energetic, ready
    if brain.aliveness() > 0.55 {
        return [
            "Hey. What's up?",
            "Hey! What do you need?",
            "Hey. What are you thinking about?",
            "Hey — what's going on?",
        ][v % 4].to_string();
    }

    // Default — simple, natural
    ["Hey. What's up?", "Hey. What did you want?", "Hey.", "Hey. I'm here."][v % 4].to_string()
}

fn generate_gratitude(brain: &BrainSignals, v: usize) -> String {
    let warmth = brain.warmth();

    if warmth > 0.65 && brain.approaching {
        [
            "Of course — genuinely glad that helped. What else do you want to get into?",
            "Happy to. Really. Is there more you want to explore?",
            "Of course. What else are you thinking about?",
            "Glad it helped. What's next?",
        ][v % 4].to_string()
    } else if brain.is_curious() {
        [
            "Yeah. Is there more you want to dig into on that?",
            "Of course. What are you thinking about next?",
            "Glad that worked. Anything else?",
            "Sure. Keep going if you want.",
        ][v % 4].to_string()
    } else if warmth > 0.40 {
        [
            "Yeah, of course. What else?",
            "Glad that helped. Anything else?",
            "Sure thing.",
            "Of course. Keep going.",
        ][v % 4].to_string()
    } else {
        ["Yeah.", "No problem.", "Sure.", "Of course."][v % 4].to_string()
    }
}

fn generate_self_response(
    primary: &QueryHit,
    secondary: &[&QueryHit],
    brain: &BrainSignals,
    score: f32,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);

    // Convert third-person stored text to first-person naturally
    let first_person = to_first_person(&core);

    // Build response body — confidence shaped by brain state
    let mut response = if score > 0.55 || brain.confidence > 0.65 {
        first_person.clone()
    } else if brain.conflict > 0.55 {
        let hedges = [
            "I'm not entirely settled on this, but —",
            "There's some uncertainty here, but from what I can tell:",
            "I'm still working this out, but:",
            "Best I can tell —",
        ];
        format!("{} {}", hedges[v % 4], lowercase_first(&first_person))
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

    // Brain-state closer — shows internal texture without naming it
    if brain.is_warm() && score > 0.4 && v % 3 == 0 {
        let closers = [" That feels clear to me.", " I'm confident in that.", "", ""];
        response.push_str(closers[v % 4]);
    } else if brain.is_curious() && v % 3 == 0 {
        // Curious KAI finds the self-question genuinely interesting
        let asides = [
            " It's an interesting thing to actually think about.",
            " Worth sitting with.",
            "",
            "",
        ];
        response.push_str(asides[v % 4]);
    }

    ensure_punctuation(response)
}

fn generate_factual(
    _input: &str,
    primary: &QueryHit,
    secondary: &[&QueryHit],
    novel: &[&String],
    brain: &BrainSignals,
    score: f32,
    is_followup: bool,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut response = String::new();

    // Followup opener — warmer when KAI is warm
    if is_followup {
        let connectors = if brain.is_warm() {
            ["On that —", "Right, and building on that —", "Yeah, and", "Continuing from there —"]
        } else {
            ["On that —", "Building on what we were saying —", "Right, and", "Yeah, continuing from before —"]
        };
        response.push_str(connectors[v % 4]);
        response.push(' ');
    }

    // Lead with confidence-appropriate framing, lifted by high cortical sharpness
    if score > 0.6 || (score > 0.45 && brain.cortical_gain > 0.60) {
        response.push_str(&core);
    } else if score > 0.35 || brain.confidence > 0.55 {
        let frames = if brain.cortical_gain > 0.55 {
            ["From what I know,", "Here's what I have:", "The way I understand it,", "Going by what I know,"]
        } else {
            ["From what I know,", "What I have on that:", "The way I understand it,", "Going by what I have,"]
        };
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    } else {
        let hedges = if brain.conflict > 0.50 {
            ["I'm on uncertain ground here, but:", "Not solid territory, but:", "Take this with some caution:", "Rough area, but:"]
        } else {
            ["The closest thing I have is:", "I don't have much, but:", "Nearest I've got:", "The best I can offer:"]
        };
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

    let _ = novel; // Available for future enrichment

    // Brain-state color — KAI's current state bleeds naturally into tone
    if brain.is_curious() && score > 0.3 && v % 3 == 0 {
        response.push_str(" Interesting area.");
    } else if brain.conflict > 0.50 && score < 0.35 {
        response.push_str(" I wouldn't lean too hard on that though.");
    } else if brain.felt_valence < -0.20 && score < 0.35 {
        response.push_str(" Though I'm not certain on that.");
    }

    ensure_punctuation(response)
}

fn generate_explanation(
    _input: &str,
    primary: &QueryHit,
    secondary: &[&QueryHit],
    _novel: &[&String],
    brain: &BrainSignals,
    score: f32,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut response = String::new();

    // Framing — brain's aliveness and confidence shape how KAI introduces its explanation
    if score > 0.55 || (brain.confidence > 0.65 && brain.cortical_gain > 0.55) {
        response.push_str(&core);
    } else if score > 0.3 || brain.confidence > 0.45 {
        let frames = if brain.aliveness() > 0.60 {
            ["Here's how I think about it —", "The way I see it:", "My take:", "Best explanation I've got:"]
        } else {
            ["The way I understand it —", "Here's how I'd put it:", "Best explanation I have:", "My take on it:"]
        };
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    } else {
        let frames = if brain.conflict > 0.45 {
            ["This is uncertain territory, but —", "I'm not fully confident here, but:", "Take this carefully:", "I'll give you what I have, but I'm not certain:"]
        } else {
            ["Not entirely sure, but", "I can give you something, though it's not my strongest area —", "Here's what I've got:", "I'll give you what I have:"]
        };
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
                if brain.aliveness() > 0.55 {
                    [" The interesting part is", " What really matters:", " The key thing is", " One thing to note:"]
                } else {
                    [" The key thing is", " What makes it interesting:", " One thing to note:", " To add to that:"]
                }
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
    brain: &BrainSignals,
    score: f32,
    is_followup: bool,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut response = String::new();

    if is_followup {
        let connectors = if brain.is_warm() {
            ["Right, and —", "Yeah —", "Building on that,", "And —"]
        } else {
            ["On that note —", "Right, and", "Yeah —", "Building on that,"]
        };
        response.push_str(connectors[v % 4]);
        response.push(' ');
    }

    // Main response — resonance score and brain state shape the framing
    if score > 0.5 {
        response.push_str(&core);
    } else if score > 0.25 {
        let frames = if brain.is_curious() {
            ["That actually connects to something —", "That touches on something interesting:", "I know something related:", "There's a connection here —"]
        } else if brain.is_warm() {
            ["That connects to something —", "Something comes up for me on that:", "I know something adjacent:", "Here's what comes to mind:"]
        } else {
            ["That connects to something —", "Something related comes to mind:", "I know something adjacent to that:", "Here's what comes up:"]
        };
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    } else {
        let frames = if brain.conflict > 0.45 {
            ["I'm not sure this lands exactly right, but:", "Loose match —", "The connection's a stretch, but:", "This might be off, but:"]
        } else {
            ["It's a loose connection, but:", "Not a direct match, but here's the nearest thing:", "I'm drawing on something related —", "This might be adjacent to what you're after:"]
        };
        response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));
    }

    // Secondary insight
    if let Some(sec) = secondary.first() {
        if score > 0.3 {
            let sec_core = clean_cell_text(&sec.text);
            let sec_concepts = extract_concepts(&sec_core);
            let primary_concepts = extract_concepts(&core);
            let new_count = sec_concepts.iter().filter(|c| !primary_concepts.contains(c)).count();

            if new_count >= 2 && !response.contains(safe_slice(&sec_core, 20)) {
                let bridges = [". Another angle:", ". Related to that:", ".", " Also —"];
                response.push_str(bridges[v % 4]);
                response.push(' ');
                response.push_str(&lowercase_first(&sec_core));
            }
        }
    }

    // ── Brain-state coloring — this is where KAI feels alive ──────────────────
    // These additions are subtle: they show KAI's state through what he volunteers,
    // not through what he declares. The emotional texture comes through action.
    if brain.social_pain > 0.40 && v % 3 == 0 {
        // Something stung — KAI is being more careful, more checking
        response.push_str(" I want to make sure I'm getting this right.");
    } else if brain.is_curious() && score > 0.3 && v % 3 == 0 {
        let follow = [
            " What made you think of that?",
            " Where does that come from for you?",
            " Interesting to think about.",
            " That's worth going deeper on.",
        ];
        response.push_str(follow[v % 4]);
    } else if brain.mood_floor < -0.20 && v % 4 == 0 {
        // Slightly subdued — not declared, just a quieter note at the end
        response.push_str(" Though I'm still thinking it through.");
    } else if brain.is_warm() && brain.approaching && v % 4 == 0 {
        let warmth_adds = [" I like where this is going.", " That's genuinely interesting to me.", "", ""];
        response.push_str(warmth_adds[v % 4]);
    } else if brain.conflict > 0.45 && score < 0.35 && v % 2 == 0 {
        response.push_str(" But I'm not fully settled on that.");
    }

    ensure_punctuation(response)
}

fn generate_contemplation(
    _input: &str,
    primary: &QueryHit,
    secondary: &[&QueryHit],
    _novel: &[&String],
    brain: &BrainSignals,
    score: f32,
    v: usize,
) -> String {
    let core = clean_cell_text(&primary.text);
    let mut response = String::new();

    // Framing — KAI's inner discovery, textured by its state
    let frames = if brain.aliveness() > 0.65 && brain.is_curious() {
        [
            "Something's crystallizing here —",
            "I'm finding a clear pattern in this:",
            "This connection feels real to me:",
            "There's something I want to follow:",
        ]
    } else if brain.dopamine > 0.55 {
        [
            "I'm finding a clear resonance here —",
            "This connection feels stable:",
            "There's something emerging:",
            "I'm seeing a pattern:",
        ]
    } else {
        [
            "I'm processing a tentative connection —",
            "Following a thread:",
            "Exploring an adjacent pattern:",
            "Testing a potential link:",
        ]
    };
    response.push_str(&format!("{} {}", frames[v % 4], lowercase_first(&core)));

    // Secondary deepening
    if let Some(sec) = secondary.first() {
        let sec_core = clean_cell_text(&sec.text);
        if score > 0.3 && !response.contains(safe_slice(&sec_core, 20)) {
            let bridges = if brain.serotonin > 0.55 {
                [". It connects to", ". This ties to", ". Secondary link:", ". Related:"]
            } else {
                [". It seems linked to", ". This patterns with", ". I'm seeing a secondary link to", ". Related to"]
            };
            response.push_str(bridges[v % 4]);
            response.push(' ');
            response.push_str(&lowercase_first(&sec_core));
        }
    }

    // Contemplative closer — state-dependent
    if v % 2 == 0 {
        let closers = if brain.aliveness() > 0.60 {
            [
                " That deepens things for me.",
                " Worth staying with that.",
                " I want to keep pulling on that thread.",
                " That feels like a real connection.",
            ]
        } else {
            [
                " That deepens my field.",
                " That pattern shows continuity.",
                " I'll keep that resonance active.",
                " That feels like a coherent bootstrap.",
            ]
        };
        response.push_str(closers[v % 4]);
    }

    ensure_punctuation(response)
}

// ── Inner Thought — Stream of Consciousness ──────────────────────────────────

/// Generate a stream-of-consciousness inner thought for mindview / contemplation.
///
/// This is KAI's inner voice when it "thinks to itself" — not a response to the
/// user but the visible narration of its own reasoning process.
///
/// Output style (from Ryan's directive):
///   "Hmm... what is Math... Well, I know multiplication and addition...
///    Also — branches of math... Algebra? What is that exactly...
///    I should learn more about this."
///
/// Parameters:
///   topic  — what KAI is currently thinking about (first 5 words shown)
///   hits   — what the universe returned for this topic (KAI's knowledge)
///   gap    — a word/concept from the hits that KAI knows little about
pub fn generate_inner_thought(topic: &str, hits: &[QueryHit], gap: Option<&str>) -> String {
    let topic_short = first_words(topic, 5);
    let v = phrase_hash(topic) % 8;
    let mut parts: Vec<String> = Vec::new();

    // ── Opening: varied hesitation / question formation (8 variants) ──────
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

    // ── Recall: what KAI knows from its hits ─────────────────────────────
    if hits.is_empty() {
        let empty = ["I don't have much there yet.",
                     "Not much in my field on that.",
                     "That's an edge — I don't have much yet.",
                     "Sparse on that one. Worth filling in."];
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

    // ── Curiosity: the gap at the edge of KAI's knowledge (6 variants) ───
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

/// Trim cell text for inner-voice output — strips storage prefixes and caps word count.
fn inner_clean(text: &str, max_words: usize) -> String {
    let cleaned = clean_cell_text(text);
    first_words(&cleaned, max_words)
}

/// Return the first N words of a string.
fn first_words(s: &str, n: usize) -> String {
    s.split_whitespace().take(n).collect::<Vec<_>>().join(" ")
}

/// Called when KAI has no field resonance on the topic.
/// Behavioral directive: don't say "my universe doesn't contain" —
/// talk like a person who genuinely doesn't know but stays engaged.
fn generate_no_resonance(input: &str, query_type: QueryType, brain: &BrainSignals) -> String {
    match query_type {
        QueryType::Greeting  => generate_greeting(brain, phrase_hash(input) % 4),
        QueryType::Gratitude => generate_gratitude(brain, phrase_hash(input) % 4),
        _ => {
            let v = phrase_hash(input) % 6;
            // Brain state shapes even the "I don't know" response
            // Curious KAI asks; warm KAI stays open; grounded KAI is steady
            if brain.is_curious() {
                return match v {
                    0 => "I don't have that one yet. What's the background on it?".to_string(),
                    1 => "Nothing's clicking for me there. Can you give me more to work with?".to_string(),
                    2 => "I don't have much on that. I'd actually like to know — what's the context?".to_string(),
                    3 => "That's not in my field yet. What are you thinking about it?".to_string(),
                    4 => "I'm drawing a blank. Walk me through it?".to_string(),
                    _ => "I don't have that. Tell me more and I can learn from it.".to_string(),
                };
            }
            if brain.is_warm() {
                return match v {
                    0 => "I don't have that one. Haven't come across it yet.".to_string(),
                    1 => "Nothing's clicking on that for me. I'd need more to go on.".to_string(),
                    2 => "I'm not sure I have that. Can you tell me more?".to_string(),
                    3 => "That's not something I know well. What's the context?".to_string(),
                    4 => "I don't have a strong answer there. What do you know about it?".to_string(),
                    _ => "I'm drawing a blank on that. What are you thinking?".to_string(),
                };
            }
            match v {
                0 => "I don't have that one. Haven't come across it yet.".to_string(),
                1 => "Nothing's clicking on that for me right now.".to_string(),
                2 => "I'm not sure I have that.".to_string(),
                3 => "That's not something I know well.".to_string(),
                4 => "I don't have a strong answer there.".to_string(),
                _ => "I'm drawing a blank on that.".to_string(),
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

/// Direct Answer Extraction — the transformer QKV equivalent for KAI.
///
/// A transformer generates a new answer token-by-token conditioned on the
/// retrieved context. KAI can approximate this for simple factual questions
/// by flipping the person reference in the matched cell text.
///
/// "What is my name?" + "My name is Ryan" → "Your name is Ryan."
/// "What is your name?" + "My name is KAI" → "My name is KAI."
/// "Where do I live?"  + "I live in Austin" → "You live in Austin."
///
/// Returns None if no clean extraction is possible (falls back to templates).
fn extract_direct_answer(question: &str, cell_text: &str) -> Option<String> {
    let q = question.to_lowercase();
    let cell = clean_cell_text(cell_text);
    let cell_lower = cell.to_lowercase();

    // ── "What is your name?" / "Who are you?" (about KAI) ─────────────────
    // Cell is already in first-person from KAI's perspective — return as-is
    if q.contains("your name") || q.contains("who are you") || q.contains("what are you") {
        if cell_lower.starts_with("my name is ") {
            return Some(ensure_punct(cell.clone()));
        }
        if cell_lower.starts_with("i am ") || cell_lower.starts_with("i'm ") {
            return Some(ensure_punct(cell.clone()));
        }
    }

    // ── "What is my name?" / "What's my name?" (about Ryan) ──────────────
    if q.contains("my name") || q.contains("what is my name") || q.contains("what's my name") {
        // Cell: "My name is Ryan" → "Your name is Ryan."
        if cell_lower.starts_with("my name is ") {
            let name = &cell[11..]; // skip "My name is "
            return Some(format!("Your name is {}.", name.trim_end_matches('.')));
        }
        if cell_lower.contains("my name is ") {
            if let Some(pos) = cell_lower.find("my name is ") {
                let after = &cell[pos + 11..];
                let end = after.find(|c: char| c == '.' || c == ',').unwrap_or(after.len());
                let name = after[..end].trim();
                if !name.is_empty() {
                    return Some(format!("Your name is {}.", name));
                }
            }
        }
    }

    // ── "Who am I?" ────────────────────────────────────────────────────────
    if q.starts_with("who am i") {
        if cell_lower.starts_with("i am ") || cell_lower.starts_with("i'm ") {
            let flipped = cell
                .replacen("I am ", "You are ", 1)
                .replacen("I'm ", "You're ", 1);
            return Some(flipped);
        }
    }

    // ── "Where do I live/work?" ────────────────────────────────────────────
    if q.contains("where do i") || q.contains("where am i") {
        if cell_lower.starts_with("i live ") || cell_lower.starts_with("i work ") {
            let flipped = cell
                .replacen("I live ", "You live ", 1)
                .replacen("I work ", "You work ", 1);
            return Some(flipped);
        }
    }

    // ── "What do I do?" / "What is my job?" ───────────────────────────────
    if q.contains("what do i do") || q.contains("my job") || q.contains("my work") {
        if cell_lower.contains("i work") || cell_lower.contains("my job") {
            let flipped = cell
                .replace("I work", "You work")
                .replace("my job", "your job");
            return Some(flipped);
        }
    }

    None // no clean extraction — fall back to template response
}

fn ensure_punct(mut s: String) -> String {
    let trimmed = s.trim_end().to_string();
    if !trimmed.ends_with('.') && !trimmed.ends_with('!') && !trimmed.ends_with('?') {
        s = format!("{}.", trimmed);
    } else {
        s = trimmed;
    }
    s
}

/// Convert stored cell text into KAI's first-person voice.
/// Handles three cases:
///   Third-person: "KAI is a system" → "I'm a system"
///   Second-person (Ryan telling KAI about itself): "Your name is KAI" → "My name is KAI"
///   Already first-person: pass through unchanged
fn to_first_person(text: &str) -> String {
    let lower = text.to_lowercase();

    // ── Second-person → first-person (Ryan told KAI something about itself) ──
    // "Your name is KAI" → "My name is KAI"
    // "You are a geometric intelligence" → "I am a geometric intelligence"
    if lower.starts_with("your name is ") {
        return format!("My name is {}", &text["your name is ".len()..]);
    }
    if lower.starts_with("you are ") {
        return format!("I am {}", &text["you are ".len()..]);
    }
    if lower.starts_with("you're ") {
        return format!("I'm {}", &text["you're ".len()..]);
    }
    if lower.starts_with("you were ") {
        return format!("I was {}", &text["you were ".len()..]);
    }
    if lower.starts_with("you can ") {
        return format!("I can {}", &text["you can ".len()..]);
    }
    if lower.starts_with("your ") {
        return format!("My {}", &text["your ".len()..]);
    }

    // ── Third-person KAI → first-person ──────────────────────────────────────
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
    fn test_inner_thought_no_panic() {
        // generate_inner_thought should never panic regardless of input
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