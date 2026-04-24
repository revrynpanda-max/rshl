"use strict";

const universe = require("./universe");
const { textVec, resonance } = require("./rshl-core");

function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function mean(arr) {
    if (!arr || !arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr) {
    if (!arr || arr.length < 2) return 0;
    const m = mean(arr);
    const variance = mean(arr.map(v => (v - m) ** 2));
    return Math.sqrt(variance);
}

function recencyWeightFromTs(ts) {
    if (!ts) return 1;
    const ageDays = Math.max(0, (Date.now() - ts) / 86400000);
    return Math.exp(-ageDays / 180);
}

function makeWinnerKey(parts) {
    return parts.map(x => String(x)).join("::");
}

function computeTau(history, winnerKey, windowSize = 8) {
    if (!winnerKey) return 0;
    const tail = (history || []).slice(-windowSize);
    if (!tail.length) return 1;
    const matches = tail.filter(h => h && h.winnerKey === winnerKey).length;
    return clamp01(matches / tail.length);
}

function computeGoalAlignment(goalText, syntheticVec) {
    if (!goalText || !syntheticVec) return 1;
    const goalVec = textVec(goalText);
    return clamp01(resonance(goalVec, syntheticVec));
}

function computeContradiction(sourceCells, candidateScores) {
    const pairDisagreement = [];
    for (let i = 0; i < sourceCells.length; i++) {
        for (let j = i + 1; j < sourceCells.length; j++) {
            const a = sourceCells[i];
            const b = sourceCells[j];
            if (!a || !b || !a.raw || !b.raw) continue;
            pairDisagreement.push(1 - clamp01(resonance(a.raw, b.raw)));
        }
    }

    const metaContradiction = sourceCells.length
        ? mean(sourceCells.map(c => clamp01((c.meta && c.meta.contradiction) || 0)))
        : 0;

    const scoreDisagreement = candidateScores && candidateScores.length
        ? mean(candidateScores.map(s => 1 - clamp01(s)))
        : 0;

    return clamp01(mean([
        pairDisagreement.length ? mean(pairDisagreement) : 0,
        metaContradiction,
        scoreDisagreement
    ]));
}

function computeFieldState({
    syntheticVec,
    sourceCells = [],
    candidateScores = [],
    goalText = "",
    winnerKey = "",
    history = [],
}) {
    const totalCount = typeof universe.count === "function"
        ? Math.max(1, universe.count())
        : Math.max(1, (typeof universe.getCells === "function" ? universe.getCells().length : 1));

    const activeCount = Math.max(1, sourceCells.length + (syntheticVec ? 1 : 0));
    const rho = clamp01(activeCount / totalCount);

    const coherenceSamples = [];

    if (candidateScores && candidateScores.length) {
        for (const s of candidateScores) coherenceSamples.push(clamp01(s));
    }

    if (syntheticVec) {
        for (const cell of sourceCells) {
            if (!cell || !cell.raw) continue;
            coherenceSamples.push(clamp01(resonance(cell.raw, syntheticVec)));
        }
    }

    for (let i = 0; i < sourceCells.length; i++) {
        for (let j = i + 1; j < sourceCells.length; j++) {
            const a = sourceCells[i];
            const b = sourceCells[j];
            if (!a || !b || !a.raw || !b.raw) continue;
            coherenceSamples.push(clamp01(resonance(a.raw, b.raw)));
        }
    }

    const R = clamp01(mean(coherenceSamples.length ? coherenceSamples : [0]));
    const s = clamp01(1 / (1 + stddev(coherenceSamples.length ? coherenceSamples : [0])));

    const g = computeGoalAlignment(goalText, syntheticVec);
    const chi = computeContradiction(sourceCells, coherenceSamples);
    const tau = computeTau(history, winnerKey, 8);

    const phi = clamp01(rho * (R ** 2) * s);
    const phi_c = clamp01(phi * (1 - chi));
    const phi_g = clamp01(phi_c * g);

    const prev = history && history.length ? clamp01(history[history.length - 1].phi_g || 0) : 0;
    const M = phi_g - prev;

    const X = clamp01(chi * (1 - R));

    const topSource = sourceCells[0] || null;
    const r = topSource ? recencyWeightFromTs(topSource.ts) : 1;
    const u = sourceCells.length
        ? clamp01(mean(sourceCells.map(c => ((c.strength || 1) / 5))))
        : 0;

    const C = clamp01(phi_g * (1 - chi) * tau);
    const Wm = clamp01(phi_g * r);
    const q = clamp01(1 - R);
    const Pr = clamp01(((1 - phi_g) + chi + q) / 3);

    return {
        rho,
        R,
        s,
        g,
        chi,
        tau,
        r,
        u,
        q,
        phi,
        phi_c,
        phi_g,
        M,
        X,
        C,
        Wm,
        Pr,
    };
}

module.exports = {
    clamp01,
    mean,
    stddev,
    recencyWeightFromTs,
    makeWinnerKey,
    computeFieldState,
};