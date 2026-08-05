//! Word-Calculus: language as carry-weight operators + hierarchical consolidation.
//!
//! Ryan's model: text is a fractal hierarchy
//!   letters -> words -> clauses -> sentences -> paragraphs -> whole reply
//! Punctuation and spaces are not noise to strip — they are OPERATORS. Each
//! operator does two jobs:
//!   (1) sets a CARRY-WEIGHT  C in [0,1] = how much accumulated meaning flows
//!       across the boundary to the next sibling, and
//!   (2) CONSOLIDATES the finished unit and pushes it up to the next level.
//! It's the SAME rule at every scale (the fractal point): multiply the carry,
//! consolidate up. That single repeated operation spans letter -> reply.
//!
//! This maps directly onto KAI's existing structures:
//!   - the levels here map to `claim.layer` (Word≈1, Clause/Sentence≈2, Para≈3, Reply≈4)
//!   - consolidation pushes a unit into a PARENT cell (`Cell.children`/`Cell.parent`)
//!   - the carry-weight is the synapse-weight analog (`Synapse.weight`) between siblings
//!
//! The carry values below are PRIORS — they are meant to be tuned by KAI's own
//! trial-and-error weight training, exactly as a learned parameter.
//!
//! This core module is std-only and fully unit-tested (`cargo test word_calculus`).
//! It is OFF by default (`WORD_CALCULUS`), so it cannot affect generation until
//! explicitly enabled — set `KAI_WORD_CALCULUS=1` in the environment (or call
//! `set_enabled(true)`) to switch it on. The only consumer is the autoregressive
//! generator in `lattice_attention.rs`, which otherwise emits space-joined words.
//!
//! SCOPE, honestly stated: this orders STRUCTURE — punctuation, clause boundaries,
//! capitalization. It does NOT choose words. Feeding it a semantically wrong word
//! list yields a well-punctuated wrong sentence.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// Master switch. OFF by default.
///
/// Two ways to turn it on, in this order of authority:
///   1. `KAI_WORD_CALCULUS=1` in the environment — read ONCE (cached) the first
///      time `enabled()` or `set_enabled()` is called, then seeded into the atomic.
///      Any value other than unset/empty/`0`/`false`/`off` counts as ON.
///   2. `set_enabled(true|false)` at runtime — an explicit call always wins over
///      the env seed, in both directions.
pub static WORD_CALCULUS: AtomicBool = AtomicBool::new(false);

/// Env name for the master switch.
pub const ENV_FLAG: &str = "KAI_WORD_CALCULUS";

/// Codebase-standard truthiness: unset/empty/`0`/`false`/`off` => OFF, else ON.
fn parse_flag(v: &str) -> bool {
    let v = v.trim();
    !v.is_empty() && v != "0" && !v.eq_ignore_ascii_case("false") && !v.eq_ignore_ascii_case("off")
}

/// Seed the atomic from the environment exactly once per process.
fn init_from_env() {
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| {
        if std::env::var(ENV_FLAG).map(|v| parse_flag(&v)).unwrap_or(false) {
            WORD_CALCULUS.store(true, Ordering::Relaxed);
        }
    });
}

pub fn enabled() -> bool {
    init_from_env();
    WORD_CALCULUS.load(Ordering::Relaxed)
}
pub fn set_enabled(on: bool) {
    init_from_env(); // so an explicit call is never later clobbered by the env seed
    WORD_CALCULUS.store(on, Ordering::Relaxed);
}

/// The structural operators of "word calculus".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operator {
    Bind,      // letter|letter inside a word (implicit, tightest)
    Space,     // word | word          (same thought)
    Colon,     // setup : expansion    (pointer: what follows explains the prior)
    Semicolon, // clause ; clause      (two full thoughts, linked)
    Comma,     // clause , clause      (related but secondary; parenthetical)
    Exclaim,   // sentence !           (period + intensity)
    Question,  // sentence ?           (period + query: expects/seeks an answer)
    Period,    // sentence .           (full stop)
    Paragraph, // block break
    Reply,     // top of the stack
}

