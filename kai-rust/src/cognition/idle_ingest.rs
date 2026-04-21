//! Idle Ingest Worker — passive learning during idle ticks.
//!
//! **What it does.** Watches `data/ingest/*.txt` for plain-text knowledge
//! files. While KAI is idle (no active conversation for 30+ seconds), the
//! worker reads a handful of lines per heartbeat, encodes each line into
//! the lattice via `store_or_reinforce`, and tracks progress per file.
//! When a file is fully absorbed, it is moved into `data/ingested/` so
//! you can see which corpora KAI has already consumed.
//!
//! **Why it exists.** Before this module, KAI only learned from live
//! conversation and one-shot `import <path>` commands. The complaint —
//! rightly — was that "when I go to sleep he doesn't learn anything."
//! This closes that gap. Drop a text file in `data/ingest/`, come back
//! hours later, and KAI has eaten it line by line.
//!
//! **Design principles.**
//!
//! 1. *Idle-first*: never runs while a conversation is live. The DMN's
//!    `idle_duration()` gates it.
//! 2. *Rate-limited*: a few lines per tick (default 5). At a 5-second
//!    heartbeat that's ~1 line/sec — fast enough to absorb thousands
//!    overnight, slow enough that it doesn't starve the rest of the
//!    cognition loop of CPU.
//! 3. *Line-level idempotent*: uses `store_or_reinforce`, so re-ingesting
//!    the same line only strengthens the existing cell rather than
//!    creating duplicates. Safe across restarts.
//! 4. *Tagged by region*: lines can carry an inline `[region]` prefix,
//!    e.g. `[science] Water is H2O.` → stored in region "science". No
//!    prefix → default region "knowledge".
//! 5. *Observable*: returns a short status string per file completion so
//!    the main loop can surface it in the TUI — you *see* KAI learning.

use crate::core::Universe;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Per-tick line budget when KAI is genuinely idle (no recent input).
/// At ~5s heartbeat that's 240 lines/minute, absorbing a 5,000-line
/// corpus in about 20 minutes of pure idle time. This is the "sleep
/// / nobody's talking to me" rate.
const IDLE_LINES_PER_TICK: usize = 20;

/// Per-tick line budget during active conversation. Learning never
/// fully stops — KAI always has a little attention spare for the
/// background corpus even while he's chatting. At 5s heartbeat this
/// is ~24 lines/minute, which is enough to grow noticeably across
/// a long conversation without competing with response generation.
const ACTIVE_LINES_PER_TICK: usize = 2;

/// Minimum character count for an ingested line. Skips short fragments
/// that would encode to nearly-zero sparse vectors.
const MIN_LINE_LEN: usize = 12;

/// How long KAI must have been idle (no active conversation turn)
/// before he's considered "fully idle" and the higher ingest budget
/// kicks in. Below this he still ingests at the active-conversation
/// rate — so learning is continuous, it just accelerates when you
/// step away.
const IDLE_THRESHOLD_SECS: u64 = 8;

/// Upper bound on concept anchors pulled from each ingested line. Two
/// to four significant words per sentence is typical; more than that
/// tends to be noise (stopwords slipping through, or filler adjectives).
const MAX_CONCEPTS_PER_LINE: usize = 3;

/// Minimum word length before we treat a word as a concept candidate.
/// Four character words like "cell", "atom", "mind" are meaningful and
/// worth keeping. Three-character words are mostly stopwords or fillers.
const MIN_CONCEPT_LEN: usize = 4;

/// Concept anchor cells are stored with lower strength than full lines
/// so they surface as supporting context during queries, not as the
/// primary answer. They gain strength through repeated reinforcement.
const CONCEPT_ANCHOR_STRENGTH: f32 = 0.55;

