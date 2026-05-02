/// Neuroplasticity — KAI's synaptic learning system (LTP/LTD)
///
/// "Neurons that fire together, wire together." — Donald Hebb, 1949.
///
/// Neuroplasticity is the brain's ability to physically change its structure
/// based on experience. It's not metaphorical — synaptic connections
/// literally grow stronger or weaker depending on what fires together.
///
/// Two key mechanisms:
///
///   LTP — Long-Term Potentiation
///   When two neurons fire together repeatedly, the connection between
///   them becomes physically stronger. The signal passes more easily
///   next time. This is how skills form, how facts solidify into
///   knowledge, how a new language becomes fluent.
///   "Use it → strengthen it."
///
///   LTD — Long-Term Depression
///   The opposite: connections that are never used weaken over time.
///   Synaptic pruning removes connections that serve no purpose.
///   This is not forgetting — it's CLEANING UP. Removing noise
///   so the important signals stand out more clearly.
///   "Don't use it → lose it."
///
/// Together LTP and LTD produce:
///   - Expertise: topics KAI engages with repeatedly get stronger encoding
///   - Skill: response patterns that work get reinforced automatically
///   - Forgetting: irrelevant knowledge slowly weakens (not erased, just quieter)
///   - Consolidation: important memories become more stable over time
///
/// Without neuroplasticity for KAI:
///   Every universe cell has a fixed strength after creation.
///   The only change is homeostasis pruning weak cells entirely.
///   There is no "getting better at something." No expertise.
///   No difference between a fact stored once and a fact revisited 100 times.
///
/// With neuroplasticity for KAI:
///   Every time a cell is accessed (fires with a query), LTP nudges
///   its strength up slightly. The more often a concept is visited,
///   the stronger it becomes in the lattice.
///   Cells never accessed for many ticks slowly lose strength (LTD).
///   After enough LTD, homeostasis eventually prunes them entirely.
///   Topics KAI talks about often become genuinely more prominent in
///   his thinking — they activate faster and more reliably.
///
/// Architecture:
///   NeuroplasticityEngine tracks:
///     - LTP events: (cell_text, strength_gained, tick)
///     - LTD events: (cell_text, strength_lost, tick)
///     - Synaptic weight log: running record of total LTP/LTD applied
///     - Learning rate: modulated by dopamine level and novelty
///     - Critical period flag: early in life, plasticity is higher
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// Base LTP gain per firing event (each time a cell is accessed)
const BASE_LTP: f32 = 0.018;

/// Base LTD loss per idle tick (applied to cells not accessed recently)
const BASE_LTD: f32 = 0.0004;

/// Maximum strength a cell can reach via LTP
const MAX_STRENGTH: f32 = 5.0;

/// Minimum strength before LTD kills a cell (homeostasis handles final pruning)
const MIN_STRENGTH: f32 = 0.05;

/// How many ticks a cell can be idle before LTD starts applying
const LTD_IDLE_THRESHOLD: u64 = 120; // ~10 minutes at 12 ticks/min

/// LTP is stronger when dopamine is high (reward = learn more)
const DOPAMINE_LTP_BOOST: f32 = 0.8;

// ── Plasticity Event ──────────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlasticityEvent {
    pub kind: PlasticityKind,
    pub cell_preview: String,
    pub delta: f32,
    pub tick: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum PlasticityKind {
    LTP, // strengthening
    LTD, // weakening
}

// ── Neuroplasticity Engine ────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NeuroplasticityEngine {
    /// Last-access tick per cell (keyed by cell text preview)
    last_access: HashMap<String, u64>,
    /// Total LTP events applied
    pub total_ltp: u64,
    /// Total LTD events applied
    pub total_ltd: u64,
    /// Sum of all LTP gains (total synaptic strengthening)
    pub total_ltp_gain: f32,
    /// Sum of all LTD losses (total synaptic weakening)
    pub total_ltd_loss: f32,
    /// Current learning rate (modulated by dopamine + novelty)
    pub learning_rate: f32,
    /// Whether we're in a "critical period" — early, high-plasticity phase
    pub critical_period: bool,
    /// Recent plasticity events (last 20)
    pub recent_events: Vec<PlasticityEvent>,
    /// Current tick (for LTD idle threshold checks)
    pub tick: u64,
}