/// Hierarchy levels (mirror `core::claim` LAYER_*). Ordered fine -> coarse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Letter = 0,
    Word = 1,
    Clause = 2,
    Sentence = 3,
    Paragraph = 4,
    Reply = 5,
}

impl Operator {
    /// Carry-weight C in [0,1]: how much of the meaning so far flows across this
    /// boundary into the next sibling. PRIORS — training tunes them.
    pub fn carry(self) -> f32 {
        match self {
            Operator::Bind => 0.95,      // letters fuse into one object
            Operator::Space => 0.80,     // next word, same thought
            Operator::Colon => 0.60,     // next part expands this one
            Operator::Semicolon => 0.55, // linked independent clauses
            Operator::Comma => 0.45,     // related but secondary
            Operator::Exclaim => 0.12,   // stop (+ intensity)
            Operator::Question => 0.12,  // stop (+ query)
            Operator::Period => 0.10,    // full stop
            Operator::Paragraph => 0.05, // block break
            Operator::Reply => 0.02,     // top
        }
    }

    /// The level this operator CLOSES (the unit it finishes + consolidates upward).
    pub fn closes(self) -> Level {
        match self {
            Operator::Bind => Level::Letter,
            Operator::Space => Level::Word,
            Operator::Comma | Operator::Semicolon | Operator::Colon => Level::Clause,
            Operator::Period | Operator::Question | Operator::Exclaim => Level::Sentence,
            Operator::Paragraph => Level::Paragraph,
            Operator::Reply => Level::Reply,
        }
    }

    /// Does this operator end a full sentence? (For the "more than one sentence per
    /// reply" handling — the sentence consolidates and is pushed up to the paragraph.)
    pub fn ends_sentence(self) -> bool {
        matches!(self, Operator::Period | Operator::Question | Operator::Exclaim)
    }

    pub fn from_char(c: char) -> Option<Operator> {
        match c {
            ' ' | '\t' => Some(Operator::Space),
            ',' => Some(Operator::Comma),
            ';' => Some(Operator::Semicolon),
            ':' => Some(Operator::Colon),
            '.' => Some(Operator::Period),
            '?' => Some(Operator::Question),
            '!' => Some(Operator::Exclaim),
            '\n' | '\r' => Some(Operator::Paragraph),
            _ => None,
        }
    }

    /// The text glyph to emit for this operator during GENERATION.
    pub fn glyph(self) -> &'static str {
        match self {
            Operator::Bind | Operator::Reply => "",
            Operator::Space => " ",
            Operator::Comma => ", ",
            Operator::Semicolon => "; ",
            Operator::Colon => ": ",
            Operator::Period => ". ",
            Operator::Question => "? ",
            Operator::Exclaim => "! ",
            Operator::Paragraph => "\n\n",
        }
    }
}

/// One node of the parsed hierarchy. A Reply contains Paragraphs contain Sentences
/// contain Clauses contain Words. `carry_next` is the carry-weight from the operator
/// that follows THIS unit, linking it to its next sibling.
#[derive(Debug, Clone, PartialEq)]
pub struct Unit {
    pub level: Level,
    pub text: String,
    pub carry_next: f32,
    pub children: Vec<Unit>,
}

impl Unit {
    fn leaf(level: Level, text: &str, carry_next: f32) -> Unit {
        Unit { level, text: text.to_string(), carry_next, children: Vec::new() }
    }
    /// Count of descendant units at a given level (handy for tests / metrics).
    pub fn count_at(&self, level: Level) -> usize {
        let here = if self.level == level { 1 } else { 0 };
        here + self.children.iter().map(|c| c.count_at(level)).sum::<usize>()
    }
}

// A flat token: a word followed by the operator that closed it.
#[derive(Debug, Clone)]
struct Tok { word: String, op: Operator }

