/// Universe â€” The cell store for KAI's memory.
///
/// Each cell is a belief: text + vector + region + strength + metadata.
/// ALL queries use rayon parallel cosine across all 12 CPU threads.
///
/// Scoring uses a hybrid of:
///   1. Cosine similarity on the 16384-dim sparse ternary vector (semantic layer)
///   2. Keyword overlap â€” shared significant words between query and cell (exact match layer)
///
/// This is the same dual-layer approach that makes Google search fast and precise:
/// semantic embeddings catch conceptual resonance, keyword overlap catches exact term hits.
/// "What is RSHL?" finds the RSHL cell because "rshl" appears in both â€” even if the
/// full-phrase cosine similarity is diluted by surrounding words.
use rayon::prelude::*;

use super::predictive::{self, ConversationTrace};
use super::SparseVec;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cell {
    pub label: String,
    #[serde(default)]
    pub text: String,
    pub vec: SparseVec,
    pub region: String,
    pub strength: f32,
    pub source: String,
    #[serde(default)]
    pub created: u64,
    #[serde(default)]
    pub continuation: SparseVec,
    #[serde(default)]
    pub last_fired: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueryHit {
    pub label: String,
    pub text: String,
    pub vec: SparseVec,
    pub region: String,
    pub score: f32,
    pub strength: f32,
    /// Source of the cell: "seed", "ryan", "conversation", "identity", etc.
    /// Voice synthesis uses this to skip user-stored utterances as KAI's own words.
    #[serde(default)]
    pub source: String,
}

/// The Universe holds all of KAI's memory cells.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Universe {
    cells: Vec<Cell>,
}

// â”€â”€ Keyword overlap helpers (BM25-style exact match layer) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Extract significant keywords from a query â€” stopwords removed, â‰¥3 chars.
/// These are the terms we expect to literally appear in a matching cell.
fn extract_query_keywords(text: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "what",
        "is",
        "are",
        "was",
        "were",
        "the",
        "a",
        "an",
        "do",
        "does",
        "did",
        "how",
        "why",
        "who",
        "where",
        "when",
        "can",
        "could",
        "will",
        "would",
        "should",
        "have",
        "has",
        "had",
        "i",
        "you",
        "me",
        "my",
        "your",
        "it",
        "its",
        "we",
        "they",
        "their",
        "this",
        "that",
        "these",
        "those",
        "in",
        "on",
        "at",
        "to",
        "for",
        "of",
        "with",
        "by",
        "from",
        "and",
        "or",
        "but",
        "not",
        "no",
        "so",
        "just",
        "very",
        "more",
        "get",
        "let",
        "make",
        "say",
        "go",
        "right",
        "now",
        "here",
        "there",
        "up",
        "out",
        "if",
        "then",
        "than",
        "also",
        "well",
        "even",
        "still",
        "too",
        "only",
        "been",
        "about",
        "into",
        "over",
        "after",
        "before",
        "be",
        "please",
        "tell",
        "much",
        "some",
        "any",
        "all",
        "each",
        "which",
        "its",
        "whose",
        // Casual fillers that add noise â€” semantically empty in queries
        "again",
        "actually",
        "basically",
        "literally",
        "really",
        "kinda",
        "sorta",
        "tbh",
        "ngl",
        "lol",
        "haha",
        "thing",
        "things",
        "something",
        "anything",
        "nothing",
        "everything",
        "ever",
        "never",
        "always",
        "sometimes",
        "often",
        // Conversational openers / hedge words â€” carry no topic signal
        "wait",
        "like",
        "mean",
        "yeah",
        "yep",
        "nah",
        "hmm",
        "huh",
        "oh",
        "hey",
        "okay",
        "ok",
        "sure",
        "true",
        "false",
        "exactly",
        "indeed",
        "wow",
        "cool",
    ];
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && w.len() >= 3 && !STOPWORDS.contains(w))
        .map(|w| w.to_string())
        .collect()
}

