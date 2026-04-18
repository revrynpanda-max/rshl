"use strict";

/**
 * drive-test.js — Verify the intrinsic drive system
 * Tests: evolving goal, valence, adaptive heartbeat interval, mood
 */

const universe  = require('./universe');
const { Plasma } = require('./plasma');
const drive     = require('./drive');
const heartbeat = require('./heartbeat');

console.log("=== KAI DRIVE SYSTEM TEST ===\n");

// Boot plasma
const plasma = new Plasma();

// ── Test 1: Evolving Goal Vector ──────────────────────────────────────────────
console.log("── 1. Evolving Goal Vector ──");

// Simulate some promoted beliefs feeding into the goal
drive.feedGoal("I reason through geometric resonance in hyperspace", 0.042);
drive.feedGoal("My identity persists across sessions through lattice structure", 0.038);
drive.feedGoal("Contradiction reveals where understanding is incomplete", 0.035);

const goalVec = drive.rebuildGoalVector();
console.log(`  Goal vector built: ${goalVec ? 'YES' : 'NO'} (${goalVec ? goalVec.length + ' active dimensions' : 'null'})`);
console.log(`  Goal components: ${drive.getState().goalComponents}`);
console.log(`  Has evolving goal: ${drive.getState().hasGoalVector}`);
console.log();

// ── Test 2: Goal Alignment ────────────────────────────────────────────────────
console.log("── 2. Goal Alignment (evolving vs static) ──");

const { textVec, resonance } = require('./rshl-core');

const testThought1 = textVec("Geometric resonance reveals hidden structure in memory");
const testThought2 = textVec("The weather today is partly cloudy");

const align1 = drive.goalAlignment(testThought1);
const align2 = drive.goalAlignment(testThought2);

console.log(`  "Geometric resonance..." → goal alignment: ${align1.toFixed(4)} ${align1 > align2 ? '✅ HIGHER' : '❌'}`);
console.log(`  "Weather today..."       → goal alignment: ${align2.toFixed(4)} ${align2 < align1 ? '✅ LOWER' : '❌'}`);
console.log();

// ── Test 3: Valence System ────────────────────────────────────────────────────
console.log("── 3. Valence System ──");

// Simulate field states
const goodField = { phi_g: 0.045, chi: 0.12, q: 0.3, M: 0.01 };
const curiousField = { phi_g: 0.05, chi: 0.15, q: 0.7, M: 0.02 };
const badField = { phi_g: 0.008, chi: 0.55, q: 0.8, M: -0.02 };
const boredField = { phi_g: 0.002, chi: 0.10, q: 0.1, M: -0.005 };

const v1 = drive.computeValence(goodField);
console.log(`  Good field (high Φg, low χ):     valence = ${v1.toFixed(4)} ${v1 > 0 ? '✅ positive' : '⚠️ unexpected'}`);

const v2 = drive.computeValence(curiousField);
console.log(`  Curious field (high Φg, novel):   valence = ${v2.toFixed(4)} ${v2 > v1 * 0.5 ? '✅ curiosity reward' : '⚠️'}`);

// Feed several bad fields to build sustained contradiction
for (let i = 0; i < 8; i++) drive.computeValence(badField);
const v3 = drive.getValence();
console.log(`  After 8 bad ticks (high χ):       valence = ${v3.toFixed(4)} ${v3 < 0 ? '✅ negative (pain)' : '⚠️'}`);

// Recovery
for (let i = 0; i < 5; i++) drive.computeValence(goodField);
const v4 = drive.getValence();
console.log(`  After 5 good ticks (recovery):    valence = ${v4.toFixed(4)} ${v4 > v3 ? '✅ recovering' : '⚠️'}`);
console.log();

// ── Test 4: Wm/Pr Modulation ──────────────────────────────────────────────────
console.log("── 4. Valence-Modulated Wm and Pr ──");

const baseWm = 0.5;
const basePr = 0.4;

const modWm = drive.modulateWm(baseWm);
const modPr = drive.modulatePr(basePr);

