/// Multi-Cell Composition — KAI's response generation.
///
/// This is the RSHL equivalent of next-token generation.
/// Instead of predicting tokens statistically, KAI walks through
/// the top-N resonating cells and composes a response by extracting
/// the most relevant information from each.
///
/// This is NOT hallucination — every piece of output comes from
/// a real cell in the universe. It's geometric synthesis.

use crate::core::QueryHit;

/// Compose a response from the top resonating cells.
///
/// Strategy:
/// 1. Take top-K hits from the query
/// 2. Extract unique information from each cell
/// 3. Order by relevance (score × strength)
/// 4. Build response with attribution
pub fn compose_response(
    hits: &[QueryHit],
    _query_text: &str,
    max_cells: usize,
) -> ComposedResponse {
    if hits.is_empty() {
        return ComposedResponse {
            text: "Nothing resonates with that query. My universe doesn't contain relevant knowledge yet.".into(),
            sources: Vec::new(),
            confidence: 0.0,
            depth: 0,
        };
    }

    let effective = hits.iter().take(max_cells).collect::<Vec<_>>();

    // If only one strong hit, return it directly
    if effective.len() == 1 || (effective[0].score > 0.6 && effective.len() < 2) {
        let hit = &effective[0];
        return ComposedResponse {
            text: hit.text.clone(),
            sources: vec![Source {
                text: hit.text.clone(),
                region: hit.region.clone(),
                score: hit.score,
            }],
            confidence: hit.score,
            depth: 1,
        };
    }

    // Multi-cell composition: extract key phrases from each hit
    let mut fragments: Vec<(String, f32, String)> = Vec::new(); // (text, score, region)
    let mut seen_phrases: Vec<String> = Vec::new();

    for hit in &effective {
        // Skip if this cell's content is too similar to something we already have
        let is_redundant = seen_phrases.iter().any(|existing| {
            phrase_overlap(existing, &hit.text) > 0.7
        });

        if !is_redundant {
            fragments.push((hit.text.clone(), hit.score, hit.region.clone()));
            seen_phrases.push(hit.text.clone());
        }
    }

    if fragments.is_empty() {
        let hit = &effective[0];
        return ComposedResponse {
            text: hit.text.clone(),
            sources: vec![Source {
                text: hit.text.clone(),
                region: hit.region.clone(),
                score: hit.score,
            }],
            confidence: hit.score,
            depth: 1,
        };
    }

    // Build composed response
    let avg_score: f32 = fragments.iter().map(|(_, s, _)| s).sum::<f32>() / fragments.len() as f32;

    // Primary cell text + supporting context from other cells
    let primary = &fragments[0].0;
    let sources: Vec<Source> = fragments
        .iter()
        .map(|(text, score, region)| Source {
            text: text.clone(),
            region: region.clone(),
            score: *score,
        })
        .collect();

    let depth = fragments.len();

    // If we have multiple cells, create a composed summary
    let text = if fragments.len() > 1 {
        // Lead with the strongest hit, add supporting info
        let mut composed = primary.clone();
        for (frag_text, _score, _region) in fragments.iter().skip(1) {
            // Only add if it provides new information
            let check_len = {
                let mut end = frag_text.len().min(30);
                while end > 0 && !frag_text.is_char_boundary(end) { end -= 1; }
                end
            };
            if !composed.contains(&frag_text[..check_len]) {
                composed.push_str(" — ");
                composed.push_str(frag_text);
            }
        }
        composed
    } else {
        primary.clone()
    };

    ComposedResponse {
        text,
        sources,
        confidence: avg_score,
        depth,
    }
}

/// Check word overlap between two phrases (0.0 to 1.0).
fn phrase_overlap(a: &str, b: &str) -> f32 {
    let a_words: Vec<&str> = a.split_whitespace().collect();
    let b_words: Vec<&str> = b.split_whitespace().collect();

    if a_words.is_empty() || b_words.is_empty() {
        return 0.0;
    }

    let shared = a_words.iter().filter(|w| b_words.contains(w)).count();
    let max_len = a_words.len().max(b_words.len());
    shared as f32 / max_len as f32
}

/// A composed response from multiple cells.
pub struct ComposedResponse {
    pub text: String,
    pub sources: Vec<Source>,
    pub confidence: f32,
    pub depth: usize, // how many cells contributed
}

/// A source cell that contributed to the response.
pub struct Source {
    pub text: String,
    pub region: String,
    pub score: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_empty_hits() {
        let response = compose_response(&[], "hello", 5);
        assert!(response.confidence == 0.0);
        assert!(response.depth == 0);
    }

    #[test]
    fn test_single_hit() {
        let hits = vec![QueryHit {
            text: "KAI is a geometric intelligence".into(),
            region: "memory".into(),
            score: 0.85,
            strength: 2.0,
        }];
        let response = compose_response(&hits, "what is KAI", 5);
        assert_eq!(response.depth, 1);
        assert!(response.confidence > 0.8);
    }

    #[test]
    fn test_multi_cell_composition() {
        let hits = vec![
            QueryHit {
                text: "KAI is a geometric intelligence".into(),
                region: "memory".into(),
                score: 0.85,
                strength: 2.0,
            },
            QueryHit {
                text: "KAI was created by Ryan".into(),
                region: "memory".into(),
                score: 0.72,
                strength: 2.0,
            },
        ];
        let response = compose_response(&hits, "tell me about KAI", 5);
        assert!(response.depth >= 2, "Should compose from multiple cells");
        assert!(response.text.contains("geometric"));
        assert!(response.text.contains("Ryan"));
    }

    #[test]
    fn test_phrase_overlap() {
        assert!(phrase_overlap("the cat sat", "the cat sat") > 0.99);
        assert!(phrase_overlap("hello world", "goodbye moon") < 0.01);
        assert!(phrase_overlap("the big dog", "the small dog") > 0.3);
    }
}