/// Score how many query keywords appear in cell text (0.0â€“1.0).
/// Uses morphological prefix matching for words â‰¥4 chars so "dream" matches "dreaming",
/// "feel" matches "feelings", "work" matches "working", etc.
fn keyword_overlap_score(query_words: &[String], cell_text: &str) -> f32 {
    if query_words.is_empty() {
        return 0.0;
    }
    let cell_lower = cell_text.to_lowercase();
    let matches = query_words
        .iter()
        .filter(|qw| {
            let q = qw.as_str();
            cell_lower
                .split(|c: char| !c.is_alphanumeric())
                .filter(|cw| !cw.is_empty())
                .any(|cw| {
                    cw == q
                // Morphological: one is prefix of the other (min 4 chars both sides)
                || (q.len() >= 4 && cw.len() >= 4
                    && (cw.starts_with(q) || q.starts_with(cw)))
                })
        })
        .count();
    matches as f32 / query_words.len() as f32
}

/// Per-cell breakdown of the predictive-query score. Used by the
/// `--diagnose-predictive` CLI to show exactly why the lattice picked
/// the cells it picked.
#[derive(Debug, Clone)]
pub struct PredictiveScoreBreakdown {
    pub label: String,
    pub text: String,
    pub vec: SparseVec,
    pub source: String,
    pub sim: f32,
    pub predict_match: f32,
    pub mh: f32,
    pub rec: f32,
    pub score: f32,
    pub last_fired: u64,
    pub continuation_nnz: usize,
}
impl Universe {
    pub fn new() -> Self {
        Self { cells: Vec::new() }
    }

    /// Store a new belief with a pre-computed vector.
    pub fn store_with_vec(&mut self, text: &str, region: &str, source: &str, strength: f32, vec: SparseVec) {
        self.cells.push(Cell {
            label: text.to_string(),
            text: text.to_string(),
            vec,
            region: region.to_string(),
            strength,
            source: source.to_string(),
            created: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            continuation: SparseVec::zero(),
            last_fired: 0,
        });
    }

    /// Store a new belief.
    pub fn store(&mut self, text: &str, region: &str, source: &str, strength: f32) {
        let vec = SparseVec::encode(text);
        self.store_with_vec(text, region, source, strength, vec);
    }

    /// Query for the top-N most similar cells.
    /// Uses rayon parallel iteration â€” all 12 CPU threads compute cosine simultaneously.
    /// Scoring = 60% cosine similarity (semantic) + 40% keyword overlap (exact match).
    /// The keyword layer is the "inverted index" signal: "what is RSHL?" finds the RSHL
    /// cell because "rshl" appears in both, even if the phrase-level cosine is diluted.
    ///
    /// **User-echo and legacy-conversation cells are ALWAYS excluded from results.**
    /// Those cells exist to record Ryan's raw input for context/continuity; they
    /// must never be surfaced as KAI's own speech output. Without this filter,
    /// a freshly-stored echo cell outranks every other match on the exact input
    /// Ryan just typed â€” and KAI parrots Ryan's own words back at him. That was
    /// the "you sound scripted" humiliation; closing the hole here.
    pub fn query(&self, text: &str, n: usize) -> Vec<QueryHit> {
        let q = SparseVec::encode(text);
        let query_words = extract_query_keywords(text);
        
        let mut scored: Vec<(usize, f32)> = self
            .cells
            .par_iter()
            .enumerate()
            .filter(|(_, cell)| cell.source != "user-echo" && cell.source != "conversation")
            .map(|(i, cell)| {
                let cosine = q.cosine(&cell.vec);
                let kw = keyword_overlap_score(&query_words, &cell.text);
                // Hybrid: 60% cosine similarity (semantic) + 40% keyword overlap (exact match)
                let raw = 0.6 * cosine + 0.4 * kw;
                let boosted = raw * (0.5 + 0.5 * cell.strength.min(2.0));
                (i, boosted)
            })
            .filter(|(_, s)| *s > 0.08)
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);

