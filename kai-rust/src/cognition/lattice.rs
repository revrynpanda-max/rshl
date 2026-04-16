/// Dream Lattice — Consolidation through geometric binding.
///
/// Biology analog: REM sleep replay.
/// Picks two cells from different regions (or with medium overlap),
/// binds them, bundles into synthetic vector, cleans up against
/// universe to find the emergent insight, measures field quality.

use crate::core::{SparseVec, Universe, FieldState};
use super::candidates::CandidateBuffer;
use rand::Rng;

#[derive(Debug)]
pub struct DreamResult {
    pub concept_a: String,
    pub concept_b: String,
    pub region_a: String,
    pub region_b: String,
    pub overlap: f32,
    pub insight: String,
    pub insight_region: String,
    pub confidence: f32,
    pub phi_g: f32,
    pub c: f32,
    pub chi: f32,
    pub duplicate_echo: bool,
    pub is_non_source: bool,
}

/// Run one dream consolidation cycle.
pub fn consolidate(universe: &Universe) -> Option<DreamResult> {
    let cells = universe.cells();
    if cells.len() < 2 { return None; }

    // Select dream pair: medium overlap (0.18 - 0.88), prefer cross-region
    let pair = select_dream_pair(universe)?;

    let (a_idx, b_idx, overlap) = pair;
    let a = &cells[a_idx];
    let b = &cells[b_idx];

    // Bundle the two source vectors into a synthetic "dream thought"
    let synthetic = SparseVec::bundle(&[&a.vec, &b.vec]);

    // Cleanup: find what the synthetic vector most resembles
    let hits = universe.query_vec(&synthetic, 5);

    if hits.is_empty() {
        return None;
    }

    // Pick best insight (prefer non-source match)
    let (insight_text, insight_region, confidence, is_non_source) = {
        let non_source = hits.iter().find(|(cell, _)| {
            cell.text != a.text && cell.text != b.text
        });

        if let Some((cell, score)) = non_source {
            (cell.text.clone(), cell.region.clone(), *score, true)
        } else {
            let (cell, score) = &hits[0];
            (cell.text.clone(), cell.region.clone(), *score, false)
        }
    };

    let duplicate_echo = insight_text == a.text || insight_text == b.text;

    // Compute local field state for this dream
    let field = FieldState::compute(universe);

    // Compute commit readiness (C = phi_g × (1 - chi) × confidence)
    let c = field.phi_g * (1.0 - field.pressure) * confidence;

    Some(DreamResult {
        concept_a: a.text.clone(),
        concept_b: b.text.clone(),
        region_a: a.region.clone(),
        region_b: b.region.clone(),
        overlap,
        insight: insight_text,
        insight_region,
        confidence,
        phi_g: field.phi_g,
        c,
        chi: field.pressure,
        duplicate_echo,
        is_non_source,
    })
}

/// Feed a dream result into the candidate buffer.
pub fn observe_dream(buffer: &mut CandidateBuffer, dream: &DreamResult) {
    if dream.duplicate_echo { return; }
    if dream.insight.is_empty() { return; }

    buffer.observe(
        &dream.insight,
        dream.phi_g,
        dream.c,
        dream.chi,
        dream.confidence,
        dream.is_non_source,
    );
}

/// Select a dream pair with medium overlap, preferring cross-region.
fn select_dream_pair(universe: &Universe) -> Option<(usize, usize, f32)> {
    let cells = universe.cells();
    if cells.len() < 2 { return None; }

    let mut rng = rand::thread_rng();
    let mut best: Option<(usize, usize, f32, f32)> = None; // (i, j, overlap, score)

    // Sample pairs (limit to avoid O(n²) explosion)
    let sample_limit = cells.len().min(20);
    let indices: Vec<usize> = if cells.len() <= 20 {
        (0..cells.len()).collect()
    } else {
        let mut v = Vec::new();
        while v.len() < sample_limit {
            let idx = rng.gen_range(0..cells.len());
            if !v.contains(&idx) { v.push(idx); }
        }
        v
    };

    for i in 0..indices.len() {
        for j in (i + 1)..indices.len() {
            let ai = indices[i];
            let bi = indices[j];
            let overlap = cells[ai].vec.cosine(&cells[bi].vec).abs();

            // Medium overlap band: 0.18 to 0.88
            if overlap < 0.18 || overlap > 0.88 { continue; }

            // Score: prefer overlap near 0.52, cross-region, mid-strength
            let target_band = 1.0 - (overlap - 0.52).abs();
            let cross_region = if cells[ai].region != cells[bi].region { 0.12 } else { 0.0 };
            let dup_penalty = if overlap > 0.72 { (overlap - 0.72) * 0.65 } else { 0.0 };
            let pair_score = target_band * 0.60 + cross_region - dup_penalty;

            if best.is_none() || pair_score > best.unwrap().3 {
                best = Some((ai, bi, overlap, pair_score));
            }
        }
    }

    best.map(|(i, j, overlap, _)| (i, j, overlap))
}
