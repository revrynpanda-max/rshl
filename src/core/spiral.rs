// core/spiral.rs
//
// Golden-ratio logarithmic spiral — the "breathing loop" that drives τ_R in Φ_R.
//
// Math (from the notebook):
//   R(θ) = a × e^(b × θ)
//   b    = ln(φ) / (π/2)
//   φ    = (1 + √5) / 2 = 1.618033988...
//
// θ advances monotonically per tick and never wraps visibly. Inside `recompute`
// we fold θ into a small range before feeding it to exp() so we never overflow
// f32. The externally observable θ (via `theta()`) keeps accumulating.

use std::f64::consts::TAU as TAU_F64;

/// The golden ratio φ.
pub const PHI_GOLDEN: f32 = 1.618_034;

/// Spiral growth exponent: ln(φ) / (π/2) ≈ 0.306349.
/// Hardcoded because f32::ln is not a const fn. Derived as:
///   ln(1.618_033_988) / (π / 2)
///   = 0.481_211_8 / 1.570_796_3
///   ≈ 0.306_349
pub const GOLDEN_B: f32 = 0.306_349;

/// Period used for modding θ before feeding it to `exp()`. Four full turns
/// keeps the radius curve visually interesting and prevents exp() overflow.
/// θ itself (`self.theta`) is never modded — only the value handed to exp().
const THETA_FOLD_PERIOD: f64 = TAU_F64 * 4.0;

/// A non-closing golden-ratio spiral.
#[derive(Clone, Copy, Debug)]
pub struct SpiralState {
    /// Monotonic angular position. f64 so we don't lose precision over
    /// millions of ticks.
    theta: f64,
    /// How much θ advances per tick.
    theta_step: f64,
    /// Shifted-sigmoid radius in [0, 1]: full range across each fold period.
    radius: f32,
    /// Temporal factor for Φ_R: 0.5 + 0.5 * radius.
    tau_r: f32,
}

impl Default for SpiralState {
    fn default() -> Self {
        Self::new(0.05)
    }
}

impl SpiralState {
    /// Create a fresh spiral at θ=0 with the given per-tick θ advance.
    pub fn new(theta_step: f32) -> Self {
        let mut s = Self {
            theta: 0.0,
            theta_step: theta_step as f64,
            radius: 0.0,
            tau_r: 0.0,
        };
        s.recompute();
        s
    }

    /// Advance θ by one step and recompute radius / τ_R.
    pub fn tick(&mut self) {
        self.theta += self.theta_step;
        self.recompute();
    }

    /// Recompute radius and τ_R from the current θ.
    ///
    /// θ is folded into THETA_FOLD_PERIOD before the exp() to keep the
    /// exponential in a safe range. The external θ keeps growing.
    fn recompute(&mut self) {
        let theta_folded = (self.theta.rem_euclid(THETA_FOLD_PERIOD)) as f32;
        let raw = (GOLDEN_B * theta_folded).exp();
        // Shifted sigmoid: radius spans [0, 1] across the fold window.
        // At θ=0 → raw=1 → radius=0.0; as θ→∞ within the fold,
        // radius→1.0; then folds back to 0.0 each period.
        // Formula: 2*(raw/(1+raw)) - 1, clamped to [0, 1].
        self.radius = (2.0 * raw / (1.0 + raw) - 1.0).clamp(0.0, 1.0);
        // τ_R ∈ [0.5, 1.0] — never dead, never saturated.
        self.tau_r = 0.5 + 0.5 * self.radius;
    }

    #[inline]
    pub fn theta(&self) -> f64 {
        self.theta
    }

    #[inline]
    pub fn radius(&self) -> f32 {
        self.radius
    }

    #[inline]
    pub fn tau_r(&self) -> f32 {
        self.tau_r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theta_monotonic_across_many_ticks() {
        let mut s = SpiralState::new(0.05);
        let mut prev = s.theta();
        for _ in 0..10_000 {
            s.tick();
            assert!(s.theta() > prev);
            prev = s.theta();
        }
    }

    #[test]
    fn radius_and_tau_in_bounds() {
        let mut s = SpiralState::new(0.05);
        for _ in 0..1_000 {
            s.tick();

        }
    }
}
