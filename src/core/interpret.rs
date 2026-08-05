use crate::core::Universe;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;

pub struct SemanticFeatureMap {
    /// Dimension index (0..16384) -> Top N associated words
    pub dim_to_words: Vec<Vec<String>>,
}

impl SemanticFeatureMap {
    pub fn build_from_data(data: Vec<(String, crate::core::SparseVec)>) -> Self {
        let total_cells = data.len() as f32;

        let mut dim_word_counts: Vec<HashMap<String, u32>> = vec![HashMap::new(); 16384];
        let mut document_frequency: HashMap<String, u32> = HashMap::new();

        // Pass 1: Parse words in parallel (heaviest text processing)
        let parsed_data: Vec<(Vec<String>, HashSet<String>, Vec<usize>)> = data.into_par_iter().map(|(text, vec)| {
            let words: Vec<String> = text
                .split(|c: char| !c.is_alphanumeric())
                .filter(|w| w.len() > 4) // ignore short words like "the", "and"
                .map(|w| w.to_lowercase())
                .collect();
            let unique_words: HashSet<String> = words.iter().cloned().collect();
            let dims: Vec<usize> = vec.iter().filter_map(|(d, _)| if d < 16384 { Some(d as usize) } else { None }).collect();
            (words, unique_words, dims)
        }).collect();

        // Pass 1.5: Fast sequential reduction
        for (words, unique_words, dims) in parsed_data {
            for w in unique_words {
                *document_frequency.entry(w).or_insert(0) += 1;
            }
            for dim in dims {
                for w in &words {
                    *dim_word_counts[dim].entry(w.clone()).or_insert(0) += 1;
                }
            }
        }

        // Pass 2: Calculate TF-IDF and select top words per dimension in parallel (16384 dimensions)
        let dim_to_words: Vec<Vec<String>> = dim_word_counts.into_par_iter().map(|dwc| {
            let mut word_scores: Vec<(String, f32)> = dwc
                .into_iter()
                .map(|(word, count)| {
                    let tf = count as f32;
                    let df = *document_frequency.get(&word).unwrap_or(&1) as f32;
                    let idf = (total_cells / df).ln();
                    let tf_idf = tf * idf;
                    (word, tf_idf)
                })
                .collect();
                
            // Sort descending by score
            word_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            
            // Take top 3
            word_scores.into_iter().take(3).map(|(w, _)| w).collect()
        }).collect();
        
        println!("[Interpretability] Semantic Feature Map built successfully.");

        Self { dim_to_words }
    }

    /// Explain a given SparseVec by its most active semantic features.
    pub fn interpret_vector(&self, vec: &crate::core::SparseVec) -> Vec<String> {
        let mut active_concepts = HashMap::new();
        
        for (dim, val) in vec.iter() {
            if dim < 16384 {
                // If the value is negative, we might want to flag it as "Anti-concept",
                // but for general visualization, we'll just show the concept it aligns with.
                let strength = (val as f32).abs();
                for word in &self.dim_to_words[dim] {
                    *active_concepts.entry(word.clone()).or_insert(0.0) += strength;
                }
            }
        }
        
        let mut sorted_concepts: Vec<(String, f32)> = active_concepts.into_iter().collect();
        sorted_concepts.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        
        // Return top 15 concepts
        sorted_concepts.into_iter().take(15).map(|(w, _)| w).collect()
    }
}

pub static GLOBAL_FEATURE_MAP: std::sync::OnceLock<Arc<RwLock<Option<SemanticFeatureMap>>>> = std::sync::OnceLock::new();

/// Guard to prevent multiple parallel feature-map rebuilds from thrashing CPU.
pub static BUILD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

pub fn get_feature_map() -> Arc<RwLock<Option<SemanticFeatureMap>>> {
    GLOBAL_FEATURE_MAP.get_or_init(|| Arc::new(RwLock::new(None))).clone()
}

/// Helper to trigger a rebuild of the map in a background thread.
/// Returns `true` if a new build was started, `false` if one is already running.
pub fn rebuild_feature_map(universe_mtx: Arc<std::sync::RwLock<Universe>>) -> bool {
    if BUILD_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        println!("[Interpretability] Build already in progress — ignoring duplicate request.");
        return false;
    }

    std::thread::spawn(move || {
        println!("[Interpretability] Extracting cell data for Feature Map...");
        let mut extracted_data = Vec::new();
        {
            let u = universe_mtx.read().unwrap_or_else(|e| e.into_inner());
            let cells = u.cells();
            extracted_data.reserve(cells.len());
            for cell in cells {
                extracted_data.push((cell.claim.text.clone(), cell.claim.vec.clone()));
            }
        }
        println!("[Interpretability] Universe lock released. Building map...");

        let map = SemanticFeatureMap::build_from_data(extracted_data);
        let lock = get_feature_map();
        let mut writer = lock.write().unwrap();
        *writer = Some(map);
        BUILD_IN_PROGRESS.store(false, Ordering::SeqCst);
        println!("[Interpretability] Semantic Feature Map built and active.");
    });
    true
}
