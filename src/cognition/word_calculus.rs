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
//! explicitly enabled.

use std::sync::atomic::{AtomicBool, Ordering};

/// Master switch. OFF by default — enable via `set_enabled(true)` (or an env hook)
/// only after `cargo test word_calculus` passes and you want it live.
pub static WORD_CALCULUS: AtomicBool = AtomicBool::new(false);
pub fn enabled() -> bool { WORD_CALCULUS.load(Ordering::Relaxed) }
pub fn set_enabled(on: bool) { WORD_CALCULUS.store(on, Ordering::Relaxed); }

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

/// GENERATION v1: render a flat word list into structured text with operators +
/// capitalization. The pure-lattice generator emits only words joined by spaces
/// (no punctuation at all), so this is the first pass that makes output read as real
/// sentences instead of a run-on. A richer version feeds per-token boundary scores
/// from the BitNet path into `choose_operator`; this safe heuristic places a sentence
/// stop near a natural length and capitalizes each opening word.
pub fn render(words: &[String]) -> String {
    if words.is_empty() { return String::new(); }
    let target = 14usize; // ~words before a natural full stop
    let mut out = String::new();
    let mut since_stop = 0usize;
    for (i, w) in words.iter().enumerate() {
        let start_sentence = out.is_empty() || out.ends_with(". ");
        if !out.is_empty() && !out.ends_with(". ") { out.push(' '); }
        let mut word = w.clone();
        if start_sentence {
            let mut ch = word.chars();
            if let Some(f) = ch.next() {
                word = f.to_uppercase().collect::<String>() + ch.as_str();
            }
        }
        out.push_str(&word);
        since_stop += 1;
        if i + 1 == words.len() || since_stop >= target {
            out.push_str(". ");
            since_stop = 0;
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_structures_words() {
        let words: Vec<String> = "the lattice resonates and the pattern forms"
            .split_whitespace().map(|s| s.to_string()).collect();
        let out = render(&words);
        assert!(out.starts_with("The"), "first word capitalized");
        assert!(out.ends_with('.'), "ends with a stop");
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
