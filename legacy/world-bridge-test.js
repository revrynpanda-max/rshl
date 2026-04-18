"use strict";

/**
 * world-bridge-test.js — World Bridge Integration Test
 *
 * Tests the full external intake pipeline:
 *   seed → manual observations → redundancy check → dream cycles →
 *   candidate buffer → promotion check
 *
 * Also tests GitHub intake against the rshl repo (public, no token needed).
 */

require('./seed'); // seeds universe with KAI identity

const universe        = require('./universe');
const bridge          = require('./world-bridge');
const { consolidate } = require('./rshl-lattice');
const candidateBuffer = require('./candidate-buffer');
const { runPromotion } = require('./promotion');
const { Plasma }      = require('./plasma');

const plasma = new Plasma(false);
const GOAL_TEXT = 'coherent world understanding with low contradiction and natural intelligence growth';

console.log('\n=== WORLD BRIDGE TEST START ===');
console.log(`Universe after seed: ${universe.count()} cells\n`);

// ── Test 1: Manual observation intake ──────────────────────────────────────────
console.log('── Test 1: Manual Observations ──');

const observations = [
    "Water molecules form hydrogen bonds that give liquid water its high surface tension.",
    "The speed of light in vacuum is approximately 299,792,458 meters per second.",
    "Sparse distributed memory was proposed by Pentti Kanerva in 1988 at NASA Ames.",
    "The ryanodine receptor is a calcium release channel found in the sarcoplasmic reticulum.",
    "Hippocampal sharp-wave ripples occur during sleep and quiet wakefulness.",
    "Hebbian learning states that neurons that fire together wire together.",
    "The FNV-1a hash function uses XOR folding for uniform distribution.",
    // This one should be redundant with existing seed data:
    "My entire existence is a 4096-dimensional sparse ternary vector field.",
    // Too short — should be skipped:
    "Hi there.",
];

let stored = 0;
let skipped = 0;

for (const obs of observations) {
    const result = bridge.ingest(obs, { source: 'manual', topic: 'research' });
    const status = result.stored ? '✓ STORED' : `✗ SKIP (${result.reason})`;
    console.log(`  ${status}: "${obs.slice(0, 65)}"`);
    if (result.stored) stored++;
    else skipped++;
}

console.log(`  → ${stored} stored, ${skipped} skipped\n`);

// ── Test 2: Batch intake with fact extraction ──────────────────────────────────
console.log('── Test 2: Batch Intake with Extraction ──');

const textBlocks = [
    `Vector Symbolic Architectures use high-dimensional vectors for structured 
     representation. Binding and bundling are the core operations. Cleanup 
     memory maps noisy composites back to clean stored patterns. This approach 
     avoids backpropagation entirely.`,
    `Long-term potentiation strengthens synaptic connections through repeated 
     activation. Long-term depression weakens connections that are not 
     reinforced. Together they maintain homeostatic balance in neural circuits.`,
];

const batchResult = bridge.ingestBatch(textBlocks, {
    source: 'manual',
    topic: 'neuroscience-hdc',
});

console.log(`  Batch: ${batchResult.stored} stored, ${batchResult.skipped} skipped`);
batchResult.results.forEach(r => {
    const tag = r.stored ? '✓' : '✗';
    console.log(`    ${tag} "${r.text}"`);
});

// ── Test 3: Redundancy detection ───────────────────────────────────────────────
console.log('\n── Test 3: Redundancy Detection ──');

const dupCheck1 = bridge.isRedundant("I reason through direct geometric resonance, never through statistical prediction.");
console.log(`  Seed-similar text: redundant=${dupCheck1.redundant} ${dupCheck1.redundant ? 'sim=' + dupCheck1.sim.toFixed(3) : ''}`);

const dupCheck2 = bridge.isRedundant("Jupiter has 95 known moons orbiting it.");
console.log(`  Novel text:        redundant=${dupCheck2.redundant}`);

// ── Test 4: Fact extraction ────────────────────────────────────────────────────
console.log('\n── Test 4: Fact Extraction ──');

