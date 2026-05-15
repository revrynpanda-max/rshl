use super::shared_bus::{GpuState, StreamEvent};
use crate::core::{SparseVec, Universe, gpu_compute::GpuCompute};
use crate::cognition::lattice;
use crossbeam_channel::{Receiver, Sender};
use rayon::prelude::*;
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// Run one tick of the GPU stream.
/// Checks for batch cosine requests and dream batch requests.
pub fn gpu_tick(
    gpu_state: &Arc<RwLock<GpuState>>,
    rx: &Receiver<StreamEvent>,
    cpu_tx: &Sender<StreamEvent>,
    universe: &Arc<RwLock<Universe>>,
    gpu_compute: &Option<Arc<GpuCompute>>,
) {
    // Process any pending requests
    while let Ok(event) = rx.try_recv() {
        match event {
            StreamEvent::BatchCosineRequest {
                query_id,
                query_vec,
            } => {
                let start = Instant::now();
                let mut data = vec![0i8; crate::core::sparse_vec::DIM];
                data.copy_from_slice(&query_vec);
                let q = SparseVec::from_raw(data);

                let uni = universe.read().unwrap();
                
                // Use GPU if available, otherwise Rayon
                let scores = if let Some(gpu) = gpu_compute {
                    let cells = uni.cells();
                    let target_vecs: Vec<&SparseVec> = cells.iter().map(|c| &c.claim.vec).collect();
                    // Note: In a real high-load scenario, we would chunk this
                    let raw_scores = pollster::block_on(gpu.batch_cosine(&q, &target_vecs));
                    
                    raw_scores.into_iter().enumerate().map(|(i, s)| {
                         let boosted = s * (0.5 + 0.5 * cells[i].claim.confidence.min(2.0));
                         (i, boosted)
                    })
                    .filter(|(_, s)| *s > 0.05)
                    .collect()
                } else {
                    uni.cells()
                        .par_iter()
                        .enumerate()
                        .map(|(i, cell)| {
                            let raw = q.cosine(&cell.claim.vec);
                            let boosted = raw * (0.5 + 0.5 * cell.claim.confidence.min(2.0));
                            (i, boosted)
                        })
                        .filter(|(_, s)| *s > 0.05)
                        .collect()
                };

                let mut final_scores: Vec<(usize, f32)> = scores;
                final_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
                final_scores.truncate(10);

                let elapsed = start.elapsed();
                let batch_size = uni.cell_count();
                drop(uni);

                update_gpu_state(gpu_state, batch_size, elapsed);
                let _ = cpu_tx.send(StreamEvent::BatchCosineResult { query_id, scores: final_scores });
            }

            StreamEvent::DreamBatchRequest { count } => {
                let start = Instant::now();
                let uni = universe.read().unwrap();
                
                // Smarter HNSW-driven batching
                let dreams = lattice::consolidate_batch(&uni, count);
                let batch_size = dreams.len();
                
                // Convert dreams to summary strings for the CPU stream to process
                // (In a fuller refactor, we'd pass the structs)
                let mut results = Vec::new();
                for dream in dreams {
                    // Serialize dream into a format the CPU can use to apply mutations
                    // Format: "DREAM|concept_a|concept_b|overlap|phi_g|chi|insight|strength|synthesis_text"
                    let syn_text = dream.synthesis.as_ref().map(|s| s.text.as_str()).unwrap_or("");
                    let res = format!(
                        "DREAM|{}|{}|{}|{}|{}|{}|{}|{}",
                        dream.concept_a, dream.concept_b, dream.overlap,
                        dream.phi_g, dream.chi, dream.insight, dream.strength,
                        syn_text
                    );
                    results.push(res);
                }

                let elapsed = start.elapsed();
                drop(uni);

                update_gpu_state(gpu_state, batch_size, elapsed);
                let _ = cpu_tx.send(StreamEvent::DreamBatchResult { results });
            }

            StreamEvent::Shutdown => return,
            _ => {}
        }
    }
}

fn update_gpu_state(gpu_state: &Arc<RwLock<GpuState>>, batch_size: usize, elapsed: std::time::Duration) {
    if let Ok(mut state) = gpu_state.write() {
        state.last_batch_size = batch_size;
        state.last_batch_duration_us = elapsed.as_micros() as u64;
        state.cosines_per_second = if elapsed.as_secs_f64() > 0.0 {
            batch_size as f64 / elapsed.as_secs_f64()
        } else {
            0.0
        };
        // 1000us baseline for 100% "utilization" in TUI terms
        state.utilization = (elapsed.as_micros() as f32 / 1000.0).min(1.0);
        state.gpu_load = (state.utilization * 100.0).min(100.0);
        state.last_tick = Some(Instant::now());
    }
}
