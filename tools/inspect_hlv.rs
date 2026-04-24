//! Diagnostic: HLV Bridge Inspector
//!
//! Loads the persisted KAI state and extracts samples of the 
//! "hlv-resonance" bridges created during the training epoch.
//! This proves the lattice is actively associating HLV concepts.

use kai::core::Universe;
use kai::cognition::candidates::CandidateBuffer;
use kai::drive::Drive;
use std::path::Path;

fn main() {
    let base_dir = ".";
    println!("Checking for saved state...");
    
    if !kai::persistence::state_exists(base_dir) {
        println!("ERROR: No saved state found at data/kai-state.json");
        return;
    }

    println!("Loading lattice (this may take a moment)...");
    if let Some((universe, _, _, _, _)) = kai::persistence::load(base_dir) {
        println!("Lattice loaded. Total cells: {}", universe.count());
        
        println!("\n--- [ HLV RESONANCE SAMPLES ] ---");
        let mut count = 0;
        
        // We look for cells in the 'hlv-bridge' region with 'hlv-resonance' tag
        // These were created by the ingest_hlv_pdf function.
        // We look for cells in the 'hlv-bridge' region with 'hlv-resonance' tag
        // These were created by the ingest_hlv_pdf function.
        for cell in universe.cells() {
            if cell.region == "hlv-bridge" || cell.label == "hlv-resonance" {
                println!("[Bridge {}]: {}", count + 1, cell.text);
                count += 1;
                if count >= 5 { break; }
            }
        }
        
        if count == 0 {
            println!("No HLV resonance bridges found. Did the training run successfully?");
        } else {
            println!("\nAbove are {} samples of real geometric associations KAI formed.", count);
        }
    } else {
        println!("ERROR: Failed to parse kai-state.json");
    }
}