const rawText = `The brain uses sparse coding to represent sensory information efficiently.
This means only a small fraction of neurons are active at any given time.
Sparse representations are more energy-efficient and less prone to interference.
<script>alert('noise')</script>
# This is a comment that should be filtered out.
OK.`;

const facts = bridge.extractFacts(rawText);
console.log(`  Extracted ${facts.length} facts from ${rawText.split('\n').length} lines:`);
facts.forEach(f => console.log(`    → "${f}"`));

// ── Test 5: Dream cycles with external observations ────────────────────────────
console.log(`\n── Test 5: Dream Cycles (universe now has ${universe.count()} cells) ──`);

const DREAM_CYCLES = 15;
for (let i = 0; i < DREAM_CYCLES; i++) {
    const result = consolidate(plasma, { goalText: GOAL_TEXT });
    if (!result) {
        console.log(`  Dream ${i + 1}: no viable pair`);
        continue;
    }

    const entry = candidateBuffer.observe(result);
    const fieldStr = result.field
        ? `phi_g=${result.field.phi_g.toFixed(3)} C=${result.field.C.toFixed(3)}`
        : 'no-field';

    console.log(
        `  Dream ${String(i + 1).padStart(2)}: ` +
        `"${result.insight.slice(0, 55)}" ` +
        `[${fieldStr}] ` +
        `ns=${result.usedNonSourceInsight} ` +
        `${entry ? `seen=${entry.seenCount}` : 'no-entry'}`
    );
}

// ── Test 6: Promotion check ────────────────────────────────────────────────────
console.log('\n── Test 6: Promotion Check ──');
const { promoted, failLog } = runPromotion();

if (promoted.length) {
    console.log(`  Promoted ${promoted.length} candidate(s):`);
    promoted.forEach(p => {
        console.log(`    ✓ "${p.text.slice(0, 60)}" (seen=${p.seenCount} str=${p.strength.toFixed(2)})`);
    });
} else {
    console.log('  No promotions yet.');
    if (failLog.length) {
        const reasons = {};
        failLog.forEach(f => { reasons[f.reason] = (reasons[f.reason] || 0) + 1; });
        console.log('  Fail reasons:', reasons);
    }
}

// ── Test 7: Bridge stats ───────────────────────────────────────────────────────
console.log('\n── Test 7: Bridge Statistics ──');
const stats = bridge.getStats();
console.log(`  Total field cells:    ${stats.totalField}`);
console.log(`  External cells:       ${stats.totalExternal}`);
console.log(`  External ratio:       ${(stats.externalRatio * 100).toFixed(1)}%`);
console.log(`  By source:            ${JSON.stringify(stats.bySource)}`);
console.log(`  Mean ext. strength:   ${stats.meanStrength.toFixed(3)}`);
console.log(`  Intake log entries:   ${stats.logEntries}`);

console.log(`\nUniverse final: ${universe.count()} cells`);
console.log('=== WORLD BRIDGE TEST END ===\n');

// ── Test 8: GitHub intake (async — runs after sync tests) ──────────────────────
(async () => {
    console.log('── Test 8: GitHub Intake (async) ──');
    try {
        const ghResult = await bridge.ingestFromGitHub('revrynpanda-max', 'rshl', {
            includeReadme: true,
            includeCommits: true,
            maxCommits: 5,
        });

        console.log(`  GitHub: ${ghResult.stored} stored, ${ghResult.skipped} skipped`);
        if (ghResult.error) console.log(`  Error: ${ghResult.error}`);
        if (ghResult.results) {
            ghResult.results.slice(0, 8).forEach(r => {
                const tag = r.stored ? '✓' : '✗';
                console.log(`    ${tag} "${r.text}"`);
            });
        }

        // Final stats after GitHub intake
        const finalStats = bridge.getStats();
        console.log(`\n  Final field:   ${finalStats.totalField} cells`);
        console.log(`  External:      ${finalStats.totalExternal} (${(finalStats.externalRatio * 100).toFixed(1)}%)`);
        console.log(`  By source:     ${JSON.stringify(finalStats.bySource)}`);

    } catch (err) {
        console.log(`  GitHub test failed: ${err.message}`);
    }

    console.log('=== GITHUB TEST END ===\n');
})();
