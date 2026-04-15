"use strict";

/**
 * homeostasis.js — Slow Weakening / Pruning Layer (LTD Analog)
 *
 * Biology analog: Long-term depression (LTD) and synaptic pruning.
 * Connections that are never re-activated, never reinforced, and never
 * replayed gradually weaken. Below a floor threshold they are removed
 * entirely, keeping the field sparse and preventing saturation.
 *
 * A cell is eligible for decay if ALL of:
 *   - age > MIN_AGE_DAYS (don't touch freshly stored patterns)
 *   - lastAccessed is stale (not queried recently)
 *   - dreamCount is 0 (never replayed)
 *   - strength < DECAY_STRENGTH_CEILING (only decay weak cells)
 *   - source !== 'promoted-dream' (never decay promoted beliefs)
 *
 * Decay amount scales with how stale and weak the cell already is.
 * Cells that fall below PRUNE_THRESHOLD are removed from the field.
 */

const universe = require('./universe');

const CONFIG = {
    minAgeDays:           1,     // Don't touch cells younger than this
    staleAccessDays:      5,     // "Stale" = not accessed in this many days
    decayStrengthCeiling: 2.0,   // Only decay cells weaker than this
    decayRate:            0.06,  // Strength reduction per homeostasis cycle
    pruneThreshold:       0.09,  // Cells below this are removed entirely
    maxDreamCount:        0,     // Replayed cells are protected
    protectedSources: new Set(['promoted-dream', 'seed']),
};

function _daysSince(ts, now) {
    if (!ts) return Infinity;
    return Math.max(0, (now - ts) / 86400000);
}

function _isDecayEligible(cell, now) {
    // Never decay protected sources
    const src = (cell.meta && cell.meta.source) || '';
    if (CONFIG.protectedSources.has(src)) return false;

    // Must be old enough to consider
    const ageDays = _daysSince(cell.ts, now);
    if (ageDays < CONFIG.minAgeDays) return false;

    // Must be stale (not recently queried)
    const lastAccessDays = _daysSince(cell.lastAccessed || 0, now);
    if (lastAccessDays < CONFIG.staleAccessDays) return false;

    // Must have never been replayed (dream count = 0)
    if ((cell.dreamCount || 0) > CONFIG.maxDreamCount) return false;

    // Only decay genuinely weak cells
    if ((cell.strength || 1) >= CONFIG.decayStrengthCeiling) return false;

    return true;
}

/**
 * runHomeostasis()
 * Scans all cells. Decays eligible ones. Prunes those below floor.
 * Returns { decayed: [...], pruned: [...] }
 */
function runHomeostasis() {
    const cells   = universe.getCells();
    const now     = Date.now();
    const decayed = [];
    const pruned  = [];

    for (const cell of cells) {
        if (!_isDecayEligible(cell, now)) continue;

        const staleFactor = Math.min(1, _daysSince(cell.lastAccessed || 0, now) / 30);
        const weakFactor  = Math.max(0, 1 - (cell.strength / CONFIG.decayStrengthCeiling));
        const amount      = CONFIG.decayRate * (0.5 + staleFactor * 0.3 + weakFactor * 0.2);

        const newStrength = (cell.strength || 1) - amount;

        if (newStrength < CONFIG.pruneThreshold) {
            universe.removeCell(cell.id);
            pruned.push({ id: cell.id, text: cell.text, region: cell.region, finalStrength: cell.strength });
        } else {
            universe.reinforceCell(cell.id, -amount, { lastDecayed: now });
            decayed.push({ id: cell.id, text: cell.text, newStrength });
        }
    }

    return { decayed, pruned };
}

module.exports = {
    CONFIG,
    runHomeostasis,
};