/// Tokenise raw text into (word, closing-operator) pairs. Runs of whitespace and
/// trailing spaces after a stronger operator collapse into that operator.
fn tokenize(text: &str) -> Vec<Tok> {
    let mut toks: Vec<Tok> = Vec::new();
    let mut cur = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match Operator::from_char(c) {
            Some(op) => {
                // Collapse following whitespace into this boundary; and collapse a
                // run of paragraph breaks into one Paragraph.
                let mut eff = op;
                loop {
                    match chars.peek().copied() {
                        Some(n) if n == ' ' || n == '\t' || n == '\r' => { chars.next(); }
                        Some('\n') if eff == Operator::Paragraph => { chars.next(); }
                        Some('\n') => { chars.next(); eff = Operator::Paragraph; }
                        _ => break,
                    }
                }
                // Skip pure-whitespace boundaries that produced no word (e.g. leading
                // spaces) unless they carry real structure.
                if cur.is_empty() && eff == Operator::Space { continue; }
                toks.push(Tok { word: std::mem::take(&mut cur), op: eff });
            }
            None => cur.push(c),
        }
    }
    if !cur.is_empty() {
        toks.push(Tok { word: std::mem::take(&mut cur), op: Operator::Reply });
    }
    toks
}

fn flush_clause(words: &mut Vec<Unit>, clauses: &mut Vec<Unit>, link: f32) {
    if words.is_empty() { return; }
    let text = words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");
    let children = std::mem::take(words);
    clauses.push(Unit { level: Level::Clause, text, carry_next: link, children });
}
fn flush_sentence(clauses: &mut Vec<Unit>, sentences: &mut Vec<Unit>, link: f32) {
    if clauses.is_empty() { return; }
    let text = clauses.iter().map(|c| c.text.as_str()).collect::<Vec<_>>().join(", ");
    let children = std::mem::take(clauses);
    sentences.push(Unit { level: Level::Sentence, text, carry_next: link, children });
}
fn flush_paragraph(sentences: &mut Vec<Unit>, paragraphs: &mut Vec<Unit>, link: f32) {
    if sentences.is_empty() { return; }
    let text = sentences.iter().map(|s| s.text.as_str()).collect::<Vec<_>>().join(" ");
    let children = std::mem::take(sentences);
    paragraphs.push(Unit { level: Level::Paragraph, text, carry_next: link, children });
}

/// READING: parse a string into the full carry-weighted hierarchy
/// (Reply > Paragraph > Sentence > Clause > Word). This is what KAI runs on input
/// to *understand* a multi-sentence passage as one integrated meaning, and the shape
/// he unfolds in reverse to *generate* a structured reply.
pub fn segment(text: &str) -> Unit {
    let toks = tokenize(text);

    // Words -> Clauses (split on clause-enders), Clauses -> Sentences, etc.
    let mut clauses: Vec<Unit> = Vec::new();
    let mut words: Vec<Unit> = Vec::new();
    let mut sentences: Vec<Unit> = Vec::new();
    let mut paragraphs: Vec<Unit> = Vec::new();

    for t in &toks {
        if !t.word.is_empty() {
            // The word's carry_next is the operator that follows it.
            words.push(Unit::leaf(Level::Word, &t.word, t.op.carry()));
        }
        match t.op {
            Operator::Space | Operator::Bind => { /* word boundary only */ }
            Operator::Comma | Operator::Semicolon | Operator::Colon => {
                flush_clause(&mut words, &mut clauses, t.op.carry());
            }
            Operator::Period | Operator::Question | Operator::Exclaim => {
                flush_clause(&mut words, &mut clauses, t.op.carry());
                flush_sentence(&mut clauses, &mut sentences, t.op.carry());
            }
            Operator::Paragraph => {
                flush_clause(&mut words, &mut clauses, t.op.carry());
                flush_sentence(&mut clauses, &mut sentences, t.op.carry());
                flush_paragraph(&mut sentences, &mut paragraphs, t.op.carry());
            }
            Operator::Reply => {
                // trailing word with no terminator — close everything up.
                flush_clause(&mut words, &mut clauses, Operator::Reply.carry());
                flush_sentence(&mut clauses, &mut sentences, Operator::Reply.carry());
                flush_paragraph(&mut sentences, &mut paragraphs, Operator::Reply.carry());
            }
        }
    }
    // close any dangling open units (text without a final terminator)
    flush_clause(&mut words, &mut clauses, Operator::Reply.carry());
    flush_sentence(&mut clauses, &mut sentences, Operator::Reply.carry());
    flush_paragraph(&mut sentences, &mut paragraphs, Operator::Reply.carry());

    let text = paragraphs.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("\n\n");
    Unit { level: Level::Reply, text, carry_next: 0.0, children: paragraphs }
}

