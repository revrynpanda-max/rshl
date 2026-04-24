use crate::cognition::candidates::CandidateBuffer;
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

    match serde_json::to_string_pretty(&snapshot) {
        Ok(json) => {
            let tmp_path = format!("{}.tmp", state_path);
            match fs::write(&tmp_path, &json) {
                Ok(_) => {
                    match fs::rename(&tmp_path, &state_path) {
                        Ok(_) => {
                            return SaveResult {
                                ok: true,
                                cells: universe.count(),
                                candidates: candidates.count(),
                                bytes: json.len(),
                            };
                        }
                        Err(_e) => {
                            // Rename failed — try copy+delete fallback (cross-device)
                            let _ = fs::copy(&tmp_path, &state_path);
                            let _ = fs::remove_file(&tmp_path);
                            return SaveResult {
                                ok: true,
                                cells: universe.count(),
                                candidates: candidates.count(),
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

/// Load cognitive state from disk.
pub fn load(base_dir: &str) -> Option<(Universe, CandidateBuffer, Drive, u64, u64)> {
    let state_path = format!("{}/{}", base_dir, STATE_FILE);

    if !Path::new(&state_path).exists() {
        return None;
    }

    let raw = fs::read_to_string(&state_path).ok()?;
    let snapshot: Snapshot = serde_json::from_str(&raw).ok()?;

    if snapshot.version != 2 {
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
    // Simple timestamp without chrono dependency
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("epoch-{}", d.as_secs())
}

