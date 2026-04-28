use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct SparseVec {
    // We don't care about the fields, just let it be a Value
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Cell {
    pub label: String,
    pub text: String,
    pub vec: SparseVec,
    pub region: String,
    pub strength: f32,
    pub source: String,
    #[serde(default)]
    pub convergence_score: f32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Universe {
    pub cells: Vec<Cell>,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    universe: Universe,
    // Catch-all for other fields
    #[serde(flatten)]
    other: serde_json::Value,
}

fn main() {
    let state_path = "data/kai-state.json";
    if !Path::new(state_path).exists() {
        println!("State file not found at {}", state_path);
        return;
    }

    println!("Loading state file (this may take a moment)...");
    let raw = fs::read_to_string(state_path).expect("Failed to read state file");
    let snapshot: Snapshot = serde_json::from_str(&raw).expect("Failed to parse state file");
    let universe = snapshot.universe;

    let mut center_count = 0;
    let mut geocentric_count = 0;
    let mut mc2_count = 0;
    let mut mass_energy_count = 0;

    for cell in &universe.cells {
        let t = cell.text.to_lowercase();
        if t.contains("center") {
            center_count += 1;
        }
        if t.contains("geocentric") {
            geocentric_count += 1;
        }
        if t.contains("mc2") {
            mc2_count += 1;
        }
        if t.contains("mass-energy") {
            mass_energy_count += 1;
        }
    }

    println!("--- Atom Counts ---");
    println!("'center': {}", center_count);
    println!("'geocentric': {}", geocentric_count);
    println!("'mc2': {}", mc2_count);
    println!("'mass-energy': {}", mass_energy_count);
    println!("Total cells: {}", universe.cells.len());
}
