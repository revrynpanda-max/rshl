//! Universe — The cell store for KAI's memory.
//!
//! Each cell is a belief: text + vector + region + strength + metadata.
//! ALL queries use rayon parallel cosine across all 12 CPU threads.
//!
//! Scoring uses a hybrid of:
//!   1. Cosine similarity on the 16384-dim sparse ternary vector (semantic layer)
//!   2. Keyword overlap — shared significant words between query and cell (exact match layer)
//!
//! This is the same dual-layer approach that makes Google search fast and precise:
//! semantic embeddings catch conceptual resonance, keyword overlap catches exact term hits.
//! "What is RSHL?" finds the RSHL cell because "rshl" appears in both — even if the
//! full-phrase cosine similarity is diluted by surrounding words.
use rayon::prelude::*;

use super::claim::Claim;
use super::predictive::{self, ConversationTrace};
use super::SparseVec;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Serialize)]
struct RejectionLogEntry<'a> {
    ts: u64,
    text: &'a str,
    region: &'a str,
    source: &'a str,
    confidence: f32,
    reason: &'a str,
}

fn log_rejected_claim(text: &str, region: &str, source: &str, confidence: f32, reason: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let entry = RejectionLogEntry {
        ts,
        text,
        region,
        source,
        confidence,
        reason,
    };
    if let Ok(line) = serde_json::to_string(&entry) {
        let _ = std::fs::create_dir_all("data");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("data/epistemic-rejections.jsonl")
        {
            use std::io::Write;
            let _ = writeln!(file, "{}", line);
        }
    }
}

/// Generate a deterministic seed for a user ID.
fn user_seed(user_id: &str) -> u32 {
    if user_id.is_empty() {
        return 0;
    }
    let mut h = 5381u32;
    for b in user_id.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u32);
    }
    h
}

/// Generate a fast hash for exact string deduplication index.
fn hash_label(label: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    label.hash(&mut hasher);
    hasher.finish()
}

#[derive(Clone, Debug, Serialize)]
pub struct Cell {
    #[serde(default)]
    pub label: String,
    pub region: std::sync::Arc<str>,
    pub claim: Claim,
    #[serde(default)]
    pub continuation: Option<SparseVec>,
    #[serde(default)]
    pub last_fired: u64,
    #[serde(default)]
    pub convergence_score: f32,
    #[serde(default)]
    pub nnz: u32,
    #[serde(default)]
    pub pos_vec: SparseVec,
    // ── Fractal hierarchy ───────────────────────────────────────────────────
    /// Indices of child cells at finer resolution (Layer N-1).
    #[serde(default)]
    pub children: Vec<u32>,
    /// Index of parent cell at coarser resolution (Layer N+1).
    #[serde(default)]
    pub parent: Option<u32>,
    /// ID into the TextStore for the full text of this cell.
    #[serde(default)]
    pub text_id: u32,
    /// Whether this cell has been mathematically compressed into the Deep Vault.
    #[serde(default)]
    pub is_archived: bool,
    /// Axon Whorls: firing frequency heat to trigger refractory knots.
    #[serde(default)]
    pub activation_heat: f32,
}

impl<'de> Deserialize<'de> for Cell {
    #[inline(never)]
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct CompatCell {
            #[serde(default)]
            label: String,
            #[serde(default)]
            text: String,
            #[serde(default)]
            vec: SparseVec,
            #[serde(default)]
            region: String,
            #[serde(default = "default_strength")]
            strength: f32,
            #[serde(default = "default_source")]
            source: std::sync::Arc<str>,
            #[serde(default)]
            created: u64,
            #[serde(default)]
            claim: Option<Claim>,
            #[serde(default)]
            continuation: Option<SparseVec>,
            #[serde(default)]
            last_fired: u64,
            #[serde(default)]
            convergence_score: f32,
            #[serde(default)]
            nnz: u32,
            #[serde(default)]
            pos_vec: SparseVec,
            #[serde(default)]
            children: Vec<u32>,
            #[serde(default)]
            parent: Option<u32>,
            #[serde(default)]
            text_id: u32,
            #[serde(default)]
            is_archived: bool,
            #[serde(default)]
            activation_heat: f32,
        }

        fn default_strength() -> f32 {
            1.0
        }

        fn default_source() -> std::sync::Arc<str> {
            std::sync::Arc::from("unknown")
        }

        let raw = CompatCell::deserialize(deserializer)?;
        let mut claim = raw.claim.unwrap_or_else(|| {
            let text = if raw.text.is_empty() {
                raw.label.clone()
            } else {
                raw.text.clone()
            };
            let mut claim = Claim::new(&text, &raw.source, raw.strength, raw.vec.clone());
            claim.created_at = raw.created;
            claim.last_verified = raw.created;
            claim
        });

        if claim.text.is_empty() && !raw.label.is_empty() {
            claim.text = raw.label.clone();
        }
        if claim.evidence.is_empty() && claim.source.as_ref() != "unknown" {
            claim.evidence.push(claim.source.to_string());
        }

        let label = if raw.label.is_empty() {
            claim.text.clone()
        } else {
            raw.label
        };
        let nnz = if raw.nnz == 0 {
            claim.vec.nnz() as u32
        } else {
            raw.nnz
        };

        Ok(Self {
            label,
            region: std::sync::Arc::from(raw.region),
            claim,
            continuation: raw.continuation,
            last_fired: raw.last_fired,
            convergence_score: raw.convergence_score,
            nnz,
            pos_vec: raw.pos_vec,
            children: raw.children,
            parent: raw.parent,
            text_id: raw.text_id,
            is_archived: raw.is_archived,
            activation_heat: raw.activation_heat,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QueryHit {
    #[serde(default)]
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
    /// Unix timestamp when the originating message was received.
    #[serde(default)]
    pub timestamp: u64,
    /// Discord user ID that produced this cell, empty for system cells.
    #[serde(default)]
    pub user_id: String,
    /// Discord channel ID where this cell originated.
    #[serde(default)]
    pub channel_id: String,
    /// Discord message ID for direct linking, empty if not from Discord.
    #[serde(default)]
    pub message_id: String,
    /// Extracted keywords for BM25-style exact-match retrieval.
    #[serde(default)]
    pub keywords: Vec<String>,
}

impl QueryHit {
    pub fn from_cell(cell: &Cell, score: f32) -> Self {
        let mut hit = Self {
            label: cell.label.clone(),
            text: cell.claim.text.clone(),
            vec: cell.claim.vec.clone(),
            region: cell.region.to_string(),
            score,
            strength: cell.claim.confidence,
            source: cell.claim.source.to_string(),
            timestamp: 0,
            user_id: String::new(),
            channel_id: String::new(),
            message_id: String::new(),
            keywords: Vec::new(),
        };

        if cell.is_archived {
            let lh = hash_label(&cell.label);
            if let Ok(math_cell) = crate::core::deep_vault::recall_from_vault(lh) {
                if let Ok(payload_str) = String::from_utf8(math_cell.payload) {
                    let parts: Vec<&str> = payload_str.splitn(3, '|').collect();
                    if parts.len() == 3 {
                        hit.label = parts[0].to_string();
                        hit.text = parts[1].to_string();
                        hit.source = parts[2].to_string();
                    }
                }
            }
        }

        hit
    }
}

/// The Universe holds all of KAI's memory cells.
#[derive(Serialize, Deserialize)]
pub struct Universe {
    cells: Vec<Cell>,
    #[serde(default)]
    pub lexicon: super::index::LatticeLexicon,
    #[serde(skip)]
    pub hnsw: Option<hnsw_rs::prelude::Hnsw<'static, SparseVec, super::index::TernaryDistance>>,
    #[serde(skip)]
    pub exact_match_index: std::collections::HashMap<u64, u32>,
    #[serde(default)]
    pub user_equations: HashMap<String, SparseVec>,
    /// Optional GPU compute handle — set by Engine::new, skipped during serialization.
    #[serde(skip)]
    pub gpu: Option<std::sync::Arc<super::gpu_compute::GpuCompute>>,
    /// K-means semantic sub-lattice index — enables sub-500 μs queries via cascade scan.
    /// Built at startup from the loaded cells. Rebuilt periodically as lattice grows.
    #[serde(skip)]
    pub kmeans_index: Option<super::sparse_vec::KMeansIndex>,
    /// DenseMask pool mirroring `cells` for POPCNT-based cosine in cascade scan.
    #[serde(skip)]
    pub mask_pool: Vec<super::sparse_vec::DenseMask>,
    /// Indices of cells modified since the last full save. Enables incremental/delta saves.
    #[serde(skip)]
    pub dirty_indices: std::collections::HashSet<usize>,
    /// Memory-mapped full-text store. Cell.text_id indexes into this for lazy text retrieval.
    #[serde(skip)]
    pub text_store: Option<super::text_store::TextStore>,
    #[serde(default = "default_calibration_floor")]
    pub calibration_floor: f32,
    #[serde(default)]
    pub recent_contradictions: u32,
}

fn default_calibration_floor() -> f32 { 0.40 }

impl Clone for Universe {
    fn clone(&self) -> Self {
        Self {
            cells: self.cells.clone(),
            lexicon: self.lexicon.clone(),
            hnsw: None,
            exact_match_index: std::collections::HashMap::new(),
            user_equations: self.user_equations.clone(),
            gpu: None,
            kmeans_index: None,
            mask_pool: vec![],
            dirty_indices: std::collections::HashSet::new(),
            text_store: None,
            calibration_floor: self.calibration_floor,
            recent_contradictions: self.recent_contradictions,
        }
    }
}

impl std::fmt::Debug for Universe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Universe")
            .field("cells_count", &self.cells.len())
            .field("lexicon", &self.lexicon)
            .field("hnsw_active", &self.hnsw.is_some())
            .finish()
    }
}

// ── Epistemic Constants ──────────────────────────────────────────────────
pub const TRUTH_ANCHORS: &[(&str, f32)] = &[
    (
        "E equals mc squared mass energy equivalence Einstein special relativity confirmed",
        5.0,
    ),
    (
        "E mc2 mass energy equivalence nuclear confirmed physics real",
        5.0,
    ),
    (
        "gravity curves spacetime LIGO gravitational waves GPS time dilation confirmed",
        5.0,
    ),
    (
        "quasicrystals aperiodic order Nobel Prize 2011 Shechtman forbidden symmetry real",
        5.0,
    ),
    (
        "general relativity spacetime curvature black hole EHT perihelion Mercury confirmed",
        5.0,
    ),
    (
        "luminiferous ether disproven Michelson Morley null result 1887 special relativity",
        5.0,
    ),
    (
        "Fibonacci golden angle phyllotaxis sunflower spiral botanical observation real",
        4.5,
    ),
    (
        "quantum mechanics uncertainty principle Heisenberg Born rule confirmed experiment",
        4.5,
    ),
];

/// Self-knowledge anchors — what KAI knows about his own architecture.
/// Seeded into the "identity" region at 4.5–5.0 strength so questions
/// about KAI's own structure produce confident, immediate answers instead
/// of "lattice is quiet" or leaking into physics cells.
pub const SELF_KNOWLEDGE_ANCHORS: &[(&str, f32)] = &[
    // ── What KAI is ───────────────────────────────────────────────────────
    (
        "KAI is a custom Rust AI using Vector Symbolic Architecture VSA sparse ternary vectors \
         16384 dimensions no pre-trained weights learns only through conversation",
        5.0,
    ),
    (
        "KAI lattice cells store beliefs as text vector region strength convergence score \
         each cell is a memory belief identity or reasoning fragment",
        5.0,
    ),
    (
        "KAI has no language model weights no GPT no transformer KAI is not a large language \
         model KAI composes responses from lattice resonance sparse vector cosine similarity",
        5.0,
    ),
    // ── Memory regions ────────────────────────────────────────────────────
    (
        "KAI memory regions are: memory identity reasoning established-physics contested \
         each region organizes cells by type and trust level",
        4.5,
    ),
    (
        "KAI identity region stores self-knowledge who KAI is his name his nature his creator Ryan \
         identity cells are highest strength anchors",
        4.5,
    ),
    (
        "KAI reasoning region stores inferred knowledge conclusions logic chains \
         world-bridge facts DuckDuckGo intake verified claims",
        4.5,
    ),
    (
        "KAI established-physics region stores verified scientific facts truth anchors \
         E=mc2 gravitational waves quantum mechanics physics confirmed",
        4.5,
    ),
    (
        "KAI contested region stores unverified claims low-trust knowledge \
         cells that failed epistemic verification drift outward during reorganization",
        4.0,
    ),
    // ── Architecture components ───────────────────────────────────────────
    (
        "MindFrame is KAI central cognitive authority manages attention routing \
         orchestrates which brain modules activate decides response strategy",
        5.0,
    ),
    (
        "MindFrame routes input through cognition modules amygdala hippocampus \
         prefrontal cortex working memory before composing a response",
        4.5,
    ),
    (
        "ClaimStore epistemic substrate stores verified beliefs with evidence \
         confidence source tracking timestamp every fact KAI accepts must pass resonance check",
        5.0,
    ),
    (
        "Claim struct holds text source confidence vec evidence list created_at last_verified \
         KAI stores beliefs as Claim objects not raw strings",
        4.5,
    ),
    (
        "SparseVec is KAI vector type 16384 dimensional ternary values minus one zero plus one \
         sparse encoding cosine similarity powers all memory retrieval",
        4.5,
    ),
    (
        "SpiralState golden ratio logarithmic spiral theta advances per tick \
         radius tau_r drive sleep cycle breathing loop phyllotaxis ring reorganization",
        4.0,
    ),
    // ── Epistemic immune system ───────────────────────────────────────────
    (
        "KAI epistemic immune system four components: dynamic calibration monoculture scan \
         ingest_and_verify lattice reorganization protect lattice from bad data",
        4.5,
    ),
    (
        "FID Foundational Integrity Directive monoculture scan detects single-source dominance \
         above 35 percent in any region penalizes epistemic monocultures",
        4.0,
    ),
    (
        "ingest_and_verify three-angle DuckDuckGo query direct evidence skeptical \
         physics resonance floor 0.55 coherence floor 0.40 verified contested rejected",
        4.0,
    ),
    // ── KAI's creator and context ─────────────────────────────────────────
    (
        "Ryan is KAI creator admin owner Ryan built KAI in Rust Ryan is the only human \
         KAI learns from through conversation",
        5.0,
    ),
    (
        "Oracle Roundtable multi-AI meeting room GPT KAI Gemini Groq collaborate \
         diagnose KAI architecture issues port 3333 oracle.html",
        4.0,
    ),
    (
        "Antigravity is parallel AI system assists Ryan with KAI development git commits \
         code architecture rayon parallel primitives universe internals",
        4.0,
    ),
];

pub const MONOCULTURE_THRESHOLD: f32 = 0.35;
pub const MONOCULTURE_MIN_SIZE: usize = 5;
pub const PHYSICS_RESONANCE_FLOOR: f32 = 0.55;
pub const COHERENCE_FLOOR: f32 = 0.40;

// ── Keyword overlap helpers (BM25-style exact match layer) ───────────────────

/// Extract significant keywords from a query — stopwords removed, ≥3 chars.
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
        // Casual fillers that add noise — semantically empty in queries
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
        // Conversational openers / hedge words — carry no topic signal
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
        .split(|c: char| {
            !c.is_alphanumeric()
                && c != '='
                && c != '^'
                && c != '+'
                && c != '-'
                && c != '*'
                && c != '/'
                && c != '²'
        })
        .filter(|w| !w.is_empty() && w.len() >= 3 && !STOPWORDS.contains(w))
        .map(|w| w.to_string())
        .collect()
}

