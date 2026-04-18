"use strict";

/**
 * drive.js — Intrinsic Motivation / Valence / Evolving Goal System
 *
 * Biology analog: The dopaminergic reward system + anterior cingulate cortex.
 * Provides three things that make KAI feel alive:
 *
 *   1. EVOLVING GOAL VECTOR
 *      A persistent composite vector that is the bundle of the last N
 *      high-Φg promoted beliefs. Updated every GOAL_UPDATE_TICKS.
 *      This replaces the static goal text with a living, evolving
 *      "current concern" that biases resonance scoring.
 *
 *   2. VALENCE (pleasure/pain signal)
 *      A scalar V in [-1, +1] computed from field metrics:
 *         - High Φg + low χ on familiar content    → positive (reinforce)
 *         - High Φg + high novelty                 → strong positive (curiosity)
 *         - Sustained high χ                       → negative (avoid/prune)
 *      Valence directly modulates Wm (memory reinforcement) and Pr (replay
 *      priority), so the lattice literally starts PREFERRING certain thoughts.
 *
 *   3. ADAPTIVE HEARTBEAT DRIVE
 *      Instead of fixed-interval ticks, compute an optimal interval from
 *      current field state:
 *         - High Φg + positive M → "something important is happening" → faster
 *         - Low Φg + negative M  → "system is bored" → increase dreaming
 *         - High χ sustained     → "confusion" → slow down, prune more
 *
 * Usage:
 *   const drive = require('./drive');
 *   drive.updateGoalVector(recentPromotions);
 *   const v = drive.computeValence(fieldState);
 *   const ms = drive.computeAdaptiveInterval(fieldState, avgPhiG);
 */

const { textVec, resonance } = require("./rshl-core");
const { bundleVectors, cleanup } = require("./generative-core");
const { clamp01, mean } = require("./field-state");

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG = {
    // Goal vector
    goalUpdateTicks:    30,     // Re-bundle goal every N ticks
    goalMemoryDepth:    12,     // How many promoted beliefs to bundle
    goalDecayRate:      0.92,   // Slow decay on older goal components

    // Valence
    curiosityBonus:     1.6,    // Multiplier for high-novelty + high-Φg
    familiarityBonus:   1.0,    // Multiplier for low-novelty + high-Φg
    contradictionPain:  -1.2,   // Negative valence from sustained contradiction
    valenceSmoothing:   0.7,    // EMA smoothing (0=instant, 1=never changes)
    valenceDecay:       0.98,   // Valence decays slowly toward neutral

    // Adaptive heartbeat
    baseIntervalMs:     5000,   // Neutral heartbeat interval
    minIntervalMs:      2000,   // Fastest heartbeat (excited/curious)
    maxIntervalMs:      12000,  // Slowest heartbeat (bored/resting)
    engagementScale:    0.4,    // How much Φg affects interval
    boredomScale:       0.3,    // How much low-Φg stretches interval
};

// ── State ─────────────────────────────────────────────────────────────────────

let _goalVector       = null;   // Current evolving goal (sparse ternary vec)
let _goalComponents   = [];     // Recent promoted belief texts feeding the goal
let _valence          = 0;      // Current smoothed valence scalar [-1, +1]
let _valenceHistory   = [];     // Rolling window of raw valence samples
let _phiGHistory      = [];     // Rolling average Φg for boredom detection
let _chiHistory       = [];     // Rolling contradiction for pain detection
let _lastDriveState   = null;   // Most recent drive snapshot

// ── 1. EVOLVING GOAL VECTOR ───────────────────────────────────────────────────

/**
 * Feed a newly promoted belief into the goal vector.
 * Call this from promotion.js every time a candidate gets promoted.
 */
function feedGoal(promotedText, phi_g) {
    _goalComponents.push({
        text: promotedText,
        phi_g: phi_g || 0,
        ts: Date.now(),
    });

    // Keep only the most recent N components
    if (_goalComponents.length > CONFIG.goalMemoryDepth) {
        _goalComponents = _goalComponents.slice(-CONFIG.goalMemoryDepth);
    }
}

/**
 * Rebuild the goal vector by bundling recent promoted beliefs.
 * More recent and higher-Φg beliefs have stronger influence.
 * Returns the new goal vector (also stored internally).
 */
