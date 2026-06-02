pub mod compact;

use crate::cognition::{
    candidates::CandidateBuffer, EpisodicStore, GlobalWorkspace, SelfStateHub, WorkingMemory,
};
use std::io::Read;
/// Persistence — Save and restore KAI's full cognitive state.
///
/// Biology analog: Long-term memory consolidation to permanent substrate.
/// Without this, KAI has complete amnesia on every restart.
///
/// Saves: universe cells, candidate buffer, drive state, tick count.
/// Format: Hybrid — metadata as JSON, cells as compact binary + zstd.
///
/// WHY THE CHANGE: JSON stored each SparseVec as {"len":16384,"nz":[[0,1],...]}.
/// At 655 pairs per vector, each pair cost ~15 bytes in JSON. That's ~10KB per vector.
/// With 3 vectors per cell: ~30KB per cell. 17K cells = 575MB. Unacceptable.
///
/// Compact binary format: [nnz: u16] [indices: u16 x nnz] [sign flags: u8 x ceil(nnz/8)].
/// At nnz=655: 2 + 1310 + 82 = 1,394 bytes per vector. ~7x smaller than JSON.
/// Plus zstd compression: another 3-5x reduction. Final: ~2.2KB per cell.
use crate::core::Universe;
use crate::drive::Drive;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    saved_at: String,
    tick: u64,
    #[serde(default)]
    dream_count: u64,
    universe: Universe,
    candidates: CandidateBuffer,
    drive: Drive,
    #[serde(default)]
    synaptic_layer: crate::core::SynapticLayer,
}

const STATE_FILE: &str = "data/kai-state.json";
const BACKUP_FILE: &str = "data/kai-state.backup.json";
const MIND_FILE: &str = "data/kai-mind.json";
const MIND_BACKUP_FILE: &str = "data/kai-mind.backup.json";

#[derive(Clone, Serialize, Deserialize)]
pub struct MindSnapshot {
    pub version: u32,
    pub saved_at: String,
    pub working_memory: WorkingMemory,
    pub episodic: EpisodicStore,
    pub global_workspace: GlobalWorkspace,
    pub self_state_hub: SelfStateHub,
    #[serde(default)]
    pub synaptic_layer: crate::core::SynapticLayer,
}

pub struct SaveResult {
    pub ok: bool,
    pub cells: usize,
    pub candidates: usize,
    pub bytes: usize,
}

pub struct LoadResult {
    pub ok: bool,
    pub cells: usize,
    pub candidates: usize,
    pub tick: u64,
}

/// Save the full cognitive state to disk.
/// Writes legacy JSON + compact binary (full, always).
/// For delta/incremental saves, use `save_compact` with `&mut Universe`.
pub fn save(
    base_dir: &str,
    universe: &Universe,
    candidates: &CandidateBuffer,
    drive: &Drive,
    synaptic_layer: &crate::core::SynapticLayer,
    tick: u64,
    dream_count: u64,
) -> SaveResult {
    // Legacy JSON persistence is fully deprecated to save 12+ GB of disk space.
    // Route all legacy save calls to the new compressed binary `.bin.zst` format.
    save_compact_full(base_dir, universe, candidates, drive, synaptic_layer, tick, dream_count)
}