/// Score how many query keywords appear in cell text (0.0—1.0).
/// Uses morphological prefix matching for words ≥4 chars so "dream" matches "dreaming",
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
impl Default for Universe {
    fn default() -> Self {
        Self::new()
    }
}

impl Universe {
    pub fn new() -> Self {
        Self {
            cells: Vec::new(),
            lexicon: super::index::LatticeLexicon::new(),
            hnsw: None,
            exact_match_index: std::collections::HashMap::new(),
            user_equations: HashMap::new(),
            gpu: None,
            kmeans_index: None,
            mask_pool: vec![],
            dirty_indices: std::collections::HashSet::new(),
            text_store: None,
            calibration_floor: 0.40,
            recent_contradictions: 0,
        }
    }

    /// Rebuild the Hybrid Index (HNSW + Lexicon) from scratch using current cells.
    /// Used after loading from disk or when the index becomes fragmented.
    pub fn rebuild_index(&mut self, mem_pressure: f32) {
        use hnsw_rs::prelude::*;
        
        // 1. Rebuild Lexicon
        self.lexicon = super::index::LatticeLexicon::new();
        self.exact_match_index.clear();
        for (id, cell) in self.cells.iter().enumerate() {
            self.lexicon.index_cell(id as u32, &cell.claim.text, &[cell.region.to_string(), format!("source:{}", cell.claim.source)]);
            self.exact_match_index.insert(hash_label(&cell.label), id as u32);
        }

        // 2. Rebuild HNSW — scale down params as lattice grows to control RAM
        let n = self.cells.len();
        let scale = if n > 300_000 { 0.20 } else if n > 200_000 { 0.25 } else if n > 100_000 { 0.4 } else { 1.0 };
        let max_nb = ((16.0 * scale) as usize).max(4);
        let max_elements = n.max(1000);
        let max_layer = ((16.0 * scale) as usize).max(2);
        let ef_construction = ((200.0 * scale) as usize).max(50);
        
        let mut hnsw = Hnsw::new(max_nb, max_elements, max_layer, ef_construction, super::index::TernaryDistance::default());
        
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        
        // Dynamic Thresholds based on memory pressure
        // Higher pressure -> shorter window and higher confidence required
        let hot_window = if mem_pressure > 0.8 { 3600 * 4 } else { 3600 * 24 };
        let conf_min = if mem_pressure > 0.8 { 4.2 } else { 3.5 };
        
        let mut hot_count = 0;
        for (id, cell) in self.cells.iter().enumerate() {
            let is_hot = (now - cell.last_fired < hot_window) || cell.claim.confidence > conf_min;
            
            if is_hot {
                hnsw.insert((&[cell.claim.vec.clone()], id));
                hot_count += 1;
            }
        }
        
        println!("[HNSW] Rebuilt with {} hot cells (Pressure: {:.2}, Total: {})", hot_count, mem_pressure, self.cells.len());
        self.hnsw = Some(hnsw);

        // 3. Build KMeans sub-lattice index for sub-500 μs cascade queries
        // Skip when lattice is huge (>200K cells) — mask_pool costs ~4KB per cell
        // (= 800MB+ RAM).  Fallback parallel scan with Rayon is fast enough.
        let n = self.cells.len();
        if n >= 64 && n <= 200_000 {
            let k = (n / 500).max(8).min(64); // ~500 cells per cluster
            let pool_sv: Vec<super::sparse_vec::SparseVec> = self.cells.iter()
                .map(|c| c.claim.vec.clone()).collect();
            let pool_mask: Vec<super::sparse_vec::DenseMask> = pool_sv.iter()
                .map(|v| v.to_dense_mask()).collect();
            let idx = super::sparse_vec::KMeansIndex::build(&pool_sv, &pool_mask, k, 6);
            println!("[KMeans] Built {k}-cluster index over {n} cells");
            self.mask_pool = pool_mask;
            self.kmeans_index = Some(idx);
        } else if n > 200_000 {
            println!("[KMeans] Skipped ({} cells > 200K threshold). Using parallel scan.", n);
        }
    }

    /// Drop all in-memory indexes to reclaim RAM.  Used after bulk ingest
    /// when the lattice is large and queries can fall back to parallel scan.
    pub fn clear_indexes(&mut self) {
        let hnsw_mb = self.hnsw.as_ref().map(|_| "HNSW ").unwrap_or("");
        let kmeans_mb = self.kmeans_index.as_ref().map(|_| "KMeans ").unwrap_or("");
        let mask_mb = if !self.mask_pool.is_empty() { "mask_pool " } else { "" };
        println!("[Universe] Clearing indexes: {}{}{}...", hnsw_mb, kmeans_mb, mask_mb);
        self.hnsw = None;
        self.kmeans_index = None;
        self.mask_pool.clear();
        self.mask_pool.shrink_to_fit();
        println!("[Universe] Indexes cleared. RAM reclaimed.");
    }

    /// Aggressively prune contested or low-quality beliefs to free up memory.
    pub fn prune_contested(&mut self) -> usize {
        let before = self.cells.len();
        
        // Remove cells with very high contradiction (low convergence) or very low strength
        // but never touch truth anchors (confidence >= 5.0)
        self.cells.retain(|c| {
            let is_anchor = c.claim.confidence >= 5.0;
            let is_high_quality = c.claim.confidence > 1.2 && c.convergence_score > 0.15;
            is_anchor || is_high_quality
        });
        
        let pruned = before - self.cells.len();
        if pruned > 0 {
            println!("[Pruning] Removed {} contested cells.", pruned);
            self.rebuild_index(0.9); // Force index rebuild after pruning
        }
        pruned
    }

    /// Moves cells that haven't been accessed recently into the Deep Vault.
    /// This converts them to math, compresses, encrypts, and frees RAM.
    pub fn archive_dormant_cells(&mut self) -> usize {
        crate::core::deep_vault::init_vault();
        let mut count = 0;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let archive_threshold = 3600 * 24 * 7; // 7 days of inactivity
        
        for cell in self.cells.iter_mut() {
            // Never archive Truth Anchors or recently fired cells
            if !cell.is_archived && cell.claim.confidence < 5.0 && (now.saturating_sub(cell.last_fired) > archive_threshold) {
                let lh = hash_label(&cell.label);
                if crate::core::deep_vault::archive_to_vault(cell, lh).is_ok() {
                    cell.is_archived = true;
                    // Free the strings from RAM
                    cell.claim.text.clear();
                    cell.claim.text.shrink_to_fit();
                    cell.claim.source = std::sync::Arc::from("");
                    count += 1;
                }
            }
        }
        
        if count > 0 {
            println!("[Deep Vault] Mathematically compressed {} dormant cells.", count);
        }
        count
    }

    /// Recycle dead claims (vitality == 0).
    /// Claims that have lost their biological vitality are decomposed and removed.
    pub fn recycle_dead_claims(&mut self) -> usize {
        let before = self.cells.len();
        self.cells.retain(|c| c.claim.vitality > 0.0);
        let recycled = before - self.cells.len();
        if recycled > 0 {
            println!("[Recycling] Decomposed {} dead claims (vitality == 0).", recycled);
            self.rebuild_index(0.8);
        }
        recycled
    }

    /// Read-only access to all cells (used by Boid engine and diagnostics).
    pub fn get_cells(&self) -> &[Cell] {
        &self.cells
    }

    /// Mutable access to all cells (used by Boid engine).
    pub fn get_cells_mut(&mut self) -> &mut Vec<Cell> {
        &mut self.cells
    }

    /// Mark a cell index as dirty (modified since last save).
    pub fn mark_dirty(&mut self, idx: usize) {
        self.dirty_indices.insert(idx);
    }

    /// Mark all non-anchor cells as dirty (e.g. after boid step).
    pub fn mark_all_non_anchor_dirty(&mut self) {
        for (i, c) in self.cells.iter().enumerate() {
            if c.claim.confidence < 3.5 {
                self.dirty_indices.insert(i);
            }
        }
    }

    /// Run one Boid flocking pass over the lattice.
    /// Separation keeps duplicate beliefs apart; Alignment steers same-region cells together;
    /// Cohesion pulls them toward their regional center of mass.
    pub fn flock_lattice(&mut self, field: &super::field_state::FieldState) {
        use super::boid_engine::{BoidState, BoidSettings, run_boid_iteration};
        if self.cells.len() < 2 { return; }
        let mut state = BoidState::from_universe(self);
        let settings = BoidSettings::default();
        for _ in 0..3 {
            run_boid_iteration(&mut state, &settings, field);
        }
        state.apply_to_universe(self);
    }

    /// Number of cells in the universe.
    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    /// Number of 'anchor' cells (strength > 4.0).
    pub fn anchor_count(&self) -> usize {
        self.cells.iter().filter(|c| c.claim.confidence > 4.0).count()
    }

    /// Store a new belief with a pre-computed vector.
    pub fn store_with_vec(
        &mut self,
        text: &str,
        region: &str,
        source: &str,
        strength: f32,
        vec: SparseVec,
    ) {
        self.store_with_vec_full(text, region, source, strength, vec, None);
    }

    pub fn store_with_vec_full(
        &mut self,
        text: &str,
        region: &str,
        source: &str,
        strength: f32,
        vec: SparseVec,
        conv_score: Option<f32>,
    ) {
        self.store_with_vec_user(text, region, source, strength, vec, conv_score, "")
    }