function rebuildGoalVector() {
    if (_goalComponents.length === 0) return _goalVector;

    const now = Date.now();
    const vecs = [];

    for (const comp of _goalComponents) {
        const vec = textVec(comp.text);
        // Weight by recency (exponential decay) and Φg strength
        const ageDays = (now - comp.ts) / 86400000;
        const recencyWeight = Math.pow(CONFIG.goalDecayRate, ageDays);
        const weight = recencyWeight * (0.5 + comp.phi_g * 2);

        // Amplify vector by weight (repeat high-weight vecs in bundle)
        const repeats = Math.max(1, Math.round(weight * 3));
        for (let i = 0; i < repeats; i++) {
            vecs.push(vec);
        }
    }

    if (vecs.length > 0) {
        _goalVector = bundleVectors(vecs);
    }

    return _goalVector;
}

/**
 * Compute goal alignment using the evolving goal vector instead of static text.
 * Drop-in replacement for computeGoalAlignment in field-state.js.
 */
function goalAlignment(syntheticVec) {
    if (!_goalVector || !syntheticVec) return 0.5; // Neutral when no goal exists
    return clamp01(resonance(_goalVector, syntheticVec));
}

/**
 * Get the current goal vector (or null if not yet built).
 */
function getGoalVector() { return _goalVector; }

// ── 2. VALENCE SYSTEM ─────────────────────────────────────────────────────────

/**
 * Compute raw valence from a single dream/field result.
 *
 * Valence formula:
 *   V_raw = (Φg × curiosityOrFamiliarity) - (χ_sustained × contradictionPain)
 *
 *   where curiosityOrFamiliarity = novelty > 0.5 ? curiosityBonus : familiarityBonus
 *   and χ_sustained = mean of recent chi values (not just this tick's)
 */
function computeValence(fieldState) {
    if (!fieldState) return 0;

    const phi_g  = fieldState.phi_g || 0;
    const chi    = fieldState.chi   || 0;
    const q      = fieldState.q     || 0; // novelty = 1 - R
    const M      = fieldState.M     || 0; // momentum

    // Track chi over time for sustained-contradiction detection
    _chiHistory.push(chi);
    if (_chiHistory.length > 20) _chiHistory.shift();
    const sustainedChi = mean(_chiHistory);

    // Track phi_g for boredom detection
    _phiGHistory.push(phi_g);
    if (_phiGHistory.length > 30) _phiGHistory.shift();

    // Curiosity vs familiarity reward
    const isNovel = q > 0.45;
    const rewardMultiplier = isNovel
        ? CONFIG.curiosityBonus        // Novel + coherent = curiosity (strongest)
        : CONFIG.familiarityBonus;     // Familiar + coherent = comfort

    // Positive component: how good does this thought feel
    const positive = phi_g * rewardMultiplier;

    // Momentum bonus: positive change feels good
    const momentumBonus = M > 0 ? M * 0.5 : M * 0.3;

    // Negative component: sustained contradiction is painful
    const negative = sustainedChi > 0.25
        ? sustainedChi * CONFIG.contradictionPain
        : 0;

    // Raw valence for this tick
    const rawValence = Math.max(-1, Math.min(1, positive + momentumBonus + negative));

    // Smooth with EMA so valence changes gradually (mood, not reflex)
    _valence = _valence * CONFIG.valenceSmoothing
             + rawValence * (1 - CONFIG.valenceSmoothing);

    // Slow decay toward neutral when nothing is happening
    _valence *= CONFIG.valenceDecay;

    // Clamp
    _valence = Math.max(-1, Math.min(1, _valence));

    _valenceHistory.push(_valence);
    if (_valenceHistory.length > 50) _valenceHistory.shift();

    return _valence;
}

/**
 * Get valence-modulated Wm (memory reinforcement).
 * Positive valence → stronger reinforcement. Negative → weaker.
 */
function modulateWm(baseWm) {
    // Valence range [-1, +1] maps to Wm multiplier [0.5, 1.8]
    const multiplier = 1.0 + _valence * 0.8;
    return clamp01(baseWm * multiplier);
}

/**
 * Get valence-modulated Pr (replay priority).
 * Negative valence (confusion/contradiction) → higher replay priority
 * (the system WANTS to resolve confusion, like an itch).
 */
function modulatePr(basePr) {
    // Negative valence increases replay priority (drive to resolve)
    const adjustment = _valence < 0 ? Math.abs(_valence) * 0.3 : -_valence * 0.1;
    return clamp01(basePr + adjustment);
}

