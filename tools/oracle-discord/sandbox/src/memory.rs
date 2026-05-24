//! SynapticLayer – Hebbian Long-Term Potentiation / Long-Term Depression.
//! 7‑region topological memory with yield points during large updates.

use crate::lattice::SHOULD_ABORT;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tokio::time::Duration;

/// Number of memory regions in the topology.
const REGIONS: usize = 7;

/// A single memory region containing a matrix of synaptic weights.
#[derive(Clone, Serialize, Deserialize)]
pub struct Region {
    weights: Vec<Vec<f64>>,
    size: usize,
}

impl Region {
    fn new(size: usize) -> Self {
        let weights = vec![vec![0.5; size]; size];
        Self { weights, size }
    }
}

/// The 7‑region synaptic layer.
pub struct SynapticLayer {
    regions: Vec<Region>,
    pub plasticity_rate: f64,
}

impl SynapticLayer {
    pub fn new(region_size: usize) -> Self {
        let regions = (0..REGIONS)
            .map(|_| Region::new(region_size))
            .collect();
        Self {
            regions,
            plasticity_rate: 0.01,
        }
    }

    /// Run a full Hebbian update across all regions with yield points.
    pub async fn update(&mut self, input: &Vec<f64>) {
        SHOULD_ABORT.store(false, std::sync::atomic::Ordering::Relaxed);

        for (idx, region) in self.regions.iter_mut().enumerate() {
            if SHOULD_ABORT.load(Ordering::Relaxed) {
                break;
            }

            // Process region in chunks to allow yield
            let chunk_size = region.size.max(1);
            for start_row in (0..region.size).step_by(chunk_size) {
                let end_row = (start_row + chunk_size).min(region.size);
                for row in start_row..end_row {
                    for col in 0..region.size {
                        // Hebbian rule: weight change proportional to pre‑synaptic * post‑synaptic
                        let delta = self.plasticity_rate * input[row] * input[col];
                        region.weights[row][col] =
                            (region.weights[row][col] + delta).clamp(-1.0, 1.0);
                    }
                }

                // Yield after each chunk
                tokio::task::yield_now().await;
                if SHOULD_ABORT.load(Ordering::Relaxed) {
                    return;
                }
            }
        }
    }

    /// Perform a constrained LTD step (depression) for pattern separation.
    pub async fn depress(&mut self, region_idx: usize, scale: f64) {
        if region_idx >= REGIONS {
            return;
        }
        let region = &mut self.regions[region_idx];
        let size = region.size;
        let chunk = size / 8;
        for start in (0..size).step_by(chunk) {
            let end = (start + chunk).min(size);
            for row in region.weights[start..end].iter_mut() {
                for w in row.iter_mut() {
                    *w = (*w - scale * *w).clamp(-1.0, 1.0);
                }
            }
            tokio::task::yield_now().await;
        }
    }
}