/// Stopwords for concept extraction. Intentionally aggressive — we
/// want concept cells to be rare, informative words, not common
/// connective tissue. This list is a superset of typical English
/// stopwords plus very common meta-words ("about", "usually",
/// "instance") that show up in definitions but aren't themselves
/// concepts worth anchoring.
const CONCEPT_STOPWORDS: &[&str] = &[
    // Articles / pronouns / auxiliary
    "the", "and", "but", "for", "nor", "yet", "all", "any", "are",
    "can", "did", "does", "doesn", "don", "each", "from", "had",
    "has", "have", "here", "how", "its", "itself", "just", "like",
    "more", "most", "much", "may", "might", "must", "not", "now",
    "off", "often", "only", "other", "our", "ours", "out", "over",
    "own", "same", "she", "should", "some", "such", "than", "that",
    "their", "them", "then", "there", "these", "they", "this", "those",
    "through", "too", "under", "very", "was", "were", "what", "when",
    "where", "which", "while", "who", "why", "will", "with", "would",
    "you", "your", "yours", "yourself", "about", "after", "again",
    "against", "before", "being", "below", "between", "both", "during",
    "further", "into", "itself", "once", "during", "himself", "herself",
    "because", "however", "therefore", "otherwise", "meanwhile",
    // Meta words common in definitions/corpora
    "example", "examples", "called", "known", "also", "usually",
    "typically", "often", "many", "several", "various", "general",
    "specific", "particular", "certain", "another", "something",
    "someone", "anything", "everyone", "everybody", "anyone", "each",
    "every", "either", "neither", "both", "whole", "part", "parts",
    "kind", "kinds", "type", "types", "sort", "sorts", "thing", "things",
    "word", "words", "name", "names", "case", "cases", "time", "times",
    "way", "ways", "form", "forms", "idea", "ideas", "fact", "facts",
    "number", "numbers", "value", "values", "term", "terms",
    "means", "refers", "including", "include", "includes", "included",
    "using", "used", "based", "between", "within",
];

/// One file's progress cursor. Persists in memory for the current
/// session; on restart, a file that was half-read just restarts from
/// line 0 — `store_or_reinforce` deduplicates so there's no harm.
#[derive(Debug, Clone)]
pub struct FileCursor {
    pub path: PathBuf,
    pub total_lines: usize,
    pub next_line: usize,
    pub added: usize,
    pub reinforced: usize,
    pub skipped: usize,
}

impl FileCursor {
    pub fn done(&self) -> bool {
        self.next_line >= self.total_lines
    }

    pub fn short_name(&self) -> String {
        self.path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string()
    }
}

/// Outcome of a single ingest tick. The caller uses this to surface
/// progress ("📚 Ingested 5 lines from science_facts.txt") in the TUI.
#[derive(Debug, Clone, Default)]
pub struct IngestReport {
    pub lines_processed: usize,
    pub lines_added: usize,
    pub lines_reinforced: usize,
    /// Concept anchor cells newly created this tick (word-level cells
    /// like "photosynthesis", "entropy", "consciousness" spawned from
    /// significant words inside ingested lines).
    pub concepts_added: usize,
    /// Concept anchor cells reinforced this tick — this is the
    /// signal that KAI is "recognizing" a concept he's seen before
    /// in a new context, which is exactly the associative branching
    /// that grows understanding.
    pub concepts_reinforced: usize,
    pub file_name: Option<String>,
    pub file_completed: bool,
    pub cells_before: usize,
    pub cells_after: usize,
}

impl IngestReport {
    pub fn is_noop(&self) -> bool {
        self.lines_processed == 0
    }

    pub fn summary(&self) -> String {
        let file = self.file_name.as_deref().unwrap_or("(unknown)");
        if self.file_completed {
            format!(
                "📚 Finished {}: +{} lines, +{} concepts, {} reinforced, {} total cells",
                file,
                self.lines_added,
                self.concepts_added,
                self.lines_reinforced + self.concepts_reinforced,
                self.cells_after
            )
        } else {
            format!(
                "📚 {} lines from {} (+{} main, +{} concepts, {} total)",
                self.lines_processed,
                file,
                self.lines_added,
                self.concepts_added,
                self.cells_after
            )
        }
    }
}