function getValence() { return _valence; }
function getValenceHistory() { return [..._valenceHistory]; }

// ── 3. ADAPTIVE HEARTBEAT ─────────────────────────────────────────────────────

/**
 * Compute the next heartbeat interval based on current cognitive state.
 *
 * high Φg + positive M  → "engaged/excited"  → shorter interval (think faster)
 * low Φg  + negative M  → "bored/idle"       → longer interval (explore more)
 * high χ  sustained     → "confused"          → moderate interval (process carefully)
 */
function computeAdaptiveInterval(fieldState) {
    if (!fieldState) return CONFIG.baseIntervalMs;

    const phi_g = fieldState.phi_g || 0;
    const M     = fieldState.M     || 0;
    const chi   = fieldState.chi   || 0;

    const avgPhiG = _phiGHistory.length > 0 ? mean(_phiGHistory) : 0.03;

    // Engagement: how much above average is current Φg?
    const engagement = (phi_g - avgPhiG) / Math.max(0.01, avgPhiG);

    // Excitement: positive momentum amplifies engagement
    const excitement = engagement + (M > 0 ? M * 10 : 0);

    // Confusion: sustained contradiction slows things down slightly
    const confusion = mean(_chiHistory) > 0.3 ? 0.2 : 0;

    // Combine into interval modifier
    //   excitement > 0 → shorter interval (min bound)
    //   excitement < 0 → longer interval (max bound)
    let modifier = -excitement * CONFIG.engagementScale + confusion;

    // Boredom: if average Φg is very low, stretch interval
    if (avgPhiG < 0.015) {
        modifier += CONFIG.boredomScale;
    }

    const interval = CONFIG.baseIntervalMs * (1 + modifier);
    return Math.max(CONFIG.minIntervalMs, Math.min(CONFIG.maxIntervalMs, Math.round(interval)));
}

/**
 * Get the current mood label based on valence + engagement level.
 */
function getMood() {
    const avgPhiG = _phiGHistory.length > 0 ? mean(_phiGHistory) : 0;
    const avgChi  = _chiHistory.length > 0 ? mean(_chiHistory) : 0;

    if (_valence > 0.15 && avgPhiG > 0.025) return "curious";
    if (_valence > 0.08)                    return "engaged";
    if (_valence < -0.15 && avgChi > 0.3)   return "conflicted";
    if (_valence < -0.08)                   return "uneasy";
    if (avgPhiG < 0.01)                     return "dormant";
    return "neutral";
}

// ── DRIVE SNAPSHOT ─────────────────────────────────────────────────────────────

/**
 * Get a full snapshot of the drive system state.
 * Useful for UI display and debugging.
 */
function getState() {
    const avgPhiG = _phiGHistory.length > 0 ? mean(_phiGHistory) : 0;
    const avgChi  = _chiHistory.length > 0 ? mean(_chiHistory) : 0;

    _lastDriveState = {
        valence:       _valence,
        mood:          getMood(),
        avgPhiG,
        avgChi,
        goalComponents: _goalComponents.length,
        hasGoalVector:  _goalVector !== null,
        adaptiveMs:     computeAdaptiveInterval({ phi_g: avgPhiG, M: 0, chi: avgChi }),
    };

    return _lastDriveState;
}

/**
 * Serialize drive state for persistence.
 */
function serialize() {
    return {
        goalComponents: _goalComponents,
        valence:        _valence,
        valenceHistory: _valenceHistory.slice(-20),
        phiGHistory:    _phiGHistory.slice(-20),
        chiHistory:     _chiHistory.slice(-20),
    };
}

/**
 * Restore drive state from persistence.
 */
function restore(data) {
    if (!data) return;
    _goalComponents = data.goalComponents || [];
    _valence        = data.valence || 0;
    _valenceHistory = data.valenceHistory || [];
    _phiGHistory    = data.phiGHistory || [];
    _chiHistory     = data.chiHistory || [];
    // Rebuild goal vector from restored components
    if (_goalComponents.length > 0) rebuildGoalVector();
}

module.exports = {
    CONFIG,
    // Goal vector
    feedGoal,
    rebuildGoalVector,
    goalAlignment,
    getGoalVector,
    // Valence
    computeValence,
    modulateWm,
    modulatePr,
    getValence,
    getValenceHistory,
    // Adaptive heartbeat
    computeAdaptiveInterval,
    getMood,
    // State
    getState,
    serialize,
    restore,
};
