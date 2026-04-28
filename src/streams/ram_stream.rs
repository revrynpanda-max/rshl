use super::shared_bus::{RamState, StreamEvent};
use crate::core::Universe;
use crossbeam_channel::{Receiver, Sender};
/// RAM Stream — Memory management, persistence, intake.
///
/// Owns all mutations to the universe. Single writer ensures
/// no data races. Handles storage, pruning, homeostasis,
/// and background fact ingestion.
use std::sync::{Arc, RwLock};
use std::time::Instant;

/// Run one tick of the RAM stream.
pub fn ram_tick(
    ram_state: &Arc<RwLock<RamState>>,
    rx: &Receiver<StreamEvent>,
    cpu_tx: &Sender<StreamEvent>,
    universe: &Arc<RwLock<Universe>>,
) {
    let mut changed = false;

    // Process incoming events
    while let Ok(event) = rx.try_recv() {
        match event {
            StreamEvent::StoreCell {
                text,
                region,
                source,
                strength,
            } => {
                if let Ok(mut uni) = universe.write() {
                    uni.ingest_and_verify(&text, &region, &source, strength);
                    changed = true;
                }
            }
            StreamEvent::ReinforceCell { cell_text, delta } => {
                if let Ok(mut uni) = universe.write() {
                    if let Some(cell) = uni
                        .cells_mut()
                        .iter_mut()
                        .find(|c| c.claim.text == cell_text)
                    {
                        cell.claim.confidence = (cell.claim.confidence + delta).min(5.0);
                        changed = true;
                    }
                }
            }
            StreamEvent::Shutdown => return,
            _ => {}
        }
    }

    // Notify CPU of cell count changes
    if changed {
        if let Ok(uni) = universe.read() {
            let _ = cpu_tx.send(StreamEvent::CellCountUpdate { count: uni.count() });
        }
    }

    // Update RAM state
    if let Ok(mut state) = ram_state.write() {
        if let Ok(uni) = universe.read() {
            state.cell_count = uni.count();
        }
        state.last_tick = Some(Instant::now());
    }
}