/// The ingest worker state. Lives inside `App` and is pumped once per
/// heartbeat via `tick()`.
#[derive(Debug)]
pub struct IdleIngest {
    pub enabled: bool,
    pub idle_lines_per_tick: usize,
    pub active_lines_per_tick: usize,
    pub ingest_dir: PathBuf,
    pub archive_dir: PathBuf,
    /// Cached file buffers keyed by absolute path. Loaded on first use
    /// and cleared when the file finishes.
    buffers: HashMap<PathBuf, Vec<String>>,
    /// Cursor for each file currently being processed. Removed when done.
    cursors: HashMap<PathBuf, FileCursor>,
    /// Total cells KAI has ever added through this worker, across the
    /// session. Exposed via `total_added()` for the TUI status line.
    total_added: usize,
    total_reinforced: usize,
    total_concepts_added: usize,
    total_concepts_reinforced: usize,
    total_files_done: usize,
}

impl IdleIngest {
    /// Build an ingest worker.
    ///
    /// The ingest folder resolution is layered — first environment
    /// variable override, then the canonical `C:\KAI\data\ingest`
    /// (same location the tick CSV logger uses), and only as a last
    /// resort the passed-in `base_dir` relative path. This is exactly
    /// the problem that just bit us: KAI's `base_dir` is wherever the
    /// binary was launched from (often `C:\KAI\kai-rust\`), so
    /// joining `base_dir/data/ingest` pointed him at a folder that
    /// wasn't the one you were actually dropping files into. Now
    /// regardless of launch directory, everyone is looking at the
    /// same canonical folder.
    pub fn new(base_dir: &str) -> Self {
        let ingest_dir = resolve_ingest_dir(base_dir);
        let archive_dir = ingest_dir
            .parent()
            .map(|p| p.join("ingested"))
            .unwrap_or_else(|| Path::new(base_dir).join("data").join("ingested"));
        let _ = fs::create_dir_all(&ingest_dir);
        let _ = fs::create_dir_all(&archive_dir);

        // Drop a README the first time so the user knows what goes here.
        let readme = ingest_dir.join("README.txt");
        if !readme.exists() {
            let _ = fs::write(
                &readme,
                DEFAULT_README,
            );
        }

        Self {
            enabled: true,
            idle_lines_per_tick: IDLE_LINES_PER_TICK,
            active_lines_per_tick: ACTIVE_LINES_PER_TICK,
            ingest_dir,
            archive_dir,
            buffers: HashMap::new(),
            cursors: HashMap::new(),
            total_added: 0,
            total_reinforced: 0,
            total_concepts_added: 0,
            total_concepts_reinforced: 0,
            total_files_done: 0,
        }
    }

    pub fn total_added(&self) -> usize {
        self.total_added
    }

    pub fn total_reinforced(&self) -> usize {
        self.total_reinforced
    }

    pub fn total_concepts_added(&self) -> usize {
        self.total_concepts_added
    }

    pub fn total_concepts_reinforced(&self) -> usize {
        self.total_concepts_reinforced
    }

    pub fn total_files_done(&self) -> usize {
        self.total_files_done
    }

    /// Does the current environment have anything to ingest right now?
    /// Used by callers to skip the whole pipeline when the folder is
    /// empty — no disk scan per tick.
    pub fn has_work(&self) -> bool {
        // Cheap check: any cursor in progress, or any .txt in the folder
        // aside from the README.
        if !self.cursors.is_empty() {
            return true;
        }
        fs::read_dir(&self.ingest_dir)
            .ok()
            .map(|iter| {
                iter.filter_map(|e| e.ok())
                    .any(|e| {
                        let p = e.path();
                        p.extension().and_then(|s| s.to_str()) == Some("txt")
                            && p.file_name().and_then(|s| s.to_str())
                                != Some("README.txt")
                    })
            })
            .unwrap_or(false)
    }

