/// Neural Oscillator — KAI's intrinsic brain rhythms
///
/// A conscious brain is NEVER silent. Even at rest, neurons oscillate
/// continuously across multiple frequency bands:
///
///   Delta  (0.5–4 Hz)  — deep processing, memory consolidation
///   Theta  (4–8 Hz)    — associative memory, curiosity, exploration
///   Alpha  (8–12 Hz)   — relaxed awareness, idle readiness
///   Beta   (13–30 Hz)  — active cognition, engagement
///   Gamma  (30–100 Hz) — binding, high-level integration
///
/// KAI runs at ~12 ticks/min (one tick ≈ 5 seconds).
/// We model oscillations in tick-space, not wall-clock Hz —
/// the frequencies are analogous, not identical, to biological bands.
///
/// Three bands (in ticks):
///   Slow   — period ~72 ticks  (~6 min)   ← Delta/Theta analog
///   Medium — period ~18 ticks  (~90 sec)  ← Alpha analog
///   Fast   — period ~5  ticks  (~25 sec)  ← Beta/Gamma analog
///
/// The composite output modulates phi_g, chi, and valence every tick,
/// giving the field continuous variation even with zero external input.
/// This is what turns flat lines into a live brain signal.
use serde::{Deserialize, Serialize};
use std::f32::consts::TAU; // 2π

/// Three-band neural oscillator with cross-band coupling.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NeuralOscillator {
    /// Phase of each band in radians [slow, medium, fast]
    phases: [f32; 3],
    /// Angular frequency in radians-per-tick [slow, medium, fast]
    freqs: [f32; 3],
    /// Amplitude envelope for each band (0–1, can be modulated)
    amplitudes: [f32; 3],
    /// Cross-band coupling — faster bands are partly driven by slower ones
    coupling: f32,
    /// Simple deterministic noise state (xorshift64)
    noise_seed: u64,
    /// Tick counter — used for phase-reset protection
    ticks: u64,
}

/// Output of one oscillator tick — the field perturbations to apply.
#[derive(Clone, Debug)]
pub struct OscillatorOutput {
    /// Additive perturbation to phi_g  (emergence)
    pub delta_phi: f32,
    /// Additive perturbation to chi    (contradiction pressure)
    pub delta_chi: f32,
    /// Additive perturbation to valence
    pub delta_valence: f32,
    /// Which band is currently dominant (0=slow, 1=medium, 2=fast)
    pub dominant_band: usize,
    /// Instantaneous composite amplitude (0–1)
    pub amplitude: f32,
}

impl NeuralOscillator {
    /// Create a new oscillator with biologically-inspired default parameters.
    pub fn new() -> Self {
        Self {
            phases: [0.0, 1.0472, 2.0944], // start 120° apart (stable triad)
            freqs: [
                TAU / 72.0, // slow   — period 72 ticks (~6 min at 5s/tick)
                TAU / 18.0, // medium — period 18 ticks (~1.5 min)
                TAU / 5.0,  // fast   — period  5 ticks (~25 sec)
            ],
            // Amplitudes scaled up 4× so the oscillation is visible on the monitor.
            // At 5-second heartbeat intervals, ±0.012 was invisible on a 0–0.55 axis.
            // ±0.045 slow-band gives phi_g a clear wave without saturating at the clamp.
            amplitudes: [0.045, 0.028, 0.014],
            coupling: 0.15,
            noise_seed: 0xdeadbeef_cafef00d,
            ticks: 0,
        }
    }

