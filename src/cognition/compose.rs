use crate::core::{Lexicon, QueryHit, SparseVec};

pub fn compose_response(
    hits: &[QueryHit],
    lexicon: &Lexicon,
    max_cells: usize,
) -> ComposedResponse {
    if hits.is_empty() {
        return ComposedResponse {
            text: "Nothing resonates. My universe is silent.".into(),
            sources: Vec::new(),
            confidence: 0.0,
            depth: 0,
        };
    }

    let vecs: Vec<&SparseVec> = hits.iter().take(max_cells).map(|h| &h.vec).collect();
    let superposed = SparseVec::superpose_sparse(&vecs, 0.04);

    // THE GENERATIVE HEAD: Decode the superposed geometric state into a sequence
    let tokens = lexicon.decode_to_sequence(&superposed, 24);
    let text = tokens.join(" ");

    let sources: Vec<Source> = hits
        .iter()
        .take(max_cells)
        .map(|h| Source {
            label: "Geometric Cluster".into(),
            region: h.region.clone(),
            score: h.score,
        })
        .collect();

    ComposedResponse {
        text,
        sources,
        confidence: hits[0].score,
        depth: hits.len(),
    }
}

pub struct ComposedResponse {
    pub text: String,
    pub sources: Vec<Source>,
    pub confidence: f32,
    pub depth: usize,
}

pub struct Source {
    pub label: String,
    pub region: String,
    pub score: f32,
}

// KAI v6.0.0
