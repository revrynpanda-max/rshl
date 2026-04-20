/// Homeostasis — Slow weakening / pruning (LTD analog).
///
/// Connections that are never re-activated, reinforced, or replayed
/// gradually weaken. Below a floor threshold they are removed,
/// keeping the field sparse and preventing saturation.
use crate::core::Universe;

pub struct HomeostasisConfig {
    pub min_age_secs: u64,
    pub stale_access_secs: u64,
    pub decay_strength_ceiling: f32,
    pub decay_rate: f32,
    pub prune_threshold: f32,
}

impl Default for HomeostasisConfig {
    fn default() -> Self {
        Self {
            min_age_secs: 86400,          // 1 day
            stale_access_secs: 5 * 86400, // 5 days
            decay_strength_ceiling: 2.0,
            decay_rate: 0.06,
            prune_threshold: 0.09,
        }
    }
}

#[derive(Debug)]
pub struct HomeostasisResult {
    pub decayed: usize,
    pub pruned: usize,
}

/// Run homeostasis: decay stale weak cells, prune below threshold.
pub fn run_homeostasis(universe: &mut Universe, config: &HomeostasisConfig) -> HomeostasisResult {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut decayed = 0;
    let mut to_remove = Vec::new();

    for (i, cell) in universe.cells().iter().enumerate() {
        // Never decay promoted beliefs or seeds
        if cell.source == "promoted-dream" || cell.source == "seed" {
            continue;
        }

        // Must be old enough
        let age = now.saturating_sub(cell.created);
        if age < config.min_age_secs {
            continue;
        }

        // Only decay weak cells
        if cell.strength >= config.decay_strength_ceiling {
            continue;
        }

        // Compute decay amount
        let stale_factor = (age as f32 / (30.0 * 86400.0)).min(1.0);
        let weak_factor = (1.0 - cell.strength / config.decay_strength_ceiling).max(0.0);
        let amount = config.decay_rate * (0.5 + stale_factor * 0.3 + weak_factor * 0.2);

        let new_strength = cell.strength - amount;
        if new_strength < config.prune_threshold {
            to_remove.push(i);
        } else {
            decayed += 1;
        }
    }

    // Apply decay to cells not being removed
    let cells = universe.cells_mut();
    for (i, cell) in cells.iter_mut().enumerate() {
        if to_remove.contains(&i) {
            continue;
        }
        if cell.source == "promoted-dream" || cell.source == "seed" {
            continue;
        }

        let age = now.saturating_sub(cell.created);
        if age < config.min_age_secs {
            continue;
        }
        if cell.strength >= config.decay_strength_ceiling {
            continue;
        }

        let stale_factor = (age as f32 / (30.0 * 86400.0)).min(1.0);
        let weak_factor = (1.0 - cell.strength / config.decay_strength_ceiling).max(0.0);
        let amount = config.decay_rate * (0.5 + stale_factor * 0.3 + weak_factor * 0.2);
        cell.strength = (cell.strength - amount).max(0.0);
    }

    // Remove pruned cells (reverse order to maintain indices)
    let pruned = to_remove.len();
    for &i in to_remove.iter().rev() {
        cells.remove(i);
    }

    HomeostasisResult { decayed, pruned }
}
