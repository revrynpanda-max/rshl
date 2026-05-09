use roaring::RoaringBitmap;
use std::collections::HashMap;
use serde::{Serialize, Deserialize};

/// A fast lexical inverted index using RoaringBitmaps.
/// Maps keywords and metadata tags to lists of Cell IDs.
#[derive(Default, Clone, Serialize, Deserialize, Debug)]
pub struct LatticeLexicon {
    /// Inverted index for keywords (lowercase, stemmed tokens)
    keywords: HashMap<String, RoaringBitmap>,
    /// Metadata tags (e.g., "userId:taz", "region:identity")
    tags: HashMap<String, RoaringBitmap>,
}

impl LatticeLexicon {
    pub fn new() -> Self {
        Self::default()
    }

    /// Index a cell's text and metadata.
    pub fn index_cell(&mut self, id: u32, text: &str, tag_list: &[String]) {
        // Index keywords
        let tokens = self.tokenize(text);
        for token in tokens {
            self.keywords.entry(token).or_default().insert(id);
        }
        // Index tags
        for tag in tag_list {
            self.tags.entry(tag.clone()).or_default().insert(id);
        }
    }

    /// Query the lexicon for IDs matching keywords and tags.
    pub fn get_matches(&self, query_text: &str, filter_tags: &[String]) -> RoaringBitmap {
        let mut result = RoaringBitmap::new();
        
        // 1. Get keyword matches
        let tokens = self.tokenize(query_text);
        if !tokens.is_empty() {
            let mut kw_results = RoaringBitmap::new();
            let mut first = true;
            for token in tokens {
                if let Some(bitmap) = self.keywords.get(&token) {
                    if first {
                        kw_results = bitmap.clone();
                        first = false;
                    } else {
                        // Intersection: must have all keywords (standard search behavior)
                        kw_results &= bitmap;
                    }
                }
            }
            result = kw_results;
        }

        // 2. Apply tag filters (Intersection)
        if !filter_tags.is_empty() {
            let mut tag_mask = RoaringBitmap::new();
            let mut first = true;
            for tag in filter_tags {
                if let Some(bitmap) = self.tags.get(tag) {
                    if first {
                        tag_mask = bitmap.clone();
                        first = false;
                    } else {
                        tag_mask &= bitmap;
                    }
                }
            }
            
            if result.is_empty() && self.tokenize(query_text).is_empty() {
                // If query is empty but we have tags, return all tagged items
                result = tag_mask;
            } else {
                result &= tag_mask;
            }
        }

        result
    }

    fn tokenize(&self, text: &str) -> Vec<String> {
        // Basic tokenization for now (lowercase, alphanumeric, len >= 3)
        text.to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|s| s.len() >= 3)
            .map(|s| s.to_string())
            .collect()
    }
}
