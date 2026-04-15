"use strict";

/**
 * kai.js — Unified KAI Runtime
 *
 * Single entry point that boots the full cognitive architecture:
 *   1. Load persisted state (or seed fresh if first run)
 *   2. Start the heartbeat (background dream/promote/decay loop)
 *   3. Open interactive REPL for direct interaction
 *
 * Usage:
 *   node kai.js              — boot and enter interactive mode
 *   node kai.js --fresh      — ignore saved state, seed fresh
 *   node kai.js --silent     — suppress heartbeat tick output
 *
 * Interactive commands:
 *   ask <query>              — query the field via resonance
 *   think <query>            — generative synthesis (bundle + cleanup)
 *   store <text>             — manually store a memory
 *   ingest <text>            — ingest via world bridge (untrusted)
 *   github <owner/repo>     — ingest from GitHub repository
 *   dream                    — trigger one manual dream cycle
 *   promote                  — run promotion check
 *   status                   — show field metrics and state
 *   save                     — force save state
 *   candidates               — show candidate buffer
 *   quit / exit              — save and exit
 */

const readline = require('readline');
const persistence     = require('./persistence');
const universe        = require('./universe');
const { Plasma }      = require('./plasma');
const heartbeat       = require('./heartbeat');
const candidateBuffer = require('./candidate-buffer');
const { runPromotion } = require('./promotion');
const { consolidate } = require('./rshl-lattice');
const { generateToResult } = require('./generative-core');
const bridge          = require('./world-bridge');
const { runHomeostasis } = require('./homeostasis');

// ── Parse args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const FRESH  = args.includes('--fresh');
const SILENT = args.includes('--silent');

const GOAL_TEXT = 'coherent world understanding with low contradiction and natural intelligence growth';

// ── Boot ───────────────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║           KAI — Geometric Intelligence          ║');
console.log('║       RSHL Sparse Ternary Cognitive Field        ║');
console.log('╚══════════════════════════════════════════════════╝\n');

let plasma;

if (!FRESH && persistence.stateExists()) {
    const info = persistence.getStateInfo();
    console.log(`  Loading saved state from ${info.savedAt}`);
    console.log(`    ${info.cells} cells, ${info.candidates} candidates, tick #${info.heartbeatTick}`);
    console.log(`    File size: ${info.fileSizeKb} KB\n`);

    const result = persistence.load();
    if (result.ok) {
        console.log(`  ✓ Restored ${result.cells} cells, ${result.candidates} candidates`);
        plasma = new Plasma(false);
    } else {
        console.log(`  ✗ Load failed: ${result.error}`);
        console.log('  → Falling back to fresh seed...\n');
        require('./seed');
        plasma = new Plasma(false);
    }
} else {
    if (FRESH) console.log('  --fresh flag: starting with clean seed\n');
    else console.log('  No saved state found. Seeding fresh...\n');
    require('./seed');
    plasma = new Plasma(false);
}

console.log(`  Universe: ${universe.count()} cells`);
console.log(`  Candidates: ${candidateBuffer.size()} entries\n`);

// ── Start heartbeat ────────────────────────────────────────────────────────────
heartbeat.start(plasma, {
    intervalMs: 8000,
    goalText: GOAL_TEXT,
    onTick: (summary) => {
        if (SILENT) return;
        const parts = [`  ♥ tick ${summary.tick}`];
        if (summary.dreamResult) {
            parts.push(`dream="${summary.dreamResult.insight.slice(0, 40)}..."`);
        }
        if (summary.promoted && summary.promoted.length) {
            parts.push(`⬆ PROMOTED ${summary.promoted.length}`);
        }
        if (summary.homeostasis) {
            const h = summary.homeostasis;
            if (h.decayed.length || h.pruned.length) {
                parts.push(`decay=${h.decayed.length} prune=${h.pruned.length}`);
            }
        }
        if (summary.saved) {
            parts.push(`💾 saved (${summary.saved.cells}c)`);
        }
        console.log(parts.join(' | '));
    },
});

console.log('  ♥ Heartbeat started (8s interval)\n');
console.log('  Type "help" for commands. KAI is thinking in the background.\n');

// ── Interactive REPL ───────────────────────────────────────────────────────────
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'KAI> ',
});

rl.prompt();

rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    const [cmd, ...rest] = input.split(/\s+/);
    const body = rest.join(' ');

    switch (cmd.toLowerCase()) {

        case 'help':
            console.log('\n  Commands:');
            console.log('    ask <query>           — resonance search across all regions');
            console.log('    think <query>          — generative synthesis (bundle + cleanup)');
            console.log('    store <text>           — store a memory directly');
            console.log('    ingest <text>          — ingest via world bridge (untrusted)');
            console.log('    github <owner/repo>   — ingest from GitHub repository');
            console.log('    dream                  — trigger one manual dream cycle');
            console.log('    promote                — run promotion check');
            console.log('    homeostasis            — run decay/pruning cycle');
            console.log('    status                 — show field metrics');
            console.log('    candidates             — show candidate buffer');
            console.log('    save                   — force save state');
            console.log('    quit / exit            — save and exit\n');
            break;

        case 'ask':
            if (!body) { console.log('  Usage: ask <query>'); break; }
            const hits = universe.query(body, 5);
            console.log(`\n  Query: "${body}"`);
            if (!hits.length) { console.log('  No resonance.\n'); break; }
            hits.forEach((h, i) => {
                console.log(`  ${i + 1}. [${h.region}] (${h.score.toFixed(3)}) "${h.text.slice(0, 70)}"`);
            });
            console.log();
            break;

        case 'think':
            if (!body) { console.log('  Usage: think <query>'); break; }
            const thought = generateToResult(body, 5);
            console.log(`\n  Query: "${body}"`);
            console.log(`  → Thought: "${thought.thought}"`);
            console.log(`  → Confidence: ${thought.confidence.toFixed(3)}`);
            if (thought.matches.length) {
                console.log('  Sources:');
                thought.matches.forEach(m => {
                    console.log(`    [${m.region}] (${m.score.toFixed(3)}) "${m.text.slice(0, 60)}"`);
                });
            }
            console.log();
            break;

        case 'store':
            if (!body) { console.log('  Usage: store <text>'); break; }
            const sid = universe.store(body, 'memory', { source: 'user-input' });
            console.log(`  ✓ Stored as cell #${sid} in memory region\n`);
            break;

        case 'ingest':
            if (!body) { console.log('  Usage: ingest <text>'); break; }
            const ir = bridge.ingest(body, { source: 'manual', topic: 'user-ingest' });
            if (ir.stored) console.log(`  ✓ Ingested as cell #${ir.id} (untrusted, strength 0.6)\n`);
            else console.log(`  ✗ Skipped: ${ir.reason}\n`);
            break;

        case 'github':
            if (!body) { console.log('  Usage: github <owner/repo>'); break; }
            const [owner, repo] = body.split('/');
            if (!owner || !repo) { console.log('  Usage: github owner/repo'); break; }
            console.log(`  Fetching ${owner}/${repo}...`);
            try {
                const gr = await bridge.ingestFromGitHub(owner, repo);
                console.log(`  ✓ ${gr.stored} stored, ${gr.skipped} skipped`);
                if (gr.error) console.log(`  Error: ${gr.error}`);
            } catch (e) {
                console.log(`  ✗ Failed: ${e.message}`);
            }
            console.log();
            break;

        case 'dream':
            const dr = consolidate(plasma, { goalText: GOAL_TEXT });
            if (dr) {
                const entry = candidateBuffer.observe(dr);
                console.log(`\n  Dream: "${dr.insight.slice(0, 65)}"`);
                console.log(`  Confidence: ${dr.confidence.toFixed(3)}  phi_g: ${dr.field.phi_g.toFixed(3)}  C: ${dr.field.C.toFixed(3)}`);
                console.log(`  Duplicate: ${dr.duplicateEcho}  NonSource: ${dr.usedNonSourceInsight}`);
                if (entry) console.log(`  Candidate seen=${entry.seenCount}`);
            } else {
                console.log('  No viable dream pair found.');
            }
            console.log();
            break;

        case 'promote':
            const pr = runPromotion();
            if (pr.promoted.length) {
                console.log(`\n  ⬆ Promoted ${pr.promoted.length}:`);
                pr.promoted.forEach(p => {
                    console.log(`    "${p.text.slice(0, 60)}" (seen=${p.seenCount} str=${p.strength.toFixed(2)})`);
                });
            } else {
                console.log('  No promotions ready.');
                if (pr.failLog.length) {
                    const reasons = {};
                    pr.failLog.forEach(f => { reasons[f.reason] = (reasons[f.reason] || 0) + 1; });
                    console.log(`  Fail reasons: ${JSON.stringify(reasons)}`);
                }
            }
            console.log();
            break;

        case 'homeostasis':
            const hr = runHomeostasis();
            console.log(`  Decayed: ${hr.decayed.length}  Pruned: ${hr.pruned.length}`);
            if (hr.pruned.length) {
                hr.pruned.forEach(p => console.log(`    ✗ "${p.text.slice(0, 50)}"`));
            }
            console.log();
            break;

        case 'status':
            const cells = universe.getCells();
            const cands = candidateBuffer.getAll();
            const promoted_count = cands.filter(c => c.status === 'promoted').length;
            const bridgeStats = bridge.getStats();

            console.log('\n  ── KAI Status ──');
            console.log(`  Universe:    ${cells.length} cells`);
            console.log(`  Candidates:  ${cands.length} (${promoted_count} promoted)`);
            console.log(`  Heartbeat:   ${heartbeat.isRunning() ? '♥ running' : '✗ stopped'} (tick ${heartbeat.tickCount()})`);
            console.log(`  External:    ${bridgeStats.totalExternal} cells (${(bridgeStats.externalRatio * 100).toFixed(1)}%)`);
            if (Object.keys(bridgeStats.bySource).length) {
                console.log(`  Sources:     ${JSON.stringify(bridgeStats.bySource)}`);
            }

            // Region breakdown
            const regions = {};
            cells.forEach(c => { regions[c.region] = (regions[c.region] || 0) + 1; });
            console.log(`  Regions:     ${JSON.stringify(regions)}`);

            // Strength distribution
            const strengths = cells.map(c => c.strength);
            const avgStr = strengths.reduce((a, b) => a + b, 0) / strengths.length;
            console.log(`  Avg strength: ${avgStr.toFixed(2)}`);

            if (persistence.stateExists()) {
                const info = persistence.getStateInfo();
                console.log(`  Last save:   ${info.savedAt} (${info.fileSizeKb} KB)`);
            }
            console.log();
            break;

        case 'candidates':
            const allCands = candidateBuffer.getAll()
                .sort((a, b) => b.seenCount - a.seenCount);
            if (!allCands.length) { console.log('  No candidates.\n'); break; }
            console.log(`\n  ── Candidate Buffer (${allCands.length}) ──`);
            allCands.forEach(c => {
                console.log(
                    `  [${c.status.toUpperCase().padEnd(9)}] seen=${c.seenCount} ` +
                    `C=${c.bestC.toFixed(3)} phi=${c.bestPhi_g.toFixed(3)} ` +
                    `"${c.text.slice(0, 50)}"`
                );
            });
            console.log();
            break;

        case 'save':
            const sr = persistence.save({ heartbeatTick: heartbeat.tickCount() });
            console.log(`  💾 Saved: ${sr.cells} cells, ${sr.candidates} candidates (${Math.round(sr.bytes / 1024)} KB)\n`);
            break;

        case 'quit':
        case 'exit':
            heartbeat.stop();
            const fr = persistence.save({ heartbeatTick: heartbeat.tickCount() });
            console.log(`\n  💾 Final save: ${fr.cells} cells, ${fr.candidates} candidates`);
            console.log('  KAI entering dormancy. State preserved.\n');
            process.exit(0);
            break;

        default:
            // Treat unknown input as a query
            const defaultHits = universe.query(input, 3);
            if (defaultHits.length && defaultHits[0].score > 0.55) {
                console.log(`\n  "${defaultHits[0].text}"`);
                console.log(`  (resonance: ${defaultHits[0].score.toFixed(3)} | region: ${defaultHits[0].region})\n`);
            } else {
                console.log(`  Unknown command. Type "help" for options.\n`);
            }
            break;
    }

    rl.prompt();
});

rl.on('close', () => {
    heartbeat.stop();
    persistence.save({ heartbeatTick: heartbeat.tickCount() });
    console.log('\n  KAI dormant. State preserved.\n');
    process.exit(0);
});
