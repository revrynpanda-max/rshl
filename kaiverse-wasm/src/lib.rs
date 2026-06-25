use wasm_bindgen::prelude::*;
use noise::{Fbm, RidgedMulti, NoiseFn, Simplex, MultiFractal};

#[wasm_bindgen]
pub fn nsTerrainHeightWASM(nx: f64, ny: f64, nz: f64, sharp: f64, sea: f64, seed: u32) -> f64 {
    // We use a fixed seed for deterministic terrain per planet
    let fbm_cont: Fbm<Simplex> = Fbm::new(seed).set_octaves(5);
    let fbm_hills: Fbm<Simplex> = Fbm::new(seed + 1).set_octaves(4);
    let ridged: RidgedMulti<Simplex> = RidgedMulti::new(seed + 2);

    let cont = (fbm_cont.get([nx * 2.2, ny * 2.2, nz * 2.2]) * 0.5 + 0.5).max(0.0).min(1.0);
    let hills = (fbm_hills.get([nx * 7.0, ny * 7.0, nz * 7.0]) * 0.5 + 0.5).max(0.0).min(1.0);
    let ridge_val = ridged.get([nx * 5.0, ny * 5.0, nz * 5.0]);
    
    let h = cont * 0.6 + hills * 0.25 + ridge_val * 0.15 * sharp;
    
    let height = h - sea;
    if height < 0.0 {
        0.0
    } else {
        height
    }
}
