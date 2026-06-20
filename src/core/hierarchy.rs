//! Fractal Hierarchy Builder — Fast keyword-based auto-clustering.
//!
//! Instead of O(N²) cosine comparisons (too slow for 300K+ cells),
//! we cluster by dominant keyword overlap — O(N) with hash maps.
//!
//! Steps:
//!   1. Extract top 3 keywords from each cell's text.
//!   2. Hash them into a signature string.
//!   3. Group cells with identical signatures.
//!   4. Create parent cells from groups of size >= MIN_GROUP_SIZE.
//!
//! RAM: Child text is truncated to 60-char micro-labels when text_store is active.

use crate::core::{Cell, SparseVec, Universe};
use crate::core::claim::{Claim, LAYER_CELLULAR, LAYER_ORGAN, LAYER_BODY};
use std::sync::Arc;

const MIN_GROUP_SIZE: usize = 5;
const MAX_GROUP_SIZE: usize = 30;

pub struct HierarchyBuilder;

fn keyword_signature(text: &str) -> String {
    let words: Vec<String> = text
        .split_whitespace()
        .map(|w| w.to_lowercase().trim_matches(|c: char| !c.is_alphanumeric()).to_string())
        .filter(|w| w.len() > 3 && w.len() < 20)
        .filter(|w| !is_stop_word(w))
        .collect();

    // Take first 3 meaningful words as signature
    let mut sig = Vec::with_capacity(3);
    for w in words {
        if !sig.contains(&w) {
            sig.push(w);
            if sig.len() >= 3 { break; }
        }
    }
    sig.sort();
    sig.join("")
}

fn is_stop_word(w: &str) -> bool {
    const STOP: &[&str] = &["the", "and", "for", "are", "but", "not", "you", "all", "can",
        "had", "her", "was", "one", "our", "out", "day", "get", "has", "him", "his", "how",
        "its", "may", "new", "now", "old", "see", "two", "way", "who", "boy", "did", "she",
        "use", "her", "him", "too", "any", "say", "man", "try", "ask", "end", "why", "let",
        "put", "say", "she", "try", "way", "own", "say", "too", "old", "tell", "very", "when",
        "come", "here", "just", "like", "long", "make", "many", "over", "such", "take", "than",
        "them", "well", "were", "with", "have", "from", "they", "know", "want", "been", "good",
        "much", "some", "time", "very", "when", "come", "here", "just", "like", "long", "make"];
    STOP.contains(&w)
}

impl HierarchyBuilder {
    /// Build one layer of parent cells from existing leaf cells.
    pub fn build_layer(universe: &mut Universe, child_layer: u8, parent_layer: u8) -> usize {
        // Collect unparented leaf cells at child_layer
        let leaf_indices: Vec<usize> = universe.cells()
            .iter()
            .enumerate()
            .filter(|(_, c)| c.claim.layer == child_layer && c.parent.is_none())
            .map(|(i, _)| i)
            .collect();

        if leaf_indices.len() < MIN_GROUP_SIZE {
            println!("hierarchy: not enough leaf cells ({} < {})", leaf_indices.len(), MIN_GROUP_SIZE);
            return 0;
        }

        // Group by keyword signature — O(N)
        let mut buckets: std::collections::HashMap<String, Vec<usize>> = std::collections::HashMap::new();
        for &idx in &leaf_indices {
            let text = &universe.cells()[idx].claim.text;
            let sig = keyword_signature(text);
            if !sig.is_empty() {
                buckets.entry(sig).or_default().push(idx);
            }
        }

        let mut parents_created = 0;
        let text_store_active = universe.text_store.is_some();

        for (_sig, group) in buckets {
            if group.len() < MIN_GROUP_SIZE {
                continue;
            }
            let group = group.into_iter().take(MAX_GROUP_SIZE).collect::<Vec<_>>();

            // Build parent vector = superposition of children
            let mut child_refs: Vec<&SparseVec> = Vec::with_capacity(group.len());
            let mut total_confidence = 0.0f32;
            let mut top_texts: Vec<(f32, String)> = Vec::with_capacity(group.len());
            let mut region_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

            for &child_idx in &group {
                let child = &universe.cells()[child_idx];
                child_refs.push(&child.claim.vec);
                total_confidence += child.claim.confidence;
                let text = if child.label.is_empty() {
                    child.claim.text.clone()
                } else {
                    child.label.clone()
                };
                top_texts.push((child.claim.confidence, text));
                *region_counts.entry(child.region.to_string()).or_insert(0) += 1;
            }
            let parent_vec = SparseVec::bundle(&child_refs);

            // Synthesize label from top 5 children by confidence
            top_texts.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            let label_parts: Vec<String> = top_texts.iter().take(5).map(|(_, t)| {
                if t.len() > 40 { format!("{}…", &t[..40]) } else { t.clone() }
            }).collect();
            let label = label_parts.join("; ");
            let synthetic_text = format!("Cluster: {}", label);

            let avg_confidence = total_confidence / group.len() as f32;
            let dominant_region = region_counts.into_iter()
                .max_by_key(|&(_, count)| count)
                .map(|(r, _)| r)
                .unwrap_or_else(|| "memory".to_string());

            let parent_idx = universe.cells().len();

            let mut claim = Claim::new(&synthetic_text, "hierarchy-cluster", avg_confidence.min(3.0), parent_vec.clone());
            claim.layer = parent_layer;

            let res_sig = crate::core::universe::compute_resonance_signature(parent_layer, "", "hierarchy-cluster", &dominant_region);

            let parent_cell = Cell {
                label: synthetic_text.clone(),
                region: Arc::from(dominant_region),
                claim,
                continuation: None,
                last_fired: 0,
                convergence_score: 2.0,
                nnz: parent_vec.nnz() as u32,
                pos_vec: SparseVec::zero(),
                children: group.iter().map(|&i| i as u32).collect(),
                parent: None,
                text_id: parent_idx as u32,
                is_archived: false,
                activation_heat: 0.0,
                resonance_signature: res_sig,
            };

            universe.cells_mut().push(parent_cell);

            // Link children to parent, truncate text if text_store is active
            for &child_idx in &group {
                let cell = &mut universe.cells_mut()[child_idx];
                cell.parent = Some(parent_idx as u32);
                if text_store_active {
                    let micro = if cell.label.is_empty() {
                        if cell.claim.text.len() > 60 {
                            format!("{}…", &cell.claim.text[..60])
                        } else {
                            cell.claim.text.clone()
                        }
                    } else {
                        if cell.label.len() > 60 {
                            format!("{}…", &cell.label[..60])
                        } else {
                            cell.label.clone()
                        }
                    };
                    cell.claim.text = micro;
                }
            }

            parents_created += 1;
        }

        println!("hierarchy: built {} parent cells at layer {} from {} leaf cells",
            parents_created, parent_layer, leaf_indices.len());
        parents_created
    }

    /// Full build: Layer 1 → Layer 2 → Layer 3 → Layer 4.
    pub fn build_full(universe: &mut Universe) -> usize {
        let mut total = 0;
        total += Self::build_layer(universe, 1, 2);
        if total > 0 {
            total += Self::build_layer(universe, 2, 3);
        }
        if total > 0 {
            total += Self::build_layer(universe, 3, 4);
        }
        total
    }
}