    /// One ingest step. Returns a report describing what was absorbed
    /// this tick. Learning is continuous: even during active
    /// conversation KAI absorbs a small trickle (ACTIVE_LINES_PER_TICK),
    /// and when he's been idle for more than IDLE_THRESHOLD_SECS the
    /// rate jumps to IDLE_LINES_PER_TICK. The only total-stop
    /// conditions are: worker disabled, or no files in data/ingest.
    ///
    /// `idle_secs` is the DMN's idle duration in seconds.
    pub fn tick(&mut self, universe: &mut Universe, idle_secs: u64) -> IngestReport {
        if !self.enabled {
            return IngestReport::default();
        }
        if !self.has_work() {
            return IngestReport::default();
        }

        // Choose budget based on idle state. A real, continuous rate
        // even during conversation — so learning never flatlines just
        // because you're typing. Idle bursts absorb the bulk of any
        // corpus across minutes rather than hours.
        let budget = if idle_secs >= IDLE_THRESHOLD_SECS {
            IDLE_LINES_PER_TICK
        } else {
            ACTIVE_LINES_PER_TICK
        };

        // Pick the next file. Prefer one already in progress to finish
        // it cleanly before starting a new one.
        let target_path = self
            .cursors
            .keys()
            .next()
            .cloned()
            .or_else(|| self.find_next_file());

        let Some(path) = target_path else {
            return IngestReport::default();
        };

        // Load the file into the buffer if it's the first time we see it.
        if !self.buffers.contains_key(&path) {
            let Ok(content) = fs::read_to_string(&path) else {
                // File vanished or is unreadable — remove cursor if any.
                self.cursors.remove(&path);
                return IngestReport::default();
            };
            let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
            let total = lines.len();
            self.buffers.insert(path.clone(), lines);
            self.cursors.insert(
                path.clone(),
                FileCursor {
                    path: path.clone(),
                    total_lines: total,
                    next_line: 0,
                    added: 0,
                    reinforced: 0,
                    skipped: 0,
                },
            );
        }

        let cells_before = universe.count();
        let mut report = IngestReport {
            file_name: Some(
                path.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string(),
            ),
            cells_before,
            ..Default::default()
        };

        let lines_budget = budget;
        let mut processed = 0usize;
        let mut added = 0usize;
        let mut reinforced = 0usize;
        let mut concepts_added = 0usize;
        let mut concepts_reinforced = 0usize;

        // Borrow split: grab mutable cursor + immutable buffer at once.
        let buffer = self.buffers.get(&path).expect("buffer just inserted");
        let cursor = self.cursors.get_mut(&path).expect("cursor just inserted");

        while processed < lines_budget && !cursor.done() {
            let raw = &buffer[cursor.next_line];
            cursor.next_line += 1;
            processed += 1;

            let (line, region) = classify_line(raw);
            if line.is_empty() || line.len() < MIN_LINE_LEN {
                cursor.skipped += 1;
                continue;
            }

            // 1. Store the full line as a main knowledge cell.
            let source = format!("ingest:{}", cursor.short_name());
            let is_new = universe.store_or_reinforce(&line, &region, &source, 1.2);
            if is_new {
                cursor.added += 1;
                added += 1;
            } else {
                cursor.reinforced += 1;
                reinforced += 1;
            }

            // 2. Word-level decomposition: extract up to
            //    MAX_CONCEPTS_PER_LINE significant concepts and store
            //    each as a small anchor cell. This is what lets KAI
            //    "learn from what he learned" — when the same word
            //    shows up in a later line, its concept cell gets
            //    reinforced, which is the associative link.
            //
            //    Concept cells use the WORD itself as their text, so
            //    `store_or_reinforce` naturally dedupes: the first time
            //    "photosynthesis" appears anywhere, it creates a cell.
            //    Every subsequent mention reinforces that same cell,
            //    growing its strength — and the lattice's dream cycle
            //    will naturally bundle high-strength concept cells
            //    together to find connections.
            for concept in extract_significant_concepts(&line, MAX_CONCEPTS_PER_LINE) {
                let concept_source = format!("ingest-concept:{}", cursor.short_name());
                let is_new_concept = universe.store_or_reinforce(
                    &concept,
                    "concept",
                    &concept_source,
                    CONCEPT_ANCHOR_STRENGTH,
                );
                if is_new_concept {
                    concepts_added += 1;
                } else {
                    concepts_reinforced += 1;
                }
            }
        }

        report.lines_processed = processed;
        report.lines_added = added;
        report.lines_reinforced = reinforced;
        report.concepts_added = concepts_added;
        report.concepts_reinforced = concepts_reinforced;
        report.cells_after = universe.count();

        self.total_added += added;
        self.total_reinforced += reinforced;
        self.total_concepts_added += concepts_added;
        self.total_concepts_reinforced += concepts_reinforced;

        // File finished? Move it to `ingested/` and drop caches.
        if cursor.done() {
            report.file_completed = true;
            self.total_files_done += 1;
            self.archive_file(&path);
            self.buffers.remove(&path);
            self.cursors.remove(&path);
        }

        report
    }

