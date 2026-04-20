use super::shared_bus::{GpuState, StreamEvent};
use crate::core::{SparseVec, Universe};
use crossbeam_channel::{Receiver, Sender};
use rayon::prelude::*;
/// GPU Stream — Parallel vector math engine.
///
/// Uses rayon parallel iterators to compute batch cosine similarity
/// across all cells simultaneously. On a Ryzen 5 with 12 threads,
/// this can process 10K+ vectors in ~1ms.
///
/// Upgradable to CUDA/wgpu compute shaders when cell count exceeds 50K.
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// Run one tick of the GPU stream.
/// Checks for batch cosine requests and processes them in parallel.
pub fn gpu_tick(
    gpu_state: &Arc<RwLock<GpuState>>,
    rx: &Receiver<StreamEvent>,
    cpu_tx: &Sender<StreamEvent>,
    universe: &Arc<RwLock<Universe>>,
) {
    // Process any pending batch cosine requests
    while let Ok(event) = rx.try_recv() {
        match event {
            StreamEvent::BatchCosineRequest {
                query_id,
                query_vec,
            } => {
                let start = Instant::now();

                // Reconstruct the query vector
                let mut data = vec![0i8; 4096];
                for (i, &v) in query_vec.iter().enumerate().take(4096) {
                    data[i] = v;
                }
                let q = SparseVec::from_raw(data);

                // Parallel cosine computation using rayon
                let uni = universe.read().unwrap();
                let cells = uni.cells();
                let mut scores: Vec<(usize, f32)> = cells
                    .par_iter()
                    .enumerate()
                    .map(|(i, cell)| {
                        let raw = q.cosine(&cell.vec);
                        let boosted = raw * (0.5 + 0.5 * cell.strength.min(2.0));
                        (i, boosted)
                    })
                    .filter(|(_, s)| *s > 0.05)
                    .collect();

                scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                scores.truncate(10); // top 10

                let elapsed = start.elapsed();
                let batch_size = cells.len();
                drop(uni);

                // Update GPU state
                if let Ok(mut state) = gpu_state.write() {
                    state.last_batch_size = batch_size;
                    state.last_batch_duration_us = elapsed.as_micros() as u64;
                    state.cosines_per_second = if elapsed.as_secs_f64() > 0.0 {
                        batch_size as f64 / elapsed.as_secs_f64()
                    } else {
                        0.0
                    };
                    state.utilization = (elapsed.as_micros() as f32 / 1000.0).min(1.0);
                    state.last_tick = Some(Instant::now());
                }

                // Send results back to CPU
                let _ = cpu_tx.send(StreamEvent::BatchCosineResult { query_id, scores });
            }
            StreamEvent::Shutdown => return,
            _ => {}
        }
    }

    // Update tick timestamp even if no work was done
    if let Ok(mut state) = gpu_state.write() {
        state.last_tick = Some(Instant::now());
    }
}
