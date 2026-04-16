/// Universe — The cell store for KAI's memory.
///
/// Each cell is a belief: text + vector + region + strength + metadata.
/// Queries use cosine similarity against all cells (parallelizable with rayon).

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
}

/// The Universe holds all of KAI's memory cells.
#[derive(Debug, Serialize, Deserialize)]
pub struct Universe {
    cells: Vec<Cell>,
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
    pub fn query(&self, text: &str, n: usize) -> Vec<QueryHit> {
        let q = SparseVec::encode(text);
        let mut scored: Vec<(usize, f32)> = self
            .cells
            .iter()
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
            .map(|&(i, score)| {
                let cell = &self.cells[i];
                QueryHit {
                    text: cell.text.clone(),
                    region: cell.region.clone(),
                    score,
                    strength: cell.strength,
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
}

impl Default for Universe {
    fn default() -> Self {
        Self::new()
    }
}