/// Save the durable parts of KAI's actual mind state.
///
/// `kai-state.json` is the lattice substrate. This sidecar is the living
/// continuity layer: short-term context, episodic memory, conscious broadcast,
/// and the integrated self-state hub.
pub fn save_mind(
    working_memory: &WorkingMemory,
    episodic: &EpisodicStore,
    global_workspace: &GlobalWorkspace,
    self_state_hub: &SelfStateHub,
    synaptic_layer: &crate::core::SynapticLayer,
    base_dir: &str,
) -> SaveResult {
    let state_path = format!("{}/{}", base_dir, MIND_FILE);
    let backup_path = format!("{}/{}", base_dir, MIND_BACKUP_FILE);

    if let Some(dir) = Path::new(&state_path).parent() {
        let _ = fs::create_dir_all(dir);
    }

    if Path::new(&state_path).exists() {
        let _ = fs::copy(&state_path, &backup_path);
    }

    let snapshot = MindSnapshot {
        version: 1,
        saved_at: chrono_now(),
        working_memory: working_memory.clone(),
        episodic: episodic.clone(),
        global_workspace: global_workspace.clone(),
        self_state_hub: self_state_hub.clone(),
        synaptic_layer: synaptic_layer.clone(),
    };

    match serde_json::to_string(&snapshot) {
        Ok(json) => {
            let tmp_path = format!("{}.tmp", state_path);
            match fs::write(&tmp_path, &json) {
                Ok(_) => {
                    if fs::rename(&tmp_path, &state_path).is_err() {
                        let _ = fs::copy(&tmp_path, &state_path);
                        let _ = fs::remove_file(&tmp_path);
                    }
                    SaveResult {
                        ok: true,
                        cells: episodic.len(),
                        candidates: working_memory.len(),
                        bytes: json.len(),
                    }
                }
                Err(_) => SaveResult {
                    ok: false,
                    cells: 0,
                    candidates: 0,
                    bytes: 0,
                },
            }
        }
        Err(_) => SaveResult {
            ok: false,
            cells: 0,
            candidates: 0,
            bytes: 0,
        },
    }
}

/// Load the durable mind continuity sidecar.
pub fn load_mind(base_dir: &str) -> Option<MindSnapshot> {
    let state_path = format!("{}/{}", base_dir, MIND_FILE);

    if !Path::new(&state_path).exists() {
        return None;
    }

    let raw = match fs::read_to_string(&state_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("persistence: failed to read {}: {}", state_path, e);
            return None;
        }
    };
    let snapshot: MindSnapshot = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("persistence: failed to deserialize {}: {}", state_path, e);
            return None;
        }
    };

    if snapshot.version != 1 {
        eprintln!(
            "persistence: mind version mismatch (found {}, expected 1)",
            snapshot.version
        );
        return None;
    }

    Some(snapshot)
}

/// Load cognitive state from disk.
/// Tries compact binary format first (fast, small), falls back to legacy JSON.
#[inline(never)]
pub fn load(base_dir: &str) -> Option<(Universe, CandidateBuffer, Drive, u64, u64, crate::core::SynapticLayer)> {
    // Try compact format first
    if let Some(result) = load_compact(base_dir) {
        println!("persistence: loaded compact format ({} cells)", result.0.cell_count());
        return Some(result);
    }

    // Fall back to legacy JSON
    let state_path = format!("{}/{}", base_dir, STATE_FILE);

    if !Path::new(&state_path).exists() {
        return None;
    }

    let raw = match fs::read_to_string(&state_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("persistence: failed to read {}: {}", state_path, e);
            return None;
        }
    };
    let snapshot: Snapshot = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("persistence: failed to parse {}: {}", state_path, e);
            return None;
        }
    };

    if snapshot.version != 2 {
        eprintln!(
            "persistence: version mismatch (found {}, expected 2)",
            snapshot.version
        );
        return None;
    }

    let mut universe = snapshot.universe;
    load_text_store(base_dir, &mut universe);

    Some((
        universe,
        snapshot.candidates,
        snapshot.drive,
        snapshot.tick,
        snapshot.dream_count,
        snapshot.synaptic_layer,
    ))
}

/// Check if saved state exists.
pub fn state_exists(base_dir: &str) -> bool {
    let legacy = Path::new(&format!("{}/{}", base_dir, STATE_FILE)).exists();
    let compact_cells = Path::new(&format!("{}/{}", base_dir, COMPACT_CELLS_FILE)).exists();
    let compact_meta = Path::new(&format!("{}/{}", base_dir, COMPACT_META_FILE)).exists();
    legacy || (compact_cells && compact_meta)
}

// ── Compact Binary Save/Load (new, size-efficient) ──────────────────────────

const COMPACT_CELLS_FILE: &str = "data/kai-cells.bin.zst";
const COMPACT_META_FILE: &str = "data/kai-meta.json";
const COMPACT_DELTA_FILE: &str = "data/kai-cells-delta.bin.zst";
const TEXT_STORE_FILE: &str = "data/kai-texts.bin";

/// Threshold: if fewer than this fraction of cells are dirty, write a delta instead of full save.
const DELTA_THRESHOLD_RATIO: f32 = 0.30;