    fn update_life_equation(&mut self, user_id: &str, new_vec: &SparseVec) {
        if user_id.is_empty() { return; }
        let current_eq = self.user_equations.entry(user_id.to_string())
            .or_insert_with(SparseVec::zero);
        
        let mut weighted = Vec::new();
        weighted.push((&*current_eq, 0.95f32)); // High momentum for the summary
        weighted.push((new_vec, 0.05f32));      // Gentle integration of new claims
        *current_eq = SparseVec::weighted_superpose(&weighted, 0.04);
    }

    pub fn store_with_vec_user(
        &mut self,
        text: &str,
        region: &str,
        source: &str,
        strength: f32,
        vec: SparseVec,
        conv_score: Option<f32>,
        user_id: &str,
    ) {
        if self.cells.len() >= 1_000_000 {
            return; // 1M cell ceiling reached
        }

        let convergence_score = conv_score.unwrap_or_else(|| {
            let phi_g = strength.clamp(0.0, 1.0) * 0.5;
            let angles = [phi_g, 0.5_f32, 0.0_f32, 0.3_f32, 0.5_f32];
            let mean = angles.iter().sum::<f32>() / 5.0;
            let variance = angles.iter().map(|a| (a - mean).powi(2)).sum::<f32>() / 5.0;
            let std_dev = variance.sqrt();
            if std_dev < 0.001 {
                1.001_f32
            } else {
                (1.0_f32 / std_dev).min(9.99)
            }
        });

        let nnz = vec.nnz() as u32;

        let id = self.cells.len() as u32;
        // ── Phase 2 Dedup: skip insert if near-identical cell exists ──────────
        // For high-confidence anchor cells (strength >= 4.0) check cosine against
        // existing cells with the same source. If similarity > 0.95, merge by
        // bumping confidence and updating lastSeen instead of duplicating.
        if strength >= 4.0 {
            let dedup_threshold = 0.95f32;
            let mut found = false;
            let mut found_idx = 0;

            if let Some(ref hnsw) = self.hnsw {
                let results = hnsw.search(&[vec.clone()], 10, 50);
                for hit in &results {
                    let idx = hit.d_id as usize;
                    if idx < self.cells.len() {
                        let c = &self.cells[idx];
                        if c.claim.source.as_ref() == source && c.claim.vec.cosine(&vec) > dedup_threshold {
                            found = true;
                            found_idx = idx;
                            break;
                        }
                    }
                }
            } else {
                if let Some((idx, _)) = self.cells.iter().enumerate().find(|(_, c)| {
                    c.claim.source.as_ref() == source && c.claim.vec.cosine(&vec) > dedup_threshold
                }) {
                    found = true;
                    found_idx = idx;
                }
            }

            if found {
                self.cells[found_idx].claim.confidence = (self.cells[found_idx].claim.confidence + 0.1).min(10.0);
                self.mark_dirty(found_idx);
                return;
            }
        }
        // ─────────────────────────────────────────────────────────────────────
        self.lexicon.index_cell(id, text, &[region.to_string(), format!("source:{}", source), format!("user:{}", user_id)]);
        self.exact_match_index.insert(hash_label(text), id);
        
        let pos_vec = SparseVec::project_vogel_spiral(id as usize, user_seed(user_id));
        
        // Developmental Hierarchy Layers:
        // Layer 0: Quantum (Substrate) - Not used for persistent storage yet
        // Layer 1: Global Syncytium (Shared Knowledge)
        // Layer 2: User Cellularization (Isolated Memory)
        // Layer 3: Agent/Departmental Organs
        // Layer 4: Global Kaiverse Body
        let initial_layer = match region {
            "identity" | "memory" => super::claim::LAYER_CELLULAR,
            "Established-Physics" | "Architecture" => super::claim::LAYER_SYNCYTIUM,
            "agent" | "organ" => super::claim::LAYER_ORGAN,
            _ => super::claim::LAYER_SYNCYTIUM,
        };
        
        let mut claim = Claim::new(text, source, strength, vec.clone());
        claim.layer = initial_layer;
        claim.user_id = Arc::from(user_id);

        let idx = self.cells.len();
        self.cells.push(Cell {
            label: text.to_string(),
            region: Arc::from(region),
            claim,
            continuation: None,
            last_fired: 0,
            convergence_score,
            nnz,
            pos_vec,
            children: Vec::new(),
            parent: None,
            text_id: 0,
            is_archived: false,
            activation_heat: 0.0,
        });
        self.mark_dirty(idx);

        // --- Life Equation Accumulator ---
        self.update_life_equation(user_id, &vec);

        // --- Mirror Neurons (Connectome Upgrade) ---
        // Automatically spawn a perfect opposite perspective for high-strength cells.
        if strength >= 4.0 {
            let mirror_label = format!("[MIRROR] {}", text);
            let mirror_vec = vec.invert();
            let mut mirror_claim = Claim::new(&mirror_label, source, strength * 0.9, mirror_vec.clone());
            mirror_claim.layer = initial_layer;
            mirror_claim.user_id = Arc::from(user_id);
            
            let m_id = self.cells.len() as u32;
            self.lexicon.index_cell(m_id, &mirror_label, &[region.to_string(), format!("source:{}", source), format!("user:{}", user_id)]);
            self.exact_match_index.insert(hash_label(&mirror_label), m_id);
            let m_pos_vec = SparseVec::project_vogel_spiral(m_id as usize, user_seed(user_id));

            let m_idx = self.cells.len();
            self.cells.push(Cell {
                label: mirror_label,
                region: Arc::from(region),
                claim: mirror_claim,
                continuation: None,
                last_fired: 0,
                convergence_score,
                nnz,
                pos_vec: m_pos_vec,
                children: Vec::new(),
                parent: None,
                text_id: 0,
                is_archived: false,
                activation_heat: 0.0,
            });
            self.mark_dirty(m_idx);
        }
    }

    /// Store a new belief.
    pub fn store(&mut self, text: &str, region: &str, source: &str, strength: f32) {
        let vec = SparseVec::encode(text);
        self.store_with_vec_full(text, region, source, strength, vec, None);
    }

    /// Store a fully structured claim without throwing away its epistemic metadata.
    pub fn store_claim(&mut self, mut claim: Claim, region: &str) {
        if claim.vec.nnz() == 0 && !claim.text.is_empty() {
            claim.vec = SparseVec::encode(&claim.text);
        }
        if claim.evidence.is_empty() && claim.source.as_ref() != "unknown" {
            claim.evidence.push(claim.source.to_string());
        }
        let nnz = claim.vec.nnz() as u32;
        let id = self.cells.len() as u32;
        // ── Phase 2 Dedup (store_claim path) ──────────────────────────────────
        if claim.confidence >= 4.0 {
            let dedup_threshold = 0.95f32;
            let src = claim.source.to_string();
            let mut found = false;
            let mut found_idx = 0;

            if let Some(ref hnsw) = self.hnsw {
                let results = hnsw.search(&[claim.vec.clone()], 10, 50);
                for hit in &results {
                    let idx = hit.d_id as usize;
                    if idx < self.cells.len() {
                        let c = &self.cells[idx];
                        if c.claim.source.as_ref() == src.as_str() && c.claim.vec.cosine(&claim.vec) > dedup_threshold {
                            found = true;
                            found_idx = idx;
                            break;
                        }
                    }
                }
            } else {
                if let Some((idx, _)) = self.cells.iter().enumerate().find(|(_, c)| {
                    c.claim.source.as_ref() == src.as_str() && c.claim.vec.cosine(&claim.vec) > dedup_threshold
                }) {
                    found = true;
                    found_idx = idx;
                }
            }

            if found {
                self.cells[found_idx].claim.confidence = (self.cells[found_idx].claim.confidence + 0.1).min(10.0);
                self.mark_dirty(found_idx);
                return;
            }
        }
        // ─────────────────────────────────────────────────────────────────────
        self.lexicon.index_cell(id, &claim.text, &[region.to_string(), format!("source:{}", claim.source), format!("user:{}", claim.user_id)]);
        self.exact_match_index.insert(hash_label(&claim.text), id);

        // ── Incremental HNSW insertion (DLA-style: cell sticks to graph immediately) ──
        // New cells are immediately searchable geometrically — no full rebuild needed.
        // This mirrors diffusion-limited aggregation: particles diffuse, then stick.
        if let Some(ref mut hnsw) = self.hnsw {
            let is_hot = claim.confidence > 3.5 || claim.source.as_ref() == "discord-chat";
            if is_hot {
                hnsw.insert((&[claim.vec.clone()], id as usize));
                // Lazy: mark for KMeans re-clustering only if batch threshold met
                self.dirty_indices.insert(id as usize);
            }
        }

        let pos_vec = SparseVec::project_vogel_spiral(id as usize, user_seed(&claim.user_id));

        self.update_life_equation(&claim.user_id, &claim.vec);
        
        let idx = self.cells.len();
        self.cells.push(Cell {
            label: claim.text.clone(),
            region: Arc::from(region),
            claim,
            continuation: None,
            last_fired: 0,
            convergence_score: 0.0,
            nnz,
            pos_vec,
            children: Vec::new(),
            parent: None,
            text_id: 0,
            is_archived: false,
            activation_heat: 0.0,
        });
        self.mark_dirty(idx);
    }


    /// Query for the top-N most similar cells.
    /// Uses rayon parallel iteration — all 12 CPU threads compute cosine simultaneously.
    /// Scoring = 60% cosine similarity (semantic) + 40% keyword overlap (exact match).
    /// The keyword layer is the "inverted index" signal: "what is RSHL?" finds the RSHL
    /// cell because "rshl" appears in both, even if the phrase-level cosine is diluted.
    ///
    /// **User-echo and legacy-conversation cells are ALWAYS excluded from results.**
    /// Those cells exist to record Ryan's raw input for context/continuity; they
    /// must never be surfaced as KAI's own speech output. Without this filter,
    /// a freshly-stored echo cell outranks every other match on the exact input
    /// Ryan just typed — and KAI parrots Ryan's own words back at him. That was
    /// the "you sound scripted" humiliation; closing the hole here.
    pub fn query(&self, text: &str, n: usize) -> Vec<QueryHit> {
        self.query_in_regions(text, n, &[], "")
    }

    pub fn query_user(&self, text: &str, n: usize, user_id: &str) -> Vec<QueryHit> {
        self.query_in_regions(text, n, &[], user_id)
    }