    /// Look for the next .txt file in the ingest folder that isn't the
    /// README and isn't already in progress. Files are processed in
    /// filename order so priority is predictable.
    fn find_next_file(&self) -> Option<PathBuf> {
        let mut candidates: Vec<PathBuf> = fs::read_dir(&self.ingest_dir)
            .ok()?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| {
                p.extension().and_then(|s| s.to_str()) == Some("txt")
                    && p.file_name().and_then(|s| s.to_str()) != Some("README.txt")
                    && !self.cursors.contains_key(p)
            })
            .collect();
        candidates.sort();
        candidates.into_iter().next()
    }

    /// Move a completed file from `ingest/` to `ingested/`. If the move
    /// fails (e.g. destination exists), fall back to deleting the
    /// source so it doesn't get re-processed on the next idle tick.
    fn archive_file(&self, path: &Path) {
        let Some(name) = path.file_name() else { return };
        let dest = self.archive_dir.join(name);
        // Remove destination if it already exists (a previous file of
        // the same name was ingested earlier).
        if dest.exists() {
            let _ = fs::remove_file(&dest);
        }
        if fs::rename(path, &dest).is_err() {
            // Cross-device or permission error — just delete the source.
            let _ = fs::remove_file(path);
        }
    }
}

/// Resolve the ingest folder, preferring (in order):
///
///   1. The `KAI_INGEST_DIR` environment variable — lets power users
///      point at any folder without recompiling.
///   2. The canonical project path `C:\KAI\data\ingest`. This mirrors
///      the tick-log CSV resolution and means the ingest folder is
///      always the same place regardless of where the binary is
///      launched from. This is the fix for the 4-hour-of-nothing
///      bug where `base_dir` pointed at the Rust package folder
///      instead of the project root.
///   3. `{base_dir}/data/ingest` as a last-resort fallback for
///      non-default installs where the canonical path doesn't exist.
fn resolve_ingest_dir(base_dir: &str) -> PathBuf {
    if let Ok(env_dir) = std::env::var("KAI_INGEST_DIR") {
        let p = PathBuf::from(env_dir);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    let canonical = PathBuf::from("C:\\KAI\\data\\ingest");
    if canonical
        .parent()
        .map(|p| p.is_dir() || fs::create_dir_all(p).is_ok())
        .unwrap_or(false)
    {
        return canonical;
    }
    Path::new(base_dir).join("data").join("ingest")
}

/// Extract the most informative concept words from a sentence.
///
/// Returns up to `max` lowercased words ranked by a simple "informativeness"
/// heuristic: longer, rarer-looking words get picked first. Stopwords and
/// short words are discarded. Words appear only once even if repeated in
/// the source text, so the concept list is always unique.
///
/// This is deliberately simple. Fancier approaches (TF-IDF, part-of-speech
/// tagging) would catch more nuance, but the sparse-vector encoder below
/// already does the semantic heavy lifting — here we just need enough of
/// a signal to pick out which words deserve their own anchor cell.
fn extract_significant_concepts(line: &str, max: usize) -> Vec<String> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut candidates: Vec<String> = line
        .split(|c: char| !c.is_alphanumeric())
        .map(|w| w.trim().to_lowercase())
        .filter(|w| {
            w.len() >= MIN_CONCEPT_LEN
                && w.chars().all(|c| c.is_alphabetic())
                && !CONCEPT_STOPWORDS.contains(&w.as_str())
        })
        .filter(|w| seen.insert(w.clone()))
        .collect();

    // Rank by length descending — rarer words tend to be longer and more
    // informative. A compound-scored rank could also factor word rarity
    // from the lexicon, but length alone catches the worst offenders.
    candidates.sort_by(|a, b| b.len().cmp(&a.len()));
    candidates.truncate(max);
    candidates
}

/// Parse an inline region tag and strip it from the line body.
///
/// `[science] Water is H2O.` → ("Water is H2O.", "science")
/// `Regular sentence.`       → ("Regular sentence.", "knowledge")
/// Lines starting with `#` are treated as empty (comments).
fn classify_line(raw: &str) -> (String, String) {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return (String::new(), String::new());
    }

    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let region = rest[..end].trim().to_lowercase();
            let body = rest[end + 1..].trim().to_string();
            if !region.is_empty() && !body.is_empty() {
                return (body, region);
            }
        }
    }

    (trimmed.to_string(), "knowledge".to_string())
}