/// Save cells in compact binary + zstd, metadata in JSON.
/// Automatically writes a delta file if <30% of cells changed since last full save.
/// Clears `universe.dirty_indices` after writing (both delta and full paths).
pub fn save_compact(
    base_dir: &str,
    universe: &mut Universe,
    candidates: &CandidateBuffer,
    drive: &Drive,
    synaptic_layer: &crate::core::SynapticLayer,
    tick: u64,
    dream_count: u64,
) -> SaveResult {
    let cells_path = format!("{}/{}", base_dir, COMPACT_CELLS_FILE);
    let meta_path = format!("{}/{}", base_dir, COMPACT_META_FILE);
    let delta_path = format!("{}/{}", base_dir, COMPACT_DELTA_FILE);
    let _ = fs::create_dir_all(Path::new(&cells_path).parent().unwrap());

    // Decide delta vs full before taking any long-lived borrows
    let dirty_count = universe.dirty_indices.len();
    let total_cells = universe.get_cells().len();
    // Use delta when: we have dirty cells AND fewer than 30% of all cells changed.
    // NOTE: We do NOT check !delta_exists here. Accumulating multiple deltas is fine —
    // the backup logic below preserves the old one before writing the new one.
    let use_delta = dirty_count > 0
        && (dirty_count as f32 / total_cells.max(1) as f32) < DELTA_THRESHOLD_RATIO;

    if use_delta {
        // ── Incremental / Delta Save ──
        let mut raw = Vec::new();
        raw.extend_from_slice(&(dirty_count as u32).to_le_bytes());
        let dirty_indices: Vec<usize> = universe.dirty_indices.iter().copied().collect();
        let cells = universe.get_cells();
        for &idx in &dirty_indices {
            if idx < cells.len() {
                raw.extend_from_slice(&(idx as u32).to_le_bytes());
                if let Err(e) = compact::write_cell(&mut raw, &cells[idx]) {
                    eprintln!("delta save failed at idx {}: {:?}", idx, e);
                    return SaveResult { ok: false, cells: 0, candidates: 0, bytes: 0 };
                }
            }
        }
        universe.dirty_indices.clear();
        let delta_bytes = match compact::compress(&raw) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("delta compression failed: {:?}", e);
                return SaveResult { ok: false, cells: 0, candidates: 0, bytes: 0 };
            }
        };
        // Before writing new delta, backup old delta if it exists (NEVER overwrite)
        if Path::new(&delta_path).exists() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let backup_path = format!("{}.bak.{}", delta_path, ts);
            let _ = fs::rename(&delta_path, &backup_path);
            eprintln!("persistence: backed up old delta to {}", backup_path);
        }
        let tmp_delta = format!("{}.tmp", delta_path);
        if fs::write(&tmp_delta, &delta_bytes).is_ok() {
            let _ = fs::rename(&tmp_delta, &delta_path);
        }
        // Metadata still needs to be saved (tick, candidates, etc. may have changed)
        save_compact_meta(base_dir, candidates, drive, synaptic_layer, tick, dream_count);
        return SaveResult {
            ok: true,
            cells: dirty_count,
            candidates: candidates.entries.len(),
            bytes: delta_bytes.len(),
        };
    }

    // ── Full Save ──
    // 1. Serialize all cells to compact binary + zstd
    let cells = universe.get_cells();
    let cell_bytes = match compact::serialize_cells(cells) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("compact save failed: {:?}", e);
            return SaveResult { ok: false, cells: 0, candidates: 0, bytes: 0 };
        }
    };
    universe.dirty_indices.clear();

    // Build text store alongside cells
    save_text_store(base_dir, universe);

    // Atomic write for cells
    let tmp_cells = format!("{}.tmp", cells_path);
    if fs::write(&tmp_cells, &cell_bytes).is_ok() {
        let _ = fs::rename(&tmp_cells, &cells_path);
    }
    // After a full save the delta is merged into the base file — safe to remove.
    // BUT: back it up first with a timestamp so it's recoverable if needed.
    if Path::new(&delta_path).exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let delta_backup = format!("{}.merged.{}", delta_path, ts);
        let _ = fs::rename(&delta_path, &delta_backup);
        eprintln!("persistence: full save merged delta → backed up to {}", delta_backup);
    }

    // 2. Save metadata as JSON
    save_compact_meta(base_dir, candidates, drive, synaptic_layer, tick, dream_count);

    SaveResult {
        ok: true,
        cells: total_cells,
        candidates: candidates.entries.len(),
        bytes: cell_bytes.len(),
    }
}

