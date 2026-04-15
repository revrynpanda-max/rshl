"use strict";

/**
 * phase4-test.js — Phase 4 Integration Test
 *
 * Runs the full pipeline:
 *   seed → dream cycles → candidate buffer → promotion → homeostasis
 *
 * Simulates what the heartbeat does in real time, but synchronously
 * for easy inspection of each stage.
 */

require('./seed'); // seeds universe with KAI identity + 4 fluid mass

const { consolidate }     = require('./rshl-lattice');
const candidateBuffer     = require('./candidate-buffer');
const { runPromotion }    = require('./promotion');
const { runHomeostasis }  = require('./homeostasis');
const universe            = require('./universe');
const { Plasma }          = require('./plasma');

const plasma = new Plasma(false); // don't clear — seed already populated

const CYCLES    = 20;
const GOAL_TEXT = 'coherent world understanding with low contradiction and natural intelligence growth';

console.log('\n=== PHASE 4 TEST START ===');
console.log(`Universe size after seed: ${universe.count()} cells\n`);

// ── Dream cycles ─────────────────────────────────────────────────────────────
for (let i = 0; i < CYCLES; i++) {
    const result = consolidate(plasma, { goalText: GOAL_TEXT });

    if (!result) {
        console.log(`Dream ${i + 1}: no viable pair`);
        continue;
    }

    const entry = candidateBuffer.observe(result);

    const fieldStr = result.field
        ? `phi_g=${result.field.phi_g.toFixed(3)} C=${result.field.C.toFixed(3)} chi=${result.field.chi.toFixed(3)}`
        : 'no-field';

    console.log(
        `Dream ${String(i + 1).padStart(2)}: ` +
        `"${result.insight.slice(0, 60)}" ` +
        `[conf=${result.confidence.toFixed(3)} ${fieldStr}] ` +
        `dup=${result.duplicateEcho} ns=${result.usedNonSourceInsight} ` +
        `${entry ? `→ seen=${entry.seenCount}` : '→ no-entry'}`
    );
}

// ── Candidate buffer snapshot ─────────────────────────────────────────────────
const allCandidates = candidateBuffer.getAll();
console.log(`\n── Candidate Buffer (${allCandidates.length} entries) ──`);
allCandidates
    .sort((a, b) => b.seenCount - a.seenCount)
    .forEach(c => {
        console.log(
            `  [${c.status.toUpperCase().padEnd(9)}] seen=${c.seenCount} ` +
            `bestC=${c.bestC.toFixed(3)} phi_g=${c.bestPhi_g.toFixed(3)} ` +
            `ns=${c.nonSourceCount}/${c.seenCount} ` +
            `"${c.text.slice(0, 55)}"`
        );
    });

// ── Promotion run ─────────────────────────────────────────────────────────────
console.log('\n── Running Promotion ──');
const { promoted, failLog, eligible } = runPromotion();

if (promoted.length) {
    console.log(`Promoted ${promoted.length} candidate(s) into universe:`);
    promoted.forEach(p => {
        console.log(
            `  ✓ "${p.text.slice(0, 60)}" ` +
            `(seen=${p.seenCount} bestC=${p.bestC.toFixed(3)} strength=${p.strength.toFixed(2)})`
        );
    });
} else {
    console.log('No promotions yet (thresholds not met — run more dream cycles).');
    if (failLog.length) {
        const reasons = {};
        failLog.forEach(f => { reasons[f.reason] = (reasons[f.reason] || 0) + 1; });
        console.log('  Fail reasons:', reasons);
    }
}

// ── Homeostasis ───────────────────────────────────────────────────────────────
console.log('\n── Running Homeostasis ──');
const { decayed, pruned } = runHomeostasis();
console.log(`  Decayed: ${decayed.length}  Pruned: ${pruned.length}`);
if (pruned.length) {
    pruned.forEach(p => console.log(`  ✗ pruned: "${p.text.slice(0, 50)}" (was ${p.finalStrength.toFixed(3)})`));
}

// ── Final universe state ──────────────────────────────────────────────────────
console.log(`\nUniverse size after homeostasis: ${universe.count()} cells`);
console.log('=== PHASE 4 TEST END ===\n');