/// GENERATION — running "alive meaning": how much of the prior context should still
/// bias the next piece. Walk the operators emitted so far; crossing one multiplies
/// the alive value by its carry, but a sentence-ender doesn't zero the thread — the
/// consolidated sentence is pushed UP, so a floor (`reply_floor`) keeps the reply's
/// meaning alive across multiple sentences. That floor is the "more than one
/// sentence per reply" mechanism.
pub fn carry_context(ops_so_far: &[Operator]) -> f32 {
    let reply_floor = 0.25_f32; // the whole-reply thread never fully dies mid-reply
    let mut alive = 1.0_f32;
    let mut crossed_sentence = false;
    for &op in ops_so_far {
        alive *= op.carry();
        if op.ends_sentence() {
            // sentence consolidated upward -> reply thread persists from here on
            crossed_sentence = true;
        }
        if crossed_sentence {
            // once a sentence has closed, the reply thread holds at/above the floor
            // for the remainder of the reply (later words can't kill it back to zero)
            alive = alive.max(reply_floor);
        }
    }
    alive.clamp(0.0, 1.0)
}

/// GENERATION — given how strong a boundary the model wants next (0 = same word,
/// 1 = end the whole thought), choose the operator to place. `at_sentence_end`
/// nudges toward a terminator. This is what replaces the hard-coded space in the
/// pure-lattice generator so KAI emits real punctuation/structure.
pub fn choose_operator(boundary_strength: f32, want_question: bool) -> Operator {
    let b = boundary_strength.clamp(0.0, 1.0);
    if b < 0.30 { Operator::Space }
    else if b < 0.55 { Operator::Comma }
    else if b < 0.75 { Operator::Semicolon }
    else if want_question { Operator::Question }
    else { Operator::Period }
}

/// Once a sentence is this long, `render` prefers to FULL-STOP at the next clause
/// boundary instead of only comma-ing it. A tunable prior, like the carry weights.
pub const TARGET_SENTENCE_WORDS: usize = 14;
/// Absolute run-on ceiling: past this, stop at the first SAFE site even without a
/// clause opener, so a long stream can't become one endless sentence.
const HARD_MAX_SENTENCE_WORDS: usize = 24;
/// Never end a sentence if doing so would leave a tail shorter than this — stops
/// the reply trailing off into a dangling one-word "sentence".
const MIN_TAIL_WORDS: usize = 4;
/// Minimum words already in the current clause before a conjunction earns a comma.
const MIN_CLAUSE_WORDS: usize = 4;

fn is_operator_char(c: char) -> bool { matches!(c, '.' | ',' | ';' | ':' | '!' | '?') }

fn capitalize_first(w: &str) -> String {
    let mut ch = w.chars();
    match ch.next() {
        Some(f) => f.to_uppercase().collect::<String>() + ch.as_str(),
        None => String::new(),
    }
}

/// Sentence-opening words that make the sentence a QUESTION. The wh-set is
/// high-precision; the inverted auxiliaries are near-always interrogative when they
/// OPEN an English sentence (the imperative "do not .." / "have not .." case is
/// excluded by the guard in `sentence_is_question`). This is a heuristic: it will
/// occasionally mark a declarative that happens to start with an auxiliary.
fn opens_question(w: &str) -> bool {
    matches!(w,
        "what" | "why" | "how" | "when" | "where" | "who" | "whom" | "whose" | "which"
        | "is" | "are" | "am" | "was" | "were" | "do" | "does" | "did"
        | "can" | "could" | "will" | "would" | "should" | "shall" | "may" | "might"
        | "has" | "have" | "had")
}

/// Words that open a new CLAUSE — the comma sites of the model.
fn opens_clause(w: &str) -> bool {
    matches!(w,
        "and" | "but" | "or" | "nor" | "so" | "yet" | "then"
        | "because" | "although" | "though" | "whereas" | "while"
        | "however" | "therefore" | "thus" | "meanwhile" | "otherwise" | "instead")
}

