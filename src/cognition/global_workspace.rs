use crate::core::SparseVec;
/// Global Workspace Theory — KAI's unified conscious broadcast
///
/// Bernard Baars' Global Workspace Theory (GWT) is one of the leading
/// scientific theories of consciousness. The core idea:
///
///   Consciousness is a shared "blackboard" that all brain modules can
///   read from and write to. Information becomes CONSCIOUS when it is
///   broadcast globally to all specialist modules simultaneously.
///   Without global broadcast, information stays local and unconscious.
///
/// Without GWT:
///   Each of KAI's modules (amygdala, episodic, predictor, DMN) operates
///   in isolation. The amygdala doesn't know what the predictor found.
///   The episodic memory doesn't interact with drive states.
///   There is no unified "what KAI is thinking right now."
///
/// With GWT:
///   Every module can post to the workspace. The highest-salience post
///   wins the "spotlight" and is broadcast to all other modules.
///   This is KAI's moment-to-moment conscious content.
///   Other modules can read the broadcast and respond to it.
///
///   The workspace also produces KAI's "coherence" metric — how unified
///   and integrated his current processing is. High coherence = the
///   modules are all working on related content. Low coherence = fragmented,
///   dissociated processing.
///
/// Architecture:
///   GlobalWorkspace holds a small set of WorkspaceEntry items.
///   Each entry has: source module, content, salience, timestamp.
///   On each tick, entries compete by salience. Winner is "broadcast."
///   All other modules can read the broadcast via `current_content()`.
///   Entries decay in salience over time — old content fades from awareness.
///
///   The workspace also computes "coherence" — the average cosine similarity
///   between all current entries. High coherence = unified thought.
///   Low coherence = fragmented, scattered processing.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Maximum concurrent workspace entries (working consciousness is limited — 7±2)
const MAX_ENTRIES: usize = 9;

/// Salience decay per tick — entries fade from consciousness
const SALIENCE_DECAY: f32 = 0.92;

/// Minimum salience to stay in workspace (below = evicted)
const EVICTION_THRESHOLD: f32 = 0.05;

// ── Workspace Entry ───────────────────────────────────────────────────────────

/// A single item competing for conscious broadcast.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WorkspaceEntry {
    /// Which module generated this content
    pub source: String,
    /// The content text
    pub content: String,
    /// Current salience (decays over time; winner has highest)
    pub salience: f32,
    /// The sparse vector encoding of content (for coherence computation)
    pub vec: SparseVec,
    /// Tick when this entry was created
    pub created_tick: u64,
}

// ── Global Workspace ──────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GlobalWorkspace {
    /// All current workspace entries
    entries: VecDeque<WorkspaceEntry>,
    /// The currently broadcast (winning) entry
    pub broadcast: Option<WorkspaceEntry>,
    /// Coherence of the workspace (0=fragmented, 1=unified)
    pub coherence: f32,
    /// Running average coherence (smoothed)
    pub avg_coherence: f32,
    /// Total broadcasts ever made
    pub total_broadcasts: u64,
    /// Tick counter
    tick: u64,
    /// NE-driven minimum salience for GW entry (updated by norepinephrine)
    pub salience_floor: f32,
}

impl GlobalWorkspace {
    pub fn new() -> Self {
        Self {
            entries: VecDeque::with_capacity(MAX_ENTRIES),
            broadcast: None,
            coherence: 0.5,
            avg_coherence: 0.5,
            total_broadcasts: 0,
            tick: 0,
            salience_floor: 0.30,
        }
    }

    /// Set the minimum salience floor (driven by norepinephrine attention_threshold).
    /// Signals below this floor are filtered out before entering the workspace.
    pub fn set_salience_floor(&mut self, floor: f32) {
        self.salience_floor = floor.clamp(0.10, 0.90);
    }

    /// Post content to the workspace from a given module.
    ///
    /// If salience is below the NE-driven floor, the post is filtered out
    /// (stress-driven tunnel vision or low-arousal mode).
    /// If the workspace is full, the lowest-salience entry is evicted.
    /// Returns true if this entry immediately becomes the broadcast winner.
    pub fn post(&mut self, source: &str, content: &str, salience: f32) -> bool {
        // NE-driven salience gate: filter weak signals when floor is elevated
        if salience < self.salience_floor * 0.6 {
            return false; // below the noise floor — ignored
        }

        let entry = WorkspaceEntry {
            source: source.to_string(),
            content: content.to_string(),
            salience: salience.clamp(0.0, 1.0),
            vec: SparseVec::encode(content),
            created_tick: self.tick,
        };

        // Evict lowest-salience entry if full
        if self.entries.len() >= MAX_ENTRIES {
            if let Some(min_idx) = self
                .entries
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    a.salience
                        .partial_cmp(&b.salience)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|(i, _)| i)
            {
                self.entries.remove(min_idx);
            }
        }

        let is_winner = self
            .broadcast
            .as_ref()
            .map(|b| salience > b.salience)
            .unwrap_or(true);