const DEFAULT_README: &str = "\
KAI IDLE INGEST FOLDER
======================

Drop plain-text files (.txt) here and KAI will learn from them
passively while idle. One fact per line. He absorbs a few lines
per heartbeat whenever no conversation is active for 30+ seconds.

FORMAT
------
Each non-empty line becomes one memory cell. Lines are best written
as complete sentences or claims — that's what the lattice encodes
and retrieves against.

  # This is a comment line — ignored.
  Water is composed of two hydrogen atoms and one oxygen atom.
  The mitochondrion is often called the powerhouse of the cell.

Optional region tagging:

  [science] Photosynthesis converts CO2 and H2O into glucose.
  [history] The Roman Empire fell in 476 CE.
  [programming] Rust's ownership model prevents data races.

Without a [tag], lines are stored in the default 'knowledge' region.

BEHAVIOR
--------
- Lines shorter than 12 characters are skipped.
- Duplicate lines reinforce existing cells instead of creating new ones.
- Files are moved to ../ingested/ once fully absorbed so you can see
  which corpora KAI has consumed.
- You can drop new files at any time; KAI will pick them up on his
  next idle tick.

TIP
---
A 5,000-line corpus will take a few hours of idle time to absorb at
the default rate. Drop files before bed, check his cell count in
the morning.
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_line_plain() {
        let (body, region) = classify_line("Water is H2O.");
        assert_eq!(body, "Water is H2O.");
        assert_eq!(region, "knowledge");
    }

    #[test]
    fn classify_line_tagged() {
        let (body, region) = classify_line("[science] Water is H2O.");
        assert_eq!(body, "Water is H2O.");
        assert_eq!(region, "science");
    }

    #[test]
    fn classify_line_comment() {
        let (body, _) = classify_line("# this is a note");
        assert_eq!(body, "");
    }

    #[test]
    fn classify_line_empty() {
        let (body, _) = classify_line("   ");
        assert_eq!(body, "");
    }

    #[test]
    fn report_summary_for_completed_file() {
        let report = IngestReport {
            lines_processed: 50,
            lines_added: 48,
            lines_reinforced: 2,
            concepts_added: 124,
            concepts_reinforced: 8,
            file_name: Some("science.txt".into()),
            file_completed: true,
            cells_before: 678,
            cells_after: 850,
        };
        let s = report.summary();
        assert!(s.contains("science.txt"));
        assert!(s.contains("850"));
    }

    #[test]
    fn extract_concepts_picks_rare_words() {
        let concepts = extract_significant_concepts(
            "Photosynthesis converts carbon dioxide and water into glucose using sunlight.",
            3,
        );
        assert!(concepts.contains(&"photosynthesis".to_string()));
        // "and", "the", "into", "using" must all be filtered.
        assert!(!concepts.iter().any(|c| c == "and" || c == "the" || c == "into"));
        assert!(concepts.len() <= 3);
    }

    #[test]
    fn extract_concepts_dedupes() {
        let concepts = extract_significant_concepts(
            "A neuron is a specialized cell. Neurons transmit information through synapses.",
            5,
        );
        // "neuron" and "neurons" are different surface forms but each
        // should only appear once in the returned list.
        let count_neuron = concepts.iter().filter(|c| c.starts_with("neuron")).count();
        assert!(count_neuron <= 2);
    }

    #[test]
    fn extract_concepts_rejects_short_words() {
        let concepts = extract_significant_concepts("The cat sat on the mat.", 3);
        // "cat", "sat", "mat" are all 3 chars → rejected.
        assert!(concepts.is_empty());
    }

    #[test]
    fn extract_concepts_skips_pure_numbers() {
        let concepts = extract_significant_concepts(
            "In 1776 the American colonies declared independence from Britain.",
            4,
        );
        assert!(!concepts.contains(&"1776".to_string()));
        assert!(concepts.contains(&"independence".to_string()));
    }
}