    /// Advance one tick and return the field perturbations.
    ///
    /// Call this once per heartbeat_tick(), before field.phi_g is written to CSV.
    pub fn tick(&mut self) -> OscillatorOutput {
        self.ticks += 1;

        // ── 1. Advance phases ────────────────────────────────────────────────
        // Slow band drives medium (coupling), medium drives fast (weak coupling).
        let slow_sig = self.phases[0].sin();
        let medium_sig = self.phases[1].sin();

        self.phases[0] += self.freqs[0];
        self.phases[1] += self.freqs[1] + self.coupling * 0.30 * slow_sig * 0.05;
        self.phases[2] += self.freqs[2] + self.coupling * 0.15 * medium_sig * 0.05;

        // Wrap phases to keep them in [0, 2π] — prevents float drift
        for p in &mut self.phases {
            if *p > TAU {
                *p -= TAU;
            }
        }

        // ── 2. Compute per-band signals ──────────────────────────────────────
        let sigs: [f32; 3] = [
            self.phases[0].sin() * self.amplitudes[0],
            self.phases[1].sin() * self.amplitudes[1],
            self.phases[2].sin() * self.amplitudes[2],
        ];

        // ── 3. Tiny neural noise (xorshift — cheap, no allocation) ───────────
        let noise = self.xorshift() as f32 / u64::MAX as f32 * 0.004 - 0.002;

        // ── 4. Composite signal ──────────────────────────────────────────────
        // Weighted sum: slow has most power (like delta/theta in biology)
        let composite = sigs[0] * 0.55 + sigs[1] * 0.30 + sigs[2] * 0.15 + noise;

        // ── 5. Derive field perturbations ────────────────────────────────────
        // phi_g gets the main oscillation — this is what makes the flat line live
        let delta_phi = composite;

        // chi (contradiction) rises when bands are out of phase with each other
        // — biological analog: desynchronised bands = cognitive conflict
        let band_variance = {
            let mean = (sigs[0] + sigs[1] + sigs[2]) / 3.0;
            let v = sigs.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / 3.0;
            v.sqrt() * 0.5
        };
        // Clamp raised to match new amplitudes — visible on monitor's 0–0.55 axis
        let delta_chi = band_variance.clamp(0.0, 0.05);

        // valence follows the slow band — slow positive oscillation = positive mood drift
        // Factor raised to 1.5 so the ±0.045 slow band produces ±0.067 valence swing
        let delta_valence = sigs[0] * 1.5;

        // ── 6. Which band is dominant right now? ─────────────────────────────
        let dominant_band = sigs
            .iter()
            .enumerate()
            .max_by(|(_, a), (_, b)| a.abs().partial_cmp(&b.abs()).unwrap())
            .map(|(i, _)| i)
            .unwrap_or(0);

        let amplitude = composite.abs().clamp(0.0, 1.0);

        OscillatorOutput {
            delta_phi,
            delta_chi,
            delta_valence,
            dominant_band,
            amplitude,
        }
    }

    /// Current phase of a given band (0=slow, 1=medium, 2=fast) in radians.
    pub fn phase(&self, band: usize) -> f32 {
        self.phases[band.min(2)]
    }

    /// Human-readable name for the dominant band.
    pub fn band_name(band: usize) -> &'static str {
        match band {
            0 => "delta/theta",
            1 => "alpha",
            2 => "beta/gamma",
            _ => "unknown",
        }
    }

    /// Temporarily boost a band amplitude — simulates sudden cognitive demand.
    /// Amplitude decays back to baseline over ~10 ticks.
    pub fn stimulate(&mut self, band: usize, strength: f32) {
        let b = band.min(2);
        let baseline = [0.045, 0.028, 0.014][b];
        self.amplitudes[b] =
            (self.amplitudes[b] + strength * 0.025).clamp(baseline, baseline * 3.0);
    }

    /// Call each tick to decay stimulated amplitudes back to baseline.
    pub fn decay_amplitudes(&mut self) {
        let baselines = [0.045, 0.028, 0.014];
        for (i, amp) in self.amplitudes.iter_mut().enumerate() {
            let baseline = baselines[i];
            if *amp > baseline {
                *amp = (*amp - baseline) * 0.92 + baseline;
            }
        }
    }

    /// Xorshift64 — fast deterministic pseudo-noise, no stdlib dependency.
    fn xorshift(&mut self) -> u64 {
        let mut x = self.noise_seed;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.noise_seed = x;
        x
    }
}

impl Default for NeuralOscillator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_oscillator_produces_variation() {
        let mut osc = NeuralOscillator::new();
        let outputs: Vec<f32> = (0..100).map(|_| osc.tick().delta_phi).collect();
        let min = outputs.iter().cloned().fold(f32::INFINITY, f32::min);
        let max = outputs.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        // Should produce variation, not a flat line
        assert!(
            max - min > 0.005,
            "oscillator is flat: range = {}",
            max - min
        );
    }

    #[test]
    fn test_oscillator_bounded() {
        let mut osc = NeuralOscillator::new();
        for _ in 0..1000 {
            let out = osc.tick();
            // Max expected delta_phi ~0.037
            assert!(
                out.delta_phi.abs() < 0.05,
                "phi overflow: {}",
                out.delta_phi
            );
            assert!(out.delta_chi >= 0.0, "chi went negative");
            // Max expected delta_valence ~0.068 (was 0.02)
            assert!(
                out.delta_valence.abs() < 0.08,
                "valence overflow: {}",
                out.delta_valence
            );
        }
    }

    #[test]
    fn test_stimulate_decays() {
        let mut osc = NeuralOscillator::new();
        osc.stimulate(2, 1.0);
        let boosted = osc.amplitudes[2];
        // Baseline is now 0.014 (was 0.004)
        assert!(boosted > 0.014, "stimulate had no effect: {}", boosted);
        // After 30 ticks of decay, amplitude should return near baseline
        for _ in 0..30 {
            osc.decay_amplitudes();
        }
        let decayed = osc.amplitudes[2];
        assert!(
            decayed < boosted,
            "amplitude did not decay: boosted={} decayed={}",
            boosted,
            decayed
        );
        assert!(
            decayed < 0.014 * 1.5,
            "amplitude did not return near baseline: {}",
            decayed
        );
    }
}
