/// Universe — The cell store for KAI's memory.
///
/// Each cell is a belief: text + vector + region + strength + metadata.
/// ALL queries use rayon parallel cosine across all 12 CPU threads.
///
/// Scoring uses a hybrid of:
///   1. Cosine similarity on the 4096-dim sparse ternary vector (semantic layer)
///   2. Keyword overlap — shared significant words between query and cell (exact match layer)
///
/// This is the same dual-layer approach that makes Google search fast and precise:
/// semantic embeddings catch conceptual resonance, keyword overlap catches exact term hits.
/// "What is RSHL?" finds the RSHL cell because "rshl" appears in both — even if the
/// full-phrase cosine similarity is diluted by surrounding words.

use rayon::prelude::*;

use super::SparseVec;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cell {
    pub text: String,
    pub vec: SparseVec,
    pub region: String,
    pub strength: f32,
    pub source: String,
    #[serde(default)]
    pub created: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueryHit {
    pub text: String,
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

// ── Keyword overlap helpers (BM25-style exact match layer) ───────────────────

/// Extract significant keywords from a query — stopwords removed, ≥3 chars.
/// These are the terms we expect to literally appear in a matching cell.
fn extract_query_keywords(text: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "what","is","are","was","were","the","a","an","do","does","did",
        "how","why","who","where","when","can","could","will","would","should",
        "have","has","had","i","you","me","my","your","it","its","we","they",
        "their","this","that","these","those","in","on","at","to","for","of",
        "with","by","from","and","or","but","not","no","so","just","very",
        "more","get","let","make","say","go","right","now","here","there",
        "up","out","if","then","than","also","well","even","still","too",
        "only","been","about","into","over","after","before","be","please",
        "tell","much","some","any","all","each","which","its","whose",
        // Casual fillers that add noise — semantically empty in queries
        "again","actually","basically","literally","really","kinda","sorta",
        "tbh","ngl","lol","haha","thing","things","something","anything",
        "nothing","everything","ever","never","always","sometimes","often",
        // Conversational openers / hedge words — carry no topic signal
        "wait","like","mean","yeah","yep","nah","hmm","huh","oh","hey",
        "okay","ok","sure","true","false","exactly","indeed","wow","cool",
    ];
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && w.len() >= 3 && !STOPWORDS.contains(w))
        .map(|w| w.to_string())
        .collect()
}

/// Score how many query keywords appear in cell text (0.0–1.0).
/// Uses morphological prefix matching for words ≥4 chars so "dream" matches "dreaming",
/// "feel" matches "feelings", "work" matches "working", etc.
fn keyword_overlap_score(query_words: &[String], cell_text: &str) -> f32 {
    if query_words.is_empty() { return 0.0; }
    let cell_lower = cell_text.to_lowercase();
    let matches = query_words.iter().filter(|qw| {
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
    }).count();
    matches as f32 / query_words.len() as f32
}

impl Universe {
    pub fn new() -> Self {
        Self { cells: Vec::new() }
    }

    /// Store a new belief.
    pub fn store(&mut self, text: &str, region: &str, source: &str, strength: f32) {
        let vec = SparseVec::encode(text);
        self.cells.push(Cell {
            text: text.to_string(),
            vec,
            region: region.to_string(),
            strength,
            source: source.to_string(),
            created: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        });
    }

    /// Query for the top-N most similar cells.
    /// Uses rayon parallel iteration — all 12 CPU threads compute cosine simultaneously.
    /// Scoring = 60% cosine similarity (semantic) + 40% keyword overlap (exact match).
    /// The keyword layer is the "inverted index" signal: "what is RSHL?" finds the RSHL
    /// cell because "rshl" appears in both, even if the phrase-level cosine is diluted.
    pub fn query(&self, text: &str, n: usize) -> Vec<QueryHit> {
        let q = SparseVec::encode(text);
        let query_keywords = extract_query_keywords(text);
        let mut scored: Vec<(usize, f32)> = self
            .cells
            .par_iter()
            .enumerate()
            .map(|(i, cell)| {
                let cosine = q.cosine(&cell.vec);
                let kw = keyword_overlap_score(&query_keywords, &cell.text);
                // Hybrid: semantic resonance + exact keyword match
                let raw = 0.55 * cosine + 0.45 * kw;
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
                    text: cell.text.clone(),
                    region: cell.region.clone(),
                    score,
                    strength: cell.strength,
                    source: cell.source.clone(),
                }
            })
            .collect()
    }

    /// Query only within a specific region — used for self/identity questions
    /// to prevent world-bridge reasoning cells from bleeding into personal answers.
    /// Also uses hybrid cosine + keyword scoring for consistent exact-term retrieval.
    pub fn query_region(&self, text: &str, region: &str, n: usize) -> Vec<QueryHit> {
        let q = SparseVec::encode(text);
        let query_keywords = extract_query_keywords(text);
        let mut scored: Vec<(usize, f32)> = self
            .cells
            .par_iter()
            .enumerate()
            .filter(|(_, cell)| cell.region == region && cell.source != "conversation")
            .map(|(i, cell)| {
                let cosine = q.cosine(&cell.vec);
                let kw = keyword_overlap_score(&query_keywords, &cell.text);
                let raw = 0.55 * cosine + 0.45 * kw;
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
                    text: cell.text.clone(),
                    region: cell.region.clone(),
                    score,
                    strength: cell.strength,
                    source: cell.source.clone(),
                }
            })
            .collect()
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

    /// Reinforce a cell by exact text match (Hebbian: fire together → wire together).
    /// Bumps strength by `delta`, capped at 2.5.
    pub fn reinforce_by_text(&mut self, text: &str, delta: f32) {
        for cell in &mut self.cells {
            if cell.text == text {
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
        // Check for exact match first
        for cell in &mut self.cells {
            if cell.text == text {
                cell.strength = (cell.strength + 0.15).min(2.5);
                // Update region/source if the caller has higher authority
                if source == "ryan" {
                    cell.source = "ryan".to_string();
                }
                return false; // reinforced, not new
            }
        }
        // New cell
        self.store(text, region, source, strength);
        true
    }

    /// Query with a pre-encoded vector (for the reasoner's iterative chain).
    /// Uses rayon parallel iteration — all 12 CPU threads compute cosine simultaneously.
    /// Vector-only path — no keyword layer since we don't have the original text here.
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
