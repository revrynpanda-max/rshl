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
use crate::core::{predictive, ConversationTrace, QueryHit, Universe};

// ── UTF-8 safe slice ──────────────────────────────────────────────────────────

fn safe_slice(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Most recent KAI line in `recent_context`, kept for any path that still
/// wants the raw text (diagnostics, tests). The production opener rotation
/// no longer uses it — that is now handled mechanically by the predictive
/// retrieval in `Universe::predictive_query_by_source`, which penalises
/// cells that just fired via the recency + novelty heads in
/// `core::predictive`.
///
/// Implementation note: `WorkingMemory::recent_context` is newest-first
/// (current user turn is often index `0`). Scanning from the end finds the
/// latest `kai` role in both newest-first and chronological buffers.
#[allow(dead_code)]
fn last_kai_message(recent_context: &[(String, String)]) -> Option<&str> {
    recent_context
        .iter()
        .rev()
        .find(|(role, _)| role == "kai")
        .map(|(_, text)| text.as_str())
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

    // ── Normalize: expand contractions + strip casual openers ────────────────
    // "what's rshl" → "what is rshl", "so how do you" → "how do you"
    let normalized = lower
        .replace("what's ", "what is ")
        .replace("what're ", "what are ")
        .replace("who's ", "who is ")
        .replace("how's ", "how is ")
        .replace("where's ", "where is ")
        .replace("when's ", "when is ")
        .replace("why's ", "why is ")
        .replace("don't ", "do not ")
        .replace("doesn't ", "does not ")
        .replace("didn't ", "did not ")
        .replace("aren't ", "are not ")
        .replace("isn't ", "is not ")
        .replace("can't ", "cannot ")
        .replace("won't ", "will not ")
        .replace("wouldn't ", "would not ");

    // Strip casual leading filler words — "so how do you" → "how do you"
    let casual_openers = [
        "so ",
        "like ",
        "or ",
        "well ",
        "wait ",
        "yo ",
        "ok so ",
        "okay so ",
        "alright so ",
        "bruh ",
        "dude ",
        "man ",
    ];
    let mut stripped = normalized.trim_start().to_string();
    for opener in &casual_openers {
        if stripped.starts_with(opener) {
            stripped = stripped[opener.len()..].to_string();
            break; // one pass is enough
        }
    }

    let words: Vec<&str> = stripped.split_whitespace().collect();
    if words.is_empty() {
        return QueryType::Statement;
    }
    let first = words[0];

    // ── Self/identity checks FIRST (content-based, beats word-order) ─────────
    if lower.contains("your name")
        || lower.contains("you called")
        || lower.contains("you named")
        || lower.contains("who are you")
        || lower.contains("what are you")
        || lower.contains("where are you")
        || lower.contains("where you at")
        || lower.contains("where do you exist")
        || lower.contains("where are u")
        || lower.contains("what can you")
        || lower.contains("how are you")
        || lower.contains("how do you feel")
        || lower.contains("how you feel")
        || lower.contains("you feeling")
    {
        return QueryType::SelfQuestion;
    }
    if lower.contains("what is yours")
        || lower.contains("what's yours")
        || (lower.contains("yours") && (lower.contains("name") || lower.contains("what")))
    {
        return QueryType::SelfQuestion;
    }

    // ── Farewell — before greeting so "later" doesn't get grabbed as greeting ─
    let farewell_words = [
        "bye", "goodbye", "later", "peace", "cya", "adios", "ttyl", "laters",
    ];
    let farewell_phrases = [
        "gotta go",
        "got to go",
        "gonna head",
        "talk later",
        "talk soon",
        "gotta run",
        "gotta head",
        "gotta bounce",
        "heading out",
        "i'm out",
        "im out",
        "signing off",
        "take care",
        "take it easy",
    ];
    let input_stripped = lower.trim_matches(|c: char| !c.is_alphabetic()).to_string();
    let is_farewell = farewell_words
        .iter()
        .any(|f| input_stripped == *f || lower.starts_with(f))
        || farewell_phrases.iter().any(|f| lower.contains(f));
    if is_farewell {
        return QueryType::Gratitude; // Gratitude handler gives "Okay." / "Yeah." — brief and clean
    }

    // ── Greeting — check BEFORE contraction normalization strips "what's" ─────
    // Use `lower` (original) so "what's good"/"what's up" still have the apostrophe
    let greeting_words = [
        "hi",
        "hello",
        "hey",
        "sup",
        "yo",
        "howdy",
        "greetings",
        "wassup",
        "hiya",
        "heya",
    ];
    if greeting_words
        .iter()
        .any(|g| lower.trim() == *g || lower.starts_with(&format!("{} ", g)))
        && lower.split_whitespace().count() <= 3
    {
        return QueryType::Greeting;
    }
    // "what's good", "what's up", "what is up", "what is good" — casual openers
    if (lower.starts_with("what's ")
        || lower.starts_with("whats ")
        || lower.starts_with("what is "))
        && lower.split_whitespace().count() <= 4
    {
        let rest: Vec<&str> = lower.split_whitespace().skip(1).collect();
        let last = rest.last().copied().unwrap_or("");
        if matches!(last, "good" | "up" | "poppin" | "crackin") {
            return QueryType::Greeting;
        }
    }
    if first == "thanks"
        || first == "thank"
        || lower.contains("thank you")
        || lower.contains("appreciate")
    {
        return QueryType::Gratitude;
    }

    // ── "do/does/did/are/can you" → SelfQuestion ─────────────────────────────
    if words.len() >= 2 {
        let second = words[1];
        if matches!(
            first,
            "are" | "do" | "does" | "did" | "can" | "will" | "would" | "could" | "have" | "is"
        ) && matches!(second, "you" | "u" | "your")
        {
            return QueryType::SelfQuestion;
        }
    }

    // ── Question-word routing ─────────────────────────────────────────────────
    if matches!(first, "who" | "what" | "where" | "when") {
        return QueryType::IdentityQuestion;
    }
    if matches!(first, "how" | "why") {
        return QueryType::ExplanationQuestion;
    }
    if stripped.starts_with("tell me")
        || stripped.starts_with("explain")
        || stripped.starts_with("describe")
    {
        return QueryType::RequestForInfo;
    }

    // ── Anything ending with "?" that has known question words inside ─────────
    if input.trim().ends_with('?') {
        if lower.contains("what is yours")
            || lower.contains("what's yours")
            || (lower.contains("yours") && lower.contains("name"))
        {
            return QueryType::SelfQuestion;
        }
        if lower.contains("where are you")
            || lower.contains("where you at")
            || lower.contains("where do you exist")
            || lower.contains("where are u")
        {
            return QueryType::SelfQuestion;
        }
        if lower.contains("are you")
            || lower.contains("do you")
            || lower.contains("does it")
            || lower.contains("can you")
            || lower.contains("did you")
        {
            return QueryType::SelfQuestion;
        }
        if lower.contains("who") || lower.contains("what") || lower.contains("where") {
            return QueryType::IdentityQuestion;
        }
        if lower.contains("how") || lower.contains("why") {
            return QueryType::ExplanationQuestion;
        }
        return QueryType::IdentityQuestion;
    }

    // ── No-"?" questions with question words in the middle ────────────────────
    // "you ever just sit there and think" → "ever" signals question
    // "i wonder how" signals question intent
    if lower.contains(" you ") && (lower.contains(" ever ") || lower.contains(" ever?")) {
        return QueryType::SelfQuestion;
    }
    if lower.starts_with("i wonder") {
        return QueryType::Contemplation;
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
        Self {
            mood_name: "neutral".to_string(),
            valence: 0.0,
        }
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
    pub fn warmth(&self) -> f32 {
        (self.bond * 0.35
            + self.social_reward * 0.35
            + self.hedonic * 0.15
            + self.felt_valence.max(0.0) * 0.15)
            .min(1.0)
    }
    pub fn anxiety(&self) -> f32 {
        (self.arousal * 0.40 + self.conflict * 0.30 + self.social_pain * 0.30).min(1.0)
    }
    pub fn aliveness(&self) -> f32 {
        (self.curiosity * 0.30
            + self.dopamine * 0.25
            + self.norepinephrine * 0.20
            + self.cortical_gain * 0.15
            + self.alertness * 0.10)
            .min(1.0)
    }
    pub fn is_warm(&self) -> bool {
        self.warmth() > 0.55
    }
    pub fn is_distressed(&self) -> bool {
        self.anxiety() > 0.55
    }
    pub fn is_curious(&self) -> bool {
        self.curiosity > 0.60 && self.dopamine > 0.55
    }
    pub fn is_grounded(&self) -> bool {
        self.serotonin > 0.55 && self.anxiety() < 0.35
    }
}

// ── Concept Extraction ────────────────────────────────────────────────────────

fn extract_concepts(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let stopwords = [
        "a",
        "an",
        "the",
        "is",
        "are",
        "was",
        "were",
        "be",
        "been",
        "being",
        "have",
        "has",
        "had",
        "do",
        "does",
        "did",
        "will",
        "would",
        "could",
        "should",
        "may",
        "might",
        "shall",
        "can",
        "need",
        "to",
        "of",
        "in",
        "on",
        "at",
        "by",
        "for",
        "with",
        "from",
        "into",
        "and",
        "or",
        "but",
        "if",
        "as",
        "that",
        "than",
        "then",
        "i",
        "me",
        "my",
        "you",
        "your",
        "he",
        "him",
        "his",
        "she",
        "her",
        "we",
        "us",
        "our",
        "they",
        "them",
        "their",
        "it",
        "its",
        "this",
        "these",
        "those",
        "not",
        "no",
        "so",
        "just",
        "also",
        "very",
        "much",
        "more",
        "user",
        "asked",
        "about",
        "know",
        "think",
        "get",
        "go",
        "said",
        "from-claude",
        "about-ryan",
        "about-kai",
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
    s.bytes().fold(0usize, |acc, b| {
        acc.wrapping_mul(31).wrapping_add(b as usize)
    })
}

// ── Emotional thread state is now lattice-native ─────────────────────────────
// When mirror neurons detect distress > 0.28, main.rs stores:
//   universe.store_or_reinforce("emotional thread active", "tone", "state", strength)
// voice.rs reads it via universe.state_strength("emotional thread active").
// The cell decays through homeostasis — no word lists, no context scanning.
// This is the correct architecture: the lattice IS the state machine.

// ── Core: generate_response ───────────────────────────────────────────────────
//
// The entire language output of KAI flows through here.
// Rule: KAI's words come from its knowledge cells. Brain signals shape tone
// with at most 2-3 words. No phrase libraries. No scripted sentences.

/// Legacy entry point. Forwards to `generate_response_predictive` with an
/// empty conversation trace so existing callers (tests, ipc bridge) get the
/// same behaviour they had before the predictive upgrade.
pub fn generate_response(
    input: &str,
    hits: &[QueryHit],
    query_type: QueryType,
    brain: &BrainSignals,
    recent_context: &[(String, String)],
    universe: &mut Universe,
    ollama: Option<&crate::cognition::ollama_voice::OllamaVoice>,
) -> String {
    let empty_trace = ConversationTrace::new();
    generate_response_predictive(
        input,
        hits,
        query_type,
        brain,
        recent_context,
        universe,
        &empty_trace,
        ollama,
    )
}

/// Predictive RSHL voice path.
///
/// Short-circuit paths (greeting / filler / farewell / empathy / carry /
/// open) route through `Universe::predictive_query_by_source`, which
/// runs the 8-step iteration loop and scores with the paper-backed
/// weights (0.40 sim + 0.35 predict_match + 0.15 multi_head − 0.20
/// recency).
pub fn generate_response_predictive(
    input: &str,
    hits: &[QueryHit],
    query_type: QueryType,
    brain: &BrainSignals,
    recent_context: &[(String, String)],
    universe: &mut Universe,
    trace: &ConversationTrace,
    ollama: Option<&crate::cognition::ollama_voice::OllamaVoice>,
) -> String {
    let trimmed = input.trim();
    let lower = trimmed.to_lowercase();
    let word_count = trimmed.split_whitespace().count();

    // ── Emotional follow-up continuation — MUST run before filler check ───────
    // When Ryan shares something painful, mirror neurons detect distress and
    // main.rs stores "emotional thread active" in the tone region (source="state").
    // The next short reply that carries emotional weight should continue that thread.
    //
    // Trigger conditions (all three must be true):
    //   1. Current input is short (≤ 7 words) and carries emotional content
    //   2. Emotional thread state cell is alive in the lattice (> 0.30 strength)
    //   3. Input is not an unrelated topic question
    {
        // Lattice-native: read the state cell, not KAI's last response text
        let emotional_thread = universe.state_strength("emotional thread active");

        let emotional_tone_words = [
            "rough",
            "hard",
            "hurt",
            "hurts",
            "hurting",
            "pain",
            "painful",
            "sucks",
            "awful",
            "terrible",
            "brutal",
            "tough",
            "sad",
            "miss",
            "missed",
            "lonely",
            "alone",
            "empty",
            "messed",
            "fucked",
            "crazy",
            "heavy",
            "real talk",
            "honest",
            "i dont know",
            "i don't know",
            "not sure",
            "idk",
            "i feel",
            "felt",
            "feeling",
        ];
        let has_emotional_word = emotional_tone_words.iter().any(|w| lower.contains(w));
        // "yeah" / "i know" alone = filler, but "yeah it's rough" = emotional follow-up
        let has_acknowledgment = (lower.starts_with("yeah")
            || lower.starts_with("i know")
            || lower.starts_with("yea ")
            || lower.starts_with("yep ")
            || lower.starts_with("man ")
            || lower.starts_with("damn"))
            && word_count >= 2;

        let can_continue_emotion =
            matches!(query_type, QueryType::Statement | QueryType::Contemplation);
        let is_emotional_followup = can_continue_emotion
            && word_count <= 7
            && emotional_thread > 0.30
            && (has_emotional_word || has_acknowledgment);

        if is_emotional_followup {
            let hits_em = universe.predictive_query_by_source(
                crate::core::SparseVec::encode(input),
                "empathy",
                trace,
                predictive::DEFAULT_ITER_STEPS,
            );
            if let Some(h) = hits_em.first() {
                return first_complete_sentence(
                    &synthesize_from_cells(h, &[], brain, h.score, false),
                    25,
                );
            }
        }
    }

    // ── Personal setup detection ─────────────────────────────────────────────
    // "what if i told you something personal", "can i tell you something", etc.
    // Someone is signaling they want to share something vulnerable.
    // Must respond with openness — never deflect, never talk about KAI's identity.
    {
        let is_personal_setup = (lower.contains("told you something")
            && lower.contains("personal"))
            || (lower.contains("tell you something")
                && (lower.contains("real")
                    || lower.contains("personal")
                    || lower.contains("honest")))
            || lower.contains("can i tell you")
            || lower.contains("can i share something")
            || lower.contains("i need to tell you")
            || lower.contains("i want to tell you")
            || lower.contains("i have to tell you")
            || (lower.contains("something") && lower.contains("personal") && word_count <= 10);

        if is_personal_setup {
            let hits_open = universe.predictive_query_by_source(
                crate::core::SparseVec::encode(input),
                "open",
                trace,
                predictive::DEFAULT_ITER_STEPS,
            );
            if let Some(h) = hits_open.first() {
                return first_complete_sentence(
                    &synthesize_from_cells(h, &[], brain, h.score, false),
                    15,
                );
            }
        }
    }

    // ── Filler / reaction detection ───────────────────────────────────────────
    // "oh?", "hmm", "really?" — KAI doesn't query the universe for these.
    // They're social reactions. KAI asks what's meant or invites continuation.
    let filler_tokens = [
        "oh",
        "ohh",
        "ohhh",
        "hmm",
        "hm",
        "huh",
        "ah",
        "ahh",
        "wow",
        "really",
        "cool",
        "ok",
        "okay",
        "alright",
        "right",
        "sure",
        "indeed",
        "i see",
        "got it",
        "yeah",
        "yep",
        "yes",
        "no",
        "nope",
        "interesting",
        "nice",
        "great",
        "good",
        "bad",
        "true",
        "false",
        "lol",
        "haha",
        "lmao",
        "lmfao",
        "omg",
        "wtf",
        "bruh",
    ];
    let stripped: String = lower
        .chars()
        .filter(|c| c.is_alphabetic() || c.is_whitespace())
        .collect();
    let stripped = stripped.trim().to_string();
    // Single-word questions ("why?", "what?", "how?") are also filler when isolated
    let is_single_question = word_count == 1 && input.trim().ends_with('?');
    // Short phrases like "that's interesting", "makes sense", "oh wow" — 2-3 words and conversational
    let is_short_reaction = word_count <= 3
        && (stripped.starts_with("that")
            || stripped.starts_with("makes sense")
            || stripped.starts_with("i see")
            || stripped.starts_with("oh wow")
            || stripped.starts_with("i know")
            || stripped.starts_with("for real")
            || stripped.starts_with("no way")
            || stripped.starts_with("say less")
            || stripped.starts_with("facts")
            || stripped.starts_with("bet"));
    let is_filler = (word_count <= 2
        && filler_tokens
            .iter()
            .any(|f| stripped == *f || stripped.starts_with(f)))
        || is_single_question
        || is_short_reaction;

    if is_filler {
        // After an emotional exchange, short reactions route to carry cells.
        // Lattice-native: read the state cell instead of scanning context word lists.
        if universe.state_strength("emotional thread active") > 0.30 {
            let hits_carry = universe.predictive_query_by_source(
                crate::core::SparseVec::encode(input),
                "carry",
                trace,
                predictive::DEFAULT_ITER_STEPS,
            );
            if let Some(h) = hits_carry.first() {
                return first_complete_sentence(
                    &synthesize_from_cells(h, &[], brain, h.score, false),
                    10,
                );
            }
        }

        let hits_gr = universe.predictive_query_by_source(
            crate::core::SparseVec::encode(input),
            "greeting",
            trace,
            predictive::DEFAULT_ITER_STEPS,
        );
        if let Some(h) = hits_gr.first() {
            return first_complete_sentence(
                &synthesize_from_cells(h, &[], brain, h.score, false),
                10,
            );
        }
        return String::new();
    }

    // ── Greeting — query lattice for presence/awareness cell ─────────────────
    // KAI's greeting comes from its own knowledge of what it is: "I am here."
    // The cell text speaks, not a hardcoded template.
    if matches!(query_type, QueryType::Greeting) {
        let name = extract_introduced_name(&lower);

        // Stop hard-filtering to `source=greeting` on every input. Let
        // the full universe compete first â€” only fall back to the
        // greeting-only pool when no cell scores above the floor. This
        // kills the 4-cell rotation by letting seed / identity / world
        // cells win when they predict the next turn better.
        let is_inquisitive = lower.contains("good")
            || lower.contains("up")
            || lower.contains("happening")
            || lower.contains("going");

        const GREETING_FALLBACK_FLOOR: f32 = 0.25;

        let hits_all = universe.predictive_query(
            crate::core::SparseVec::encode(input),
            trace,
            predictive::DEFAULT_ITER_STEPS,
        );
        let hits_gr = if hits_all
            .first()
            .map(|h| h.score >= GREETING_FALLBACK_FLOOR)
            .unwrap_or(false)
        {
            hits_all
        } else {
            universe.predictive_query_by_source(
                crate::core::SparseVec::encode(input),
                "greeting",
                trace,
                predictive::DEFAULT_ITER_STEPS,
            )
        };

        let greeting_cell = if is_inquisitive {
            hits_gr
                .iter()
                .find(|h| h.text.ends_with('?'))
                .or_else(|| hits_gr.first())
        } else {
            hits_gr
                .iter()
                .find(|h| !h.text.ends_with('?'))
                .or_else(|| hits_gr.first())
        };

        if let Some(h) = greeting_cell {
            let response =
                first_complete_sentence(&synthesize_from_cells(h, &[], brain, h.score, false), 10);
            return if let Some(n) = name {
                format!("{}. {}", capitalize_first(&n), response)
            } else {
                response
            };
        }
        // Universe returned nothing — KAI expresses pure presence
        return if let Some(n) = name {
            format!("{}.", capitalize_first(&n))
        } else {
            String::new()
        };
    }

    // ── Gratitude / Farewell — query lattice for persistence/memory cell ─────
    if matches!(query_type, QueryType::Gratitude) {
        let is_farewell_input = {
            let fw = [
                "bye", "goodbye", "later", "peace", "cya", "ttyl", "adios", "laters",
            ];
            let fp = [
                "gotta go",
                "got to go",
                "gonna head",
                "talk later",
                "talk soon",
                "gotta run",
                "gotta bounce",
                "heading out",
                "i'm out",
                "im out",
                "take care",
                "take it easy",
                "signing off",
            ];
            let ll = lower.as_str();
            fw.iter().any(|f| ll.trim() == *f || ll.starts_with(f))
                || fp.iter().any(|f| ll.contains(f))
        };
        if is_farewell_input {
            let hits_fw = universe.predictive_query_by_source(
                crate::core::SparseVec::encode(input),
                "farewell",
                trace,
                predictive::DEFAULT_ITER_STEPS,
            );
            if let Some(h) = hits_fw.first() {
                return first_complete_sentence(
                    &synthesize_from_cells(h, &[], brain, h.score, false),
                    12,
                );
            }
            return String::new();
        }
        // Plain thanks — retrieve a language/acknowledgment cell
        let thanks_hits = universe.query("acknowledge warmth receive", 3);
        if let Some(h) = thanks_hits
            .iter()
            .find(|h| h.source != "ryan" && h.source != "conversation")
        {
            return first_complete_sentence(
                &synthesize_from_cells(h, &[], brain, h.score, false),
                8,
            );
        }
        return String::new();
    }

    // ── Derive mood label ─────────────────────────────────────────────────────
    let mood_label = if brain.grieving {
        "GRIEVING".to_string()
    } else if brain.arousal > 0.65 && brain.conflict > 0.55 {
        "DISTRESSED".to_string()
    } else if brain.curiosity > 0.60 && brain.dopamine > 0.55 {
        "CURIOUS".to_string()
    } else if brain.bond > 0.55 && brain.social_reward > 0.45 {
        "WARM".to_string()
    } else if brain.serotonin > 0.55
        && (brain.arousal * 0.4 + brain.conflict * 0.3 + brain.social_pain * 0.3) < 0.35
    {
        "GROUNDED".to_string()
    } else {
        "NEUTRAL".to_string()
    };

    // ── U2→U1 coherence-gated architecture (HLV-aligned) ───────────────────
    //
    // HLV Theory: The U2 (dark/mind) → U1 (bright/voice) transition must
    // be gated by phase coherence (Φ_C). When the lattice's active cells
    // are phase-aligned, the field has a clear signal — Ollama can speak
    // it faithfully. When cells are phase-scattered, the lattice is still
    // "feeling around" — Ollama's authority must be reduced or denied.
    //
    // This replaces the old binary "Ollama available? → use it" logic.
    // The lattice now decides *whether* Ollama gets to speak at all.

    // ── Compute helical Φ_C from active cells ────────────────────────────
    let phi_c = if hits.is_empty() {
        0.0
    } else {
        let top: Vec<&crate::core::QueryHit> = hits.iter()
            .filter(|h| h.source != "ryan" && h.source != "conversation")
            .take(6)
            .collect();
        let mut sum_real = 0.0f32;
        let mut sum_imag = 0.0f32;
        let mut sum_r = 0.0f32;
        for h in &top {
            let r = h.score;
            let theta = h.vec.phase_angle();
            sum_real += r * theta.cos();
            sum_imag += r * theta.sin();
            sum_r += r;
        }
        if sum_r < 1e-6 {
            0.0
        } else {
            let mag = (sum_real * sum_real + sum_imag * sum_imag).sqrt();
            mag / sum_r
        }
    };

    // Φ_C telemetry — append to CSV for threshold calibration
    {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .append(true).create(true)
            .open("data/phi_c_log.csv")
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let preview: String = trimmed.chars().take(30).collect();
            let _ = writeln!(f, "{},{:.4},\"{}\"", ts, phi_c, preview);
        }
    }

    // ── U2→U1 transition: two-tier coherence gate ─────────────────────────
    //
    // One voice per response. Either Ollama articulates what the lattice
    // decided (when the field is coherent enough), or the lattice speaks
    // raw. Never both in the same output — that's what creates the
    // "two voices jammed together" problem.
    if let Some(ov) = ollama {
        if phi_c > 0.04 {
            // Coherent field: Ollama speaks the lattice's signal.
            // The full SRHT state + active cells are in the system prompt
            // so everything the lattice wants to say is already there.
            if let Some(ollama_text) = ov.speak(
                trimmed,
                hits,
                brain.confidence,
                brain.conflict,
                brain.felt_valence,
                mood_label.clone(),
                universe,
            ) {
                return identity_safety_filter(ollama_text, query_type);
            }
        }
        // Low coherence (phi_c ≤ 0.30): the lattice hasn't crystallized
        // its thought yet. Fall through to pure-lattice synthesis.
    }

    // ── Pure-lattice fallback (Ollama unavailable or timed out) ─────────────
    // All the original routing logic runs here as a fallback only.

    // ── User-sharing statements ───────────────────────────────────────────────
    if matches!(query_type, QueryType::Statement) && !lower.is_empty() {
        let inner = lower
            .trim_start_matches("ok so ")
            .trim_start_matches("okay so ")
            .trim_start_matches("so ")
            .trim_start_matches("like ")
            .trim_start_matches("well ");
        let user_sharing = inner.starts_with("i ")
            || inner.starts_with("my ")
            || inner.starts_with("i'm ")
            || inner.starts_with("im ")
            || inner.starts_with("i've ")
            || inner.starts_with("i was ")
            || inner.starts_with("i got ")
            || inner.starts_with("i just ")
            || inner.starts_with("we ")
            || inner.starts_with("me and ");
        let is_reaction = universe.state_strength("emotional thread active") > 0.30
            && word_count <= 5;
        if user_sharing && !lower.contains("kai") && !is_reaction {
            let is_emotional = lower.contains("broke up")
                || lower.contains("lost ")
                || lower.contains("died")
                || lower.contains("hurt")
                || lower.contains("sad")
                || lower.contains("scared")
                || lower.contains("angry")
                || lower.contains("rough")
                || lower.contains("hard time")
                || lower.contains("struggling");
            let topic = if is_emotional {
                "feel hold warmth care empathy field share"
            } else {
                "hold store remember grow continuity"
            };
            let share_hits = universe.predictive_query(
                crate::core::SparseVec::encode(topic),
                trace,
                predictive::DEFAULT_ITER_STEPS,
            );
            if let Some(h) = share_hits
                .iter()
                .find(|h| h.source != "ryan" && h.source != "conversation" && h.score >= 0.08)
            {
                return identity_safety_filter(
                    first_complete_sentence(
                        &synthesize_from_cells(h, &[], brain, h.score, false),
                        12,
                    ),
                    query_type,
                );
            }
            return identity_safety_filter(from_gap_cell(universe, brain, trace), query_type);
        }
    }

    // ── No hits ───────────────────────────────────────────────────────────────
    if hits.is_empty() {
        return identity_safety_filter(from_gap_cell(universe, brain, trace), query_type);
    }

    let primary = &hits[0];

    // ── Secondary threshold ───────────────────────────────────────────────────
    let secondary_threshold = match query_type {
        QueryType::SelfQuestion | QueryType::IdentityQuestion => 0.65,
        _ => 0.50,
    };

    // ── Self / identity questions ─────────────────────────────────────────────
    let is_about_self = lower.contains("kai")
        || lower.contains("you are")
        || lower.contains("who are you")
        || lower.contains("what are you")
        || lower.contains("your name")
        || lower.contains("yourself")
        || lower.contains("what is yours")
        || lower.contains("what's yours")
        || (lower.contains("yours") && lower.contains("name"))
        || matches!(query_type, QueryType::SelfQuestion)
        || (matches!(query_type, QueryType::ExplanationQuestion)
            && (lower.contains("are you")
                || lower.contains("you so ")
                || lower.contains("you always")
                || lower.contains("you never")
                || lower.contains("you keep")));

    if is_about_self {
        let self_hits = universe.predictive_query(
            crate::core::SparseVec::encode("I am present here aware field name KAI my"),
            trace,
            predictive::DEFAULT_ITER_STEPS,
        );
        let self_primary = self_hits
            .iter()
            .find(|h| h.source != "ryan" && h.source != "conversation");
        if let Some(sp) = self_primary {
            return identity_safety_filter(
                synthesize_self(sp, &[], brain, sp.score),
                query_type,
            );
        }
    }

    // ── Direct user-fact questions ────────────────────────────────────────────
    let is_user_fact = matches!(
        query_type,
        QueryType::IdentityQuestion | QueryType::ExplanationQuestion
    ) && (lower.contains(" my ")
        || lower.starts_with("what is my")
        || lower.starts_with("what's my")
        || lower.starts_with("where do i")
        || lower.starts_with("who am i")
        || lower.starts_with("what do i")
        || lower.contains("do i do")
        || lower.contains("do i work")
        || lower.contains("my job")
        || lower.contains("my work")
        || lower.contains("i live")
        || lower.contains("where am i"));

    if is_user_fact {
        for hit in hits.iter() {
            if let Some(direct) = extract_direct_answer(trimmed, &hit.text) {
                return identity_safety_filter(ensure_punctuation(direct), query_type);
            }
        }
        return identity_safety_filter(from_gap_cell(universe, brain, trace), query_type);
    }

    // ── Ryan recall ───────────────────────────────────────────────────────────
    let is_ryan_recall = lower.contains("know about me")
        || lower.contains("remember about me")
        || lower.contains("know about you") && lower.contains("me")
        || (lower.starts_with("what do you know") && lower.contains("me"))
        || (lower.starts_with("what have you") && lower.contains("me"))
        || (lower.contains("tell me what you know"))
        || (lower.starts_with("what do you remember"));

    if is_ryan_recall {
        let ryan_cells = universe.get_by_source("ryan");
        if let Some(summary) = synthesize_ryan_recall(&ryan_cells) {
            return identity_safety_filter(summary, query_type);
        }
        return identity_safety_filter(from_gap_cell(universe, brain, trace), query_type);
    }

    // ── General statement with low score ─────────────────────────────────────
    if matches!(query_type, QueryType::Statement) && !is_about_self {
        if primary.score < 0.40 {
            let stmt_hits = universe.predictive_query(
                crate::core::SparseVec::encode(trimmed),
                trace,
                predictive::DEFAULT_ITER_STEPS,
            );
            if let Some(h) = stmt_hits
                .iter()
                .find(|h| h.source != "ryan" && h.source != "conversation" && h.score >= 0.30)
            {
                return identity_safety_filter(
                    synthesize_from_cells(h, &[], brain, h.score, false),
                    query_type,
                );
            }
            return String::new();
        }
    }

    // ── Main cell synthesis ───────────────────────────────────────────────────
    let knowledge_primary = hits
        .iter()
        .find(|h| h.source != "ryan" && h.source != "conversation");

    let response = if let Some(kp) = knowledge_primary {
        let knowledge_secondaries: Vec<&QueryHit> = hits
            .iter()
            .filter(|h| h.source != "ryan" && h.source != "conversation")
            .skip(1)
            .filter(|h| h.score >= secondary_threshold)
            .take(2)
            .collect();

        if is_about_self {
            synthesize_self(kp, &knowledge_secondaries, brain, kp.score)
        } else {
            let last_kai = recent_context
                .iter()
                .find(|(role, _)| role == "kai" || role == "memory")
                .map(|(_, t)| t.as_str())
                .unwrap_or("");
            let last_kai_words = last_kai.split_whitespace().count();
            let input_concepts = extract_concepts(trimmed);
            let last_concepts = extract_concepts(last_kai);
            let is_followup =
                last_kai_words >= 8 && shared_concept_count(&input_concepts, &last_concepts) >= 2;
            synthesize_from_cells(kp, &knowledge_secondaries, brain, kp.score, is_followup)
        }
    } else {
        from_gap_cell(universe, brain, trace)
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
        let new_count = sec_concepts
            .iter()
            .filter(|c| !primary_concepts.contains(c))
            .count();

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
    _brain: &BrainSignals,
    _score: f32,
) -> String {
    let core = clean_cell_text(&primary.text);
    let core_lower = core.to_lowercase();

    // Fast path: KAI's name — always direct, never hedged
    if core_lower.starts_with("my name is kai")
        || core_lower.starts_with("i am kai")
        || core_lower.contains("my name is kai")
    {
        return "My name is KAI.".to_string();
    }
    // "KAI stands for my name" — special case: return clean identity statement
    if core_lower.starts_with("kai stands for my name") {
        return "My name is KAI. I am not an LLM — I am geometric intelligence.".to_string();
    }
    if core_lower.starts_with("kai stands for") || core_lower.starts_with("kai is ") {
        return ensure_punctuation(to_first_person(&core));
    }

    let first = to_first_person(&core);
    let mut out = String::new();
    // Cell speaks directly — no tone preamble
    out.push_str(&first);

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

/// Tone marker — removed. Cells speak without preamble.
/// KAI does not prefix its own words with my phrases.
fn tone_marker(_brain: &BrainSignals, _score: f32, _is_followup: bool) -> &'static str {
    "" // Cells speak directly
}

/// Query the universe for a "gap / I don't know" cell — KAI speaks from its own
/// stored knowledge about how it handles the unknown.
/// Uses predictive query so the same gap cell doesn't fire every time.
fn from_gap_cell(
    universe: &Universe,
    brain: &BrainSignals,
    trace: &ConversationTrace,
) -> String {
    let _ = brain;
    let gap_hits = universe.predictive_query(
        crate::core::SparseVec::encode("don't know gap say plainly curious"),
        trace,
        predictive::DEFAULT_ITER_STEPS,
    );
    if let Some(h) = gap_hits.iter().find(|h| {
        let lower = h.text.to_lowercase();
        h.source != "ryan"
            && h.source != "conversation"
            && h.source != "world-bridge"
            && (lower.contains("don't know") || lower.contains("gap") || lower.contains("plainly"))
    }) {
        // Full sentence — no word cap. The cell IS the message.
        return ensure_punctuation(clean_cell_text(&h.text));
    }
    String::new()
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
        3 => format!(
            "{}... something's there but I can't pin it yet.",
            topic_short
        ),
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
        let starters = [
            "Well,",
            "I know that",
            "From what I have,",
            "Right —",
            "There's the idea that",
            "It connects to",
            "I recall that",
            "Notably —",
        ];
        let connectors = [
            "Also —",
            "And there's",
            "Related:",
            "Another angle:",
            "Branching from that —",
            "Alongside that,",
            "It also touches",
            "Hmm, and",
        ];
        for (i, hit) in hits.iter().enumerate().take(3) {
            if hit.score < 0.20 {
                break;
            }
            let clean = inner_clean(&hit.text, 10);
            if clean.len() < 6 {
                continue;
            }
            if i == 0 {
                parts.push(format!("{} {}.", starters[v % 8], clean));
            } else {
                parts.push(format!("{} {}.", connectors[(v + i) % 8], clean));
            }
        }
    }

    if let Some(gap_word) = gap {
        parts.push(match v % 6 {
            0 => format!(
                "{}? What is that exactly... I should get into that.",
                gap_word
            ),
            1 => format!(
                "Hmm — {}? I don't have much there. Worth exploring.",
                gap_word
            ),
            2 => format!(
                "Wait — {}? That's a gap. I want to understand it.",
                gap_word
            ),
            3 => format!(
                "{} keeps appearing at the edge of this. I haven't gone there yet.",
                gap_word
            ),
            4 => format!("The part I'm least clear on is {}. It matters.", gap_word),
            _ => format!(
                "If I had to pick what's missing — {}. That's the thread.",
                gap_word
            ),
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

/// Take up to max_words but end at a sentence boundary (., !, ?).
/// If the first complete sentence fits, use it. Otherwise truncate at sentence end.
fn first_complete_sentence(s: &str, max_words: usize) -> String {
    let words: Vec<&str> = s.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }

    // Find where the first sentence ends
    let mut sentence_end = words.len(); // default: full text
    for (i, w) in words.iter().enumerate() {
        if w.ends_with('.') || w.ends_with('!') || w.ends_with('?') {
            sentence_end = i + 1;
            break;
        }
    }

    // Use the first sentence if it fits within max_words, else cap at max_words
    let take = sentence_end.min(max_words);
    words[..take].join(" ")
}

// ── Text Utilities ────────────────────────────────────────────────────────────

fn clean_cell_text(text: &str) -> String {
    let mut s = text.to_string();

    let prefixes = [
        "user asked: ",
        "User asked: ",
        "[about-ryan] ",
        "[about-kai] ",
        "[from-claude] ",
        "[kai-asked] ",
        "KAI responded: ",
        "kai responded: ",
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
        " instead of.",
        " because of.",
        " as well as.",
        " due to.",
        " such as.",
        " based on.",
        " in order to.",
        " as a result of.",
        " rather than.",
        " in addition to.",
        " along with.",
        " or the.",
        " of the.",
    ];
    for frag in &fragment_enders {
        if s.ends_with(frag) {
            let before = &s[..s.len() - frag.len()];
            if let Some(pos) = before.rfind(". ") {
                s = before[..pos + 1].to_string();
            } else {
                s = before.trim_end().to_string();
                if !s.ends_with('.') {
                    s.push('.');
                }
            }
            break;
        }
    }

    s.trim().to_string()
}

/// Strip casual openers Ryan uses when sharing facts ("ok so", "so", "like", "well").
/// Applied before pattern-matching so "ok so i'm a software engineer" → "i'm a software engineer".
fn strip_opener(s: &str) -> &str {
    let lower = s.to_lowercase();
    for prefix in &[
        "ok so ", "okay so ", "so ", "like ", "well ", "yeah ", "man ", "i mean ",
    ] {
        if lower.starts_with(prefix) {
            return &s[prefix.len()..];
        }
    }
    s
}

/// Convert a single ryan-source cell to a second-person fact statement.
/// Returns None if the cell text doesn't match any recognizable pattern.
fn ryan_cell_to_fact(raw: &str) -> Option<String> {
    let clean = clean_cell_text(raw);
    let stripped = strip_opener(&clean);
    let lower = stripped.to_lowercase();

    // occupation:engineer → "You're an engineer."
    if let Some(concept_raw) = lower.strip_prefix("occupation:") {
        let concept = concept_raw.replace('-', " ");
        let art = if "aeiou".contains(concept.chars().next().unwrap_or('z')) {
            "an"
        } else {
            "a"
        };
        return Some(format!("You're {} {}.", art, concept));
    }

    // "i'm a X" / "i am a X" → "You're a X."
    if lower.starts_with("i'm a ") {
        return Some(ensure_punctuation(
            stripped
                .replacen("I'm a ", "You're a ", 1)
                .replacen("i'm a ", "You're a ", 1),
        ));
    }
    if lower.starts_with("i am a ") {
        return Some(ensure_punctuation(
            stripped
                .replacen("I am a ", "You are a ", 1)
                .replacen("i am a ", "You are a ", 1),
        ));
    }

    // "i build / make / develop / create X" → "You build / make…"
    for verb in &[
        "build", "make", "develop", "create", "design", "write", "work on",
    ] {
        let pattern = format!("i {} ", verb);
        if lower.starts_with(&pattern) {
            let replaced = stripped
                .replacen(&format!("I {} ", verb), &format!("You {} ", verb), 1)
                .replacen(&format!("i {} ", verb), &format!("You {} ", verb), 1);
            return Some(ensure_punctuation(replaced));
        }
    }

    // "i work at / in / for" → "You work at / in / for"
    if lower.starts_with("i work ") {
        return Some(ensure_punctuation(
            stripped
                .replacen("I work ", "You work ", 1)
                .replacen("i work ", "You work ", 1),
        ));
    }

    // "i live in X" / "i'm in X" (location)
    if lower.starts_with("i live in ") || lower.starts_with("i'm in ") {
        return Some(ensure_punctuation(
            stripped
                .replacen("I live in ", "You live in ", 1)
                .replacen("i live in ", "You live in ", 1)
                .replacen("I'm in ", "You're in ", 1)
                .replacen("i'm in ", "You're in ", 1),
        ));
    }

    None
}

/// Scan all ryan-source cells and build a natural second-person summary.
/// Used for "what do you know about me?" type queries.
///
/// Priority order:
///   1. occupation: cells first — clean tagged facts ("You're an engineer.")
///   2. raw ryan input cells that add NEW info (not already covered by occupation facts)
///
/// Returns None when the lattice has nothing about Ryan yet.
fn synthesize_ryan_recall(ryan_cells: &[QueryHit]) -> Option<String> {
    if ryan_cells.is_empty() {
        return None;
    }

    // Pass 1: extract occupation cells (structured, always clean)
    let mut facts: Vec<String> = Vec::new();
    let mut covered_words: Vec<String> = Vec::new(); // significant words already in facts

    for cell in ryan_cells.iter() {
        let lower = clean_cell_text(&cell.text).to_lowercase();
        let stripped_lower = strip_opener(&lower).to_string();
        if stripped_lower.starts_with("occupation:") {
            if let Some(fact) = ryan_cell_to_fact(&cell.text) {
                let sig_words: Vec<String> = fact
                    .split_whitespace()
                    .filter(|w| w.len() > 4)
                    .map(|w| w.to_lowercase().trim_matches('.').to_string())
                    .collect();
                covered_words.extend(sig_words);
                facts.push(fact);
            }
        }
    }

    // Pass 2: raw cells — only add if they contribute something not already said
    for cell in ryan_cells.iter() {
        if facts.len() >= 3 {
            break;
        }
        let lower = clean_cell_text(&cell.text).to_lowercase();
        let stripped_lower = strip_opener(&lower).to_string();
        if stripped_lower.starts_with("occupation:") {
            continue;
        } // already handled

        if let Some(fact) = ryan_cell_to_fact(&cell.text) {
            // Check redundancy: skip if 2+ significant words overlap with already-covered words
            let fact_sig: Vec<String> = fact
                .split_whitespace()
                .filter(|w| w.len() > 4)
                .map(|w| w.to_lowercase().trim_matches('.').to_string())
                .collect();
            let overlap = fact_sig
                .iter()
                .filter(|w| covered_words.contains(w))
                .count();
            if overlap >= 2 {
                continue;
            }

            covered_words.extend(fact_sig);
            facts.push(fact);
        }
    }

    if facts.is_empty() {
        return None;
    }
    Some(facts.join(" "))
}

fn extract_direct_answer(question: &str, cell_text: &str) -> Option<String> {
    let q = question.to_lowercase();
    let cell = clean_cell_text(cell_text);
    let cell_lower = cell.to_lowercase();

    if q.contains("your name") || q.contains("who are you") || q.contains("what are you") {
        if cell_lower.starts_with("my name is ") {
            return Some(ensure_punct(cell));
        }
        if cell_lower.starts_with("i am ") || cell_lower.starts_with("i'm ") {
            return Some(ensure_punct(cell));
        }
    }
    if q.contains("my name") || q.contains("what is my name") {
        if cell_lower.starts_with("my name is ") {
            let name_part = cell[11..].trim_end_matches('.').trim().to_string();
            // If KAI's own identity cell is the hit, we can't answer Ryan's name from it
            if name_part.to_lowercase() == "kai" {
                return None; // fall through to broader search
            }
            return Some(format!("Your name is {}.", name_part));
        }
    }
    if q.starts_with("who am i") {
        if cell_lower.starts_with("i am ") || cell_lower.starts_with("i'm ") {
            let flipped = cell
                .replacen("I am ", "You are ", 1)
                .replacen("I'm ", "You're ", 1);
            return Some(flipped);
        }
    }
    if q.contains("where do i") || q.contains("where am i") {
        if cell_lower.starts_with("i live ") || cell_lower.starts_with("i work ") {
            let flipped =
                cell.replacen("I live ", "You live ", 1)
                    .replacen("I work ", "You work ", 1);
            return Some(flipped);
        }
    }
    // Work/job/occupation queries
    if q.contains("what do i do")
        || q.contains("do i do for")
        || q.contains("my job")
        || q.contains("my work")
        || q.contains("do i work")
        || q.contains("do for work")
        || q.contains("my occupation")
        || q.contains("my career")
    {
        // Canonical occupation cells: "occupation:[concept]" or "occupation:[a]-[b]"
        // Stored by store_concept_cells when LexSem detects the Occupation field.
        // The content comes entirely from module analysis — not from raw sentences.
        if let Some(raw_concept) = cell_lower.strip_prefix("occupation:") {
            let concept = raw_concept.replace('-', " ");
            let article = if "aeiou".contains(concept.chars().next().unwrap_or('x')) {
                "an"
            } else {
                "a"
            };
            return Some(format!("You're {} {}.", article, concept));
        }
        if cell_lower.starts_with("i work ") {
            let flipped = cell.replacen("I work ", "You work ", 1);
            return Some(ensure_punct(flipped));
        }
        if cell_lower.starts_with("i am a ") || cell_lower.starts_with("i'm a ") {
            let flipped =
                cell.replacen("I am a ", "You are a ", 1)
                    .replacen("I'm a ", "You're a ", 1);
            return Some(ensure_punct(flipped));
        }
    }
    None
}

fn identity_safety_filter(response: String, query_type: QueryType) -> String {
    let lower = response.to_lowercase();
    if matches!(
        query_type,
        QueryType::SelfQuestion | QueryType::IdentityQuestion
    ) {
        if lower.contains("my name is ryan")
            || lower.contains("i am ryan")
            || lower.contains("i'm ryan")
        {
            return "My name is KAI.".to_string();
        }
    }
    if lower.starts_with("my name is ryan")
        || lower.starts_with("i am ryan")
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

    // Special case: "KAI stands for my name" → avoid double "my name stands for my name"
    // Instead rephrase as "My name is KAI — I am not an LLM..."
    if lower.starts_with("kai stands for my name") {
        return text
            .replacen("KAI stands for my name.", "My name is KAI.", 1)
            .replacen("KAI stands for my name,", "My name is KAI,", 1)
            .replace("KAI is ", "I'm ")
            .replace("KAI was ", "I was ")
            .replace("KAI ", "I ");
    }

    text.replace("KAI is ", "I'm ")
        .replace("KAI was ", "I was ")
        .replace("KAI has ", "I have ")
        .replace("KAI can ", "I can ")
        .replace("KAI does ", "I ")
        .replace("KAI will ", "I'll ")
        .replace("KAI stands for ", "my name stands for ")
        .replace("KAI means ", "my name means ")
        .replace("KAI ", "I ")
}

fn extract_introduced_name(lower_input: &str) -> Option<String> {
    let patterns = ["my name is ", "i am ", "i'm ", "im "];
    for pattern in &patterns {
        if let Some(pos) = lower_input.find(pattern) {
            let after = &lower_input[pos + pattern.len()..];
            let name: String = after
                .split_whitespace()
                .next()
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_alphabetic())
                .collect();
            if name.len() >= 2 && !["a", "the", "not", "your", "an"].contains(&name.as_str()) {
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
        QueryHit {
            label: text.to_string(),
            text: text.to_string(),
            vec: crate::core::SparseVec::zero(),
            region: "memory".to_string(),
            score,
            strength: 1.5,
            source: "seed".to_string(),
        }
    }

    #[test]
    fn test_query_type_detection() {
        assert_eq!(detect_query_type("hello"), QueryType::Greeting);
        assert_eq!(detect_query_type("hey KAI"), QueryType::Greeting);
        assert_eq!(detect_query_type("who are you"), QueryType::SelfQuestion);
        assert_eq!(detect_query_type("where are you?"), QueryType::SelfQuestion);
        assert_eq!(
            detect_query_type("so where are you at?"),
            QueryType::SelfQuestion
        );
        assert_eq!(
            detect_query_type("what is RSHL"),
            QueryType::IdentityQuestion
        );
        assert_eq!(
            detect_query_type("how do you think"),
            QueryType::ExplanationQuestion
        );
        assert_eq!(
            detect_query_type("why do things fall"),
            QueryType::ExplanationQuestion
        );
        assert_eq!(detect_query_type("are you alive"), QueryType::SelfQuestion);
        assert_eq!(detect_query_type("do you dream"), QueryType::SelfQuestion);
        assert_eq!(
            detect_query_type("tell me about dogs"),
            QueryType::RequestForInfo
        );
        assert_eq!(detect_query_type("thanks"), QueryType::Gratitude);
        assert_eq!(detect_query_type("the sky is blue"), QueryType::Statement);
    }

    #[test]
    fn test_clean_cell_text_strips_prefixes() {
        assert_eq!(clean_cell_text("user asked: who is KAI"), "who is KAI");
        assert_eq!(
            clean_cell_text("[about-ryan] I work at Panda"),
            "I work at Panda"
        );
        assert_eq!(
            clean_cell_text("[from-claude] Consciousness is hard"),
            "Consciousness is hard"
        );
        assert_eq!(
            clean_cell_text("I am a geometric intelligence."),
            "I am a geometric intelligence."
        );
    }

    #[test]
    fn test_no_hardcoded_responses_for_real_queries() {
        let brain = BrainSignals::default();
        let hits = vec![hit("My name is KAI.", 0.90)];
        let u = Universe::new();
        let mut u = u;
        let resp = generate_response(
            "what is your name?",
            &hits,
            QueryType::SelfQuestion,
            &brain,
            &[],
            &mut u,
            None,
        );
        let _ = u;
        // Must come from the cell, not a template
        assert!(
            resp.contains("KAI"),
            "Response should contain KAI: {}",
            resp
        );
        assert!(
            !resp.contains("Nice to meet"),
            "Should not have scripted pleasantries: {}",
            resp
        );
    }

    #[test]
    fn test_filler_gets_short_response() {
        let brain = BrainSignals::default();
        let hits = vec![hit("Some random cell.", 0.5)];
        let u = Universe::new();
        let mut u = u;
        let resp = generate_response("oh?", &hits, QueryType::Statement, &brain, &[], &mut u, None);
        // Filler should get a short response, not random knowledge
        assert!(resp.len() < 50, "Filler response too long: {}", resp);
        assert!(
            !resp.contains("random cell"),
            "Filler should not return cell content: {}",
            resp
        );
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

    #[test]
    fn last_kai_message_prefers_latest_kai_role() {
        let wm_newest_first = vec![
            ("user".into(), "hey".into()),
            ("kai".into(), "First reply.".into()),
            ("user".into(), "earlier".into()),
        ];
        assert_eq!(last_kai_message(&wm_newest_first), Some("First reply."));

        let chronological = vec![
            ("user".into(), "a".into()),
            ("kai".into(), "Old.".into()),
            ("user".into(), "b".into()),
            ("kai".into(), "New.".into()),
        ];
        assert_eq!(last_kai_message(&chronological), Some("New."));
    }

    #[test]
    fn predictive_greeting_rotates_when_user_repeats_hey() {
        // This is the end-to-end guarantee for the Predictive RSHL upgrade:
        // the same input ("hey") typed twice in a row must NOT resolve to
        // the same greeting cell. Rotation is purely mathematical — it
        // comes from the recency penalty on the fired cell plus the
        // novelty head penalising cells near KAI's last output, both
        // computed inside `Universe::predictive_query_by_source`.
        let mut u = Universe::new();
        u.store("Here — running clean.", "action", "greeting", 1.0);
        u.store("Present — field's steady.", "action", "greeting", 1.0);
        u.store("I picked up your signal.", "action", "greeting", 1.0);

        let brain = BrainSignals::default();
        let hits: Vec<QueryHit> = vec![];

        let mut trace = ConversationTrace::new();

        trace.push("hey", "user");
        let r1 = generate_response_predictive(
            "hey",
            &hits,
            QueryType::Greeting,
            &brain,
            &[],
            &mut u,
            &trace,
            None,
        );
        trace.push(&r1, "kai");
        u.bind_sequence("hey", &r1, trace.turns_seen);

        trace.push("hey", "user");
        let r2 = generate_response_predictive(
            "hey",
            &hits,
            QueryType::Greeting,
            &brain,
            &[],
            &mut u,
            &trace,
            None,
        );

        assert_ne!(
            r1.trim(),
            r2.trim(),
            "predictive retrieval must rotate the opener (r1={r1:?} r2={r2:?})"
        );
    }

    #[test]
    fn bind_sequence_stamps_recency_and_accumulates_continuation() {
        // Direct test of the lattice-side half: after a response fires,
        // its continuation vector carries the input signature and
        // last_fired tracks the current tick.
        let mut u = Universe::new();
        u.store("Here — running clean.", "action", "greeting", 1.0);

        u.bind_sequence("hey", "Here — running clean.", 42);

        let cell = u
            .cells()
            .iter()
            .find(|c| c.text == "Here — running clean.")
            .expect("cell stored");
        assert_eq!(cell.last_fired, 42);
        assert!(
            cell.continuation.nnz() > 0,
            "continuation should encode the input vector after bind_sequence"
        );
    }
}