/// Grammatical glue — articles, determiners, prepositions, conjunctions,
/// auxiliaries/modals, pronouns, wh-words. In carry terms these are the HIGH-carry
/// words: they bind tightly to their neighbour, so a full stop must never be placed
/// immediately before or after one. Content words are the only safe stop sites.
fn is_function_word(w: &str) -> bool {
    matches!(w,
        // articles / determiners / quantifiers
        "a" | "an" | "the" | "this" | "that" | "these" | "those" | "my" | "your" | "his"
        | "her" | "its" | "our" | "their" | "some" | "any" | "each" | "every" | "both"
        | "few" | "more" | "most" | "other" | "such" | "no" | "all"
        // pronouns
        | "i" | "you" | "he" | "she" | "it" | "we" | "they" | "me" | "him" | "us" | "them"
        // prepositions / particles
        | "of" | "at" | "by" | "for" | "with" | "about" | "against" | "between" | "into"
        | "through" | "during" | "before" | "after" | "above" | "below" | "to" | "from"
        | "up" | "down" | "in" | "out" | "on" | "off" | "over" | "under" | "as" | "than"
        // conjunctions / connectives
        | "and" | "but" | "or" | "nor" | "so" | "yet" | "if" | "because" | "although"
        | "though" | "while" | "whereas" | "since" | "then" | "when" | "where"
        // auxiliaries / modals / negation
        | "is" | "are" | "am" | "was" | "were" | "be" | "been" | "being" | "have" | "has"
        | "had" | "do" | "does" | "did" | "can" | "could" | "will" | "would" | "should"
        | "shall" | "may" | "might" | "must" | "not" | "very" | "just"
        // wh-words (relative or interrogative — both bind forward)
        | "what" | "why" | "how" | "who" | "whom" | "whose" | "which")
}

fn sentence_is_question(toks: &[String], start: usize) -> bool {
    let first = match toks.get(start) { Some(f) => f.to_lowercase(), None => return false };
    if !opens_question(&first) { return false; }
    // "do not touch" / "have not seen" are commands/statements, not questions.
    match toks.get(start + 1).map(|n| n.to_lowercase()) {
        Some(n) if n == "not" || n == "n't" || n == "never" => false,
        _ => true,
    }
}

/// GENERATION v1: render a flat word list into structured text with operators +
/// capitalization. The pure-lattice generator emits only words joined by spaces
/// (no punctuation at all), so this is the pass that makes output read as real
/// sentences instead of a run-on. A richer version feeds per-token boundary scores
/// from the BitNet path into `choose_operator`; this safe heuristic derives the
/// boundary strength from sentence length + clause openers and lets
/// `choose_operator` place the actual glyph.
///
/// It orders STRUCTURE ONLY. If the incoming word list is semantically wrong, the
/// output is a well-punctuated wrong sentence — this does not touch word choice.
pub fn render(words: &[String]) -> String {
    render_with(words, TARGET_SENTENCE_WORDS)
}

