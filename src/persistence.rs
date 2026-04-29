use crate::cognition::{
    candidates::CandidateBuffer, EpisodicStore, GlobalWorkspace, SelfStateHub, WorkingMemory,
};
/// Persistence — Save and restore KAI's full cognitive state.
///
/// Biology analog: Long-term memory consolidation to permanent substrate.
/// Without this, KAI has complete amnesia on every restart.
///
/// Saves: universe cells, candidate buffer, drive state, tick count.
/// Format: JSON snapshot with atomic write (write .tmp, rename).
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
pub fn save(
    universe: &Universe,
    candidates: &CandidateBuffer,
    drive: &Drive,
    tick: u64,
    dream_count: u64,
    base_dir: &str,
) -> SaveResult {
    let state_path = format!("{}/{}", base_dir, STATE_FILE);
    let backup_path = format!("{}/{}", base_dir, BACKUP_FILE);

    // Ensure data directory exists
    let dir = Path::new(&state_path).parent().unwrap();
    let _ = fs::create_dir_all(dir);

    // Backup previous state
    if Path::new(&state_path).exists() {
        let _ = fs::copy(&state_path, &backup_path);
    }

    let snapshot = Snapshot {
        version: 2,
        saved_at: chrono_now(),
        tick,
        dream_count,
        universe: universe.clone(),
        candidates: candidates.clone(),
        drive: drive.clone(),
    };

    match serde_json::to_string(&snapshot) {
        Ok(json) => {
            let tmp_path = format!("{}.tmp", state_path);
            match fs::write(&tmp_path, &json) {
                Ok(_) => {
                    match fs::rename(&tmp_path, &state_path) {
                        Ok(_) => {
                            return SaveResult {
                                ok: true,
                                cells: universe.cell_count(),
                                candidates: candidates.entries.len(),
                                bytes: json.len(),
                            };
                        }
                        Err(_e) => {
                            // Rename failed — try copy+delete fallback (cross-device)
                            let _ = fs::copy(&tmp_path, &state_path);
                            let _ = fs::remove_file(&tmp_path);
                            return SaveResult {
                                ok: true,
                                cells: universe.cell_count(),
                                candidates: candidates.entries.len(),
                                bytes: json.len(),
                            };
                        }
                    }
                }
                Err(_) => {}
            }
            SaveResult {
                ok: false,
                cells: 0,
                candidates: 0,
                bytes: 0,
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
pub fn load(base_dir: &str) -> Option<(Universe, CandidateBuffer, Drive, u64, u64)> {
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
            eprintln!("persistence: failed to deserialize {}: {}", state_path, e);
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

    Some((
        snapshot.universe,
        snapshot.candidates,
        snapshot.drive,
        snapshot.tick,
        snapshot.dream_count,
    ))
}

/// Check if saved state exists.
pub fn state_exists(base_dir: &str) -> bool {
    Path::new(&format!("{}/{}", base_dir, STATE_FILE)).exists()
}

fn chrono_now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("epoch-{}", d.as_secs())
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
            &base_dir,
        );
        assert!(saved.ok);
        assert!(saved.bytes > 0);

        let loaded = load_mind(&base_dir).expect("mind state should load");

    }
}