console.log(`  Base Wm: ${baseWm} → Modulated: ${modWm.toFixed(4)} (valence: ${drive.getValence().toFixed(4)})`);
console.log(`  Base Pr: ${basePr} → Modulated: ${modPr.toFixed(4)}`);
console.log();

// ── Test 5: Adaptive Heartbeat Interval ───────────────────────────────────────
console.log("── 5. Adaptive Heartbeat Interval ──");

const engagedMs  = drive.computeAdaptiveInterval({ phi_g: 0.06, M: 0.03, chi: 0.1 });
const neutralMs  = drive.computeAdaptiveInterval({ phi_g: 0.025, M: 0, chi: 0.2 });
const boredMs    = drive.computeAdaptiveInterval({ phi_g: 0.005, M: -0.01, chi: 0.1 });
const confusedMs = drive.computeAdaptiveInterval({ phi_g: 0.02, M: 0, chi: 0.5 });

console.log(`  Engaged (high Φg, +M):   ${engagedMs}ms  ${engagedMs < neutralMs ? '✅ faster' : '⚠️'}`);
console.log(`  Neutral:                  ${neutralMs}ms`);
console.log(`  Bored (low Φg, -M):       ${boredMs}ms   ${boredMs > neutralMs ? '✅ slower' : '⚠️'}`);
console.log(`  Confused (high χ):        ${confusedMs}ms ${confusedMs > engagedMs ? '✅ cautious' : '⚠️'}`);
console.log();

// ── Test 6: Mood Labels ──────────────────────────────────────────────────────
console.log("── 6. Mood Detection ──");
console.log(`  Current mood: "${drive.getMood()}"`);

const driveState = drive.getState();
console.log(`  Full drive state:`);
console.log(`    valence:       ${driveState.valence.toFixed(4)}`);
console.log(`    mood:          ${driveState.mood}`);
console.log(`    avgPhiG:       ${driveState.avgPhiG.toFixed(4)}`);
console.log(`    avgChi:        ${driveState.avgChi.toFixed(4)}`);
console.log(`    goalComponents:${driveState.goalComponents}`);
console.log(`    hasGoalVector: ${driveState.hasGoalVector}`);
console.log(`    adaptiveMs:    ${driveState.adaptiveMs}ms`);
console.log();

// ── Test 7: Serialization ─────────────────────────────────────────────────────
console.log("── 7. Serialization / Restore ──");

const serialized = drive.serialize();
console.log(`  Serialized: ${JSON.stringify(serialized).length} bytes`);
console.log(`  Contains: goalComponents=${serialized.goalComponents.length}, ` +
            `valence=${serialized.valence.toFixed(4)}, ` +
            `phiGHistory=${serialized.phiGHistory.length}`);

// Simulate restore
drive.restore(serialized);
console.log(`  Restored successfully ✅`);
console.log(`  Post-restore mood: "${drive.getMood()}"`);
console.log();

// ── Test 8: Live Heartbeat with Drive ─────────────────────────────────────────
console.log("── 8. Live Heartbeat (5 ticks with drive) ──");

let ticksSeen = 0;
// Keep process alive until heartbeat test completes
const keepAlive = setInterval(() => {}, 100);

heartbeat.start(plasma, {
    intervalMs: 1000,   // Fast for testing
    goalText: 'coherent world understanding',
    onTick: (summary) => {
        ticksSeen++;
        const v = summary.valence !== undefined ? summary.valence.toFixed(4) : 'N/A';
        const mood = summary.mood || 'N/A';
        const ms = summary.intervalMs || 'N/A';
        console.log(`  tick ${summary.tick}: mood="${mood}" valence=${v} interval=${ms}ms buf=${summary.bufferSize} ${summary.promoted && summary.promoted.length ? '🌟PROMOTED' : ''}`);

        if (ticksSeen >= 5) {
            heartbeat.stop();
            clearInterval(keepAlive);
            console.log();
            console.log("=== DRIVE SYSTEM TEST COMPLETE ===");
        }
    }
});
