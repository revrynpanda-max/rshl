"use strict";

/**
 * promotion.js — Belief Formation / Long-Term Potentiation Layer
 *
 * Biology analog: Repeated, stable, goal-aligned co-activation with low
 * contradiction earns a pattern permanent synaptic change (LTP). Here,
 * a dream candidate that meets all thresholds gets written back into
 * universe as durable memory — it becomes a belief.
 *
 * Promotion requires ALL of:
 *   1. seenCount >= THRESHOLDS.seenCount        (must recur, not one-shot)
 *   2. bestC >= THRESHOLDS.bestC                (commit readiness proven)
 *   3. bestPhi_g >= THRESHOLDS.bestPhi_g        (emergence quality proven)
 *   4. bestConfidence >= THRESHOLDS.bestConf    (cleanup match quality)
 *   5. meanContradiction <= THRESHOLDS.maxChi   (contradiction must be low)
 *   6. contradictionStddev <= THRESHOLDS.maxChiSd  (must be STABLE, not spiking)
 *   7. nonSourceRatio >= THRESHOLDS.minNSR      (must be genuine insight, not echo)
 *
 * Competition: before promotion, candidates within the same "cluster"
 * (resonance > 0.72 between their universe vectors) compete — only the
 * highest-scoring wins; others are suppressed for this cycle.
 */

const universe        = require('./universe');
const candidateBuffer = require('./candidate-buffer');
const { textVec, resonance } = require('./rshl-core');
const { clamp01, mean, stddev } = require('./field-state');

// ── Promotion thresholds ──────────────────────────────────────────────────────
// Calibrated to the actual field output range.
// With rho ≈ activeCount/totalCount (e.g. 2/33 ≈ 0.09 for a seeded universe),
// phi_g peaks around 0.03–0.06 and C peaks around 0.015–0.040.
// Thresholds must be set relative to what the field can actually produce —
// not abstract [0,1] ideals — so that promotion is achievable but not trivial.
const THRESHOLDS = {
    seenCount:   3,     // Must recur in at least 3 independent dream cycles
    bestC:       0.015, // Minimum commit readiness (C = phi_g × (1-chi) × tau)
    bestPhi_g:   0.024, // Minimum integrated goal-aligned emergence
    bestConf:    0.72,  // Minimum attractor cleanup confidence (field scores high here)
    maxChi:      0.38,  // Mean contradiction must stay below this
    maxChiSd:    0.28,  // Contradiction must be stable (not oscillating)
    minNSR:      0.35,  // At least 35% of sightings must be non-source insight
    competeSim:  0.72,  // Vector similarity threshold for competition grouping
};

// ── Scoring ───────────────────────────────────────────────────────────────────
function _score(entry) {
    const nsr       = entry.seenCount > 0 ? entry.nonSourceCount / entry.seenCount : 0;
    const chiMean   = mean(entry.contradictionHistory);
    const stability = clamp01(1 - stddev(entry.phiHistory || [entry.bestPhi_g]));
    return (
        entry.bestPhi_g   * 0.30 +
        entry.bestC       * 0.25 +
        entry.bestConf    * 0.15 +
        nsr               * 0.15 +
        stability         * 0.10 +
        clamp01(1 - chiMean) * 0.05
    );
}

// ── Gate check ────────────────────────────────────────────────────────────────
function _passesThresholds(entry) {
    if (entry.status !== candidateBuffer.STATUS.CANDIDATE) return { pass: false, reason: 'not-candidate' };
    if (entry.seenCount < THRESHOLDS.seenCount)            return { pass: false, reason: 'seen-count' };
    if (entry.bestC     < THRESHOLDS.bestC)                return { pass: false, reason: 'best-C' };
    if (entry.bestPhi_g < THRESHOLDS.bestPhi_g)            return { pass: false, reason: 'best-phi_g' };
    if (entry.bestConfidence < THRESHOLDS.bestConf)        return { pass: false, reason: 'best-confidence' };

    const ch = entry.contradictionHistory;
    if (!ch || !ch.length)                                 return { pass: false, reason: 'no-chi-history' };

    const chiMean = mean(ch);
    if (chiMean > THRESHOLDS.maxChi)                       return { pass: false, reason: 'chi-too-high' };

    const chiSd = stddev(ch);
    if (chiSd > THRESHOLDS.maxChiSd)                       return { pass: false, reason: 'chi-unstable' };

    const nsr = entry.seenCount > 0 ? entry.nonSourceCount / entry.seenCount : 0;
    if (nsr < THRESHOLDS.minNSR)                           return { pass: false, reason: 'echo-ratio' };

    return { pass: true };
}

// ── Competition: cluster threshold-passing candidates by vector similarity ────
// Within each cluster, only the highest scorer is allowed to promote this cycle.
function _resolveCompetition(eligibles) {
    if (!eligibles.length) return [];

    // Compute vectors for each eligible candidate
    const withVecs = eligibles.map(e => ({
        entry: e,
        vec: textVec(e.text),
        score: _score(e),
    }));

    const suppressed = new Set();
    const winners    = [];

    for (let i = 0; i < withVecs.length; i++) {
        if (suppressed.has(i)) continue;
        let bestIdx = i;

        for (let j = i + 1; j < withVecs.length; j++) {
            if (suppressed.has(j)) continue;
            const sim = clamp01(resonance(withVecs[i].vec, withVecs[j].vec));
            if (sim >= THRESHOLDS.competeSim) {
                // Same cluster — keep the higher scorer, suppress the other
                if (withVecs[j].score > withVecs[bestIdx].score) {
                    suppressed.add(bestIdx);
                    bestIdx = j;
                } else {
                    suppressed.add(j);
                }
            }
        }

        if (!suppressed.has(bestIdx)) {
            winners.push(withVecs[bestIdx].entry);
        }
    }

    return winners;
}

// ── Main promotion run ────────────────────────────────────────────────────────
function runPromotion() {
    const all       = candidateBuffer.getAll();
    const eligible  = [];
    const failLog   = [];

    for (const entry of all) {
        const check = _passesThresholds(entry);
        if (check.pass) {
            eligible.push(entry);
        } else if (entry.status === candidateBuffer.STATUS.CANDIDATE) {
            failLog.push({ key: entry.key, reason: check.reason });
        }
    }

    const winners   = _resolveCompetition(eligible);
    const promoted  = [];

    for (const entry of winners) {
        const chiMean   = mean(entry.contradictionHistory);
        const stability = clamp01(1 - stddev(entry.phiHistory || [entry.bestPhi_g]));

        // Map field quality into universe strength (range 1.5–4.0)
        const rawStrength = clamp01(entry.bestC * 2.5 + entry.bestPhi_g * 1.5 + stability * 0.5);
        const strength    = 1.5 + rawStrength * 2.5; // maps [0,1] → [1.5, 4.0]

        universe.store(entry.text, 'memory', {
            source:        'promoted-dream',
            strength,
            novelty:       clamp01(entry.bestPhi_g),
            contradiction: chiMean,
            unresolved:    false,
            promotedAt:    Date.now(),
            seenCount:     entry.seenCount,
            bestC:         entry.bestC,
            bestPhi_g:     entry.bestPhi_g,
            score:         _score(entry),
        });

        candidateBuffer.markPromoted(entry.key);
        promoted.push({
            text:     entry.text,
            seenCount: entry.seenCount,
            bestC:    entry.bestC,
            bestPhi_g: entry.bestPhi_g,
            strength,
        });
    }

    return { promoted, failLog, eligible: eligible.length };
}

module.exports = {
    THRESHOLDS,
    runPromotion,
};