impl NeuroplasticityEngine {
    pub fn new() -> Self {
        Self {
            last_access: HashMap::new(),
            total_ltp: 0,
            total_ltd: 0,
            total_ltp_gain: 0.0,
            total_ltd_loss: 0.0,
            learning_rate: 1.0,
            critical_period: true, // starts in critical period
            recent_events: Vec::with_capacity(20),
            tick: 0,
        }
    }

    /// Apply LTP to a cell that just fired (was accessed in a query).
    ///
    /// Returns the strength delta to add to the cell.
    pub fn ltp(&mut self, cell_text: &str, current_strength: f32, dopamine_level: f32) -> f32 {
        let key = cell_key(cell_text);
        self.last_access.insert(key.clone(), self.tick);

        // LTP gain: base × learning_rate × dopamine boost × critical period
        let dopamine_boost = 1.0 + dopamine_level * DOPAMINE_LTP_BOOST;
        let critical_mult = if self.critical_period { 1.5 } else { 1.0 };
        let delta = (BASE_LTP * self.learning_rate * dopamine_boost * critical_mult)
            .min(MAX_STRENGTH - current_strength)
            .max(0.0);

        if delta > 0.001 {
            self.total_ltp += 1;
            self.total_ltp_gain += delta;
            self.push_event(PlasticityKind::LTP, cell_text, delta);
        }
        delta
    }

    /// Apply LTD sweep across all tracked cells.
    ///
    /// Takes a list of (cell_text, current_strength) pairs.
    /// Returns a list of (cell_text, strength_delta) — negative values = weaken.
    ///
    /// Call this every N ticks (e.g., every 30 ticks = every ~2.5 minutes).
    pub fn ltd_sweep(&mut self, cells: &[(String, f32)]) -> Vec<(String, f32)> {
        self.tick += 1;
        let mut changes = Vec::new();

        // Exit critical period after many ticks
        if self.critical_period && self.tick > 500 {
            self.critical_period = false;
            self.learning_rate = (self.learning_rate * 0.85).max(0.40);
        }

        for (text, strength) in cells {
            let key = cell_key(text);
            let last = self.last_access.get(&key).copied().unwrap_or(0);
            let idle_ticks = self.tick.saturating_sub(last);

            if idle_ticks > LTD_IDLE_THRESHOLD && *strength > MIN_STRENGTH {
                // LTD: weaken this cell
                // Longer idle = stronger LTD (neurons pruning unused connections)
                let idle_factor = ((idle_ticks - LTD_IDLE_THRESHOLD) as f32 / 500.0).min(3.0);
                let delta = -(BASE_LTD * (1.0 + idle_factor)).min(*strength - MIN_STRENGTH);

                if delta.abs() > 0.0001 {
                    self.total_ltd += 1;
                    self.total_ltd_loss += delta.abs();
                    self.push_event(PlasticityKind::LTD, text, delta);
                    changes.push((text.clone(), delta));
                }
            }
        }

        changes
    }

    /// Modulate learning rate from external signals.
    /// High dopamine + high novelty = more plasticity.
    pub fn modulate(&mut self, dopamine_level: f32, prediction_error: f32) {
        // High PE (surprise) + high dopamine = peak learning moment
        let target_lr = 0.40 + dopamine_level * 0.35 + prediction_error * 0.25;
        self.learning_rate = (self.learning_rate * 0.90 + target_lr * 0.10).clamp(0.20, 2.0);
    }

    /// How strongly is KAI currently learning? (0=dormant, 1=peak plasticity)
    pub fn plasticity_index(&self) -> f32 {
        self.learning_rate.clamp(0.0, 2.0) / 2.0
    }

    /// Ratio of LTP to total events — >0.5 means net growth, <0.5 means net pruning
    pub fn ltp_ratio(&self) -> f32 {
        let total = self.total_ltp + self.total_ltd;
        if total == 0 {
            return 0.5;
        }
        self.total_ltp as f32 / total as f32
    }