/// Save compact format (FULL only, no delta). Use `save_compact` for delta-aware saves.
pub fn save_compact_full(
    base_dir: &str,
    universe: &Universe,
    candidates: &CandidateBuffer,
    drive: &Drive,
    synaptic_layer: &crate::core::SynapticLayer,
    tick: u64,
    dream_count: u64,
) -> SaveResult {
    let cells_path = format!("{}/{}", base_dir, COMPACT_CELLS_FILE);
    let delta_path = format!("{}/{}", base_dir, COMPACT_DELTA_FILE);
    let _ = fs::create_dir_all(Path::new(&cells_path).parent().unwrap());

    let cells = universe.get_cells();
    let cell_bytes = match compact::serialize_cells(cells) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("compact save failed: {:?}", e);
            return SaveResult { ok: false, cells: 0, candidates: 0, bytes: 0 };
        }
    };

    // Build text store alongside compact cells
    save_text_store(base_dir, universe);

    let tmp_cells = format!("{}.tmp", cells_path);
    if fs::write(&tmp_cells, &cell_bytes).is_ok() {
        let _ = fs::rename(&tmp_cells, &cells_path);
    }
    let _ = fs::remove_file(&delta_path);
    save_compact_meta(base_dir, candidates, drive, synaptic_layer, tick, dream_count);

    SaveResult {
        ok: true,
        cells: cells.len(),
        candidates: candidates.entries.len(),
        bytes: cell_bytes.len(),
    }
}

fn save_compact_meta(
    base_dir: &str,
    candidates: &CandidateBuffer,
    drive: &Drive,
    synaptic_layer: &crate::core::SynapticLayer,
    tick: u64,
    dream_count: u64,
) {
    let meta_path = format!("{}/{}", base_dir, COMPACT_META_FILE);
    #[derive(Serialize)]
    struct Meta { version: u32, tick: u64, dream_count: u64, candidates: CandidateBuffer, drive: Drive, synaptic_layer: crate::core::SynapticLayer }
    let meta = Meta { version: 3, tick, dream_count, candidates: candidates.clone(), drive: drive.clone(), synaptic_layer: synaptic_layer.clone() };
    if let Ok(json) = serde_json::to_string(&meta) {
        let tmp_meta = format!("{}.tmp", meta_path);
        let _ = fs::write(&tmp_meta, json);
        let _ = fs::rename(&tmp_meta, meta_path);
    }
}

