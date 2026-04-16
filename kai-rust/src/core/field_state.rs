/// Field State — Emergence metrics for KAI's cognitive field.
///
/// Computes:
///   Φg — Global emergence (how much the field "knows")
///   C  — Coherence (agreement between regions)
///   M  — Semantic mass (weighted significance)  
///   Pr — Contradiction pressure (disagreement, drives curiosity)

use super::Universe;

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct FieldState {
    pub phi_g: f32,
    pub coherence: f32,
    pub mass: f32,
    pub pressure: f32,
}

impl FieldState {
    /// Compute the full field state from the universe.
    pub fn compute(universe: &Universe) -> Self {
        let cells = universe.cells();
        if cells.is_empty() {
            return Self::default();
        }

        let n = cells.len() as f32;

        // Φg — emergence: average interconnectedness
        // Sample pairs, compute average similarity
        let mut phi_sum = 0.0f32;
        let mut phi_count = 0u32;
        let sample_limit = 50.min(cells.len());
        for i in 0..sample_limit {
            for j in (i + 1)..sample_limit.min(i + 10) {
                let sim = cells[i].vec.cosine(&cells[j].vec).abs();
                phi_sum += sim;
                phi_count += 1;
            }
        }
        let phi_g = if phi_count > 0 {
            phi_sum / phi_count as f32
        } else {
            0.0
        };

        // C — coherence: how aligned are cells within same region
        let regions = universe.region_counts();
        let mut coh_sum = 0.0f32;
        let mut coh_count = 0u32;
        for region in regions.keys() {
            let rcells: Vec<_> = cells.iter().filter(|c| c.region == *region).collect();
            for i in 0..rcells.len().min(10) {
                for j in (i + 1)..rcells.len().min(10) {
                    coh_sum += rcells[i].vec.cosine(&rcells[j].vec).abs();
                    coh_count += 1;
                }
            }
        }
        let coherence = if coh_count > 0 {
            coh_sum / coh_count as f32
        } else {
            0.0
        };

        // M — semantic mass: sum of strengths, normalized
        let mass: f32 = cells.iter().map(|c| c.strength).sum::<f32>() / n;

        // Pr — contradiction pressure: cross-region disagreement
        let region_keys: Vec<_> = regions.keys().collect();
        let mut pr_sum = 0.0f32;
        let mut pr_count = 0u32;
        for i in 0..region_keys.len() {
            for j in (i + 1)..region_keys.len() {
                let a_cells: Vec<_> = cells.iter().filter(|c| c.region == *region_keys[i]).collect();
                let b_cells: Vec<_> = cells.iter().filter(|c| c.region == *region_keys[j]).collect();
                if let (Some(a), Some(b)) = (a_cells.first(), b_cells.first()) {
                    let sim = a.vec.cosine(&b.vec);
                    if sim < 0.0 {
                        pr_sum += sim.abs();
                        pr_count += 1;
                    }
                }
            }
        }
        let pressure = if pr_count > 0 {
            pr_sum / pr_count as f32
        } else {
            0.0
        };

        Self {
            phi_g,
            coherence,
            mass,
            pressure,
        }
    }
}