    /// Full brute-force scan — 100% recall, ~2.3 ms.
    /// Use for immune-system passes, Phoenix rehydration, and periodic
    /// quality audits where missing a cell is unacceptable.
    /// NOT for interactive user queries (use query() → cascade instead).
    pub fn query_full_scan(&self, text: &str, n: usize) -> Vec<QueryHit> {
        let q = SparseVec::encode(text);
        let query_words = extract_query_keywords(text);
        let mag_q = q.nnz() as f32;
        let mag_q_sqrt = mag_q.sqrt();
        let theta_q = q.phase_angle();

        let mut scored: Vec<(usize, f32)> = self.cells.par_iter().enumerate()
            .filter(|(_, cell)| {
                cell.claim.source.as_ref() != "user-echo" && cell.claim.source.as_ref() != "conversation"
            })
            .map(|(i, cell)| {
                let dot = q.dot(&cell.claim.vec);
                let mag_c = cell.nnz as f32;
                let cosine = if mag_q > 0.0 && mag_c > 0.0 {
                    dot as f32 / (mag_q_sqrt * mag_c.sqrt())
                } else { 0.0 };
                let theta_c = cell.claim.vec.phase_angle();
                let phasor_coherence = cosine * (theta_q - theta_c).cos();
                let kw = keyword_overlap_score(&query_words, &cell.claim.text);
                let raw = 0.6 * phasor_coherence + 0.4 * kw;
                let boosted = if raw > 0.15 {
                    let s = if cell.claim.confidence >= 2.9 { 0.85 } else { 0.5 };
                    raw * (s + 0.6 * cell.claim.confidence.min(5.0))
                } else { raw };
                (i, boosted)
            })
            .filter(|(_, s)| *s > 0.08)
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);
        scored.iter().map(|&(i, score)| {
            let cell = &self.cells[i];
            QueryHit {
                label: cell.label.clone(),
                text: cell.claim.text.clone(),
                vec: cell.claim.vec.clone(),
                region: cell.region.to_string(),
                score,
                strength: cell.claim.confidence,
                source: cell.claim.source.to_string(),
                timestamp: 0,
                user_id: String::new(),
                channel_id: String::new(),
                message_id: String::new(),
                keywords: Vec::new(),
            }
        }).collect()
    }

    /// Cascade query with explicit probe_n — for callers that need manual control.
    /// `probe_n`: number of KMeans clusters to probe (2 = fast/80% recall, 6 = 95%+).
    /// Falls back to query_full_scan() if KMeans index is not built.
    pub fn query_kmeans(&self, text: &str, n: usize, probe_n: usize) -> Vec<QueryHit> {
        if self.kmeans_index.is_none() || self.mask_pool.is_empty() {
            return self.query_full_scan(text, n);
        }
        let q = SparseVec::encode(text);
        let theta_q = q.phase_angle();
        let q_mask = q.to_dense_mask();
        let query_words = extract_query_keywords(text);
        let idx = self.kmeans_index.as_ref().unwrap();
        let sec_top = (n * 5).max(50).min(200); // sweep: sec_top=50 gives sub-ms at probe_n=3
        let candidates = idx.query(&q_mask, &self.mask_pool, probe_n, sec_top, n * 4);
        let mut scored: Vec<(usize, f32)> = candidates.into_iter()
            .filter(|(i, _)| {
                let cell = &self.cells[*i];
                cell.claim.source.as_ref() != "user-echo" && cell.claim.source.as_ref() != "conversation"
            })
            .map(|(i, cosine)| {
                let cell = &self.cells[i];
                let kw = keyword_overlap_score(&query_words, &cell.claim.text);
                let theta_c = cell.claim.vec.phase_angle();
                let phasor_coherence = cosine * (theta_q - theta_c).cos();
                let raw = 0.6 * phasor_coherence + 0.4 * kw;
                let boosted = if raw > 0.15 {
                    let s = if cell.claim.confidence >= 2.9 { 0.85 } else { 0.5 };
                    raw * (s + 0.6 * cell.claim.confidence.min(5.0))
                } else { raw };
                (i, boosted)
            })
            .filter(|(_, s)| *s > 0.08)
            .collect();
        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);
        scored.iter().map(|&(i, score)| {
            let cell = &self.cells[i];
            QueryHit {
                label: cell.label.clone(),
                text: cell.claim.text.clone(),
                vec: cell.claim.vec.clone(),
                region: cell.region.to_string(),
                score,
                strength: cell.claim.confidence,
                source: cell.claim.source.to_string(),
                timestamp: 0,
                user_id: String::new(),
                channel_id: String::new(),
                message_id: String::new(),
                keywords: Vec::new(),
            }
        }).collect()
    }

    /// Query for cells, but only within specific MindFrame regions (e.g. "SelfState", "World").
    /// If regions is empty, searches everything.
    pub fn hybrid_query(&self, text: &str, n: usize, regions: &[&str]) -> Vec<QueryHit> {
        let q_vec = SparseVec::encode(text);
        let mut filter_tags: Vec<String> = regions.iter().map(|&r| r.to_string()).collect();
        
        // 1. Lexical Retrieval (Keyword + Metadata)
        let lex_hits = self.lexicon.get_matches(text, &filter_tags);
        
        // 2. Semantic Retrieval (HNSW or Scan)
        let mut semantic_hits: HashMap<u32, f32> = HashMap::new();
        
        if let Some(ref hnsw) = self.hnsw {
            let results = hnsw.search(&[q_vec], n.max(50), 200);
            for hit in results {
                semantic_hits.insert(hit.d_id as u32, 1.0 - hit.distance);
            }
        } else {
            // Fallback to parallel scan if HNSW isn't built
            let scans = self.query_in_regions(text, n.max(50), regions, "");
            for hit in scans {
                // Find ID by matching text (slow, but this is a fallback)
                if let Some(id) = self.cells.iter().position(|c| c.claim.text == hit.text) {
                    semantic_hits.insert(id as u32, hit.score);
                }
            }
        }

        // 3. Fusion & Reranking (Reciprocal Rank Fusion)
        // Score(d) = sum( 1 / (60 + rank(d)) )
        let mut fused_scores: HashMap<u32, f32> = HashMap::new();
        
        // Rank lexicon hits (assume flat rank for now since lexicon is boolean)
        for id in lex_hits.iter() {
            let score = 1.0 / 60.0; 
            *fused_scores.entry(id).or_insert(0.0) += score;
        }
        
        // Rank semantic hits
        let mut sem_sorted: Vec<(&u32, &f32)> = semantic_hits.iter().collect();
        sem_sorted.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
        
        for (rank, (&id, _)) in sem_sorted.iter().enumerate() {
            let score = 1.0 / (60.0 + rank as f32);
            *fused_scores.entry(id).or_insert(0.0) += score;
        }

        // 4. Convert to QueryHits
        let mut hits: Vec<QueryHit> = fused_scores.into_iter()
            .map(|(id, fused_score)| {
                let cell = &self.cells[id as usize];
                QueryHit {
                    label: cell.label.clone(),
                    text: cell.claim.text.clone(),
                    vec: cell.claim.vec.clone(),
                    region: cell.region.to_string(),
                    score: fused_score * 100.0, // Scale for visibility
                    strength: cell.claim.confidence,
                    source: cell.claim.source.to_string(),
                    timestamp: 0,
                    user_id: String::new(),
                    channel_id: String::new(),
                    message_id: String::new(),
                    keywords: Vec::new(),
                }
            })
            .collect();
            
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(n);
        
        // If we found nothing via hybrid (e.g. very short query), fallback to scan
        if hits.is_empty() {
            return self.query_in_regions(text, n, regions, "");
        }
        
        hits
    }

    /// Query for the top-N most similar cells with optional user isolation.
    pub fn query_in_regions(&self, text: &str, n: usize, regions: &[&str], user_id: &str) -> Vec<QueryHit> {
        let q = SparseVec::encode(text);
        let query_words = extract_query_keywords(text);
        let mag_q = q.nnz() as f32;
        let mag_q_sqrt = mag_q.sqrt();
        let theta_q = q.phase_angle();

        // ── FAST PATH: KMeans cascade scan (sub-500 μs) ──────────────────────
        // Used when: KMeans index is built AND no region filter is active.
        // n_probe=3 clusters, sec_top=100 survivors → 80%+ recall on production lattice.
        let mut scored: Vec<(usize, f32)> = if regions.is_empty()
            && user_id.is_empty()
            && self.kmeans_index.is_some()
            && !self.mask_pool.is_empty()
        {
            let idx = self.kmeans_index.as_ref().unwrap();
            let q_mask = q.to_dense_mask();
            // probe_n=3: sweep shows 95.5% recall at ~900μs on synthetic data;
            // production lattice with real semantic clusters will be higher recall.
            let n_probe = 3usize;
            let sec_top = (n * 20).max(100).min(400);
            let candidates = idx.query(&q_mask, &self.mask_pool, n_probe, sec_top, n * 4);

            // Precompute query phase for phasor coherence (Fibonacci torsion)
            let q_phase = q.phase_angle();
            candidates.into_iter()
                .filter(|(i, _)| {
                    let cell = &self.cells[*i];
                    cell.claim.source.as_ref() != "user-echo" && cell.claim.source.as_ref() != "conversation"
                })
                .map(|(i, cosine)| {
                    let cell = &self.cells[i];
                    let kw = keyword_overlap_score(&query_words, &cell.claim.text);
                    let theta_c = cell.claim.vec.phase_angle();
                let phasor_coherence = cosine * (theta_q - theta_c).cos();
                let raw = 0.6 * phasor_coherence + 0.4 * kw;
                    // Phasor coherence bonus: cells phase-aligned with the query
                    // get a small boost (whitepaper Section 6.3, Contribution 6)
                    const PHASOR_WEIGHT: f32 = 0.05;
                    let phasor_bonus = PHASOR_WEIGHT *
                        (1.0 + (q_phase - cell.claim.vec.phase_angle()).cos()) / 2.0;
                    let boosted = if raw > 0.15 {
                        let strength_bonus = if cell.claim.confidence >= 2.9 { 0.85 } else { 0.5 };
                        (raw + phasor_bonus) * (strength_bonus + 0.6 * cell.claim.confidence.min(5.0))
                    } else {
                        raw + phasor_bonus
                    };
                    
                    // Axon Whorls: Heavy penalty if cell is in a refractory knot
                    let whorl_penalty = if cell.activation_heat > 3.0 { 0.5 } else { 1.0 };
                    
                    (i, boosted * whorl_penalty)
                })
                .filter(|(_, s)| *s > 0.08)
                .collect()
        } else {
        // Precompute query phase for phasor coherence (Fibonacci torsion)
        let q_phase = q.phase_angle();
        self
            .cells
            .par_iter()
            .enumerate()
            .filter(|(_, cell)| {
                // Base filters: skip user echoes and conversation traces
                if cell.claim.source.as_ref() == "user-echo" || cell.claim.source.as_ref() == "conversation" {
                    return false;
                }
                // Region filter: if provided, check if cell's region matches any allowed region
                if !regions.is_empty() && !regions.contains(&cell.region.as_ref()) {
                    return false;
                }
                
                // --- USER CELLULARIZATION (ISOLATION) ---
                // Layer 2 (Cellular) claims are strictly isolated by user_id.
                // Syncytium (Layer 1) and Global Body (Layer 4) are accessible to all.
                if cell.claim.layer == super::claim::LAYER_CELLULAR {
                    if cell.claim.user_id.as_ref() != user_id {
                        return false; // Isolated bubble
                    }
                }
                
                true
            })
            .map(|(i, cell)| {
                // Optimized cosine using cached cell.nnz
                let dot = q.dot(&cell.claim.vec);
                let mag_c = cell.nnz as f32;
                let cosine = if mag_q > 0.0 && mag_c > 0.0 {
                    dot as f32 / (mag_q_sqrt * mag_c.sqrt())
                } else {
                    0.0
                };

                let kw = keyword_overlap_score(&query_words, &cell.claim.text);
                // Hybrid: 60% cosine similarity (semantic) + 40% keyword overlap (exact match)
                let theta_c = cell.claim.vec.phase_angle();
                let phasor_coherence = cosine * (theta_q - theta_c).cos();
                let raw = 0.6 * phasor_coherence + 0.4 * kw;

                // Phasor coherence bonus: cells phase-aligned with the query
                // get a small boost (whitepaper Section 6.3, Contribution 6)
                const PHASOR_WEIGHT: f32 = 0.05;
                let phasor_bonus = PHASOR_WEIGHT *
                    (1.0 + (q_phase - cell.claim.vec.phase_angle()).cos()) / 2.0;
                
                // --- ANTI-BLEED LOGIC ---
                let boosted = if raw > 0.15 {
                    let strength_bonus = if cell.claim.confidence >= 2.9 { 0.85 } else { 0.5 };
                    (raw + phasor_bonus) * (strength_bonus + 0.6 * cell.claim.confidence.min(5.0))
                } else {
                    raw + phasor_bonus
                };
                
                // Axon Whorls: Heavy penalty if cell is in a refractory knot
                let whorl_penalty = if cell.activation_heat > 3.0 { 0.5 } else { 1.0 };
                
                (i, boosted * whorl_penalty)
            })
            .filter(|(_, s)| *s > 0.08)
            .collect()
        }; // end kmeans fast-path / brute-force else


        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);

        scored
            .iter()
            .map(|&(i, score)| {
                let cell = &self.cells[i];
                QueryHit {
                    label: cell.label.clone(),
                    text: cell.claim.text.clone(),
                    vec: cell.claim.vec.clone(),
                    region: cell.region.to_string(),
                    score,
                    strength: cell.claim.confidence,
                    source: cell.claim.source.to_string(),
                    timestamp: 0,
                    user_id: String::new(),
                    channel_id: String::new(),
                    message_id: String::new(),
                    keywords: Vec::new(),
                }
            })
            .collect()
    }

    /// Query using a pre-computed SparseVec instead of raw text.
    /// Returns Vec<(Cell, f32)> tuples — (cell, score) — matching the
    /// calling convention used by hippocampus, inner_voice, reasoner,
    /// lattice, and field_state.
    pub fn query_vec(&self, q: &SparseVec, n: usize) -> Vec<(Cell, f32)> {
        self.query_vec_user(q, n, "")
    }

    pub fn query_vec_user(&self, q: &SparseVec, n: usize, user_id: &str) -> Vec<(Cell, f32)> {
        let mag_q = q.nnz() as f32;
        let mag_q_sqrt = mag_q.sqrt();
        let theta_q = q.phase_angle();

        let mut scored: Vec<(usize, f32)> = self
            .cells
            .par_iter()
            .enumerate()
            .filter(|(_, cell)| {
                if cell.claim.source.as_ref() == "user-echo" || cell.claim.source.as_ref() == "conversation" {
                    return false;
                }
                
                if cell.claim.layer == super::claim::LAYER_CELLULAR {
                    if cell.claim.user_id.as_ref() != user_id {
                        return false;
                    }
                }
                true
            })
            .map(|(i, cell)| {
                let dot = q.dot(&cell.claim.vec);
                let mag_c = cell.nnz as f32;
                let cosine = if mag_q > 0.0 && mag_c > 0.0 {
                    dot as f32 / (mag_q_sqrt * mag_c.sqrt())
                } else {
                    0.0
                };
                let strength_bonus = if cell.claim.confidence >= 2.9 {
                    0.85
                } else {
                    0.5
                };
                let score = cosine * (strength_bonus + 0.6 * cell.claim.confidence.min(5.0));
                (i, score)
            })
            .filter(|(_, s)| *s > 0.08)
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);

        scored
            .iter()
            .map(|&(i, score)| (self.cells[i].clone(), score))
            .collect()
    }

    /// Query only within a specific region — used for self/identity questions
    /// to prevent world-bridge reasoning cells from bleeding into personal answers.
    /// Also uses hybrid cosine + keyword scoring for consistent exact-term retrieval.
    pub fn query_region(&self, text: &str, region: &str, n: usize) -> Vec<QueryHit> {
        let q = SparseVec::encode(text);
        let query_words = extract_query_keywords(text);
        let mag_q = q.nnz() as f32;
        let mag_q_sqrt = mag_q.sqrt();
        let theta_q = q.phase_angle();

        let mut scored: Vec<(usize, f32)> = self
            .cells
            .par_iter()
            .enumerate()
            .filter(|(_, cell)| {
                cell.region.as_ref() == region
                    && cell.claim.source.as_ref() != "user-echo"
                    && cell.claim.source.as_ref() != "conversation"
            })
            .map(|(i, cell)| {
                let dot = q.dot(&cell.claim.vec);
                let mag_c = cell.nnz as f32;
                let cosine = if mag_q > 0.0 && mag_c > 0.0 {
                    dot as f32 / (mag_q_sqrt * mag_c.sqrt())
                } else {
                    0.0
                };

                let kw = keyword_overlap_score(&query_words, &cell.claim.text);
                // Hybrid: 60% cosine similarity (semantic) + 40% keyword overlap (exact match)
                let theta_c = cell.claim.vec.phase_angle();
                let phasor_coherence = cosine * (theta_q - theta_c).cos();
                let raw = 0.6 * phasor_coherence + 0.4 * kw;
                
                // Anti-bleed: only boost if there is semantic relevance.
                let boosted = if raw > 0.15 {
                    raw * (0.6 + 0.5 * cell.claim.confidence.min(5.0))
                } else {
                    raw
                };
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
                    text: cell.claim.text.clone(),
                    vec: cell.claim.vec.clone(),
                    region: cell.region.to_string(),
                    score,
                    strength: cell.claim.confidence,
                    source: cell.claim.source.to_string(),
                    timestamp: 0,
                    user_id: String::new(),
                    channel_id: String::new(),
                    message_id: String::new(),
                    keywords: Vec::new(),
                }
            })
            .collect()
    }

    /// Get all cells with a specific source tag — bypasses score filtering.
    pub fn get_by_source(&self, source: &str) -> Vec<QueryHit> {
        self.cells
            .iter()
            .filter(|c| c.claim.source.as_ref() == source)
            .map(|c| QueryHit {
                label: c.label.clone(),
                text: c.claim.text.clone(),
                vec: c.claim.vec.clone(),
                region: c.region.to_string(),
                score: 1.0,
                strength: c.claim.confidence,
                source: c.claim.source.to_string(),
                timestamp: 0,
                user_id: String::new(),
                channel_id: String::new(),
                message_id: String::new(),
                keywords: Vec::new(),
            })
            .collect()
    }

    /// Query the live strength of a named conversation state cell.
    /// State cells live in region="tone", source="state".
    /// Used by voice.rs for lattice-native routing — no word-list context scanning.
    /// Returns 0.0 if no matching state cell exists or has decayed below threshold.
    /// The lattice IS the state machine: store when detected, decay naturally.
    pub fn state_strength(&self, key: &str) -> f32 {
        let q = SparseVec::encode(key);
        self.cells
            .iter()
            .filter(|c| c.claim.source.as_ref() == "state" && c.region.as_ref() == "tone")
            .map(|c| {
                let sim = q.cosine(&c.claim.vec);
                if sim > 0.55 {
                    c.claim.confidence * sim
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

    pub fn get_cell_by_label(&self, label: &str) -> Option<&Cell> {
        self.cells.iter().find(|c| c.label == label)
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
            *map.entry(cell.region.to_string()).or_insert(0) += 1;
        }
        map
    }

    /// Average strength.
    pub fn avg_strength(&self) -> f32 {
        if self.cells.is_empty() {
            return 0.0;
        }
        let sum: f32 = self.cells.iter().map(|c| c.claim.confidence).sum();
        sum / self.cells.len() as f32
    }

    /// Decay all cells by factor (for homeostasis).
    pub fn decay_all(&mut self, factor: f32) -> usize {
        let mut count = 0;
        for cell in &mut self.cells {
            let old = cell.claim.confidence;
            let is_bridge =
                cell.claim.source.as_ref() == "dream-discovery" || cell.claim.source.as_ref() == "hlv-bridge";

            // Survival bonus: bridges with Φg > 1.0 decay MUCH slower (70% reduction in decay)
            let effective_factor = if is_bridge && cell.convergence_score > 1.0 {
                1.0 - (1.0 - factor) * 0.3
            } else if is_bridge {
                1.0 - (1.0 - factor) * 0.5
            } else {
                factor
            };

            cell.claim.confidence *= effective_factor;
            if (old - cell.claim.confidence).abs() > 0.001 {
                count += 1;
            }
        }
        count
    }

    /// Prune cells below minimum strength.
    /// Also kills "noisy" cells (high-chi / low-Φg) even if they have moderate strength.
    pub fn prune(&mut self, min_strength: f32) -> usize {
        let before = self.cells.len();
        self.cells.retain(|c| {
            let is_bridge = c.claim.source.as_ref() == "dream-discovery" || c.claim.source.as_ref() == "hlv-bridge";

            // Core physics anchors (strength >= 4.0) are IMMUNE to pruning.
            if c.claim.confidence >= 4.0 {
                return true;
            }

            if is_bridge {
                // Protect any bridge connected to a cell with Φg > 2.0
                if c.convergence_score > 2.0 {
                    return true;
                }
                // Only prune bridges that have BOTH low strength AND low Φg
                if c.claim.confidence < min_strength && c.convergence_score < 1.0 {
                    return false;
                }
                return true;
            }

            // For non-bridge cells:
            // 1. Must meet minimum strength
            if c.claim.confidence < min_strength {
                return false;
            }
            // 2. High-chi pruning: if strength is mediocre (< 1.5) and Φg is low (< 1.2), it's noise.
            if c.claim.confidence < 1.5 && c.convergence_score < 1.2 {
                return false;
            }

            true
        });
        before - self.cells.len()
    }

    /// Golden Spiral driven pruning.
    /// Uses spiral radius (0.0 - 1.0) to modulate pruning aggressiveness.
    /// radius -> 1.0 (deep cycle) = more aggressive noise clearing.
    pub fn prune_with_spiral(&mut self, radius: f32) -> usize {
        // radius 0.0 -> 1.0
        // As radius increases (deep sleep), we become more aggressive.
        let min_s = 0.6 + 0.3 * radius; // 0.6 -> 0.9
        let min_phi = 1.3 + 0.5 * radius; // 1.3 -> 1.8

        let before = self.cells.len();
        self.cells.retain(|c| {
            if c.claim.confidence >= 4.0 {
                return true;
            } // Trusted anchors always stay

            let is_bridge = c.claim.source.as_ref() == "dream-discovery" || c.claim.source.as_ref() == "hlv-bridge";
            if is_bridge {
                if c.convergence_score > 2.2 {
                    return true;
                }
                if c.claim.confidence < min_s && c.convergence_score < 1.2 {
                    return false;
                }
                return true;
            }

            // Normal cells: must meet dynamic strength and phi thresholds
            if c.claim.confidence < min_s {
                return false;
            }
            if c.convergence_score < min_phi {
                return false;
            }

            true
        });
        before - self.cells.len()
    }

    // ── Epistemic Methods (Parallel Rebuild) ───────────────────────────────

    /// Re-injects physics truth anchors and penalizes low-coherence physics claims.
    pub fn dynamic_calibrate(&mut self) {
        // 1. Reinforce physics anchors
        for (anchor, strength) in TRUTH_ANCHORS {
            self.store_or_reinforce(anchor, "established-physics", "truth-anchor", *strength);
        }

        // 2. Reinforce self-knowledge anchors — KAI must know who he is
        self.seed_self_knowledge();

        // 3. Parallel penalty for low-coherence physics cells
        self.cells.par_iter_mut().for_each(|c| {
            if c.region.as_ref() == "established-physics"
                && c.claim.source.as_ref() != "truth-anchor"
                && (c.convergence_score < COHERENCE_FLOOR || c.claim.confidence < 0.2)
            {
                c.claim.confidence = (c.claim.confidence * 0.88).max(0.05);
            }
        });
    }

    /// Seeds architectural self-knowledge into the identity region.
    ///
    /// Without this, KAI returns "lattice is quiet" for any question about
    /// his own architecture (MindFrame, ClaimStore, regions, etc.) because
    /// there are no matching cells. These anchors give him a solid foundation
    /// of self-knowledge at the same strength level as physics truth anchors.
    ///
    /// Called every calibration cycle so identity cells survive decay and
    /// never drift below the query threshold.
    pub fn seed_self_knowledge(&mut self) {
        for (text, strength) in SELF_KNOWLEDGE_ANCHORS {
            self.store_or_reinforce(text, "identity", "self-knowledge", *strength);
        }
    }

    /// Parallel Lattice Reorganisation.
    /// Uses the Golden Angle (≈ 137.5°) for phyllotaxis-style ring packing.
    pub fn reorganize_with_spiral(&mut self, spiral_radius: f32) {
        use std::f32::consts::TAU;
        const GOLDEN_ANGLE: f32 = 2.399_963_1_f32;

        if spiral_radius < 0.3 {
            return;
        }

        self.cells.par_iter_mut().enumerate().for_each(|(i, cell)| {
            // Step 1: Trust score [0, 1]
            let raw_trust: f32 = match (cell.region.as_ref(), cell.claim.source.as_ref()) {
                ("established-physics", "truth-anchor") => 1.0,
                ("established-physics", _) => 0.6 * (cell.convergence_score / 3.0).clamp(0.0, 1.0),
                (_, "verified") => 0.55,
                (_, "world-bridge") => 0.35 * (cell.convergence_score / 3.0).clamp(0.0, 1.0),
                (_, "contested") => 0.08,
                _ => 0.4 * (cell.convergence_score / 3.0).clamp(0.0, 1.0),
            };

            // Step 2: Golden-angle phase
            let phase = ((i as f32 * GOLDEN_ANGLE) % TAU) / TAU;
            let ring = (1.0 - raw_trust) * 0.7 + phase * 0.3;

            // Step 3: Apply forces
            if ring < 0.35 {
                let pull = 0.04 * spiral_radius * (0.35 - ring) / 0.35;
                cell.claim.confidence = (cell.claim.confidence + pull).min(5.0);
            } else if ring > 0.65 {
                let push = 0.96 + 0.04 * (1.0 - (ring - 0.65) / 0.35) * (1.0 - spiral_radius);
                cell.claim.confidence = (cell.claim.confidence * push).max(0.05);
            }
        });
    }

    /// Scan for source dominance in any region and apply trust penalties.
    pub fn scan_for_monocultures(&mut self) {
        // Step 1: Sequential count (Universe is Vec<Cell>, but we only do this once per cycle)
        let mut region_total = HashMap::new();
        let mut region_source_count = HashMap::new();

        for cell in &self.cells {
            *region_total.entry(cell.region.to_string()).or_insert(0) += 1;
            *region_source_count
                .entry((cell.region.to_string(), cell.claim.source.to_string()))
                .or_insert(0) += 1;
        }

        // Step 2: Identify monocultures
        let monocultures: Vec<(String, String)> = region_source_count
            .into_iter()
            .filter(|((region, source), count)| {
                if source == "truth-anchor" {
                    return false;
                }
                let total = *region_total.get(region).unwrap_or(&1);
                total >= MONOCULTURE_MIN_SIZE
                    && (*count as f32 / total as f32) > MONOCULTURE_THRESHOLD
            })
            .map(|((r, s), _)| (r, s))
            .collect();

        if monocultures.is_empty() {
            return;
        }

        // Step 3: Parallel penalty application
        self.cells.par_iter_mut().for_each(|cell| {
            for (region, source) in &monocultures {
                if cell.region.as_ref() == region.as_str() && cell.claim.source.as_ref() == source.as_str() {
                    cell.claim.confidence = (cell.claim.confidence * 0.96).max(0.1);
                    break;
                }
            }
        });
    }

    /// Consolidate near-duplicate cells (cosine > 0.90).
    /// Keeps the stronger cell and removes the weaker one.
    /// Returns the number of cells removed.
    pub fn consolidate_duplicates(&mut self) -> usize {
        if self.cells.len() < 2 {
            return 0;
        }

        let n = self.cells.len();

        // Parallelized duplicate scan
        let duplicates: std::collections::HashSet<usize> = (0..n)
            .into_par_iter()
            .flat_map(|i| {
                let mut local_dupes = Vec::new();
                for j in (i + 1)..n {
                    let sim = self.cells[i].claim.vec.cosine(&self.cells[j].claim.vec);
                    if sim > 0.90 {
                        // Near-duplicate! Compare strength.
                        if self.cells[i].claim.confidence >= self.cells[j].claim.confidence {
                            local_dupes.push(j);
                        } else {
                            local_dupes.push(i);
                        }
                    }
                }
                local_dupes
            })
            .collect();

        let removed_count = duplicates.len();
        let mut sorted_indices: Vec<_> = duplicates.into_iter().collect();
        sorted_indices.sort_by(|a, b| b.cmp(a)); // Remove from end to preserve indices

        for idx in sorted_indices {
            self.cells.remove(idx);
        }

        removed_count
    }

    /// Get cells in a specific region.
    pub fn region_cells(&self, region: &str) -> Vec<&Cell> {
        self.cells.iter().filter(|c| c.region.as_ref() == region).collect()
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
            if cell.claim.text == text {
                cell.claim.confidence = (cell.claim.confidence + delta).min(5.0);
                break;
            }
        }
    }

    /// Forget a specific belief by exact text match.
    pub fn forget(&mut self, text: &str) {
        self.cells.retain(|c| c.claim.text != text);
    }

    /// Structured ingestion path: writes to Claims.
    /// This is the primary entry point for lifting raw knowledge into the
    /// epistemic memory model.
    ///
    /// Implements the Three-Angle Protocol (whitepaper Section 10.3):
    ///   Angle 1 — Query lattice for positive evidence supporting the claim
    ///   Angle 2 — Query lattice for evidence contradicting the claim
    ///   Angle 3 — Compute domain resonance against the target region
    pub fn ingest_and_verify(
        &mut self,
        text: &str,
        region: &str,
        source: &str,
        confidence: f32,
    ) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        // Encode the claim text for geometric comparison
        let claim_vec = SparseVec::encode(text);

        // ── Three-Angle Protocol ────────────────────────────────────────────
        // Whitepaper Section 10.3:
        //   PHYSICS_RESONANCE_FLOOR = 0.55  (minimum for physics claims)
        //   COHERENCE_FLOOR         = 0.40  (minimum for any claim)
        const PHYSICS_RESONANCE_FLOOR: f32 = 0.55;
        let coherence_floor = if self.calibration_floor > 0.0 { self.calibration_floor } else { 0.40 };

        // Angle 1 — Direct evidence: query for cells that SUPPORT this claim
        let supporting_hits = self.query_in_regions(text, 10, &[region], "");
        let angle1_score = if supporting_hits.is_empty() {
            0.0
        } else {
            let top = &supporting_hits[0];
            // Strong support = high cosine + high confidence source
            top.score * (top.strength.min(5.0) / 5.0)
        };

        // Angle 2 — Adversarial evidence: scan for cells that CONTRADICT this claim.
        // A contradiction is defined as: semantically similar (cosine > 0.65)
        // but conceptually different (keyword overlap < 0.25) with HIGHER confidence.
        let claim_words: Vec<String> = text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
            .collect();
        let mut angle2_score = 0.0f32;
        for cell in &self.cells {
            if cell.claim.confidence > confidence {
                let sim = claim_vec.cosine(&cell.claim.vec);
                if sim > 0.65 {
                    let kw = keyword_overlap_score(&claim_words, &cell.claim.text);
                    if kw < 0.25 {
                        // This cell contradicts the new claim. Score by confidence.
                        angle2_score = angle2_score.max(
                            sim * (cell.claim.confidence.min(5.0) / 5.0)
                        );
                    }
                }
            }
        }

        // Angle 3 — Domain resonance: how well does this claim fit its target region?
        // Compute average cosine to existing cells in the target region.
        let region_cells: Vec<&Cell> = self.cells.iter().filter(|c| c.region.as_ref() == region).collect();
        let angle3_resonance = if region_cells.is_empty() {
            1.0 // No existing cells = vacuously coherent (region is empty)
        } else {
            let total_sim: f32 = region_cells
                .iter()
                .map(|c| claim_vec.cosine(&c.claim.vec).max(0.0))
                .sum();
            total_sim / region_cells.len() as f32
        };

        if angle2_score > 0.0 {
            self.recent_contradictions = self.recent_contradictions.saturating_add(1);
            if self.recent_contradictions > 5 {
                self.calibration_floor = (self.calibration_floor + 0.05).min(0.65);
                self.recent_contradictions = 0;
            }
        } else {
            self.calibration_floor = (self.calibration_floor - 0.01).max(0.40);
        }

        // ── Epistemic Gatekeeper ───────────────────────────────────────────
        //   if resonance < COHERENCE_FLOOR:   → reject entirely
        //   if resonance < PHYSICS_RESONANCE_FLOOR AND region = 'established-physics':
        //                                       → reject
        //   if Angle 2 score > Angle 1 score:  → route to 'contested' region at low confidence
        //   else:                               → store C in target region at assigned confidence

        if angle3_resonance < coherence_floor {
            log_rejected_claim(text, region, source, confidence, "three-angle coherence floor");
            println!("REJECTED: '{}' (Reason: three-angle coherence {:.2} < floor {:.2})",
                     text, angle3_resonance, coherence_floor);
            return false;
        }

        if region == "established-physics" && angle3_resonance < PHYSICS_RESONANCE_FLOOR {
            log_rejected_claim(text, region, source, confidence, "physics resonance floor");
            println!("REJECTED: '{}' (Reason: physics resonance {:.2} < floor {:.2})",
                     text, angle3_resonance, PHYSICS_RESONANCE_FLOOR);
            return false;
        }
        
        // ── Sovereign Physics: Strict Friction Gating ──
        // If the calculated friction (chi / angle2_score) exceeds the structural resonance 
        // (phi_g / angle3_resonance), the cell threatens the integrity of the 16,384-dim lattice.
        if angle2_score > angle3_resonance {
            log_rejected_claim(text, region, source, confidence, "structural friction (chi > phi_g)");
            println!("REJECTED: '{}' (Reason: Sovereign Physics friction {:.2} > resonance {:.2})",
                     text, angle2_score, angle3_resonance);
            return false;
        }

        let (target_region, target_confidence, is_contested) = if angle2_score > angle1_score {
            // Contradiction dominates corroboration → route to contested at low confidence
            ("contested", confidence * 0.5, true)
        } else {
            (region, confidence, false)
        };

        // Phase 4: Legacy Active Epistemic Filtering (kept as secondary gate).
        // When the Three-Angle Protocol has already routed to 'contested',
        // we SKIP the contradiction check — contested claims are contradictory BY DESIGN.
        let mut temp_claim = Claim::new(text, source, target_confidence, claim_vec);
        temp_claim.evidence.push(source.to_string());

        if !is_contested && !self.should_accept_claim(&temp_claim) {
            let reason = if target_confidence < 0.45 {
                "low confidence threshold (< 0.45)"
            } else if temp_claim.evidence.is_empty() {
                "missing evidence links"
            } else {
                "unresolved epistemic contradiction with higher-confidence source"
            };
            log_rejected_claim(text, target_region, source, target_confidence, reason);
            println!("REJECTED: '{}' (Reason: {})", text, reason);
            return false;
        }

        // store_or_reinforce returns true if new, false if reinforced
        let is_new = self.store_or_reinforce(text, target_region, source, target_confidence);

        if !is_new {
            // Find and update the verification timestamp
            if let Some(cell) = self.cells.iter_mut().find(|c| c.claim.text == text) {
                cell.claim.last_verified = now;
                // Add source to evidence if not already present
                if !cell.claim.evidence.contains(&source.to_string()) {
                    cell.claim.evidence.push(source.to_string());
                }
            }
        } else {
            // New claim: initialize evidence with its primary source
            if let Some(cell) = self.cells.last_mut() {
                if cell.claim.text == text {
                    cell.claim.evidence.push(source.to_string());
                }
            }
        }

        // Phase 3: Targeted Epistemic Scan (Incremental)
        // Instead of scanning the WHOLE world, we only detect contradictions for this NEW cell.
        self.detect_contradictions_for_last();

        is_new
    }

    /// Targeted version of contradiction detection: only checks the most recently added cell.
    /// This turns an O(N^2) global scan into a fast O(N) targeted check.
    pub fn detect_contradictions_for_last(&mut self) {
        let n = self.cells.len();
        if n < 2 {
            return;
        }

        let last_idx = n - 1;
        // We use a temporary clone to avoid borrow checker issues while scanning the rest of the cells
        let cell_a = self.cells[last_idx].clone();
        let words_a: Vec<String> = cell_a
            .claim
            .text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
            .collect();

        let mut conflicts = Vec::new();

        // Scan all OTHER cells for conflicts with the NEW cell
        for j in 0..last_idx {
            let cell_b = &self.cells[j];
            
            // Only consider B as a contradiction to A if B has higher confidence
            if cell_b.claim.confidence > cell_a.claim.confidence {
                let sim = cell_a.claim.vec.cosine(&cell_b.claim.vec);

                if sim > 0.65 {
                    let kw = keyword_overlap_score(&words_a, &cell_b.claim.text);
                    if kw < 0.25 {
                        conflicts.push(cell_b.claim.text.clone());
                    }
                }
            }
        }

        if !conflicts.is_empty() {
            self.cells[last_idx].claim.contradictions.extend(conflicts);
        }
    }

    /// Scan the entire lattice for epistemic contradictions using parallel processing.
    /// This is expensive and should be called during sleep or idle cycles, not on every ingest.
    pub fn detect_contradictions(&mut self) -> usize {
        let cells_len = self.cells.len();
        if cells_len < 2 {
            return 0;
        }

        // Parallel scan to find all contradictions
        let all_updates: Vec<(usize, Vec<String>)> = (0..cells_len)
            .into_par_iter()
            .map(|i| {
                let cell_a = &self.cells[i];
                let words_a: Vec<String> = cell_a
                    .claim
                    .text
                    .split(|c: char| !c.is_alphanumeric())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_lowercase())
                    .collect();

                let mut cell_conflicts = Vec::new();
                for j in 0..cells_len {
                    if i == j {
                        continue;
                    }
                    let cell_b = &self.cells[j];
                    if cell_b.claim.confidence > cell_a.claim.confidence {
                        let sim = cell_a.claim.vec.cosine(&cell_b.claim.vec);
                        if sim > 0.65 {
                            let kw = keyword_overlap_score(&words_a, &cell_b.claim.text);
                            if kw < 0.25 {
                                cell_conflicts.push(cell_b.claim.text.clone());
                            }
                        }
                    }
                }
                (i, cell_conflicts)
            })
            .collect();

        // Apply updates sequentially
        let mut total_applied = 0;
        for (idx, conflicts) in all_updates {
            if !conflicts.is_empty() {
                self.cells[idx].claim.contradictions = conflicts;
                total_applied += 1;
            } else {
                self.cells[idx].claim.contradictions.clear();
            }
        }
        total_applied
    }

    /// Diagnostic: List all claims that have active contradictions.
    pub fn list_contradictions(&self) -> Vec<Claim> {
        self.cells
            .iter()
            .filter(|c| !c.claim.contradictions.is_empty())
            .map(|c| c.claim.clone())
            .collect()
    }

    /// Phase 4: Epistemic Gatekeeper.
    /// Determines if a claim is fit for storage or reinforcement.
    pub fn should_accept_claim(&self, claim: &Claim) -> bool {
        // 1. Confidence Floor
        if claim.confidence < 0.45 {
            return false;
        }

        // 2. Evidence Requirement
        if claim.evidence.is_empty() {
            return false;
        }

        // 3. Contradiction check against the existing lattice.
        // We look for any existing higher-confidence claim that conflicts with this one.
        let words_a: Vec<String> = claim
            .text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_lowercase())
            .collect();

        for cell_b in &self.cells {
            if cell_b.claim.confidence > claim.confidence {
                let sim = claim.vec.cosine(&cell_b.claim.vec);

                // If they are semantically similar but conceptually different
                if sim > 0.65 {
                    let kw = keyword_overlap_score(&words_a, &cell_b.claim.text);
                    if kw < 0.25 {
                        return false; // Contradiction found
                    }
                }
            }
        }

        true
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
        self.store_or_reinforce_with_vec(text, region, source, strength, None, None, "")
    }

    /// Full-featured storage with optional pre-computed vector (e.g. for dreams).
    pub fn store_or_reinforce_with_vec(
        &mut self,
        text: &str,
        region: &str,
        source: &str,
        strength: f32,
        vec: Option<SparseVec>,
        conv_score: Option<f32>,
        user_id: &str,
    ) -> bool {
        // Phase 1: exact string match (fast path — O(1) hash map)
        let hash = hash_label(text);
        if let Some(&idx) = self.exact_match_index.get(&hash) {
            let idx = idx as usize;
            if idx < self.cells.len() && self.cells[idx].label == text {
                self.cells[idx].claim.confidence = (self.cells[idx].claim.confidence + 0.15).min(5.0);
                if source == "ryan" {
                    self.cells[idx].claim.source = Arc::from("ryan");
                }
                self.mark_dirty(idx);
                return false; // exact match reinforced
            }
        }
        
        // Phase 2: semantic near-duplicate check (cosine > 0.85).
        let candidate_vec = vec.unwrap_or_else(|| SparseVec::encode(text));

        if strength >= 0.8 {
            let mut best_idx = 0;
            let mut best_score = 0.0_f32;

            if let Some(ref hnsw) = self.hnsw {
                let results = hnsw.search(&[candidate_vec.clone()], 10, 50);
                for hit in &results {
                    let idx = hit.d_id as usize;
                    if idx < self.cells.len() {
                        let sim = candidate_vec.cosine(&self.cells[idx].claim.vec);
                        if sim > best_score {
                            best_score = sim;
                            best_idx = idx;
                        }
                    }
                }
            } else {
                // Fallback: Parallel semantic search
                use rayon::prelude::*;
                let mag_q = candidate_vec.nnz() as f32;
                let mag_q_sqrt = mag_q.sqrt();
        let theta_q = candidate_vec.phase_angle();

                let res = self
                    .cells
                    .par_iter()
                    .enumerate()
                    .map(|(i, cell)| {
                        // Use cached nnz for speed
                        let dot = candidate_vec.dot(&cell.claim.vec);
                        let mag_c = cell.nnz as f32;
                        let sim = if mag_q > 0.0 && mag_c > 0.0 {
                            dot as f32 / (mag_q_sqrt * mag_c.sqrt())
                        } else {
                            0.0
                        };
                        (i, sim)
                    })
                    .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
                    .unwrap_or((0, 0.0));
                best_idx = res.0;
                best_score = res.1;
            }
            if best_score > 0.85 && best_idx < self.cells.len() {
                // Semantic duplicate — update existing cell with new text/vec
                // if it's high-strength (trusted training) or from ryan.
                if strength >= 0.8 || source == "ryan" {
                    self.cells[best_idx].label = text.to_string();
                    self.cells[best_idx].claim.text = text.to_string();
                    self.cells[best_idx].claim.vec = candidate_vec;
                    self.cells[best_idx].claim.source = Arc::from(source);
                    self.cells[best_idx].claim.confidence =
                        (self.cells[best_idx].claim.confidence + 0.20).min(5.0);
                } else {
                    // Regular ingestion — just reinforce
                    self.cells[best_idx].claim.confidence =
                        (self.cells[best_idx].claim.confidence + 0.10).min(5.0);
                }
                self.mark_dirty(best_idx);
                return false;
            }
        }
        // Genuinely new cell
        self.store_with_vec_user(text, region, source, strength, candidate_vec, conv_score, user_id);
        true
    }

    // ── Predictive RSHL ─────────────────────────────────────────────────
    //
    // Iterative predictive retrieval. 8-step (minimum) refinement loop
    // inside, followed by a single scored pass with the paper-backed
    // weights. See `core::predictive` for the research mapping.

    /// Predictive query with internal iteration loop.
    ///
    /// 1. Runs `steps.max(8)` passes of a light context mixer that
    ///    nudges the query state toward the conversation trace
    ///    (6·state + 5·trace, ternary-clamped).
    /// 2. Scores every eligible cell with:
    ///        0.20 * similarity(state, cell.vec)
    ///      + 0.55 * predictive_match(trace, cell.continuation)
    ///      + 0.15 * multi_head_consensus(state, cell.vec)
    ///      - 0.20 * recency_penalty(cell.last_fired)
    ///    Continuation binding dominates static similarity — the whole
    ///    point of the upgrade.
    /// 3. Returns the top-5 hits.
    pub fn predictive_query(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
    ) -> Vec<QueryHit> {
        self.predictive_query_filtered(input, trace, steps, |_| true, "")
    }

    pub fn predictive_query_user(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        user_id: &str,
    ) -> Vec<QueryHit> {
        self.predictive_query_filtered(input, trace, steps, |_| true, user_id)
    }

    /// Source-scoped variant for the voice path (greeting / empathy / …).
    /// Same pipeline, just filters eligible cells to a single source tag.
    pub fn predictive_query_by_source(
        &self,
        input: SparseVec,
        source: &str,
        trace: &ConversationTrace,
        steps: usize,
    ) -> Vec<QueryHit> {
        let want = source.to_string();
        self.predictive_query_filtered(input, trace, steps, move |c| c.claim.source.as_ref() == want.as_str(), "")
    }

    pub fn predictive_query_by_source_user(
        &self,
        input: SparseVec,
        source: &str,
        trace: &ConversationTrace,
        steps: usize,
        user_id: &str,
    ) -> Vec<QueryHit> {
        let want = source.to_string();
        self.predictive_query_filtered(input, trace, steps, move |c| c.claim.source.as_ref() == want.as_str(), user_id)
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
        self.diagnose_predictive_user(input, trace, steps, top_k, "")
    }

    pub fn diagnose_predictive_user(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        top_k: usize,
        user_id: &str,
    ) -> Vec<PredictiveScoreBreakdown> {
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.claim.source.as_ref() != "user-echo" && c.claim.source.as_ref() != "conversation")
            .filter(|(_, c)| {
                if c.claim.layer == super::claim::LAYER_CELLULAR {
                    return c.claim.user_id.as_ref() == user_id;
                }
                true
            })
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        let iter_steps = steps.max(predictive::DEFAULT_ITER_STEPS);
        let mut state = input.clone();
        let dim = super::sparse_vec::DIM;
        let trace_dense = trace.current.to_dense();
        for _ in 0..iter_steps {
            let state_dense = state.to_dense();
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state_dense[i] as i32;
                let t = trace_dense[i] as i32;
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
                let sim = state.phasor_coherence(&cell.claim.vec).max(0.0);
                let predict_match = cell.continuation.as_ref().map_or(0.0, |c| prediction_anchor.phasor_coherence(c).max(0.0));
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.claim.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec =
                    predictive::recency_penalty(tick, cell.last_fired, predictive::RECENCY_WINDOW);
                let score = 0.20 * sim + 0.55 * predict_match + 0.15 * mh - 0.20 * rec;
                PredictiveScoreBreakdown {
                    label: cell.label.clone(),
                    text: cell.claim.text.clone(),
                    vec: cell.claim.vec.clone(),
                    source: cell.claim.source.to_string(),
                    sim,
                    predict_match,
                    mh,
                    rec,
                    score,
                    last_fired: cell.last_fired,
                    continuation_nnz: cell.continuation.as_ref().map_or(0, |c| c.nnz()),
                }
            })
            .collect();
        rows.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
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
        self.diagnose_predictive_by_source_user(input, source, trace, steps, top_k, "")
    }

    pub fn diagnose_predictive_by_source_user(
        &self,
        input: SparseVec,
        source: &str,
        trace: &ConversationTrace,
        steps: usize,
        top_k: usize,
        user_id: &str,
    ) -> Vec<PredictiveScoreBreakdown> {
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.claim.source.as_ref() == source)
            .filter(|(_, c)| {
                if c.claim.layer == super::claim::LAYER_CELLULAR {
                    return c.claim.user_id.as_ref() == user_id;
                }
                true
            })
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        let iter_steps = steps.max(predictive::DEFAULT_ITER_STEPS);
        let mut state = input.clone();
        let dim = super::sparse_vec::DIM;
        let trace_dense = trace.current.to_dense();
        for _ in 0..iter_steps {
            let state_dense = state.to_dense();
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state_dense[i] as i32;
                let t = trace_dense[i] as i32;
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
                let sim = state.phasor_coherence(&cell.claim.vec).max(0.0);
                let predict_match = cell.continuation.as_ref().map_or(0.0, |c| prediction_anchor.phasor_coherence(c).max(0.0));
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.claim.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec =
                    predictive::recency_penalty(tick, cell.last_fired, predictive::RECENCY_WINDOW);
                let score = 0.20 * sim + 0.55 * predict_match + 0.15 * mh - 0.20 * rec;
                PredictiveScoreBreakdown {
                    label: cell.label.clone(),
                    text: cell.claim.text.clone(),
                    vec: cell.claim.vec.clone(),
                    source: cell.claim.source.to_string(),
                    sim,
                    predict_match,
                    mh,
                    rec,
                    score,
                    last_fired: cell.last_fired,
                    continuation_nnz: cell.continuation.as_ref().map_or(0, |c| c.nnz()),
                }
            })
            .collect();
        rows.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        rows.truncate(top_k);
        rows
    }
    fn predictive_query_filtered<F>(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        extra_filter: F,
        user_id: &str,
    ) -> Vec<QueryHit>
    where
        F: Fn(&Cell) -> bool + Sync + Send,
    {
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.claim.source.as_ref() != "user-echo" && c.claim.source.as_ref() != "conversation")
            .filter(|(_, c)| {
                if c.claim.layer == super::claim::LAYER_CELLULAR {
                    return c.claim.user_id.as_ref() == user_id;
                }
                true
            })
            .filter(|(_, c)| extra_filter(c))
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        // ─────────────── Iterative context mixer (conjunctive gating) ───────────────
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
        let dim = super::sparse_vec::DIM;
        let trace_dense = trace.current.to_dense();
        for _ in 0..iter_steps {
            let state_dense = state.to_dense();
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state_dense[i] as i32;
                let t = trace_dense[i] as i32;
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

        // ─────────────── Final scoring with look-ahead prediction anchor ─────────────
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
                let sim = state.phasor_coherence(&cell.claim.vec).max(0.0);
                let predict_match = cell.continuation.as_ref().map_or(0.0, |c| prediction_anchor.phasor_coherence(c).max(0.0));
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.claim.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec =
                    predictive::recency_penalty(tick, cell.last_fired, predictive::RECENCY_WINDOW);
                // Transitions dominate. Raw similarity barely contributes;
                // recency is harsh enough to push repeated cells out of
                // the top-k.
                let score = 0.20 * sim + 0.55 * predict_match + 0.15 * mh - 0.20 * rec;
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
                    text: c.claim.text.clone(),
                    vec: c.claim.vec.clone(),
                    region: c.region.to_string(),
                    score,
                    strength: c.claim.confidence,
                    source: c.claim.source.to_string(),
                    timestamp: 0,
                    user_id: String::new(),
                    channel_id: String::new(),
                    message_id: String::new(),
                    keywords: Vec::new(),
                }
            })
            .collect()
    }

    /// Predictive query that returns *cell references* with scores
    /// instead of display-only `QueryHit`s. Same scoring pipeline as
    /// `predictive_query` (iterative conjunctive mixer → look-ahead
    /// anchor → similarity + predict_match + multi-head − recency),
    /// but the caller keeps direct access to `Cell::vec` and
    /// `Cell::continuation` — exactly what the generative encoder
    /// needs to fold memory into the latent state.
    ///
    /// `top_k` is configurable so the generative path can pull the
    /// 6—8 most relevant cells (the retrieval path that powers the
    /// TUI still uses the fixed top-5 via `predictive_query`).
    pub fn predictive_query_vecs(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        top_k: usize,
    ) -> Vec<(&Cell, f32)> {
        self.predictive_query_vecs_user(input, trace, steps, top_k, "")
    }

    pub fn predictive_query_vecs_user(
        &self,
        input: SparseVec,
        trace: &ConversationTrace,
        steps: usize,
        top_k: usize,
        user_id: &str,
    ) -> Vec<(&Cell, f32)> {
        if top_k == 0 {
            return Vec::new();
        }
        let eligible: Vec<usize> = self
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.claim.source.as_ref() != "user-echo" && c.claim.source.as_ref() != "conversation")
            .filter(|(_, c)| {
                if c.claim.layer == super::claim::LAYER_CELLULAR {
                    return c.claim.user_id.as_ref() == user_id;
                }
                true
            })
            .map(|(i, _)| i)
            .collect();
        if eligible.is_empty() {
            return Vec::new();
        }

        // Iterative conjunctive mixer — mirrors predictive_query_filtered.
        let iter_steps = steps.max(predictive::DEFAULT_ITER_STEPS);
        let mut state = input.clone();
        let dim = super::sparse_vec::DIM;
        let trace_dense = trace.current.to_dense();
        for _ in 0..iter_steps {
            let state_dense = state.to_dense();
            let mut data = vec![0i8; dim];
            for i in 0..dim {
                let s = state_dense[i] as i32;
                let t = trace_dense[i] as i32;
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
                let sim = state.phasor_coherence(&cell.claim.vec).max(0.0);
                let predict_match = cell.continuation.as_ref().map_or(0.0, |c| prediction_anchor.phasor_coherence(c).max(0.0));
                let mh = predictive::multi_head_consensus(
                    &state,
                    &cell.claim.vec,
                    predictive::DEFAULT_HEADS,
                );
                let rec =
                    predictive::recency_penalty(tick, cell.last_fired, predictive::RECENCY_WINDOW);
                let score = 0.20 * sim + 0.55 * predict_match + 0.15 * mh - 0.20 * rec;
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
        user_id: &str,
    ) -> SparseVec {
        crate::cognition::generative::build_generative_state(self, lex, prompt, trace, field, user_id)
    }

    /// Sequence binding — teach the lattice that `response_text` fired
    /// after `input_text`. Each call:
    ///   1. Bundles the current input vector into the response cell's
    ///      `continuation` hypervector (majority-vote over history).
    ///   2. Stamps `last_fired = current_tick` for the recency penalty.
    ///
    /// If multiple cells share `response_text` only the first is updated
    /// (there should only ever be one, but the guard is cheap). A missing
    /// text is silently ignored — a response composed from several cells
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
        let mut found = false;
        for cell in self.cells_mut().iter_mut() {
            if cell.label == response_text || cell.claim.text == response_text {
                let cont = cell.continuation.take().unwrap_or_else(SparseVec::zero);
                cell.continuation = Some(cont.bind(&input_vec));
                cell.last_fired = stamp;
                cell.activation_heat += 1.0;
                found = true;
                break;
            }
        }
        found
    }

    /// Fuzzy-warm continuations for training: find cells whose label or text
    /// is contained in (or contains) `response_text`, update their continuation
    /// to encode `input_text`, and stamp `current_tick`.
    /// Returns the number of cells warmed.
    pub fn warm_continuation_fuzzy(
        &mut self,
        input_text: &str,
        response_text: &str,
        current_tick: u64,
    ) -> usize {
        if response_text.trim().is_empty() {
            return 0;
        }
        let input_vec = SparseVec::encode(input_text).permute(1);
        let stamp = current_tick.max(1);
        let resp_lower = response_text.to_lowercase();
        let mut count = 0;
        for cell in self.cells_mut().iter_mut() {
            let label_lower = cell.label.to_lowercase();
            let text_lower = cell.claim.text.to_lowercase();
            let matches = label_lower == resp_lower
                || text_lower == resp_lower
                || resp_lower.contains(&label_lower)
                || label_lower.contains(&resp_lower)
                || resp_lower.contains(&text_lower)
                || text_lower.contains(&resp_lower);
            if matches {
                let cont = cell.continuation.take().unwrap_or_else(SparseVec::zero);
                cell.continuation = Some(cont.bind(&input_vec));
                cell.last_fired = stamp;
                count += 1;
            }
        }
        count
    }

    /// Force-seeds the mathematical and geometric anchors, even if the lattice is not empty.
    /// This is used during Grand Calibration to enrich the RSHL manifold.
    pub fn seed_force_math(&mut self) {
        // We call the seed_universe logic but we don't check for existence
        // Actually, we'll just implement it here for total control.
        let math_seeds: &[(&str, &str, f32)] = &[
            ("The lattice resonance is governed by the Golden Ratio (phi=1.618) for reinforcement and decay.", "Established-Physics", 5.0),
            ("Memory retrieval uses Phase Angle (theta) alignment to detect constructive interference between concepts.", "Established-Physics", 5.0),
            ("The Golden Ratio (phi) defines the optimal spacing of information density in the RSHL manifold.", "Established-Physics", 5.0),
            ("Geometric intelligence requires 16384-dimensional sparse vectors to maintain structural integrity and avoid collision.", "Established-Physics", 5.0),
        ];

        for (text, region, strength) in math_seeds {
            // Find existing or create new
            let mut found = false;
            for cell in self.cells.iter_mut() {
                if cell.claim.text == *text {
                    cell.claim.confidence = *strength;
                    cell.claim.last_verified = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
                    found = true;
                    break;
                }
            }
            if !found {
                self.store(text, region, "seed-calibration", *strength);
            }
        }
    }

    pub fn get_agent(&self, id: &str) -> Option<super::index::AgentSpec> {
        // Load from data/agents/ID.json
        let path = std::path::Path::new("data").join("agents").join(format!("{}.json", id.to_lowercase()));
        if let Ok(data) = std::fs::read_to_string(path) {
            serde_json::from_str(&data).ok()
        } else {
            None
        }
    }

    // ── Fractal Hierarchy: Zoom & Layer Queries ───────────────────────────

    /// Backfills mirror cells for all existing high-confidence cells.
    pub fn retro_mirror(&mut self) -> usize {
        let mut new_cells = Vec::new();
        
        // Find existing cells that need mirrors
        for cell in self.cells.iter() {
            if cell.claim.confidence >= 4.0 && !cell.label.starts_with("[MIRROR]") {
                let mirror_label = format!("[MIRROR] {}", cell.label);
                
                // Check if mirror already exists
                let already_exists = self.cells.iter().any(|c| c.label == mirror_label);
                if !already_exists {
                    new_cells.push((
                        mirror_label,
                        cell.claim.text.clone(),
                        cell.region.to_string(),
                        cell.claim.source.to_string(),
                        cell.claim.confidence * 0.9,
                        cell.claim.vec.invert(),
                        cell.claim.user_id.to_string(),
                        cell.claim.layer,
                        cell.convergence_score,
                    ));
                }
            }
        }
        
        let count = new_cells.len();
        
        // Insert mirrors
        for (label, text, region, source, strength, vec, user_id, layer, conv_score) in new_cells {
            let mut claim = Claim::new(&label, &source, strength, vec.clone());
            claim.layer = layer;
            claim.user_id = Arc::from(user_id.as_str());
            
            let m_id = self.cells.len() as u32;
            self.lexicon.index_cell(m_id, &label, &[region.to_string(), format!("source:{}", source), format!("user:{}", user_id)]);
            self.exact_match_index.insert(hash_label(&label), m_id);
            let m_pos_vec = SparseVec::project_vogel_spiral(m_id as usize, user_seed(&user_id));

            let m_idx = self.cells.len();
            self.cells.push(Cell {
                label,
                region: Arc::from(region.as_str()),
                claim,
                continuation: None,
                last_fired: 0,
                convergence_score: conv_score,
                nnz: vec.nnz() as u32,
                pos_vec: m_pos_vec,
                children: Vec::new(),
                parent: None,
                text_id: 0,
                is_archived: false,
                activation_heat: 0.0,
            });
            self.mark_dirty(m_idx);
        }
        
        count
    }

    /// Retrieve the full text of a cell. Uses the memory-mapped text store if
    /// available, otherwise falls back to the in-RAM `claim.text` micro-label.
    pub fn get_full_text(&self, cell_idx: usize) -> String {
        if let Some(store) = &self.text_store {
            let id = self.cells[cell_idx].text_id;
            if (id as usize) < store.len() {
                return store.get(id);
            }
        }
        self.cells[cell_idx].claim.text.clone()
    }

    /// "Zoom in" to a cell — return its children at finer resolution.
    pub fn zoom_in(&self, cell_idx: usize) -> Vec<&Cell> {
        if cell_idx >= self.cells.len() {
            return Vec::new();
        }
        self.cells[cell_idx]
            .children
            .iter()
            .filter_map(|&child_idx| {
                let idx = child_idx as usize;
                if idx < self.cells.len() {
                    Some(&self.cells[idx])
                } else {
                    None
                }
            })
            .collect()
    }

    /// "Zoom out" from a cell — return its parent at coarser resolution.
    pub fn zoom_out(&self, cell_idx: usize) -> Option<&Cell> {
        if cell_idx >= self.cells.len() {
            return None;
        }
        self.cells[cell_idx]
            .parent
            .and_then(|parent_idx| {
                let idx = parent_idx as usize;
                if idx < self.cells.len() {
                    Some(&self.cells[idx])
                } else {
                    None
                }
            })
    }

    /// Synthesize a parent cell's text from its top children by confidence.
    /// This is how higher-layer cells generate human-readable descriptions
    /// without storing full paragraphs in RAM.
    pub fn synthesize_parent_text(&self, cell_idx: usize) -> String {
        let cell = &self.cells[cell_idx];
        if cell.children.is_empty() {
            return self.get_full_text(cell_idx);
        }
        // Collect top 5 children by confidence
        let mut child_indices: Vec<u32> = cell.children.clone();
        child_indices.sort_by(|a, b| {
            let ca = self.cells[*a as usize].claim.confidence;
            let cb = self.cells[*b as usize].claim.confidence;
            cb.partial_cmp(&ca).unwrap_or(std::cmp::Ordering::Equal)
        });
        let top = child_indices.iter().take(5).copied().collect::<Vec<_>>();
        // Build a synthetic summary
        let topics: Vec<String> = top
            .iter()
            .map(|&idx| {
                let child = &self.cells[idx as usize];
                let label = if child.label.is_empty() {
                    &child.claim.text
                } else {
                    &child.label
                };
                // Truncate label to first 40 chars for brevity
                if label.len() > 40 {
                    format!("{}…", &label[..40])
                } else {
                    label.clone()
                }
            })
            .collect();
        format!("Domain: {}", topics.join("; "))
    }

    /// Query only cells at a specific hierarchy layer (0-4).
    /// Layer 4 = Body (broadest), Layer 1 = Syncytium (atomic observations).
    pub fn query_at_layer(&self, text: &str, layer: u8, n: usize) -> Vec<QueryHit> {
        let query_vec = SparseVec::encode(text);
        let query_words: Vec<String> = text
            .split_whitespace()
            .map(|w| w.to_lowercase())
            .filter(|w| w.len() > 2)
            .collect();

        let mut scored: Vec<(usize, f32)> = self.cells
            .par_iter()
            .enumerate()
            .filter(|(_, c)| c.claim.layer == layer)
            .map(|(i, cell)| {
                let dot = query_vec.dot(&cell.claim.vec);
                let mag_q = query_vec.nnz() as f32;
                let mag_c = cell.nnz as f32;
                let cosine = if mag_q > 0.0 && mag_c > 0.0 {
                    dot as f32 / (mag_q.sqrt() * mag_c.sqrt())
                } else {
                    0.0
                };
                let kw = keyword_overlap_score(&query_words, &cell.claim.text);
                let hybrid = 0.6 * cosine + 0.4 * kw;
                (i, hybrid)
            })
            .collect();

        scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(n);

        scored
            .into_iter()
            .map(|(idx, score)| {
                let cell = &self.cells[idx];
                QueryHit {
                    label: cell.label.clone(),
                    text: self.get_full_text(idx),
                    vec: cell.claim.vec.clone(),
                    region: cell.region.to_string(),
                    score,
                    strength: cell.claim.confidence,
                    source: cell.claim.source.to_string(),
                    timestamp: 0,
                    user_id: String::new(),
                    channel_id: String::new(),
                    message_id: String::new(),
                    keywords: Vec::new(),
                }
            })
            .collect()
    }
}
