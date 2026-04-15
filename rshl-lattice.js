"use strict";

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

function textEq(a, b) {
    return String(a || "").trim() === String(b || "").trim();
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

            if (overlap < 0.18 || overlap > 0.88) continue;

            const targetBand = 1 - Math.abs(overlap - 0.52);
            const replayMean = ((candA.replayPriority || 0) + (candB.replayPriority || 0)) / 2;
            const contradictionMean =
                ((((a.meta && a.meta.contradiction) || 0) + ((b.meta && b.meta.contradiction) || 0)) / 2);
            const noveltyMean =
                ((((a.meta && a.meta.novelty) || 0) + ((b.meta && b.meta.novelty) || 0)) / 2);
            const unresolvedBoost =
                (a.meta && a.meta.unresolved ? 0.10 : 0) +
                (b.meta && b.meta.unresolved ? 0.10 : 0);
            const crossRegionBoost = a.region !== b.region ? 0.12 : 0;

            // Penalize near-duplicate pairs more aggressively
            const duplicatePenalty = overlap > 0.72 ? (overlap - 0.72) * 0.65 : 0;

            const pairScore =
                (replayMean * 0.40) +
                (targetBand * 0.28) +
                (contradictionMean * 0.10) +
                (noveltyMean * 0.08) +
                unresolvedBoost +
                crossRegionBoost -
                duplicatePenalty;

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

function pickBestInsight(decoded, sourceA, sourceB) {
    const matches = Array.isArray(decoded.matches) ? decoded.matches : [];

    // Prefer the strongest non-source match
    const nonSource = matches.find(m =>
        !textEq(m.text, sourceA.text) && !textEq(m.text, sourceB.text)
    );

    if (nonSource) {
        return {
            text: nonSource.text,
            score: nonSource.score,
            usedNonSource: true,
        };
    }

    // Fall back to top decoded result
    return {
        text: decoded.text,
        score: decoded.score,
        usedNonSource: false,
    };
}

function consolidate(plasma, options = {}) {
    const candidateLimit = options.candidateLimit || 14;
    const goalText = options.goalText || DEFAULT_GOAL_TEXT;

    const candidates = universe.rankReplayCandidates(candidateLimit);
    if (!candidates || candidates.length < 2) return null;

    const pair = selectDreamPair(candidates);
    if (!pair) return null;

    universe.markReplayed(pair.a.id);
    universe.markReplayed(pair.b.id);

    const synthetic = bundleVectors([pair.a.raw, pair.b.raw]);
    const decoded = cleanup(synthetic, 5);
    const chosen = pickBestInsight(decoded, pair.a, pair.b);

    // winnerKey is based on the insight text alone (not source cell IDs) so
    // that tau accumulates whenever the same insight recurs across any pair —
    // matching how biological replay values recurrence of the PATTERN, not
    // recurrence of the exact same source neurons.
    const winnerKey = makeWinnerKey([chosen.text || "no-idea"]);

    const field = computeFieldState({
        syntheticVec: synthetic,
        sourceCells: [pair.a, pair.b],
        candidateScores: [pair.overlap, clamp01(chosen.score)],
        goalText,
        winnerKey,
        history: DREAM_HISTORY,
    });

    const duplicateEcho =
        textEq(chosen.text, pair.a.text) || textEq(chosen.text, pair.b.text);

    const promotionReady =
        !duplicateEcho &&
        chosen.text !== "no strong concept found" &&
        chosen.score >= 0.64 &&
        field.C >= 0.16 &&
        field.chi <= 0.45 &&
        field.phi_g >= 0.03;

    const reinforceBy = promotionReady
        ? Math.max(0.05, Math.min(0.30, field.Wm * 0.60))
        : (field.Wm >= 0.10 ? Math.max(0.02, Math.min(0.08, field.Wm * 0.20)) : 0);

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
        insight: chosen.text,
        confidence: chosen.score,
        vector: synthetic,
        field,
        promotionReady,
        sourceReinforcement: reinforceBy,
        contradictionPressure: field.X,
        duplicateEcho,
        usedNonSourceInsight: chosen.usedNonSource,
    };
}

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