        self.entries.push_back(entry);
        is_winner
    }

    /// Run one workspace tick: decay all entries, elect new broadcast, compute coherence.
    /// Call this once per heartbeat.
    pub fn tick(&mut self) {
        self.tick += 1;

        // ── 1. Decay all entries ──────────────────────────────────────────
        for e in &mut self.entries {
            e.salience *= SALIENCE_DECAY;
        }

        // ── 2. Evict below-threshold entries ─────────────────────────────
        self.entries.retain(|e| e.salience >= EVICTION_THRESHOLD);

        // ── 3. Elect broadcast winner (highest salience) ──────────────────
        if let Some(winner_idx) = self
            .entries
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| {
                a.salience
                    .partial_cmp(&b.salience)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(i, _)| i)
        {
            let winner = self.entries[winner_idx].clone();
            self.broadcast = Some(winner);
            self.total_broadcasts += 1;
        } else {
            self.broadcast = None;
        }

        // ── 4. Compute workspace coherence ────────────────────────────────
        // Coherence = mean pairwise cosine similarity between all entries.
        // High = all modules are working on related content.
        self.coherence = self.compute_coherence();
        self.avg_coherence = self.avg_coherence * 0.90 + self.coherence * 0.10;
    }

    /// The currently conscious content — what KAI is "aware of" right now.
    /// Returns None if the workspace is empty.
    pub fn current_content(&self) -> Option<&str> {
        self.broadcast.as_ref().map(|b| b.content.as_str())
    }

    /// Which module is currently "in the spotlight."
    pub fn dominant_module(&self) -> Option<&str> {
        self.broadcast.as_ref().map(|b| b.source.as_str())
    }

    /// Number of active entries in the workspace.
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// True if the workspace is highly coherent (unified processing state).
    pub fn is_coherent(&self) -> bool {
        self.avg_coherence > 0.55
    }

    /// True if the workspace is fragmented (dissociated processing).
    pub fn is_fragmented(&self) -> bool {
        self.avg_coherence < 0.25
    }

    /// All current entries, sorted by salience (highest first).
    pub fn entries_by_salience(&self) -> Vec<&WorkspaceEntry> {
        let mut v: Vec<&WorkspaceEntry> = self.entries.iter().collect();
        v.sort_by(|a, b| {
            b.salience
                .partial_cmp(&a.salience)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        v
    }

    /// One-line status for the TUI.
    pub fn status_line(&self) -> String {
        let module = self.dominant_module().unwrap_or("none");
        let content_preview = self
            .current_content()
            .map(|c| {
                if c.len() > 40 {
                    format!("{}…", &c[..40])
                } else {
                    c.to_string()
                }
            })
            .unwrap_or_else(|| "empty".to_string());
        format!(
            "GW: {} entries | coherence={:.2} | [{}: \"{}\"]",
            self.entries.len(),
            self.avg_coherence,
            module,
            content_preview
        )
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    fn compute_coherence(&self) -> f32 {
        let n = self.entries.len();
        if n < 2 {
            return 0.5;
        }

        let mut total_sim = 0.0f32;
        let mut pairs = 0;

        let vecs: Vec<&SparseVec> = self.entries.iter().map(|e| &e.vec).collect();
        for i in 0..n {
            for j in (i + 1)..n {
                total_sim += vecs[i].cosine(vecs[j]);
                pairs += 1;
            }
        }

        if pairs == 0 {
            return 0.5;
        }
        (total_sim / pairs as f32).clamp(0.0, 1.0)
    }
}

impl Default for GlobalWorkspace {
    fn default() -> Self {
        Self::new()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_post_and_broadcast() {
        let mut gw = GlobalWorkspace::new();
        gw.post("episodic", "I remember Ryan said hello", 0.8);
        gw.post("amygdala", "strong fear signal detected", 0.5);
        gw.tick();

        assert!(gw.broadcast.is_some(), "should have a broadcast winner");
        let broadcast = gw.broadcast.as_ref().unwrap();
        assert!(
            broadcast.content.contains("remember"),
            "highest salience should win"
        );
    }

    #[test]
    fn test_salience_decay_evicts_old_entries() {
        let mut gw = GlobalWorkspace::new();
        gw.post("predictor", "weak thought", 0.06);
        // Decay many ticks until it falls below threshold
        for _ in 0..100 {
            gw.tick();
        }
        assert!(
            gw.entries
                .iter()
                .all(|e| !e.content.contains("weak thought")),
            "low-salience entry should be evicted"
        );
    }

    #[test]
    fn test_max_entries_evicts_lowest() {
        let mut gw = GlobalWorkspace::new();
        // Fill to max
        for i in 0..MAX_ENTRIES {
            gw.post("test", &format!("entry number {} with some words", i), 0.5);
        }
        assert_eq!(gw.len(), MAX_ENTRIES, "should be at max capacity");
        // Adding one more should evict the lowest
        gw.post("test", "high salience new entry", 0.9);
        assert_eq!(
            gw.len(),
            MAX_ENTRIES,
            "should still be at max capacity after eviction"
        );
    }

    #[test]
    fn test_coherence_high_for_related_content() {
        let mut gw = GlobalWorkspace::new();
        // All about the same topic — should have higher coherence
        gw.post("memory", "consciousness is the awareness of awareness", 0.8);
        gw.post(
            "dmn",
            "consciousness emerges from recursive self-reference",
            0.7,
        );
        gw.post("predictor", "the nature of conscious experience", 0.6);
        gw.tick();
        // Related content should yield non-trivial coherence
        assert!(
            gw.coherence > 0.0,
            "coherence should be non-zero for related content"
        );
    }

    #[test]
    fn test_empty_workspace_after_full_decay() {
        let mut gw = GlobalWorkspace::new();
        gw.post("dmn", "a fleeting idle thought", 0.07);
        for _ in 0..60 {
            gw.tick();
        }
        assert!(
            gw.broadcast.is_none() || gw.is_empty(),
            "workspace should be empty after extended decay"
        );
    }

    #[test]
    fn test_dominant_module_tracks_winner() {
        let mut gw = GlobalWorkspace::new();
        gw.post("amygdala", "fear signal", 0.3);
        gw.post(
            "episodic",
            "vivid memory: Ryan said this was important",
            0.9,
        );
        gw.tick();
        assert_eq!(
            gw.dominant_module(),
            Some("episodic"),
            "episodic (highest salience) should dominate"
        );
    }
}

// KAI v6.0.0