/// Load from compact format. Falls back to legacy JSON if compact files don't exist.
/// Applies any pending delta file on top of the base cells.
#[inline(never)]
pub fn load_compact(base_dir: &str) -> Option<(Universe, CandidateBuffer, Drive, u64, u64, crate::core::SynapticLayer)> {
    let cells_path = format!("{}/{}", base_dir, COMPACT_CELLS_FILE);
    let meta_path = format!("{}/{}", base_dir, COMPACT_META_FILE);
    let delta_path = format!("{}/{}", base_dir, COMPACT_DELTA_FILE);

    println!("[load_compact] checking cells_path={} meta_path={}", cells_path, meta_path);
    if !Path::new(&cells_path).exists() || !Path::new(&meta_path).exists() {
        println!("[load_compact] missing files — falling back to legacy JSON");
        return None;
    }

    // 1. Load base cells from compact binary
    let cell_bytes = match fs::read(&cells_path) {
        Ok(b) => b,
        Err(e) => {
            println!("[load_compact] failed to read cells file: {}", e);
            return None;
        }
    };
    println!("[load_compact] read {} bytes from cells file", cell_bytes.len());
    let cells = match compact::deserialize_cells(&cell_bytes) {
        Ok(c) => {
            println!("[load_compact] deserialized {} cells", c.len());
            c
        }
        Err(e) => {
            println!("[load_compact] deserialize_cells failed: {:?}", e);
            return None;
        }
    };

    // Validate and repair corrupted cells
    let mut valid_cells = Vec::with_capacity(cells.len());
    let mut repaired = 0usize;
    for mut cell in cells {
        if !compact::validate_cell(&cell) {
            compact::repair_cell(&mut cell);
            repaired += 1;
        }
        valid_cells.push(cell);
    }
    if repaired > 0 {
        println!("persistence: repaired {} corrupted cells on load", repaired);
    }

    let mut universe = Universe::new();
    *universe.get_cells_mut() = valid_cells;

    // 2. Apply pending delta file if present
    if Path::new(&delta_path).exists() {
        if let Ok(delta_bytes) = fs::read(&delta_path) {
            if let Ok(raw) = compact::decompress(&delta_bytes) {
                let mut r = &raw[..];
                let mut buf4 = [0u8; 4];
                if r.read_exact(&mut buf4).is_ok() {
                    let n = u32::from_le_bytes(buf4) as usize;
                    let mut applied = 0usize;
                    let mut failed = 0usize;
                    for _ in 0..n {
                        if r.read_exact(&mut buf4).is_err() { break; }
                        let idx = u32::from_le_bytes(buf4) as usize;
                        match compact::read_cell(&mut r) {
                            Ok(cell) => {
                                if idx < universe.get_cells().len() {
                                    universe.get_cells_mut()[idx] = cell;
                                } else if idx == universe.get_cells().len() {
                                    universe.get_cells_mut().push(cell);
                                }
                                applied += 1;
                            }
                            Err(_) => { failed += 1; }
                        }
                    }
                    if applied > 0 || failed > 0 {
                        println!("persistence: applied {} delta cells ({} failed)", applied, failed);
                    }
                }
            }
        }
    }

    // NOTE: Index rebuild deferred to first query to reduce RAM on load.
    // For large lattices (>100K cells) this saves 3-5 GB of HNSW + KMeans RAM.
    if universe.cells().len() < 50_000 {
        universe.rebuild_index(0.0);
    } else {
        println!("persistence: deferred index rebuild ({} cells). Will build on first query.", universe.cells().len());
    }

    // 3. Attach text store for lazy full-text retrieval
    load_text_store(base_dir, &mut universe);

    // 4. Load metadata from JSON
    let meta_raw = match fs::read_to_string(&meta_path) {
        Ok(s) => s,
        Err(e) => {
            println!("[load_compact] failed to read meta file: {}", e);
            return None;
        }
    };
    #[derive(Deserialize)]
    struct Meta { tick: u64, #[serde(default)] dream_count: u64, candidates: CandidateBuffer, drive: Drive, synaptic_layer: crate::core::SynapticLayer }
    let meta: Meta = match serde_json::from_str(&meta_raw) {
        Ok(m) => m,
        Err(e) => {
            println!("[load_compact] meta JSON deserialize failed: {}", e);
            return None;
        }
    };
    println!("[load_compact] loaded meta: tick={} dream_count={} candidates={} synapses={}",
        meta.tick, meta.dream_count, meta.candidates.entries.len(), meta.synaptic_layer.synapses.len());

    Some((universe, meta.candidates, meta.drive, meta.tick, meta.dream_count, meta.synaptic_layer))
}

fn chrono_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("epoch-{}", d.as_secs())
}

// ── TextStore Save/Load ───────────────────────────────────────────────────

/// Build a memory-mapped text store from all cell texts and write to disk.
pub fn save_text_store(base_dir: &str, universe: &crate::core::Universe) {
    let texts: Vec<String> = universe.cells()
        .iter()
        .map(|c| c.claim.text.clone())
        .collect();

    let path = std::path::Path::new(base_dir).join(TEXT_STORE_FILE);
    if let Ok(store) = crate::core::text_store::TextStore::build(&path, &texts) {
        println!("persistence: text store built ({} entries, {} MB)",
            store.len(),
            std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) / (1024 * 1024)
        );
    }
}

