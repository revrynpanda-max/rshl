use super::shared_bus::{RamState, StreamEvent};
use crate::core::{Universe, SynapticLayer};
use crate::core::gpu_compute::GpuCompute;
use crate::core::boid_engine::{BoidState, BoidSettings, run_boid_iteration, find_near_duplicates};
use crossbeam_channel::{Receiver, Sender};
use rayon::prelude::*;
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// Run one tick of the RAM stream.
pub fn ram_tick(
    ram_state: &Arc<RwLock<RamState>>,
    rx: &Receiver<StreamEvent>,
    cpu_tx: &Sender<StreamEvent>,
    universe: &Arc<RwLock<Universe>>,
    synaptic_layer: &Arc<RwLock<SynapticLayer>>,
    gpu: &Option<Arc<GpuCompute>>,
) {
    let mut changed = false;

    while let Ok(event) = rx.try_recv() {
        match event {
            StreamEvent::StoreCell { text, region, source, strength } => {
                if let Ok(mut uni) = universe.write() {
                    uni.ingest_and_verify(&text, &region, &source, strength);
                    changed = true;
                }
            }
            StreamEvent::ReinforceCell { cell_text, delta } => {
                if let Ok(mut uni) = universe.write() {
                    if let Some(cell) = uni.cells_mut().iter_mut().find(|c| c.claim.text == cell_text) {
                        cell.claim.confidence = (cell.claim.confidence + delta).min(5.0);
                        changed = true;
                    }
                }
            }
            StreamEvent::HomeostasisRequest { field } => {
                let start = Instant::now();
                let mut uni = universe.write().unwrap();

                // 1. Biological Pruning
                let pruned_v = uni.recycle_dead_claims();

                // 2. Synaptic pruning (LTD)
                synaptic_layer.write().unwrap().ltd_sweep();

                // 3. GPU-Accelerated Boid Homeostasis (Exact Ternary N×N)
                let total_cells = uni.cell_count();
                if total_cells >= 10 {
                    let cells_snapshot: Vec<crate::core::SparseVec> = uni
                        .get_cells()
                        .iter()
                        .map(|c| c.claim.vec.clone())
                        .collect();
                    let is_anchor: Vec<bool> = uni
                        .get_cells()
                        .iter()
                        .map(|c| c.claim.confidence >= 3.5)
                        .collect();

                    // ── GPU path: Ternary bitpack exact N×N ──────────────────
                    let new_vecs: Vec<Vec<i8>> = if let Some(ref g) = *gpu {
                        let result = pollster::block_on(g.run_boid_forces(
                            &cells_snapshot,
                            3,  // sep_weight
                            2,  // coh_weight
                            10, // anchor_weight
                        ));

                        // Threshold bundle_sums back to ternary using Rayon
                        let words = crate::core::sparse_vec::DIM / 32;
                        cells_snapshot
                            .par_iter()
                            .enumerate()
                            .map(|(i, orig)| {
                                if is_anchor[i] { return orig.data.clone(); }
                                let start_idx = i * words;
                                let slice = &result.bundle_sums[start_idx .. start_idx + words];
                                crate::core::gpu_compute::threshold_bundle(slice, total_cells)
                            })
                            .collect()
                    } else {
                        // ── CPU fallback: Rayon-parallel dot products ────────────
                        let mut state = BoidState::from_universe(&uni);
                        let settings = BoidSettings::default();
                        for _ in 0..3 {
                            run_boid_iteration(&mut state, &settings, &field);
                        }
                        state.positions.iter().enumerate().map(|(i, pos)| {
                            if is_anchor[i] { return cells_snapshot[i].data.clone(); }
                            let orig = &cells_snapshot[i].data;
                            let target_nnz = (crate::core::sparse_vec::DIM as f32 * 0.04) as usize;
                            let mut acc: Vec<(usize, i32)> = orig.iter().enumerate()
                                .map(|(k, &v)| (k, v as i32 * 100 + (pos[k] * 50.0) as i32))
                                .collect();
                            acc.sort_unstable_by(|a, b| b.1.abs().cmp(&a.1.abs()));
                            let mut out = vec![0i8; crate::core::sparse_vec::DIM];
                            for j in 0..target_nnz {
                                let (idx, val) = acc[j];
                                out[idx] = if val > 0 { 1 } else { -1 };
                            }
                            out
                        }).collect()
                    };

                    // Write updated vectors back to universe
                    let cells = uni.get_cells_mut();
                    for (i, new_data) in new_vecs.into_iter().enumerate() {
                        if i >= cells.len() || is_anchor[i] { continue; }
                        cells[i].claim.vec = crate::core::SparseVec::from_raw(new_data);
                    }

                    let _dupes = find_near_duplicates(&BoidState::from_universe(&uni));
                    let elapsed = start.elapsed();
                    if let Ok(mut rs) = ram_state.write() {
                        rs.last_prune = Some(Instant::now());
                    }
                    let _ = cpu_tx.send(StreamEvent::CellCountUpdate { count: total_cells });
                }
                changed = true;
            }
            StreamEvent::Shutdown => return,
            _ => {}
        }
    }

    if changed {
        if let Ok(uni) = universe.read() {
            let _ = cpu_tx.send(StreamEvent::CellCountUpdate { count: uni.count() });
        }
    }

    if let Ok(mut state) = ram_state.write() {
        if let Ok(uni) = universe.read() {
            state.cell_count = uni.count();
        }
    }
}
