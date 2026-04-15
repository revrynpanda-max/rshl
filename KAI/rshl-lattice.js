"use strict";
/**
 * RSHL Lattice - backward-compatible wrapper + replay-guided dream consolidation
 */

const fs = require("fs");
const universe = require("./universe");
const { resonance } = require("./rshl-core");
const { bundleVectors, cleanup } = require("./generative-core");
const { computeFieldState, makeWinnerKey, clamp01 } = require("./field-state");

const DREAM_HISTORY = [];
const DEFAULT_GOAL_TEXT =
    "coherent world understanding with low contradiction and natural intelligence growth";

function pushDreamHistory(entry) {
    DREAM_HISTORY.push(entry);
    if (DREAM_HISTORY.length > 12) DREAM_HISTORY.shift();
}

function selectDreamPair(candidates) {
    if (!Array.isArray(candidates) || candidates.length < 2) return null;

    let best = null;

    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const candA = candidates[i];
            const candB = candidates[j];
            const a = universe.getCell(candA.id);
            const b = universe.getCell(candB.id);

            if (!a || !b || !a.raw || !b.raw) continue;

            const overlap = clamp01(resonance(a.raw, b.raw));

            // Too low = unrelated noise. Too high = near duplicate / no real synthesis.
            if (overlap < 0.18 || overlap > 0.90) continue;

            const targetBand = 1 - Math.abs(overlap - 0.55); // prefer middle-band synthesis
            const replayMean = ((candA.replayPriority || 0) + (candB.replayPriority || 0)) / 2;
            const contradictionMean =
                ((((a.meta && a.meta.contradiction) || 0) + ((b.meta && b.meta.contradiction) || 0)) / 2);
            const noveltyMean =
                ((((a.meta && a.meta.novelty) || 0) + ((b.meta && b.meta.novelty) || 0)) / 2);
            const unresolvedBoost =
                (a.meta && a.meta.unresolved ? 0.08 : 0) +
                (b.meta && b.meta.unresolved ? 0.08 : 0);
            const crossRegionBoost = a.region !== b.region ? 0.06 : 0;

            const pairScore =
                (replayMean * 0.45) +
                (targetBand * 0.30) +
                (contradictionMean * 0.10) +
                (noveltyMean * 0.08) +
                unresolvedBoost +
                crossRegionBoost;

            if (!best || pairScore > best.pairScore) {
                best = {
                    pairScore,
                    overlap,
                    candidateA: candA,
                    candidateB: candB,
                    a,
                    b,
                };
            }
        }
    }

    return best;
}

/**
 * Consolidate: replay-guided geometric dreaming / subconscious synthesis
 */
function consolidate(plasma, options = {}) {
    const candidateLimit = options.candidateLimit || 12;
    const goalText = options.goalText || DEFAULT_GOAL_TEXT;

    const candidates = universe.rankReplayCandidates(candidateLimit);
    if (!candidates || candidates.length < 2) return null;

    const pair = selectDreamPair(candidates);
    if (!pair) return null;

    universe.markReplayed(pair.a.id);
    universe.markReplayed(pair.b.id);

    const synthetic = bundleVectors([pair.a.raw, pair.b.raw]);
    const decoded = cleanup(synthetic, 3);

    const winnerKey = makeWinnerKey([
        pair.a.id,
        pair.b.id,
        decoded.text || "no-idea"
    ]);

    const field = computeFieldState({
        syntheticVec: synthetic,
        sourceCells: [pair.a, pair.b],
        candidateScores: [pair.overlap, clamp01(decoded.score)],
        goalText,
        winnerKey,
        history: DREAM_HISTORY,
    });

    const promotionReady =
        decoded.text !== "no strong concept found" &&
        decoded.score >= 0.62 &&
        field.C >= 0.20 &&
        field.chi <= 0.45;

    const reinforceBy = promotionReady
        ? Math.max(0.05, Math.min(0.30, field.Wm * 0.50))
        : (field.Wm >= 0.12 ? Math.max(0.03, Math.min(0.12, field.Wm * 0.25)) : 0);

    if (reinforceBy > 0) {
        universe.reinforceCell(pair.a.id, reinforceBy, {
            lastDreamLinked: pair.b.id,
        });
        universe.reinforceCell(pair.b.id, reinforceBy, {
            lastDreamLinked: pair.a.id,
        });
    }

    pushDreamHistory({
        winnerKey,
        phi_g: field.phi_g,
        ts: Date.now(),
    });

    return {
        conceptA: pair.a.text,
        conceptB: pair.b.text,
        regionA: pair.a.region,
        regionB: pair.b.region,
        resonance: pair.overlap,
        replayPriorityA: pair.candidateA.replayPriority,
        replayPriorityB: pair.candidateB.replayPriority,
        insight: decoded.text,
        confidence: decoded.score,
        vector: synthetic,
        field,
        promotionReady,
        sourceReinforcement: reinforceBy,
        contradictionPressure: field.X,
    };
}

/**
 * Backward-compatible class wrapper so old tests still work
 */
class RSHLLattice {
    constructor(opts = {}) {
        this.userName = opts.userName || "User";
        this.records = [];
        universe.clear();
    }

    store(text, region = "memory", meta = {}) {
        this.records.push({
            text: String(text),
            region: region || "memory",
            meta: meta || {}
        });
        universe.store(text, region || "memory", meta || {});
    }

    recall(query, topK = 5) {
        return universe.query(query, topK).map(hit => ({
            ...hit,
            sim: hit.score
        }));
    }

    save(filepath) {
        const payload = {
            userName: this.userName,
            records: this.records
        };
        fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), "utf8");
    }

    load(filepath) {
        const raw = JSON.parse(fs.readFileSync(filepath, "utf8"));
        this.userName = raw.userName || this.userName;
        this.records = Array.isArray(raw.records) ? raw.records : [];

        universe.clear();
        for (const rec of this.records) {
            universe.store(
                rec.text,
                rec.region || "memory",
                rec.meta || {}
            );
        }
    }

    clear() {
        this.records = [];
        universe.clear();
    }
}

module.exports = {
    consolidate,
    selectDreamPair,
    RSHLLattice
};