/// Open the text store from disk and attach it to the Universe.
/// Then optionally clear in-RAM text for non-atomic (Layer 2+) cells to reclaim RAM.
pub fn load_text_store(base_dir: &str, universe: &mut crate::core::Universe) {
    let path = std::path::Path::new(base_dir).join(TEXT_STORE_FILE);
    if path.exists() {
        if let Ok(store) = crate::core::text_store::TextStore::open(&path) {
            let count = store.len();
            universe.text_store = Some(store);
            // Assign text_ids and reclaim RAM for parent cells (Layer 2+)
            let n = universe.cells().len().min(count);
            let mut to_truncate: Vec<(usize, String)> = Vec::new();
            for idx in 0..n {
                let cell = &universe.cells()[idx];
                if cell.claim.layer >= crate::core::claim::LAYER_CELLULAR {
                    // Parent cell — prepare synthetic micro-label
                    let synthetic = universe.synthesize_parent_text(idx);
                    if !synthetic.is_empty() && synthetic != cell.claim.text {
                        to_truncate.push((idx, synthetic));
                    }
                }
            }
            let mut reclaimed = 0isize;
            for (idx, synthetic) in to_truncate {
                let cell = &mut universe.cells_mut()[idx];
                cell.text_id = idx as u32;
                reclaimed += cell.claim.text.len() as isize;
                cell.claim.text = synthetic;
                reclaimed -= cell.claim.text.len() as isize;
            }
            if reclaimed > 1024 * 1024 {
                println!("persistence: reclaimed ~{:.1} MB of parent text via text store", (reclaimed as f64) / (1024.0 * 1024.0));
            }
            println!("persistence: text store attached ({} entries)", count);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mind_state_round_trips() {
        let mut base_dir = std::env::temp_dir();
        base_dir.push(format!("kai-mind-persistence-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base_dir);
        fs::create_dir_all(&base_dir).expect("temp dir should be created");
        let base_dir = base_dir.to_string_lossy().to_string();

        let mut working_memory = WorkingMemory::new();
        working_memory.push("Ryan asked about KAI's mind", "user", 42);

        let mut episodic = EpisodicStore::new();
        episodic.store("KAI noticed a persistence test", "kai", "test-session", 0.8);

        let mut global_workspace = GlobalWorkspace::new();
        global_workspace.post("test", "mind continuity matters", 0.9);
        global_workspace.tick();

        let mut self_state_hub = SelfStateHub::new();
        self_state_hub.ingest_input("does KAI remember?", 1.2, 42);
        self_state_hub.integrate(43);

        let saved = save_mind(
            &working_memory,
            &episodic,
            &global_workspace,
            &self_state_hub,
            &crate::core::SynapticLayer::new(),
            &base_dir,
        );
        assert!(saved.ok);
        assert!(saved.bytes > 0);

        let loaded = load_mind(&base_dir).expect("mind state should load");
        drop(loaded);
    }

    #[test]
    fn compact_cells_roundtrip() {
        use crate::core::{Cell, SparseVec};
        use crate::core::claim::Claim;

        let vec = SparseVec::encode("KAI is a geometric intelligence");
        let cell = Cell {
            label: "test-label".into(),
            region: "memory".into(),
            claim: Claim {
                text: "KAI is a geometric intelligence".into(),
                source: "test".into(),
                evidence: vec!["ev1".into()],
                confidence: 2.5,
                last_verified: 100,
                created_at: 50,
                contradictions: vec![],
                vec,
                vitality: 0.8,
                layer: 1,
                user_id: "ryan".into(),
                channel_id: "#test".into(),
                message_id: "msg1".into(),
                guild_id: "guild1".into(),
                keywords: vec!["kai".into()],
            },
            continuation: Some(SparseVec::encode("continuation vector")),
            last_fired: 200,
            convergence_score: 3.0,
            nnz: 0, // 0 means "don't validate" in validate_cell
            pos_vec: SparseVec::encode("position vector"),
            children: Vec::new(),
            parent: None,
            text_id: 0,
            is_archived: false,
            activation_heat: 0.0,
        };

        let bytes = compact::serialize_cells(&[cell.clone()]).expect("serialize should succeed");
        // JSON was ~35KB per cell. Compact + zstd should be much smaller.
        // For a single cell, zstd dictionary overhead is amortized poorly;
        // at scale (10K+ cells) the ratio improves to ~7-10x vs JSON.
        assert!(bytes.len() < 8000, "compact format should be <8KB for one cell, got {} bytes", bytes.len());

        let cells = compact::deserialize_cells(&bytes).expect("deserialize should succeed");
        assert_eq!(cells.len(), 1);
        assert_eq!(cells[0].label, "test-label");
        assert_eq!(cells[0].claim.text, "KAI is a geometric intelligence");
        assert_eq!(cells[0].claim.confidence, 2.5);
        assert!(compact::validate_cell(&cells[0]));
    }

    #[test]
    fn delta_save_roundtrip() {
        use crate::core::{Cell, SparseVec, Universe};
        use crate::core::claim::Claim;
        use crate::drive::Drive;
        use crate::cognition::candidates::CandidateBuffer;

        let mut base_dir = std::env::temp_dir();
        base_dir.push(format!("kai-delta-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base_dir);
        fs::create_dir_all(&base_dir).expect("temp dir should be created");
        let base_dir = base_dir.to_string_lossy().to_string();

        fn make_cell(text: &str, conf: f32) -> Cell {
            let vec = SparseVec::encode(text);
            Cell {
                label: text.into(),
                region: "memory".into(),
                claim: Claim {
                    text: text.into(),
                    source: "test".into(),
                    evidence: vec![],
                    confidence: conf,
                    last_verified: 0,
                    created_at: 0,
                    contradictions: vec![],
                    vec,
                    vitality: 0.5,
                    layer: 1,
                    user_id: "".into(),
                    channel_id: "".into(),
                    message_id: "".into(),
                    guild_id: "".into(),
                    keywords: vec![],
                },
                continuation: None,
                last_fired: 0,
                convergence_score: 2.0,
                nnz: 0,
                pos_vec: SparseVec::zero(),
                children: Vec::new(),
                parent: None,
                text_id: 0,
                is_archived: false,
                activation_heat: 0.0,
            }
        }

        // 1. Create universe with 5 cells
        let mut universe = Universe::new();
        for i in 0..5 {
            let text = format!("cell {}", i);
            universe.get_cells_mut().push(make_cell(&text, 1.0));
        }

        // 2. Full save
        let sl = crate::core::SynapticLayer::new();
        let res = save_compact(&base_dir, &mut universe, &CandidateBuffer::new(), &Drive::default(), &sl, 1, 0);
        assert!(res.ok, "full save should succeed");
        assert_eq!(res.cells, 5, "full save should write all 5 cells");

        // 3. Modify 2 cells (40% dirty = above 30% threshold, so next save is also full)
        universe.get_cells_mut()[0].claim.confidence = 3.0;
        universe.mark_dirty(0);
        universe.get_cells_mut()[1].claim.confidence = 3.5;
        universe.mark_dirty(1);

        // With 2/5 = 40% dirty, should still do FULL save (above 30% threshold)
        let res2 = save_compact(&base_dir, &mut universe, &CandidateBuffer::new(), &Drive::default(), &sl, 2, 0);
        assert!(res2.ok);
        assert_eq!(res2.cells, 5, "40% dirty should trigger full save");

        // 4. Now modify only 1 cell (20% dirty = below 30% threshold, delta save)
        universe.get_cells_mut()[2].claim.confidence = 4.0;
        universe.mark_dirty(2);

        let res3 = save_compact(&base_dir, &mut universe, &CandidateBuffer::new(), &Drive::default(), &sl, 3, 0);
        assert!(res3.ok);
        assert_eq!(res3.cells, 1, "20% dirty should trigger delta save (1 cell)");

        // 5. Load and verify delta applied
        let loaded = load_compact(&base_dir).expect("load should succeed");
        assert_eq!(loaded.0.get_cells().len(), 5);
        assert_eq!(loaded.0.get_cells()[0].claim.confidence, 3.0);
        assert_eq!(loaded.0.get_cells()[1].claim.confidence, 3.5);
        assert_eq!(loaded.0.get_cells()[2].claim.confidence, 4.0);
        assert_eq!(loaded.0.get_cells()[3].claim.confidence, 1.0);
    }
}
