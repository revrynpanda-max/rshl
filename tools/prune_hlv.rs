//! Pruning Tool: Remove noisy HLV bridges
use kai::core::Universe;
use kai::cognition::candidates::CandidateBuffer;
use kai::drive::Drive;

fn main() {
    let base_dir = ".";
    if let Some((mut universe, candidates, drive, tick, dream_count)) = kai::persistence::load(base_dir) {
        let before = universe.count();
        
        // Remove all current hlv-resonance bridges
        universe.cells_mut().retain(|c| c.label != "hlv-resonance");
        
        let after = universe.count();
        println!("Pruned {} noisy resonance bridges.", before - after);
        
        kai::persistence::save(&universe, &candidates, &drive, tick, dream_count, base_dir);
        println!("Lattice cleansed. Ready for high-fidelity training.");
    }
}