        scored
            .iter()
            .map(|&(i, score)| {
                let cell = &self.cells[i];
                QueryHit {
                    label: cell.label.clone(),
                    text: cell.label.clone(),
                    vec: cell.vec.clone(),
                    region: cell.region.clone(),
                    score,
                    strength: cell.strength,
                    source: cell.source.clone(),
                }
            })
            .collect()
    }

    /// Query only within a specific region â€” used for self/identity questions
    /// to prevent world-bridge reasoning cells from bleeding into personal answers.
    /// Also uses hybrid cosine + keyword scoring for consistent exact-term retrieval.
    pub fn query_region(&self, text: &str, region: &str, n: usize) -> Vec<QueryHit> {
        let q = SparseVec::encode(text);
        let query_words = extract_query_keywords(text);
        
        let mut scored: Vec<(usize, f32)> = self
            .cells
            .par_iter()
            .enumerate()
            .filter(|(_, cell)| {
                cell.region == region
                    && cell.source != "user-echo"
                    && cell.source != "conversation"
            })
            .map(|(i, cell)| {
                let cosine = q.cosine(&cell.vec);
                let kw = keyword_overlap_score(&query_words, &cell.text);
                // Hybrid: 60% cosine similarity (semantic) + 40% keyword overlap (exact match)
                let raw = 0.6 * cosine + 0.4 * kw;
                let boosted = raw * (0.5 + 0.5 * cell.strength.min(4.0));
                (i, boosted)
            })
            .filter(|(_, s)| *s > 0.05)
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);

        scored
            .iter()
            .map(|&(i, score)| {
                let cell = &self.cells[i];
                QueryHit {
                    label: cell.label.clone(),
                    text: cell.label.clone(),
                    vec: cell.vec.clone(),
                    region: cell.region.clone(),
                    score,
                    strength: cell.strength,
                    source: cell.source.clone(),
                }
            })
            .collect()
    }

    /// Get all cells with a specific source tag â€” bypasses score filtering.
    /// Used by the empathy path in voice.rs to fetch the 5 outward-facing
    /// empathy cells directly, regardless of how they score on a generic query.
    pub fn get_by_source(&self, source: &str) -> Vec<QueryHit> {
        self.cells
            .iter()
            .filter(|c| c.source == source)
            .map(|c| QueryHit {
                label: c.label.clone(),
                text: c.label.clone(),
                vec: c.vec.clone(),
                region: c.region.clone(),
                score: 1.0, // score is irrelevant â€” selection is by source
                strength: c.strength,
                source: c.source.clone(),
            })
            .collect()
    }

    /// Query the live strength of a named conversation state cell.
    /// State cells live in region="tone", source="state".
    /// Used by voice.rs for lattice-native routing â€” no word-list context scanning.
    /// Returns 0.0 if no matching state cell exists or has decayed below threshold.
    /// The lattice IS the state machine: store when detected, decay naturally.
    pub fn state_strength(&self, key: &str) -> f32 {
        let q = SparseVec::encode(key);
        self.cells
            .iter()
            .filter(|c| c.source == "state" && c.region == "tone")
            .map(|c| {
                let sim = q.cosine(&c.vec);
                if sim > 0.55 {
                    c.strength * sim
                } else {
                    0.0
                }
            })
            .fold(0.0_f32, f32::max)
    }

    /// Get all cells.
    pub fn cells(&self) -> &[Cell] {
        &self.cells
    }

    /// Get mutable cells (for homeostasis).
    pub fn cells_mut(&mut self) -> &mut Vec<Cell> {
        &mut self.cells
    }

    /// Count cells.
    pub fn count(&self) -> usize {
        self.cells.len()
    }

    /// Count cells per region.
    pub fn region_counts(&self) -> HashMap<String, usize> {
        let mut map = HashMap::new();
        for cell in &self.cells {
            *map.entry(cell.region.clone()).or_insert(0) += 1;
        }
        map
    }

    /// Average strength.
    pub fn avg_strength(&self) -> f32 {
        if self.cells.is_empty() {
            return 0.0;
        }
        let sum: f32 = self.cells.iter().map(|c| c.strength).sum();
        sum / self.cells.len() as f32
    }

    /// Decay all cells by factor (for homeostasis).
    pub fn decay_all(&mut self, factor: f32) -> usize {
        let mut count = 0;
        for cell in &mut self.cells {
            let old = cell.strength;
            cell.strength *= factor;
            if (old - cell.strength).abs() > 0.001 {
                count += 1;
            }
        }
        count
    }

    /// Prune cells below minimum strength.
    pub fn prune(&mut self, min_strength: f32) -> usize {
        let before = self.cells.len();
        self.cells.retain(|c| c.strength >= min_strength);
        before - self.cells.len()
    }

    /// Get cells in a specific region.
    pub fn region_cells(&self, region: &str) -> Vec<&Cell> {
        self.cells.iter().filter(|c| c.region == region).collect()
    }

    /// Pick a random pair of cells (for dreaming).
    pub fn random_pair(&self) -> Option<(&Cell, &Cell)> {
        use rand::Rng;
        if self.cells.len() < 2 {
            return None;
        }
        let mut rng = rand::thread_rng();
        let i = rng.gen_range(0..self.cells.len());
        let mut j = rng.gen_range(0..self.cells.len() - 1);
        if j >= i {
            j += 1;
        }
        Some((&self.cells[i], &self.cells[j]))
    }

    /// Reinforce a cell by exact text match (Hebbian: fire together â†’ wire together).
    /// Bumps strength by `delta`, capped at 2.5.
    pub fn reinforce_by_text(&mut self, text: &str, delta: f32) {
        for cell in &mut self.cells {
            if cell.label == text {
                cell.strength = (cell.strength + delta).min(2.5);
                break;
            }
        }
    }

    /// Store a cell if the text is new, or reinforce it if it already exists.
    /// Ryan's repeated statements should grow stronger, not duplicate.
    /// Returns true if a new cell was created, false if an existing one was reinforced.
    pub fn store_or_reinforce(
        &mut self,
        text: &str,
        region: &str,
        source: &str,
        strength: f32,
    ) -> bool {
        // Phase 1: exact string match (fast path — O(n) string compare)
        for cell in &mut self.cells {
            if cell.label == text {
                cell.strength = (cell.strength + 0.15).min(2.5);
                if source == "ryan" {
                    cell.source = "ryan".to_string();
                }
                return false; // exact match reinforced
            }
        }
        // Phase 2: semantic near-duplicate check (cosine > 0.85).
        // Only runs during ingestion (strength >= 0.8) to avoid slowing
        // live conversation where store_or_reinforce is called on replies.
        if strength >= 0.8 {
            let candidate_vec = SparseVec::encode(text);
            let mut best_score = 0.0f32;
            let mut best_idx = usize::MAX;
            for (i, cell) in self.cells.iter().enumerate() {
                let sim = candidate_vec.cosine(&cell.vec);
                if sim > best_score {
                    best_score = sim;
                    best_idx = i;
                }
            }
            if best_score > 0.85 && best_idx < self.cells.len() {
                // Semantic duplicate — reinforce existing cell, discard new
                self.cells[best_idx].strength =
                    (self.cells[best_idx].strength + 0.10).min(2.5);
                return false;
            }
        }
        // Genuinely new cell
        self.store(text, region, source, strength);
        true
    }

    // â”€â”€ Predictive RSHL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    //
    // Iterative predictive retrieval. 8-step (minimum) refinement loop
    // inside, followed by a single scored pass with the paper-backed
    // weights. See `core::predictive` for the research mapping.

    /// Predictive query with internal iteration loop.
    ///
    /// 1. Runs `steps.max(8)` passes of a light context mixer that
    ///    nudges the query state toward the conversation trace
    ///    (6Â·state + 5Â·trace, ternary-clamped).
    /// 2. Scores every eligible cell with:
    ///        0.20 * similarity(state, cell.vec)
    ///      + 0.55 * predictive_match(trace, cell.continuation)
    ///      + 0.15 * multi_head_consensus(state, cell.vec)
    ///      - 0.20 * recency_penalty(cell.last_fired)
    ///    Continuation binding dominates static similarity â€” the whole
    ///    point of the upgrade.
    /// 3. Returns the top-5 hits.
    pub fn predictive_query(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
    ) -> Vec<QueryHit> {
        self.predictive_query_filtered(input, trace, steps, |_| true)
    }

    /// Source-scoped variant for the voice path (greeting / empathy / â€¦).
    /// Same pipeline, just filters eligible cells to a single source tag.
    pub fn predictive_query_by_source(
        &self,
        input: SparseVec,
        source: &str,
        trace: &ConversationTrace,
        steps: usize,
    ) -> Vec<QueryHit> {
        let want = source.to_string();
        self.predictive_query_filtered(input, trace, steps, move |c| c.source == want)
    }

    /// Diagnostic variant of `predictive_query` that returns the full
    /// per-component score breakdown for the top-k cells. Same pipeline
    /// as `predictive_query_filtered`, but exposes `sim`,
    /// `predict_match`, `mh`, `rec` and the final score so the CLI can
    /// print why the lattice picked what it picked.
    pub fn diagnose_predictive(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        top_k: usize,
    ) -> Vec<PredictiveScoreBreakdown> {
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.source != "user-echo" && c.source != "conversation")
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        let iter_steps = steps.max(predictive::DEFAULT_ITER_STEPS);
        let mut state = input.clone();
        let dim = state.data.len();
        for _ in 0..iter_steps {
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state.data[i] as i32;
                let t = trace.current.data[i] as i32;
                let conjunction = s * t;
                let v = 5 * s + 3 * t + 4 * conjunction;
                data[i] = if v >= 3 {
                    1
                } else if v <= -3 {
                    -1
                } else {
                    0
                };
            }
            state = SparseVec::from_raw(data);
        }

        let tick = trace.turns_seen;
        let prediction_anchor = trace.current.permute(1).contrast(&input);

        let mut rows: Vec<PredictiveScoreBreakdown> = eligible
            .par_iter()
            .map(|&i| {
                let cell = &self.cells[i];
                let sim = state.cosine(&cell.vec).max(0.0);
                let predict_match = prediction_anchor.cosine(&cell.continuation).max(0.0);
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec = predictive::recency_penalty(
                    tick,
                    cell.last_fired,
                    predictive::RECENCY_WINDOW,
                );
                let score = 0.10 * sim + 0.65 * predict_match + 0.10 * mh - 0.45 * rec;
                PredictiveScoreBreakdown {
                    label: cell.label.clone(),
                    text: cell.label.clone(),
                    vec: cell.vec.clone(),
                    source: cell.source.clone(),
                    sim,
                    predict_match,
                    mh,
                    rec,
                    score,
                    last_fired: cell.last_fired,
                    continuation_nnz: cell.continuation.nnz(),
                }
            })
            .collect();
        rows.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        rows.truncate(top_k);
        rows
    }
    /// Source-filtered variant of `diagnose_predictive`. Mirrors the
    /// production voice path's `predictive_query_by_source`, so we can
    /// see exactly what the greeting/empathy/farewell retrieval is
    /// scoring when the full universe is hidden behind a source filter.
    pub fn diagnose_predictive_by_source(
        &self,
        input: SparseVec,
        source: &str,
        trace: &ConversationTrace,
        steps: usize,
        top_k: usize,
    ) -> Vec<PredictiveScoreBreakdown> {
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.source == source)
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        let iter_steps = steps.max(predictive::DEFAULT_ITER_STEPS);
        let mut state = input.clone();
        let dim = state.data.len();
        for _ in 0..iter_steps {
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state.data[i] as i32;
                let t = trace.current.data[i] as i32;
                let conjunction = s * t;
                let v = 5 * s + 3 * t + 4 * conjunction;
                data[i] = if v >= 3 {
                    1
                } else if v <= -3 {
                    -1
                } else {
                    0
                };
            }
            state = SparseVec::from_raw(data);
        }

        let tick = trace.turns_seen;
        let prediction_anchor = trace.current.permute(1).contrast(&input);

        let mut rows: Vec<PredictiveScoreBreakdown> = eligible
            .par_iter()
            .map(|&i| {
                let cell = &self.cells[i];
                let sim = state.cosine(&cell.vec).max(0.0);
                let predict_match = prediction_anchor.cosine(&cell.continuation).max(0.0);
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec = predictive::recency_penalty(
                    tick,
                    cell.last_fired,
                    predictive::RECENCY_WINDOW,
                );
                let score = 0.10 * sim + 0.65 * predict_match + 0.10 * mh - 0.45 * rec;
                PredictiveScoreBreakdown {
                    label: cell.label.clone(),
                    text: cell.label.clone(),
                    vec: cell.vec.clone(),
                    source: cell.source.clone(),
                    sim,
                    predict_match,
                    mh,
                    rec,
                    score,
                    last_fired: cell.last_fired,
                    continuation_nnz: cell.continuation.nnz(),
                }
            })
            .collect();
        rows.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        rows.truncate(top_k);
        rows
    }
    fn predictive_query_filtered<F>(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        extra_filter: F,
    ) -> Vec<QueryHit>
    where
        F: Fn(&Cell) -> bool + Sync + Send,
    {
        // Eligible cell indices (skip user-echo / conversation cells).
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.source != "user-echo" && c.source != "conversation")
            .filter(|(_, c)| extra_filter(c))
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Iterative context mixer (conjunctive gating) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Transformer-style attention gate: the `state * trace` term is
        // a multiplicative mask that only passes signal where the query
        // and the conversation history resonate (same sign). Where they
        // disagree the conjunction is negative and partially cancels
        // the sum, collapsing that dimension to 0. The VSA analogue of
        // softmax gating: keep only dimensions where the two role-
        // spaces agree.
        //
        // Per-dim: v = 5*state + 3*trace + 4*(state * trace), thresh +/- 3.
        let iter_steps = steps.max(predictive::DEFAULT_ITER_STEPS);
        let mut state = input.clone();
        let dim = state.data.len();
        for _ in 0..iter_steps {
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state.data[i] as i32;
                let t = trace.current.data[i] as i32;
                let conjunction = s * t;
                let v = 5 * s + 3 * t + 4 * conjunction;
                data[i] = if v >= 3 {
                    1
                } else if v <= -3 {
                    -1
                } else {
                    0
                };
            }
            state = SparseVec::from_raw(data);
        }

        // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ Final scoring with look-ahead prediction anchor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // Cells were bound with permute(1) applied to the input, so
        // their `continuation` lives in the "next-slot" role-space. To
        // retrieve them we project the current trace forward into that
        // same space before cosine-matching. Temporal equivalent of
        // querying attention with a shifted key.
        let tick = trace.turns_seen;
        let prediction_anchor = trace.current.permute(1).contrast(&input);
        let mut final_scores: Vec<(usize, f32)> = eligible
            .par_iter()
            .map(|&i| {
                let cell = &self.cells[i];
                let sim = state.cosine(&cell.vec).max(0.0);
                let predict_match = prediction_anchor.cosine(&cell.continuation).max(0.0);
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec = predictive::recency_penalty(
                    tick,
                    cell.last_fired,
                    predictive::RECENCY_WINDOW,
                );
                // Transitions dominate. Raw similarity barely contributes;
                // recency is harsh enough to push repeated cells out of
                // the top-k.
                let score = 0.10 * sim + 0.65 * predict_match + 0.10 * mh - 0.45 * rec;
                (i, score)
            })
            .collect();
        final_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        final_scores.truncate(5);

        final_scores
            .into_iter()
            .map(|(i, score)| {
                let c = &self.cells[i];
                QueryHit {
                label: c.label.clone(),
                text: c.label.clone(),
                vec: c.vec.clone(),
                    region: c.region.clone(),
                    score,
                    strength: c.strength,
                    source: c.source.clone(),
                }
            })
            .collect()
    }

    /// Predictive query that returns *cell references* with scores
    /// instead of display-only `QueryHit`s. Same scoring pipeline as
    /// `predictive_query` (iterative conjunctive mixer â†’ look-ahead
    /// anchor â†’ similarity + predict_match + multi-head âˆ’ recency),
    /// but the caller keeps direct access to `Cell::vec` and
    /// `Cell::continuation` â€” exactly what the generative encoder
    /// needs to fold memory into the latent state.
    ///
    /// `top_k` is configurable so the generative path can pull the
    /// 6â€“8 most relevant cells (the retrieval path that powers the
    /// TUI still uses the fixed top-5 via `predictive_query`).
    pub fn predictive_query_vecs(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        top_k: usize,
    ) -> Vec<(&Cell, f32)> {
        if top_k == 0 {
            return Vec::new();
        }
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.source != "user-echo" && c.source != "conversation")
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        // Iterative conjunctive mixer â€” mirrors predictive_query_filtered.
        let iter_steps = steps.max(predictive::DEFAULT_ITER_STEPS);
        let mut state = input.clone();
        let dim = state.data.len();
        for _ in 0..iter_steps {
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state.data[i] as i32;
                let t = trace.current.data[i] as i32;
                let conjunction = s * t;
                let v = 5 * s + 3 * t + 4 * conjunction;
                data[i] = if v >= 3 {
                    1
                } else if v <= -3 {
                    -1
                } else {
                    0
                };
            }
            state = SparseVec::from_raw(data);
        }

        let tick = trace.turns_seen;
        let prediction_anchor = trace.current.permute(1).contrast(&input);
        let mut final_scores: Vec<(usize, f32)> = eligible
            .par_iter()
            .map(|&i| {
                let cell = &self.cells[i];
                let sim = state.cosine(&cell.vec).max(0.0);
                let predict_match = prediction_anchor.cosine(&cell.continuation).max(0.0);
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec = predictive::recency_penalty(
                    tick,
                    cell.last_fired,
                    predictive::RECENCY_WINDOW,
                );
                let score = 0.10 * sim + 0.65 * predict_match + 0.10 * mh - 0.45 * rec;
                (i, score)
            })
            .collect();
        final_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        final_scores.truncate(top_k);

        final_scores
            .into_iter()
            .map(|(i, score)| (&self.cells[i], score))
            .collect()
    }

    /// Build a complete generative latent state for `prompt`, weaving
    /// the prompt backbone together with resonance-attended re-
    /// weighting, top-k memory injection from `predictive_query_vecs`,
    /// `FieldState`-modulated scaling, and a light trace mix.
    ///
    /// Thin convenience wrapper around
    /// [`crate::cognition::generative::build_generative_state`] so
    /// callers on the CLI, voice, and DMN paths can invoke the full
    /// encoder without touching internal bundle math.
    pub fn encode_generative_state(
        &self,
        prompt: &str,
        lex: &crate::core::StatLexicon,
        trace: &ConversationTrace,
        field: &crate::core::FieldState,
    ) -> SparseVec {
        crate::cognition::generative::build_generative_state(self, lex, prompt, trace, field)
    }

    /// Sequence binding â€” teach the lattice that `response_text` fired
    /// after `input_text`. Each call:
    ///   1. Bundles the current input vector into the response cell's
    ///      `continuation` hypervector (majority-vote over history).
    ///   2. Stamps `last_fired = current_tick` for the recency penalty.
    ///
    /// If multiple cells share `response_text` only the first is updated
    /// (there should only ever be one, but the guard is cheap). A missing
    /// text is silently ignored â€” a response composed from several cells
    /// doesn't have a single owner.
    pub fn bind_sequence(
        &mut self,
        input_text: &str,
        response_text: &str,
        current_tick: u64,
    ) -> bool {
        if response_text.trim().is_empty() {
            return false;
        }
        let input_vec = SparseVec::encode(input_text).permute(1);
        // `0` is reserved as the "never fired" sentinel (see
        // `predictive::recency_penalty`). Clamp to 1 so first-time firings
        // at tick 0 still register as "fired".
        let stamp = current_tick.max(1);
        for cell in &mut self.cells {
            if cell.label == response_text {
                // If continuation is empty, bootstrap straight from input.
                // Otherwise bundle old + new so we get majority-vote memory
                // of "the kind of inputs I fire for".
                if cell.continuation.nnz() == 0 {
                    cell.continuation = input_vec.clone();
                } else {
                    cell.continuation =
                        SparseVec::bundle(&[&cell.continuation, &input_vec]);
                }
                cell.last_fired = stamp;
                return true;
            }
        }
        false
    }

    /// Warm-up variant of `bind_sequence` for replaying transcripts where
    /// the historical reply was often a composite phrase ("Hey. I'm here,
    /// running well.") while cells store atomic fragments ("Hey there.",
    /// "I'm here.").
    ///
    /// Matches any cell whose normalized text is a substring of the
    /// response (cell âŠ† response) or vice versa (response âŠ† cell). Every
    /// matching cell gets the input bundled into its continuation and
    /// `last_fired` stamped.
    ///
    /// Returns the number of cells warmed for this pair.
    pub fn warm_continuation_fuzzy(
        &mut self,
        input_text: &str,
        response_text: &str,
        current_tick: u64,
    ) -> usize {
        let resp = response_text.trim();
        if resp.is_empty() {
            return 0;
        }
        let input_vec = SparseVec::encode(input_text).permute(1);
        let _ = current_tick;

        let norm = |s: &str| -> String {
            s.chars()
                .filter(|c| !matches!(c, '.' | ',' | '!' | '?' | ';' | ':' | '"' | '\''))
                .flat_map(|c| c.to_lowercase())
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
        };

        let resp_norm = norm(resp);
        if resp_norm.is_empty() {
            return 0;
        }

        let mut hits = 0usize;
        for cell in &mut self.cells {
            let cell_norm = norm(&cell.label);
            if cell_norm.is_empty() {
                continue;
            }
            // Require at least ~6 chars of overlap so tiny tokens like "I"
            // or "ok" don't get bound to every conversation turn.
            let short = cell_norm.len().min(resp_norm.len());
            if short < 6 {
                continue;
            }
            let matched = resp_norm == cell_norm
                || resp_norm.contains(&cell_norm)
                || cell_norm.contains(&resp_norm);
            if !matched {
                continue;
            }
            if cell.continuation.nnz() == 0 {
                cell.continuation = input_vec.clone();
            } else {
                cell.continuation =
                    SparseVec::bundle(&[&cell.continuation, &input_vec]);
            }
            // Do NOT touch cell.last_fired from the warm path.
            // Recency should only activate from live firings.
            hits += 1;
        }
        hits
    }

    /// Query with a pre-encoded vector (for the reasoner's iterative chain).
    /// Uses rayon parallel iteration â€” all 12 CPU threads compute cosine simultaneously.
    /// Vector-only path â€” no keyword layer since we don't have the original text here.
    pub fn query_vec(&self, q: &SparseVec, n: usize) -> Vec<(&Cell, f32)> {
        let mut scored: Vec<(usize, f32)> = self
            .cells
            .par_iter()
            .enumerate()
            .map(|(i, cell)| {
                let raw = q.cosine(&cell.vec);
                let boosted = raw * (0.5 + 0.5 * cell.strength.min(2.0));
                (i, boosted)
            })
            .filter(|(_, s)| *s > 0.1)
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);

        scored
            .iter()
            .map(|&(i, score)| (&self.cells[i], score))
            .collect()
    }
}

impl Default for Universe {
    fn default() -> Self {
        Self::new()
    }
}