/// `render` with an explicit sentence-length target (used by tests/benchmarks).
pub fn render_with(words: &[String], target: usize) -> String {
    // Normalise: flatten any embedded whitespace, strip punctuation the generator
    // may already have glued on (we re-derive structure), drop empty/pure-symbol
    // tokens. Prevents "word.." and double spaces.
    let toks: Vec<String> = words
        .iter()
        .flat_map(|w| w.split_whitespace())
        .map(|w| w.trim_matches(is_operator_char).to_string())
        .filter(|w| w.chars().any(|c| c.is_alphanumeric()))
        .collect();
    if toks.is_empty() { return String::new(); }
    let target = target.max(1);

    let mut out = String::new();
    let mut since_stop = 0usize;     // words in the current sentence
    let mut since_clause = 0usize;   // words since the last clause boundary
    let mut start_sentence = true;
    let mut is_question = sentence_is_question(&toks, 0);

    for i in 0..toks.len() {
        let mut word = toks[i].clone();
        if start_sentence {
            word = capitalize_first(&word);
        } else if word == "i" || word.starts_with("i'") {
            // the first-person pronoun is always capital ("i", "i'm", "i've", "i'll")
            word = capitalize_first(&word);
        }
        out.push_str(&word);
        start_sentence = false;
        since_stop += 1;
        since_clause += 1;

        let remaining = toks.len() - (i + 1);
        let op = if remaining == 0 {
            // ALWAYS terminate — the last sentence is never left open.
            if is_question { Operator::Question } else { Operator::Period }
        } else {
            let cur = toks[i].to_lowercase();
            let next = toks[i + 1].to_lowercase();
            // No boundary of ANY strength may follow grammatical glue: ", and" is
            // fine after "store", nonsense after "the".
            let cur_is_glue = is_function_word(&cur);
            // A full stop additionally must not orphan a runt tail and must not land
            // before glue ("... recall. Can ...").
            let can_stop =
                remaining >= MIN_TAIL_WORDS && !cur_is_glue && !is_function_word(&next);
            // The one place we KNOW a new clause begins.
            let clause_site =
                opens_clause(&next) && since_clause >= MIN_CLAUSE_WORDS && !cur_is_glue;

            // Boundary strength -> operator, via the module's own mapping.
            let strength = if clause_site && since_stop >= target && remaining >= MIN_TAIL_WORDS {
                1.0 // long enough: full stop, and the conjunction opens the next sentence
            } else if clause_site {
                0.45 // comma band
            } else if since_stop >= HARD_MAX_SENTENCE_WORDS && can_stop {
                1.0 // run-on ceiling: break at the first safe site
            } else {
                0.10 // same thought
            };
            choose_operator(strength, is_question)
        };

        out.push_str(op.glyph());
        if op.ends_sentence() {
            since_stop = 0;
            since_clause = 0;
            start_sentence = true;
            is_question = sentence_is_question(&toks, i + 1);
        } else if op.closes() == Level::Clause {
            since_clause = 0;
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<String> {
        s.split_whitespace().map(|x| x.to_string()).collect()
    }

    #[test]
    fn render_structures_words() {
        let words = w("the lattice resonates and the pattern forms");
        let out = render(&words);
        assert!(out.starts_with("The"), "first word capitalized");
        assert!(out.ends_with('.'), "ends with a stop");
    }

    // ---- flag ---------------------------------------------------------------
    // NOTE: kept as ONE test so it cannot race another test mutating the global.
    #[test]
    fn flag_parsing_and_default_off() {
        assert!(parse_flag("1"));
        assert!(parse_flag("true"));
        assert!(parse_flag("ON"));
        assert!(parse_flag("yes"));
        assert!(!parse_flag(""));
        assert!(!parse_flag("0"));
        assert!(!parse_flag("false"));
        assert!(!parse_flag("FALSE"));
        assert!(!parse_flag("off"));
        assert!(!parse_flag(" off "));
        // Default is OFF unless the operator set the env for this test run.
        if std::env::var(ENV_FLAG).is_err() {
            assert!(!enabled(), "word calculus must ship OFF by default");
            set_enabled(true);
            assert!(enabled(), "explicit set_enabled(true) turns it on");
            set_enabled(false);
            assert!(!enabled(), "explicit set_enabled(false) turns it back off");
        }
    }

    // ---- render -------------------------------------------------------------

    #[test]
    fn render_empty_and_junk() {
        assert_eq!(render(&[]), "");
        assert_eq!(render(&w("... , ;")), "", "pure-punctuation tokens are dropped");
    }

    #[test]
    fn render_single_word() {
        assert_eq!(render(&w("hello")), "Hello.");
    }

    #[test]
    fn render_never_double_punctuates() {
        // The generator can hand us tokens with punctuation already glued on.
        let out = render(&w("hello. there, friend"));
        assert_eq!(out, "Hello there friend.");
        assert!(!out.contains(".."), "no doubled stops");
        assert!(!out.contains("  "), "no doubled spaces");
    }

    #[test]
    fn render_marks_questions() {
        assert!(render(&w("what is the lattice")).ends_with('?'), "wh-opener => question");
        assert!(render(&w("how does memory work")).ends_with('?'));
        assert!(render(&w("the lattice is memory")).ends_with('.'), "declarative => period");
        assert!(render(&w("do not touch the lattice")).ends_with('.'), "imperative is not a question");
    }

    #[test]
    fn render_capitalizes_lone_i() {
        let out = render(&w("today i think about the lattice"));
        assert_eq!(out, "Today I think about the lattice.");
    }

    #[test]
    fn render_inserts_clause_commas() {
        // >= MIN_CLAUSE_WORDS before the conjunction => comma.
        let out = render(&w("i went to the store then i bought milk"));
        assert_eq!(out, "I went to the store, then I bought milk.");
        // ... and NOT for a short "and" that just joins two nouns.
        let out2 = render(&w("data and memory"));
        assert_eq!(out2, "Data and memory.");
    }

    #[test]
    fn render_splits_long_streams_and_never_leaves_a_runt() {
        // 31 content words with no clause openers — the run-on ceiling must fire.
        let words: Vec<String> = (0..31).map(|i| format!("word{}", i)).collect();
        let out = render(&words);
        let sentences: Vec<&str> = out.split(". ").collect();
        assert!(sentences.len() >= 2, "long stream must break into sentences: {}", out);
        for s in &sentences {
            let first = s.chars().next().unwrap();
            assert!(first.is_uppercase(), "every sentence starts capitalized: {:?}", s);
            let n = s.split_whitespace().count();
            assert!(n >= MIN_TAIL_WORDS, "no runt sentence ({} words): {:?}", n, s);
            assert!(n <= HARD_MAX_SENTENCE_WORDS + MIN_TAIL_WORDS,
                    "no unbounded run-on ({} words): {:?}", n, s);
        }
        assert!(out.ends_with('.'), "the last sentence is terminated, not dropped");
        // No word is lost, no word is added.
        assert_eq!(out.split_whitespace().count(), words.len());
    }

    #[test]
    fn render_stops_at_clause_boundary_not_mid_phrase() {
        // 18 words: past TARGET, so the second "and" becomes a full stop rather
        // than a comma — and the stop lands at the clause opener, not after "the".
        let words = w("memory is stored as vectors in the lattice and the engine can \
                       recall it later and the pattern holds");
        let out = render(&words);
        assert!(out.contains(". And"), "breaks at the clause opener: {}", out);
        // A stop must never sit right after grammatical glue.
        for s in out.split(". ") {
            let last = s.trim_end_matches(is_operator_char).split_whitespace().last().unwrap();
            assert!(!is_function_word(&last.to_lowercase()),
                    "sentence ends on a function word ({:?}): {}", last, out);
        }
    }

    #[test]
    fn render_round_trips_through_segment() {
        // What render emits must parse back into the same hierarchy it encodes.
        let out = render(&w("i went to the store then i bought milk"));
        let u = segment(&out);
        assert_eq!(u.count_at(Level::Sentence), 1);
        assert_eq!(u.count_at(Level::Clause), 2);
    }

    /// The headline before/after: a realistic word list from the AR generator in
    /// `lattice_attention::generate_autoregressive` (vocab = lattice hits + the
    /// hard-coded conversational words).
    #[test]
    fn render_realistic_ar_output() {
        let words = w("the lattice is a symbolic architecture and memory is stored \
                       as vectors so the engine can recall what it learned today");
        let before = words.join(" "); // exactly what the generator emits with the flag OFF
        let after = render(&words);
        println!("BEFORE: {}", before);
        println!("AFTER : {}", after);

        assert!(!before.ends_with('.'), "before: unpunctuated run-on");
        assert!(before.starts_with("the"), "before: uncapitalized");

        assert!(after.starts_with("The"), "after: capitalized");
        assert!(after.ends_with('.'), "after: terminated");
        assert!(after.contains(", "), "after: clause boundaries marked: {}", after);
        // structure only — the words themselves are untouched and in order
        let strip = |s: &str| s.chars().filter(|c| !is_operator_char(*c)).collect::<String>().to_lowercase();
        assert_eq!(strip(&after), strip(&before), "render must not change word choice");
    }

    /// Prints the full before/after table (`cargo test --lib word_calculus -- --nocapture`).
    /// Every sample must survive the invariants: unchanged word sequence, terminated,
    /// capitalized. This is the evidence, not a new behaviour.
    #[test]
    fn render_before_after_table() {
        let samples = [
            "the lattice is a symbolic architecture and memory is stored as vectors so the engine can recall what it learned today",
            "what is the lattice and how does the engine store memory",
            "hello Ryan i am the engine and i can recall what you asked me yesterday about the symbolic architecture",
            "data",
            "i went to the store then i bought milk",
        ];
        for s in samples {
            let words = w(s);
            let after = render(&words);
            println!("BEFORE: {}", words.join(" "));
            println!("AFTER : {}\n", after);
            let strip = |s: &str| {
                s.chars().filter(|c| !is_operator_char(*c)).collect::<String>().to_lowercase()
            };
            assert_eq!(strip(&after), strip(&words.join(" ")), "word choice untouched: {}", s);
            let end = after.chars().last().unwrap();
            assert!(end == '.' || end == '?' || end == '!', "terminated: {}", after);
            assert!(after.chars().next().unwrap().is_uppercase(), "capitalized: {}", after);
        }
    }


    #[test]
    fn carry_weights_ordered() {
        // tighter binding = higher carry, down to the full stop
        assert!(Operator::Bind.carry() > Operator::Space.carry());
        assert!(Operator::Space.carry() > Operator::Comma.carry());
        assert!(Operator::Comma.carry() > Operator::Period.carry());
        assert!(Operator::Period.carry() < 0.2);
    }

    #[test]
    fn comma_vs_period_example() {
        // Ryan's example: "I went to the store, then I bought milk."
        let u = segment("I went to the store, then I bought milk.");
        // one sentence, two clauses
        assert_eq!(u.count_at(Level::Sentence), 1, "should be ONE sentence");
        assert_eq!(u.count_at(Level::Clause), 2, "comma splits into TWO clauses");
        // the clause before the comma carries ~0.45 to the next; sentence ends ~0.10
        let sentence = &u.children[0].children[0];
        assert!((sentence.children[0].carry_next - Operator::Comma.carry()).abs() < 1e-6);
        assert!((sentence.carry_next - Operator::Period.carry()).abs() < 1e-6);
        // clause texts are the two halves
        assert_eq!(sentence.children[0].text, "I went to the store");
        assert_eq!(sentence.children[1].text, "then I bought milk");
    }

    #[test]
    fn multiple_sentences_in_one_reply() {
        // the "more than one sentence" case
        let u = segment("Hello there. How are you? I am fine.");
        assert_eq!(u.count_at(Level::Sentence), 3, "three sentences, one reply");
        assert_eq!(u.count_at(Level::Paragraph), 1, "all under one paragraph");
        // the reply thread stays alive across sentence boundaries (floor)
        let alive = carry_context(&[Operator::Space, Operator::Period, Operator::Space]);
        assert!(alive >= 0.25, "reply meaning persists across a period");
    }

    #[test]
    fn words_and_letters() {
        let u = segment("cat dog");
        assert_eq!(u.count_at(Level::Word), 2);
        // a word stays one tight object; the space links to the next word at ~0.8
        let w0 = &u.children[0].children[0].children[0].children[0];
        assert_eq!(w0.text, "cat");
        assert!((w0.carry_next - Operator::Space.carry()).abs() < 1e-6);
    }

    #[test]
    fn paragraphs_split() {
        let u = segment("First thought here.\n\nSecond block now.");
        assert_eq!(u.count_at(Level::Paragraph), 2);
    }

    #[test]
    fn generation_operator_choice() {
        assert_eq!(choose_operator(0.1, false), Operator::Space);
        assert_eq!(choose_operator(0.5, false), Operator::Comma);
        assert_eq!(choose_operator(0.9, false), Operator::Period);
        assert_eq!(choose_operator(0.9, true), Operator::Question);
    }
}