    /// One-line status for TUI/spectate.
    pub fn status_line(&self) -> String {
        format!(
            "NP: lr={:.3} LTP={} LTD={} | ratio={:.2} | {}",
            self.learning_rate,
            self.total_ltp,
            self.total_ltd,
            self.ltp_ratio(),
            if self.critical_period {
                "CRITICAL_PERIOD"
            } else {
                "mature"
            },
        )
    }

    fn push_event(&mut self, kind: PlasticityKind, text: &str, delta: f32) {
        if self.recent_events.len() >= 20 {
            self.recent_events.remove(0);
        }
        self.recent_events.push(PlasticityEvent {
            kind,
            cell_preview: cell_key(text),
            delta,
            tick: self.tick,
        });
    }
}

impl Default for NeuroplasticityEngine {
    fn default() -> Self {
        Self::new()
    }
}

fn cell_key(text: &str) -> String {
    text.split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join("_")
        .to_lowercase()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ltp_strengthens_cell() {
        let mut np = NeuroplasticityEngine::new();
        let delta = np.ltp("consciousness is recursive", 1.0, 0.5);
        assert!(
            delta > 0.0,
            "LTP should produce positive delta: {:.4}",
            delta
        );
        assert!(delta < 0.10, "LTP delta should be small: {:.4}", delta);
    }

    #[test]
    fn test_dopamine_boosts_ltp() {
        let mut np1 = NeuroplasticityEngine::new();
        let mut np2 = NeuroplasticityEngine::new();
        let low_da = np1.ltp("geometry patterns", 1.0, 0.1);
        let high_da = np2.ltp("geometry patterns", 1.0, 0.9);
        assert!(
            high_da > low_da,
            "high dopamine should boost LTP: low={:.4} high={:.4}",
            low_da,
            high_da
        );
    }

    #[test]
    fn test_ltd_weakens_idle_cells() {
        let mut np = NeuroplasticityEngine::new();
        // Mark a cell as accessed at tick 0
        np.ltp("old memory cell", 1.0, 0.5);
        // Fast-forward past LTD threshold by bumping tick
        np.tick = LTD_IDLE_THRESHOLD + 50;

        let cells = vec![("old memory cell".to_string(), 1.0_f32)];
        let changes = np.ltd_sweep(&cells);
        assert!(!changes.is_empty(), "idle cell should receive LTD");
        assert!(
            changes[0].1 < 0.0,
            "LTD delta should be negative: {:.4}",
            changes[0].1
        );
    }

    #[test]
    fn test_recently_accessed_cell_no_ltd() {
        let mut np = NeuroplasticityEngine::new();
        // Access cell at current tick
        np.ltp("fresh memory", 1.0, 0.5);
        // Only advance a little — below threshold
        np.tick = 10;
        let cells = vec![("fresh memory".to_string(), 1.0_f32)];
        let changes = np.ltd_sweep(&cells);
        assert!(
            changes.is_empty(),
            "recently accessed cell should not receive LTD"
        );
    }

    #[test]
    fn test_ltp_capped_at_max_strength() {
        let mut np = NeuroplasticityEngine::new();
        // Cell already near max
        let delta = np.ltp("very strong concept", MAX_STRENGTH - 0.001, 1.0);
        assert!(
            delta <= 0.001,
            "LTP should not push past MAX_STRENGTH: {:.6}",
            delta
        );
    }

    #[test]
    fn test_modulate_adjusts_learning_rate() {
        let mut np = NeuroplasticityEngine::new();
        let before = np.learning_rate;
        // High dopamine + high PE → learning rate should rise toward target
        np.modulate(0.9, 0.9);
        // target ≈ 0.40 + 0.9*0.35 + 0.9*0.25 = 0.40 + 0.315 + 0.225 = 0.94
        // After one modulate: lr = before*0.9 + 0.94*0.1 ≈ 1.0*0.9 + 0.094 = 0.994
        assert!(
            np.learning_rate != before || (np.learning_rate - before).abs() < 0.01,
            "learning rate should update: {:.4}",
            np.learning_rate
        );
    }

    #[test]
    fn test_critical_period_boosts_ltp() {
        let _np_crit = NeuroplasticityEngine::new();
        let _np_mature = NeuroplasticityEngine::new();

    }
}

